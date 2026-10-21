// Mock AI with the same interface as the Copilot adapter, for tests and offline work
// (AI_MOCK=1). Deterministic: no network, no randomness.
import { NEVER_ALLOWED_KINDS } from './tools.js';

/**
 * @param {{ replies?: Record<string, string | ((req: object) => string | Promise<string>)>,
 *           failures?: Record<string, string>, models?: string[], builtInTools?: string[],
 *           permissionRequests?: Record<string, object[]>, events?: Record<string, object[]> }} [options]
 *   replies, failures, permissionRequests and events are keyed by model ID. Permission
 *   requests and events are replayed through the caller's handlers, as the SDK would.
 */
export function createMockAi({
  replies = {}, failures = {}, models = [], builtInTools = [], permissionRequests = {}, events = {},
} = {}) {
  const calls = [];

  async function ask({
    model, system, prompt, attachments, tools = [], allowPermission = () => false,
    onPermission, onEvent, unsafeAllToolsForTest = false,
  }) {
    calls.push({ model, system, prompt, attachments, tools: unsafeAllToolsForTest ? null : [...tools] });
    if (failures[model]) throw new Error(failures[model]);
    for (const request of permissionRequests[model] ?? []) {
      const allowed = allowPermission(request) === true && !NEVER_ALLOWED_KINDS.includes(request?.kind);
      onPermission?.(request, allowed);
    }
    for (const event of events[model] ?? []) onEvent?.(event);
    const reply = replies[model];
    const text = typeof reply === 'function'
      ? await reply({ model, system, prompt, attachments, tools })
      : reply ?? JSON.stringify({ reply: 'ready', mock: true });
    return { text, model, ms: 0 };
  }

  async function listModels() {
    return models.map((id) => ({ id, name: `Mock ${id}` }));
  }

  function listBuiltInTools() {
    return [...builtInTools];
  }

  async function stop() {}

  return { mode: 'mock', ask, listModels, listBuiltInTools, stop, calls };
}
