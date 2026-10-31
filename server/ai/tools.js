// Tool allowed list (blueprint §7.5, build spec §25). Anything not on a list is refused,
// including the SDK's built-in shell and file tools, because the Codespace holds credentials.

// Built-in web tool names, verified in phase 0 (WP-007). The SDK's BuiltInTools export doesn't
// list them (1.0.22: { Isolated: [...] }), so nothing relies on that export.
export const WEB_TOOLS = Object.freeze(['web_fetch', 'web_search']);

// The permission kind a web tool raises (verified in WP-007).
export const WEB_PERMISSION_KINDS = Object.freeze(['url']);

// Never approved, whatever a caller asks for. The adapter checks this too.
export const NEVER_ALLOWED_KINDS = Object.freeze(['shell', 'write', 'read', 'mcp']);

// VERIFY: the permission kind the SDK raises for an app-defined tool is 'custom-tool', with the
// name in request.toolName (SDK PermissionRequest type). npm run spike:tools prints what arrives.
export const CUSTOM_TOOL_KIND = 'custom-tool';

// The app's own tools (read_curriculum, read_notebook, ...): lower case, so they can't be
// mistaken for an SDK built-in with a different spelling.
export const CUSTOM_TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{2,63}$/;
export const MAX_TOOL_RESULT_CHARS = 20_000;
export const TOOL_ERROR_TEXT = 'Not available.';

/** A permission check that approves only the given request kinds (never the ones above). */
export function permissionPolicy(kinds = []) {
  const allowed = new Set(kinds.filter((kind) => !NEVER_ALLOWED_KINDS.includes(kind)));
  return (request) => typeof request?.kind === 'string' && allowed.has(request.kind);
}

/** The tool name on a permission request or event payload, whichever field it uses. */
export function toolNameOf(value) {
  if (!value || typeof value !== 'object') return null;
  for (const key of ['toolName', 'tool_name', 'name', 'tool']) {
    if (typeof value[key] === 'string' && value[key]) return value[key];
  }
  return null;
}

/** A safe summary of a permission request: its kind and tool name only, never its arguments. */
export function describePermission(request) {
  return { kind: typeof request?.kind === 'string' ? request.kind : 'unknown', tool: toolNameOf(request) };
}

/**
 * One permission decision, shared by the Copilot adapter and the mock.
 * The app's own tools are approved by name only (a caller's policy can't widen that);
 * shell, write, read and MCP are never approved; anything else follows allowPermission.
 */
export function decidePermission(request, { allowPermission = () => false, customNames = new Set() } = {}) {
  try {
    const kind = request?.kind;
    if (kind === CUSTOM_TOOL_KIND) return customNames.has(toolNameOf(request));
    if (NEVER_ALLOWED_KINDS.includes(kind)) return false;
    return allowPermission(request) === true;
  } catch {
    return false;
  }
}

/** Check the app's own tool definitions; returns their names. Throws on the first problem. */
export function checkCustomTools(list = []) {
  if (!Array.isArray(list)) throw new Error('customTools must be an array');
  const names = [];
  for (const tool of list) {
    const name = tool?.name;
    if (typeof name !== 'string' || !CUSTOM_TOOL_NAME_PATTERN.test(name)) {
      throw new Error(`Custom tool name not allowed: ${String(name)}`);
    }
    if (WEB_TOOLS.includes(name)) throw new Error(`Custom tool name clashes with a web tool: ${name}`);
    if (names.includes(name)) throw new Error(`Custom tool listed twice: ${name}`);
    if (typeof tool.description !== 'string' || !tool.description.trim()) {
      throw new Error(`Custom tool ${name} needs a description`);
    }
    if (!tool.parameters || typeof tool.parameters !== 'object' || tool.parameters.type !== 'object') {
      throw new Error(`Custom tool ${name} needs a JSON schema of type "object"`);
    }
    if (typeof tool.handler !== 'function') throw new Error(`Custom tool ${name} needs a handler`);
    names.push(name);
  }
  return names;
}

/** Text for the model from a handler result: strings as they are, anything else as JSON, capped. */
export function toolResultText(value, max = MAX_TOOL_RESULT_CHARS) {
  let text;
  if (typeof value === 'string') text = value;
  else {
    try {
      text = JSON.stringify(value ?? null);
    } catch {
      text = TOOL_ERROR_TEXT;
    }
  }
  if (typeof text !== 'string') text = 'null';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Wrap a read-only handler so a failure never throws into the SDK and the result is always text.
 * onCall receives { name, ok, ms } only: never arguments or results, which may hold learner text.
 */
export function wrapToolHandler(tool, { onCall, now = () => Date.now() } = {}) {
  return async (args) => {
    const started = now();
    let ok = true;
    let text;
    try {
      text = toolResultText(await tool.handler(args && typeof args === 'object' ? args : {}));
    } catch {
      ok = false;
      text = TOOL_ERROR_TEXT;
    }
    if (onCall) {
      try { onCall({ name: tool.name, ok, ms: now() - started }); } catch { /* reporting only */ }
    }
    return text;
  };
}
