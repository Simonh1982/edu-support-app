// Copilot SDK adapter (blueprint §7.1). Every SDK call is in this file, so a changed SDK API
// means changing one place. Items marked VERIFY are taken from the SDK README, not yet run live.
import os from 'node:os';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';

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

// No tools at all until WP-007 adds the allowed list (blueprint §7.5).
function rejectAll() {
  return { kind: 'reject', feedback: 'Not available.' };
}

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
   * Send one prompt in a fresh session and return the reply text.
   * @param {{ model: string, system: string, prompt: string, attachments?: object[], timeoutMs?: number }} request
   *   attachments: image attachments built by server/ai/image-input.js
   */
  async function ask({ model, system, prompt, attachments, timeoutMs = 60_000 }) {
    const c = await ensureClient();
    // VERIFY: createSession config names: systemMessage { mode: 'replace' }, availableTools
    // (an empty list should mean no built-in tools), infiniteSessions, onPermissionRequest.
    const session = await c.createSession({
      model,
      systemMessage: { mode: 'replace', content: system },
      availableTools: [],
      infiniteSessions: { enabled: false },
      onPermissionRequest: rejectAll,
    });
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

  return { mode: 'copilot', ask, listModels, stop };
}
