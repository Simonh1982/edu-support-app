// AI layer: models.json, the Copilot adapter (against a fake SDK), the mock, the start-up test
// and the server wiring. No network: the real SDK is never loaded here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROLES, validateModels, loadModels } from '../server/ai/models.js';
import { createCopilotAi, errorSummary, loadSdk, redact, DEFAULT_WORK_DIR } from '../server/ai/copilot.js';
import { createMockAi } from '../server/ai/mock.js';
import { createAi, runStartupCheck, startAi } from '../server/ai/index.js';
import { describeModel, compareRoles } from '../scripts/list-copilot-models.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const silent = { error() {}, log() {} };
const FAKE_TOKEN = 'test-token-not-real';
const BLUEPRINT_MODELS = {
  conversation: 'claude-sonnet-5.5', review: 'claude-opus-5.5', light: 'claude-haiku-5.5',
  spelling: 'claude-haiku-5.5', checker: 'claude-haiku-5.5', judge: 'claude-opus-5.5',
};

/** A stand-in for @github/copilot-sdk that records how it is called. */
function fakeSdk({ reply = 'ready', failOn = {}, models = [] } = {}) {
  const record = { clients: [], sessions: [] };
  class CopilotClient {
    constructor(options) { this.options = options; this.starts = 0; this.stopped = false; record.clients.push(this); }
    async start() { this.starts += 1; }
    async stop() { this.stopped = true; return []; }
    async listModels() { return models; }
    async createSession(config) {
      const session = {
        config, disconnected: false, sent: [],
        async sendAndWait(options, timeout) {
          session.sent.push({ options, timeout });
          if (failOn[config.model]) throw new Error(failOn[config.model]);
          return reply === null ? undefined : { data: { content: reply } };
        },
        async disconnect() { session.disconnected = true; },
      };
      record.sessions.push(session);
      return session;
    }
  }
  return { sdk: { CopilotClient }, record };
}

test('models.json in the repository has every role and no "auto"', async () => {
  const { models, errors } = await loadModels();
  assert.deepEqual(errors, []);
  assert.deepEqual(Object.keys(models).sort(), [...ROLES].sort());
});

test('validateModels rejects missing roles, "auto", unknown roles and non-objects', () => {
  assert.ok(validateModels(BLUEPRINT_MODELS).models);
  const { light, ...missing } = BLUEPRINT_MODELS;
  assert.match(validateModels(missing).errors.join(), /light: missing/);
  assert.match(validateModels({ ...BLUEPRINT_MODELS, judge: 'auto' }).errors.join(), /judge: "auto"/);
  assert.match(validateModels({ ...BLUEPRINT_MODELS, extra: 'x' }).errors.join(), /extra: unknown role/);
  assert.equal(validateModels([]).models, null);
  assert.equal(validateModels(null).models, null);
});

test('loadModels reports an unreadable file without throwing', async () => {
  const { models, errors } = await loadModels(new URL('file:///nonexistent/models.json'));
  assert.equal(models, null);
  assert.match(errors[0], /could not be read/);
});

test('createAi: mock when AI_MOCK=1; off without a token; off if the SDK is missing', async () => {
  assert.equal((await createAi({ env: { AI_MOCK: '1' } })).ai.mode, 'mock');
  let imported = false;
  const none = await createAi({ env: {}, importer: async () => { imported = true; } });
  assert.equal(none.ai, null);
  assert.match(none.error, /COPILOT_GITHUB_TOKEN is not set/);
  assert.equal(imported, false, 'SDK is not loaded without a token');
  const missing = await createAi({
    env: { COPILOT_GITHUB_TOKEN: FAKE_TOKEN },
    importer: async () => { const e = new Error('nope'); e.code = 'ERR_MODULE_NOT_FOUND'; throw e; },
  });
  assert.equal(missing.ai, null);
  assert.match(missing.error, /SDK not available \(not installed\)/);
});

test('loadSdk rejects a module without CopilotClient', async () => {
  const { sdk, error } = await loadSdk(async () => ({}));
  assert.equal(sdk, null);
  assert.match(error, /CopilotClient/);
});

test('Copilot adapter: token auth, temp work folder, replace prompt, no tools', async () => {
  const { sdk, record } = fakeSdk();
  const ai = createCopilotAi({ sdk, token: FAKE_TOKEN, log: silent });
  const reply = await ai.ask({ model: 'm1', system: 'SYS', prompt: 'hello', timeoutMs: 1234 });
  assert.equal(reply.text, 'ready');
  const [client] = record.clients;
  assert.equal(client.options.gitHubToken, FAKE_TOKEN);
  assert.equal(client.options.useLoggedInUser, false);
  assert.equal(client.options.baseDirectory, DEFAULT_WORK_DIR);
  assert.ok(!DEFAULT_WORK_DIR.startsWith(ROOT), 'SDK files live outside the repository');
  const [session] = record.sessions;
  assert.equal(session.config.model, 'm1');
  assert.deepEqual(session.config.systemMessage, { mode: 'replace', content: 'SYS' });
  assert.deepEqual(session.config.availableTools, []);
  assert.deepEqual(session.config.infiniteSessions, { enabled: false });
  assert.deepEqual(session.sent[0], { options: { prompt: 'hello' }, timeout: 1234 });
  for (const kind of ['shell', 'write', 'read', 'url', 'mcp']) {
    assert.equal(session.config.onPermissionRequest({ kind }).kind, 'reject', `${kind} refused`);
  }
  assert.equal(session.disconnected, true);
});

test('Copilot adapter: one client, one session per request, disconnect even on failure', async () => {
  const { sdk, record } = fakeSdk({ failOn: { bad: 'boom' } });
  const ai = createCopilotAi({ sdk, token: FAKE_TOKEN, log: silent });
  await ai.ask({ model: 'good', system: 's', prompt: 'p' });
  await assert.rejects(ai.ask({ model: 'bad', system: 's', prompt: 'p' }), /boom/);
  assert.equal(record.clients.length, 1);
  assert.equal(record.clients[0].starts, 1);
  assert.equal(record.sessions.length, 2);
  assert.ok(record.sessions.every((s) => s.disconnected));
  await ai.stop();
  assert.equal(record.clients[0].stopped, true);
});

test('Copilot adapter: an empty or missing reply is an error', async () => {
  for (const reply of [null, '   ']) {
    const { sdk } = fakeSdk({ reply });
    const ai = createCopilotAi({ sdk, token: FAKE_TOKEN, log: silent });
    await assert.rejects(ai.ask({ model: 'm', system: 's', prompt: 'p' }), /Empty reply/);
  }
});

test('errorSummary: extracts the body, hides tokens, stays short', () => {
  const dump = 'Request failed: headers={"x-a":"1","authorization":"Bearer abc.def"} "body":"{\\"message\\":\\"Model not available\\"}"';
  assert.equal(errorSummary(new Error(dump)), 'Model not available');
  const leaky = `failed with ghp_${'a'.repeat(36)} and github_pat_${'b'.repeat(40)}`;
  const safe = errorSummary(new Error(leaky));
  assert.ok(!safe.includes('ghp_') && !safe.includes('github_pat_'), safe);
  assert.equal(redact('Bearer xyz.123'), '[redacted]');
  assert.ok(errorSummary(new Error('x'.repeat(1000))).length <= 300);
  assert.equal(errorSummary(undefined), 'Unknown error');
});

test('mock AI is deterministic and can fail on request', async () => {
  const ai = createMockAi({ replies: { a: 'hi', b: ({ prompt }) => `echo ${prompt}` }, failures: { c: 'down' } });
  assert.equal((await ai.ask({ model: 'a', system: '', prompt: 'x' })).text, 'hi');
  assert.equal((await ai.ask({ model: 'b', system: '', prompt: 'x' })).text, 'echo x');
  assert.deepEqual(JSON.parse((await ai.ask({ model: 'z', system: '', prompt: '' })).text), { reply: 'ready', mock: true });
  await assert.rejects(ai.ask({ model: 'c', system: '', prompt: '' }), /down/);
  assert.equal(ai.calls.length, 4);
});

test('start-up check: one message per distinct model; every role reported', async () => {
  const ai = createMockAi();
  const result = await runStartupCheck({ ai, models: BLUEPRINT_MODELS });
  assert.equal(ai.calls.length, 3, 'Sonnet, Opus and Haiku once each');
  assert.equal(result.ready, true);
  assert.deepEqual(Object.keys(result.roles).sort(), [...ROLES].sort());
  assert.equal(result.roles.spelling.model, 'claude-haiku-5.5');
});

test('start-up check: a failing model marks its roles and AI is not ready', async () => {
  const ai = createMockAi({ failures: { 'claude-opus-5.5': `403 not authorized ghp_${'c'.repeat(36)}` } });
  const result = await runStartupCheck({ ai, models: BLUEPRINT_MODELS });
  assert.equal(result.ready, false);
  assert.equal(result.roles.review.ok, false);
  assert.equal(result.roles.judge.ok, false);
  assert.equal(result.roles.light.ok, true);
  assert.equal(result.errors.length, 1);
  assert.ok(!result.errors[0].includes('ghp_'), 'token redacted');
});

test('startAi records off, mock and models.json problems in state.ai', async () => {
  const off = { ai: {} };
  assert.equal(await startAi({ state: off, env: {}, log: silent }), null);
  assert.equal(off.ai.mode, 'off');
  assert.match(off.ai.errors[0], /COPILOT_GITHUB_TOKEN/);

  const mock = { ai: {} };
  const handle = await startAi({ state: mock, env: { AI_MOCK: '1' }, log: silent });
  assert.equal(mock.ai.mode, 'mock');
  assert.equal(mock.ai.ready, true);
  assert.equal(handle.ai.mode, 'mock');

  const broken = { ai: {} };
  await startAi({ state: broken, env: { AI_MOCK: '1' }, log: silent, modelsUrl: new URL('file:///nonexistent/models.json') });
  assert.equal(broken.ai.mode, 'off');
  assert.match(broken.ai.errors[0], /models\.json/);
});

test('startAi with a fake Copilot SDK reaches ready', async () => {
  const { sdk, record } = fakeSdk();
  const state = { ai: {} };
  const handle = await startAi({ state, env: { COPILOT_GITHUB_TOKEN: FAKE_TOKEN }, importer: async () => sdk, log: silent });
  assert.equal(state.ai.mode, 'copilot');
  assert.equal(state.ai.ready, true);
  assert.equal(record.sessions.length, 3);
  assert.ok(!JSON.stringify(state.ai).includes(FAKE_TOKEN), 'token never in health');
  await handle.ai.stop();
});

test('npm run models helpers: readable lines and role matching', () => {
  assert.equal(
    describeModel({ id: 'm1', name: 'Model One', billing: { multiplier: 1 }, capabilities: { supports: { vision: true } } }),
    'm1  (Model One)  multiplier 1  images: yes',
  );
  assert.equal(describeModel({}), '(no id)');
  const rows = compareRoles({ light: 'a', judge: 'b' }, [{ id: 'a' }]);
  assert.deepEqual(rows, [{ role: 'light', id: 'a', found: true }, { role: 'judge', id: 'b', found: false }]);
});

test('server process starts the AI after listening (mock) and health reports it', { timeout: 15_000 }, async () => {
  const env = { ...process.env, PORT: '0', HOST: '127.0.0.1', AI_MOCK: '1' };
  delete env.COPILOT_GITHUB_TOKEN;
  const child = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no listen line: ${out}`)), 10_000);
      child.stdout.on('data', (d) => {
        out += d;
        const m = out.match(/listening on (\d+)/);
        if (m) { clearTimeout(timer); resolve(Number(m[1])); }
      });
    });
    let body;
    for (let i = 0; i < 40; i += 1) {
      body = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
      if (body.ai.mode === 'mock') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(body.ai.mode, 'mock');
    assert.equal(body.ai.ready, true);
    assert.equal(Object.keys(body.ai.roles).length, 6);
  } finally {
    const exited = new Promise((r) => child.on('exit', r));
    child.kill('SIGTERM');
    assert.equal(await exited, 0);
  }
});
