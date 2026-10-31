// Mock AI with the same interface as the Copilot adapter, for tests and offline work
// (AI_MOCK=1). Deterministic: no network, no randomness.
import { checkCustomTools, decidePermission, wrapToolHandler } from './tools.js';

/**
 * @param {{ replies?: Record<string, string | ((req: object) => string | Promise<string>)>,
 *           failures?: Record<string, string>, models?: string[], builtInTools?: string[],
 *           permissionRequests?: Record<string, object[]>, events?: Record<string, object[]>,
 *           toolCalls?: Record<string, { name: string, args?: object }[]> }} [options]
 *   replies, failures, permissionRequests, events and toolCalls are keyed by model ID.
 *   Permission requests and events are replayed through the caller's handlers, as the SDK would.
 *   toolCalls run the caller's own tools (customTools) through the same wrapper as the adapter;
 *   the results reach a reply function as toolResults: [{ name, text }] (text null if the tool
 *   wasn't offered).
 */
export function createMockAi({
  replies = {}, failures = {}, models = [], builtInTools = [], permissionRequests = {}, events = {}, toolCalls = {},
} = {}) {
  const calls = [];

  async function ask({
    model, system, prompt, attachments, tools = [], customTools = [], allowPermission = () => false,
    onPermission, onEvent, onToolCall, unsafeAllToolsForTest = false,
  }) {
    const names = checkCustomTools(customTools);
    const customNames = new Set(names);
    calls.push({ model, system, prompt, attachments, tools: unsafeAllToolsForTest ? null : [...tools], customTools: names });
    if (failures[model]) throw new Error(failures[model]);
    for (const request of permissionRequests[model] ?? []) {
      const allowed = decidePermission(request, { allowPermission, customNames });
      onPermission?.(request, allowed);
    }
    for (const event of events[model] ?? []) onEvent?.(event);
    const toolResults = [];
    for (const call of toolCalls[model] ?? []) {
      const tool = customTools.find((t) => t.name === call.name);
      const text = tool ? await wrapToolHandler(tool, { onCall: onToolCall })(call.args ?? {}) : null;
      toolResults.push({ name: call.name, text });
    }
    const reply = replies[model];
    const text = typeof reply === 'function'
      ? await reply({ model, system, prompt, attachments, tools, toolResults })
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

  return { mode: 'mock', ask, listModels, listBuiltInTools, stop, calls, features: Object.freeze({ defineTool: false }) };
}
