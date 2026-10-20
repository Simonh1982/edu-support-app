// AI start-up: choose the client (Copilot, mock or off) and test every role's model, so that
// "ready" in /api/health means Copilot really answers (blueprint §7.1).
import { ROLES, loadModels } from './models.js';
import { createCopilotAi, errorSummary, loadSdk } from './copilot.js';
import { createMockAi } from './mock.js';

export const STARTUP_SYSTEM = 'You are a connection test for an app. Reply with the single word: ready';
export const STARTUP_PROMPT = 'Connection test. Reply with the single word: ready';

/**
 * Pick the AI client from the environment. Never throws.
 * @returns {Promise<{ ai: object | null, error: string | null }>}
 */
export async function createAi({ env = process.env, importer, log = console } = {}) {
  if (env.AI_MOCK === '1') return { ai: createMockAi(), error: null };
  const token = env.COPILOT_GITHUB_TOKEN;
  if (!token) return { ai: null, error: 'COPILOT_GITHUB_TOKEN is not set' };
  const { sdk, error } = await loadSdk(importer);
  if (!sdk) return { ai: null, error: `Copilot SDK not available (${error})` };
  return { ai: createCopilotAi({ sdk, token, workDir: env.COPILOT_WORK_DIR || undefined, log }), error: null };
}

/**
 * Send one tiny message per distinct model; roles sharing a model share the result.
 * @returns {Promise<{ ready: boolean, roles: Record<string, object>, errors: string[] }>}
 */
export async function runStartupCheck({ ai, models, timeoutMs = 60_000 }) {
  const rolesByModel = new Map();
  for (const role of ROLES) {
    const model = models[role];
    if (!rolesByModel.has(model)) rolesByModel.set(model, []);
    rolesByModel.get(model).push(role);
  }
  const roles = {};
  const errors = [];
  for (const [model, sharing] of rolesByModel) {
    let result;
    try {
      const reply = await ai.ask({ model, system: STARTUP_SYSTEM, prompt: STARTUP_PROMPT, timeoutMs });
      result = { model, ok: true, ms: reply.ms };
    } catch (err) {
      const message = errorSummary(err);
      result = { model, ok: false, error: message };
      errors.push(`${model}: ${message}`);
    }
    for (const role of sharing) roles[role] = result;
  }
  return { ready: errors.length === 0, roles, errors };
}

/**
 * Start the AI layer and record the outcome in state.ai. Never throws.
 * @returns {Promise<{ ai: object, models: object } | null>}
 */
export async function startAi({ state, env = process.env, importer, log = console, modelsUrl, timeoutMs } = {}) {
  state.ai = { ready: false, roles: {}, errors: [], mode: 'starting' };
  try {
    const { models, errors } = await loadModels(modelsUrl);
    if (!models) {
      state.ai = { ready: false, roles: {}, errors, mode: 'off' };
      log.error(`[ai] models.json problems: ${errors.join('; ')}`);
      return null;
    }
    const { ai, error } = await createAi({ env, importer, log });
    if (!ai) {
      state.ai = { ready: false, roles: {}, errors: [error], mode: 'off' };
      log.log(`[ai] not started: ${error}`);
      return null;
    }
    const result = await runStartupCheck({ ai, models, timeoutMs });
    state.ai = { ...result, mode: ai.mode };
    log.log(`[ai] ${ai.mode}: ${result.ready ? 'ready' : 'NOT ready'}`);
    for (const message of result.errors) log.error(`[ai] start-up test failed: ${message}`);
    return { ai, models };
  } catch (err) {
    const message = errorSummary(err);
    state.ai = { ready: false, roles: {}, errors: [message], mode: 'off' };
    log.error(`[ai] start-up failed: ${message}`);
    return null;
  }
}
