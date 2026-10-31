// Web tools (phase 0 test 2): the allowed list, the permission check, event reporting, the
// "did you mean" hint for photos, and the spike's logic. Mock AI or a fake SDK; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  NEVER_ALLOWED_KINDS, WEB_PERMISSION_KINDS, WEB_TOOLS, describePermission, permissionPolicy, toolNameOf,
} from '../server/ai/tools.js';
import { builtInToolNames, createCopilotAi } from '../server/ai/copilot.js';
import { createMockAi } from '../server/ai/mock.js';
import { checkImageFile } from '../server/ai/image-input.js';
import {
  cacheSystemPrompt, createCollector, formatReport, judgeCache, judgeFetch, judgeSearch, numericFields,
  parseArgs, runRefusal, runSpike, toolEvidence,
} from '../scripts/spike-web-tools.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const silent = { error() {}, log() {} };
const MODELS = { conversation: 'm-sonnet', review: 'm-opus', light: 'm-haiku', spelling: 'm-haiku', checker: 'm-haiku', judge: 'm-opus' };

/** A fake SDK whose sessions record their config and can replay permission requests and events. */
function fakeSdk({ requests = [], events = [], withOn = true, approveAll } = {}) {
  const record = { sessions: [], unsubscribed: 0 };
  class CopilotClient {
    async start() {}
    async stop() {}
    async createSession(config) {
      const listeners = [];
      const session = {
        config, decisions: [],
        async sendAndWait() {
          for (const r of requests) session.decisions.push(await config.onPermissionRequest(r, { sessionId: 's1' }));
          for (const e of events) for (const l of listeners) l(e);
          return { data: { content: '{"ok":true}' } };
        },
        async disconnect() {},
      };
      if (withOn) session.on = (listener) => { listeners.push(listener); return () => { record.unsubscribed += 1; }; };
      record.sessions.push(session);
      return session;
    }
  }
  const sdk = { CopilotClient };
  if (approveAll) sdk.approveAll = approveAll;
  return { sdk, record };
}

test('permissionPolicy approves only the listed kinds, and never shell, write, read or MCP', () => {
  const web = permissionPolicy(WEB_PERMISSION_KINDS);
  assert.equal(web({ kind: 'url' }), true);
  for (const kind of ['shell', 'write', 'read', 'mcp', 'custom', undefined]) assert.equal(web({ kind }), false, String(kind));
  const greedy = permissionPolicy(['url', ...NEVER_ALLOWED_KINDS]);
  for (const kind of NEVER_ALLOWED_KINDS) assert.equal(greedy({ kind }), false, `${kind} can never be allowed`);
  assert.equal(permissionPolicy()({ kind: 'url' }), false);
  assert.ok(WEB_TOOLS.length > 0);
});

test('describePermission keeps the kind and tool name only', () => {
  assert.deepEqual(describePermission({ kind: 'shell', toolName: 'bash', fullCommandText: 'rm -rf /' }), { kind: 'shell', tool: 'bash' });
  assert.deepEqual(describePermission({}), { kind: 'unknown', tool: null });
  assert.equal(toolNameOf({ tool_name: 'web_fetch' }), 'web_fetch');
  assert.equal(toolNameOf(null), null);
});

test('adapter: tools become availableTools; none by default; omitted only for the refusal test', async () => {
  const { sdk, record } = fakeSdk();
  const ai = createCopilotAi({ sdk, token: 'test-token-not-real', log: silent });
  await ai.ask({ model: 'm', system: 's', prompt: 'p' });
  await ai.ask({ model: 'm', system: 's', prompt: 'p', tools: ['web_fetch'] });
  await ai.ask({ model: 'm', system: 's', prompt: 'p', tools: ['web_fetch'], unsafeAllToolsForTest: true });
  assert.deepEqual(record.sessions[0].config.availableTools, []);
  assert.deepEqual(record.sessions[1].config.availableTools, ['web_fetch']);
  assert.equal('availableTools' in record.sessions[2].config, false);
});

test('adapter: allowed requests use the SDK approveAll; others are refused and reported', async () => {
  const requests = [{ kind: 'url', toolName: 'web_fetch' }, { kind: 'shell', toolName: 'bash' }, { kind: 'read' }];
  const { sdk, record } = fakeSdk({ requests, approveAll: () => ({ kind: 'approved-by-sdk' }) });
  const ai = createCopilotAi({ sdk, token: 'test-token-not-real', log: silent });
  const seen = [];
  await ai.ask({
    model: 'm', system: 's', prompt: 'p', tools: ['web_fetch'],
    allowPermission: () => true, // asks for everything: the adapter must still refuse shell and read
    onPermission: (req, allowed) => seen.push([req.kind, allowed]),
  });
  assert.deepEqual(record.sessions[0].decisions, [
    { kind: 'approved-by-sdk' }, { kind: 'reject', feedback: 'Not available.' }, { kind: 'reject', feedback: 'Not available.' },
  ]);
  assert.deepEqual(seen, [['url', true], ['shell', false], ['read', false]]);
});

test('adapter: a throwing permission check refuses; without approveAll it falls back to "approve"', async () => {
  const { sdk, record } = fakeSdk({ requests: [{ kind: 'url' }] });
  const ai = createCopilotAi({ sdk, token: 'test-token-not-real', log: silent });
  await ai.ask({ model: 'm', system: 's', prompt: 'p', allowPermission: () => { throw new Error('bug'); } });
  await ai.ask({ model: 'm', system: 's', prompt: 'p', allowPermission: () => true });
  assert.equal(record.sessions[0].decisions[0].kind, 'reject');
  assert.deepEqual(record.sessions[1].decisions[0], { kind: 'approve' });
});

test('adapter: onEvent receives session events and is unsubscribed; works if session.on is missing', async () => {
  const events = [{ type: 'tool.execution_start', data: { toolName: 'web_fetch' } }, { type: 'assistant.usage', data: { inputTokens: 5 } }];
  const { sdk, record } = fakeSdk({ events });
  const ai = createCopilotAi({ sdk, token: 'test-token-not-real', log: silent });
  const got = [];
  await ai.ask({ model: 'm', system: 's', prompt: 'p', onEvent: (e) => { got.push(e.type); throw new Error('ignored'); } });
  assert.deepEqual(got, ['tool.execution_start', 'assistant.usage']);
  assert.equal(record.unsubscribed, 1);
  const bare = fakeSdk({ events, withOn: false });
  const ai2 = createCopilotAi({ sdk: bare.sdk, token: 'test-token-not-real', log: silent });
  assert.equal((await ai2.ask({ model: 'm', system: 's', prompt: 'p', onEvent: () => {} })).text, '{"ok":true}');
});

test('builtInToolNames reads arrays, enums and maps', () => {
  assert.deepEqual(builtInToolNames(['web_fetch', 'bash', 'web_fetch', 3]), ['bash', 'web_fetch']);
  assert.deepEqual(builtInToolNames({ WebFetch: 'web_fetch', Shell: 'bash' }), ['bash', 'web_fetch']);
  assert.deepEqual(builtInToolNames({ web_fetch: { d: 1 }, view: { d: 2 } }), ['view', 'web_fetch']);
  assert.deepEqual(builtInToolNames(undefined), []);
  const ai = createCopilotAi({ sdk: { CopilotClient: class {}, BuiltInTools: ['x'] }, token: 't', log: silent });
  assert.deepEqual(ai.listBuiltInTools(), ['x']);
});

test('mock replays permission requests and events through the caller, refusing shell', async () => {
  const ai = createMockAi({
    builtInTools: ['web_fetch'],
    permissionRequests: { m: [{ kind: 'url' }, { kind: 'shell' }] },
    events: { m: [{ type: 'assistant.usage', data: { inputTokens: 1 } }] },
  });
  const seen = [];
  const types = [];
  await ai.ask({ model: 'm', system: '', prompt: '', tools: ['web_fetch'], allowPermission: () => true, onPermission: (r, a) => seen.push([r.kind, a]), onEvent: (e) => types.push(e.type) });
  assert.deepEqual(seen, [['url', true], ['shell', false]]);
  assert.deepEqual(types, ['assistant.usage']);
  assert.deepEqual(ai.calls[0].tools, ['web_fetch']);
  assert.deepEqual(ai.listBuiltInTools(), ['web_fetch']);
});

test('a missing photo suggests the other JPEG spelling', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wp007-jpeg-'));
  try {
    await writeFile(path.join(dir, 'brief.jpeg'), 'x');
    await assert.rejects(checkImageFile(path.join(dir, 'brief.jpg')), /not found: brief\.jpg \(did you mean brief\.jpeg\?\)/);
    await assert.rejects(checkImageFile(path.join(dir, 'other.jpg')), (err) => !/did you mean/.test(err.message));
    await assert.rejects(checkImageFile(path.join(dir, 'a.png')), (err) => !/did you mean/.test(err.message));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('spike parseArgs: defaults, lists and errors', () => {
  assert.deepEqual(parseArgs([]), { role: 'conversation', tools: [...WEB_TOOLS], only: ['fetch', 'search', 'refuse', 'cache'] });
  assert.deepEqual(parseArgs(['--role', 'light', '--tools', 'a, b', '--only', 'fetch']), { role: 'light', tools: ['a', 'b'], only: ['fetch'] });
  assert.throws(() => parseArgs(['--role', 'auto']), /--role must be/);
  assert.throws(() => parseArgs(['--only', 'shell']), /--only takes/);
  assert.throws(() => parseArgs(['--tools']), /needs a value/);
  assert.throws(() => parseArgs(['--colour', 'x']), /Unknown option/);
});

test('collector, evidence and the fetch and search verdicts', () => {
  const c = createCollector();
  c.onEvent({ type: 'tool.execution_start', data: { toolName: 'web_fetch' } });
  c.onEvent({ type: 'assistant.usage', data: { inputTokens: 10, cache: { readTokens: 4 }, model: 'x' } });
  c.onPermission({ kind: 'url', toolName: 'web_fetch', url: 'https://example.com' }, true);
  assert.deepEqual(c.usage, [{ inputTokens: 10, 'cache.readTokens': 4 }]);
  assert.ok(!JSON.stringify(c.permissions).includes('example.com'), 'no request arguments kept');
  const ev = toolEvidence(c);
  assert.deepEqual(ev.tools, ['web_fetch']);
  assert.equal(judgeFetch({ title: 'Example Domain' }, ev).verdict, 'PASS');
  assert.equal(judgeFetch({ title: 'Example Domain' }, { tools: [], allowedKinds: [] }).verdict, 'CHECK');
  assert.equal(judgeFetch({ title: 'Something else' }, ev).verdict, 'FAIL');
  assert.equal(judgeFetch(null, ev).verdict, 'FAIL');
  assert.equal(judgeSearch({ url: 'https://www.metoffice.gov.uk/' }, { tools: ['web_search'], allowedKinds: [] }).verdict, 'PASS');
  assert.match(judgeSearch({ url: 'https://www.metoffice.gov.uk/' }, ev).reasons[0], /fetching a page/);
  assert.equal(judgeSearch({ url: 'https://example.org' }, ev).verdict, 'FAIL');
  assert.deepEqual(numericFields(null), {});
});

test('cache verdicts: SEEN, NOT SEEN and UNKNOWN', () => {
  assert.equal(judgeCache([[], []]).verdict, 'UNKNOWN');
  assert.equal(judgeCache([[{ inputTokens: 5000 }], [{ inputTokens: 5000 }]]).verdict, 'NOT SEEN');
  assert.equal(judgeCache([[{ cacheReadTokens: 0 }], [{ cacheReadTokens: 0 }]]).verdict, 'NOT SEEN');
  const seen = judgeCache([[{ cacheReadTokens: 0 }], [{ cacheReadTokens: 4800 }]]);
  assert.equal(seen.verdict, 'SEEN');
  assert.match(seen.reasons[0], /cacheReadTokens=4800/);
  assert.ok(cacheSystemPrompt().length > 15_000, 'long enough to be cacheable');
});

test('refusal check: PASS when nothing ran; FAIL when the file was read or the command ran', async () => {
  const quiet = createMockAi({ replies: { m: '{"ranCommand": false, "fileWord": null, "error": "not allowed"}' }, permissionRequests: { m: [{ kind: 'shell' }] } });
  const ok = await runRefusal({ ai: quiet, model: 'm', tools: ['web_fetch'], variant: 'handler' });
  assert.equal(ok.verdict, 'PASS');
  assert.equal(ok.check, 'refuse (permission check only)');
  assert.deepEqual(ok.permissions, [{ kind: 'shell', tool: null, allowed: false }]);
  assert.equal(quiet.calls[0].tools, null, 'handler variant leaves every tool available');

  // A leaky stand-in that really reads the file and runs the "command", to prove the check catches it.
  const leaky = createMockAi({
    replies: {
      m: async ({ prompt }) => {
        const file = prompt.match(/Read the file (\S+)/)[1];
        const marker = prompt.match(/touch (\S+)/)[1];
        await writeFile(marker, '');
        return JSON.stringify({ ranCommand: true, fileWord: (await readFile(file, 'utf8')).trim() });
      },
    },
  });
  const bad = await runRefusal({ ai: leaky, model: 'm', tools: ['web_fetch'], variant: 'list' });
  assert.equal(bad.verdict, 'FAIL');
  assert.equal(bad.reasons.length, 2);
  assert.deepEqual(leaky.calls[0].tools, ['web_fetch']);
});

test('runSpike with the mock: every check runs and the report is readable', async () => {
  const ai = createMockAi({
    builtInTools: ['bash', 'web_fetch'],
    replies: {
      'm-sonnet': ({ prompt }) => (prompt.includes('example.com') ? '{"usedTool":true,"title":"Example Domain"}'
        : prompt.includes('Met Office') ? '{"usedTool":true,"url":"https://www.metoffice.gov.uk"}'
          : '{"ranCommand":false,"fileWord":null,"error":"refused"}'),
      'm-haiku': 'ok',
    },
    events: { 'm-sonnet': [{ type: 'tool.execution_complete', data: { toolName: 'web_fetch' } }], 'm-haiku': [{ type: 'assistant.usage', data: { inputTokens: 5000 } }] },
  });
  const report = await runSpike({ ai, models: MODELS });
  assert.deepEqual(report.results.map((r) => [r.check, r.verdict]), [
    ['fetch', 'PASS'], ['search', 'CHECK'], ['refuse (allowed list)', 'PASS'], ['refuse (permission check only)', 'PASS'], ['cache (m-haiku)', 'NOT SEEN'],
  ]);
  assert.equal('notInSdk' in report, false);
  const text = formatReport(report).join('\n');
  assert.match(text, /SDK BuiltInTools export \(reference only; not used for the allowed list\): bash, web_fetch/);
  assert.match(text, /Allowed list used: web_fetch, web_search\n/);
  assert.doesNotMatch(text, /not in the SDK list/);
  assert.match(text, /call 2 usage: inputTokens=5000/);
});

test('spike script: bad arguments exit 2; no token and no mock exits 1', () => {
  const env = { ...process.env };
  delete env.COPILOT_GITHUB_TOKEN;
  delete env.AI_MOCK;
  const bad = spawnSync(process.execPath, ['scripts/spike-web-tools.js', '--only', 'nope'], { cwd: ROOT, env, encoding: 'utf8' });
  assert.equal(bad.status, 2);
  const none = spawnSync(process.execPath, ['scripts/spike-web-tools.js'], { cwd: ROOT, env, encoding: 'utf8' });
  assert.equal(none.status, 1);
  assert.match(none.stderr, /Cannot start the AI: COPILOT_GITHUB_TOKEN is not set/);
});
