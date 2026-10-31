// Copilot SDK adapter (blueprint §7.1). Every SDK call is in this file, so a changed SDK API
// means changing one place. Items marked VERIFY are taken from the SDK README, not yet run live.
import os from 'node:os';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { checkCustomTools, decidePermission, wrapToolHandler } from './tools.js';

export const SDK_PACKAGE = '@github/copilot-sdk';

// Outside the repository, so SDK session files can never be committed by accident.
export const DEFAULT_WORK_DIR = path.join(os.tmpdir(), 'edu-support-copilot');

const SECRET_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
];

/** Remove anything that looks like a GitHub token. */
export function redact(text) {
  let out = String(text ?? '');
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[redacted]');
  return out;
}

/**
 * A short, safe error message for logs and /api/health. Copilot errors embed long header dumps,
 * so prefer the "body" text when there is one.
 */
export function errorSummary(err, max = 300) {
  const message = redact(err && typeof err === 'object' && 'message' in err ? err.message : err);
  const match = message.match(/"body"\s*:\s*"((?:[^"\\]|\\.)*)"/) || message.match(/\bbody\s*[:=]\s*'([^']*)'/);
  let text = match ? match[1].replace(/\\"/g, '"').replace(/\\n/g, ' ') : message;
  try {
    const inner = JSON.parse(text);
    const innerMessage = inner?.error?.message ?? inner?.message;
    if (typeof innerMessage === 'string') text = innerMessage;
  } catch {
    // not JSON: keep the text as it is
  }
  text = text.replace(/\s+/g, ' ').trim() || 'Unknown error';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Import the SDK without failing the server if it is missing. Returns { sdk, error }. */
export async function loadSdk(importer = (name) => import(name)) {
  try {
    const sdk = await importer(SDK_PACKAGE);
    if (typeof sdk?.CopilotClient !== 'function') return { sdk: null, error: 'CopilotClient export not found' };
    return { sdk, error: null };
  } catch (err) {
    return { sdk: null, error: err?.code === 'ERR_MODULE_NOT_FOUND' ? 'not installed' : errorSummary(err) };
  }
}

/** Tool names in the SDK's BuiltInTools export, whatever its shape (array, enum or map). */
export function builtInToolNames(value) {
  let names = [];
  if (Array.isArray(value)) names = value;
  else if (value && (typeof value === 'object' || typeof value === 'function')) {
    const values = Object.values(value);
    names = values.length && values.every((v) => typeof v === 'string') ? values : Object.keys(value);
  }
  return [...new Set(names.filter((n) => typeof n === 'string' && n))].sort();
}

/**
 * The app's own read-only tools as SDK tools. Handlers are wrapped (server/ai/tools.js), so a
 * failure becomes "Not available." for the model instead of an exception inside the SDK.
 */
export function sdkTools(sdk, customTools, { onToolCall } = {}) {
  return customTools.map((tool) => {
    const config = {
      description: tool.description,
      parameters: tool.parameters,
      handler: wrapToolHandler(tool, { onCall: onToolCall }),
    };
    // VERIFY: defineTool(name, { description, parameters, handler }) in SDK 1.0.22 (README form;
    // raw JSON schemas are accepted). If the installed types take one object ({ name, ... }),
    // change this line only.
    if (typeof sdk.defineTool === 'function') return sdk.defineTool(tool.name, config);
    return { name: tool.name, ...config };
  });
}

function rejectResult() {
  return { kind: 'reject', feedback: 'Not available.' };
}

const refuseAll = () => false;

/**
 * The real AI client. One CopilotClient for the server's lifetime; one session per request.
 * @param {{ sdk: any, token: string, workDir?: string, log?: Console }} options
 */
export function createCopilotAi({ sdk, token, workDir = DEFAULT_WORK_DIR, log = console }) {
  let client = null;
  let starting = null;

  async function ensureClient() {
    if (client) return client;
    if (!starting) {
      starting = (async () => {
        await mkdir(workDir, { recursive: true });
        // VERIFY: CopilotClient options gitHubToken, useLoggedInUser, baseDirectory,
        // workingDirectory and logLevel (SDK 1.0.22 README). Never use the logged-in user in a
        // Codespace: its token is not a Copilot credential and fails with 403.
        const c = new sdk.CopilotClient({
          gitHubToken: token,
          useLoggedInUser: false,
          baseDirectory: workDir,
          workingDirectory: workDir,
          logLevel: 'error',
        });
        await c.start();
        client = c;
        return c;
      })().catch((err) => {
        starting = null;
        throw err;
      });
    }
    return starting;
  }

  /**
   * Approve or refuse one permission request. Shell, write, read and MCP are always refused;
   * the app's own tools are approved by name only.
   */
  function decide(request, invocation, allowPermission, onPermission, customNames) {
    const allowed = decidePermission(request, { allowPermission, customNames });
    if (onPermission) {
      try { onPermission(request, allowed); } catch { /* a reporting error must not change the decision */ }
    }
    if (!allowed) return rejectResult();
    // VERIFY: approveAll is the SDK's approving handler, so its result has the right shape.
    return typeof sdk.approveAll === 'function' ? sdk.approveAll(request, invocation) : { kind: 'approve' };
  }

  /**
   * Send one prompt in a fresh session and return the reply text.
   * @param {{ model: string, system: string, prompt: string, attachments?: object[],
   *           tools?: string[], customTools?: object[],
   *           allowPermission?: (request: object) => boolean,
   *           onPermission?: (request: object, allowed: boolean) => void,
   *           onEvent?: (event: object) => void,
   *           onToolCall?: (call: { name: string, ok: boolean, ms: number }) => void,
   *           unsafeAllToolsForTest?: boolean, timeoutMs?: number }} request
   *   attachments: image attachments built by server/ai/image-input.js
   *   tools: the allowed list of built-in tool names (default: none)
   *   customTools: the app's own read-only tools, { name, description, parameters, handler }
   *     (checked by checkCustomTools; added to the allowed list automatically)
   *   allowPermission: which permission requests to approve (default: none)
   *   unsafeAllToolsForTest: refusal tests only; leaves every tool available so the
   *     permission check is the only guard
   */
  async function ask({
    model, system, prompt, attachments, tools = [], customTools = [], allowPermission = refuseAll,
    onPermission, onEvent, onToolCall, unsafeAllToolsForTest = false, timeoutMs = 60_000,
  }) {
    // Checked before the client starts, so a bad definition fails fast and costs nothing.
    const customNames = new Set(checkCustomTools(customTools));
    const c = await ensureClient();
    // VERIFY: createSession config names: systemMessage { mode: 'replace' }, availableTools
    // (a list means only those tools), infiniteSessions, onPermissionRequest(request, invocation).
    const config = {
      model,
      systemMessage: { mode: 'replace', content: system },
      infiniteSessions: { enabled: false },
      onPermissionRequest: (request, invocation) => decide(request, invocation, allowPermission, onPermission, customNames),
    };
    // VERIFY: createSession accepts tools: [...] for app-defined tools.
    if (customNames.size) config.tools = sdkTools(sdk, customTools, { onToolCall });
    // Leaving availableTools out means every tool, so it is always set outside the refusal test.
    // VERIFY: availableTools also filters app-defined tools, so their names are listed too.
    if (!unsafeAllToolsForTest) config.availableTools = [...tools, ...customNames];
    const session = await c.createSession(config);
    let unsubscribe = null;
    if (onEvent && typeof session.on === 'function') {
      // VERIFY: session.on(listener) with one function subscribes to every event and returns
      // a function that unsubscribes.
      unsubscribe = session.on((event) => {
        try { onEvent(event); } catch { /* a reporting error must not break the request */ }
      });
    }
    const started = Date.now();
    try {
      // VERIFY: sendAndWait(options, timeout) resolves to an event with data.content, or undefined.
      // VERIFY: the message options accept attachments: [{ type: 'file' | 'blob', ... }].
      // Only include the key when there are attachments, so text-only calls are unchanged.
      const options = attachments?.length ? { prompt, attachments } : { prompt };
      const event = await session.sendAndWait(options, timeoutMs);
      const text = event?.data?.content;
      if (typeof text !== 'string' || !text.trim()) throw new Error('Empty reply from model');
      return { text, model, ms: Date.now() - started };
    } finally {
      if (typeof unsubscribe === 'function') {
        try { unsubscribe(); } catch { /* ignore */ }
      }
      try {
        await session.disconnect();
      } catch (err) {
        log.error(`[ai] session disconnect failed: ${errorSummary(err)}`);
      }
    }
  }

  /** The models this account can use. */
  async function listModels() {
    const c = await ensureClient();
    // VERIFY: client.listModels() exists and returns an array of ModelInfo objects.
    if (typeof c.listModels !== 'function') throw new Error('This SDK version has no listModels()');
    return c.listModels();
  }

  /** Built-in tool names the SDK declares (empty if it doesn't say). */
  function listBuiltInTools() {
    // VERIFY: BuiltInTools is exported by SDK 1.0.22 (seen in the WP-005 export list).
    return builtInToolNames(sdk.BuiltInTools);
  }

  async function stop() {
    const c = client;
    client = null;
    starting = null;
    if (c) {
      try {
        await c.stop();
      } catch (err) {
        log.error(`[ai] client stop failed: ${errorSummary(err)}`);
      }
    }
  }

  // Reported by npm run spike:tools: plain tool objects are used if defineTool is missing.
  const features = Object.freeze({ defineTool: typeof sdk?.defineTool === 'function' });

  return { mode: 'copilot', ask, listModels, listBuiltInTools, stop, features };
}
