// Tool allowed list (blueprint §7.5, build spec §25). Anything not on a list is refused,
// including the SDK's built-in shell and file tools, because the Codespace holds credentials.

// VERIFY: built-in web tool names in @github/copilot-sdk 1.0.22 (BuiltInTools export).
// npm run spike:web prints the SDK's own list, so a wrong name shows up there.
export const WEB_TOOLS = Object.freeze(['web_fetch', 'web_search']);

// VERIFY: the permission kind a web tool raises. 'url' is one of the SDK's request kinds.
export const WEB_PERMISSION_KINDS = Object.freeze(['url']);

// Never approved, whatever a caller asks for. The adapter checks this too.
export const NEVER_ALLOWED_KINDS = Object.freeze(['shell', 'write', 'read', 'mcp']);

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
