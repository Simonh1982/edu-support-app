// Mock AI with the same interface as the Copilot adapter, for tests and offline work
// (AI_MOCK=1). Deterministic: no network, no randomness.

/**
 * @param {{ replies?: Record<string, string | ((req: object) => string)>,
 *           failures?: Record<string, string>, models?: string[] }} [options]
 *   replies and failures are keyed by model ID.
 */
export function createMockAi({ replies = {}, failures = {}, models = [] } = {}) {
  const calls = [];

  async function ask({ model, system, prompt }) {
    calls.push({ model, system, prompt });
    if (failures[model]) throw new Error(failures[model]);
    const reply = replies[model];
    const text = typeof reply === 'function'
      ? reply({ model, system, prompt })
      : reply ?? JSON.stringify({ reply: 'ready', mock: true });
    return { text, model, ms: 0 };
  }

  async function listModels() {
    return models.map((id) => ({ id, name: `Mock ${id}` }));
  }

  async function stop() {}

  return { mode: 'mock', ask, listModels, stop, calls };
}
