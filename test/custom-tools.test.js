// The app's own read-only tools (WP-101): definition checks, the permission rule, handler
// wrapping, the adapter and mock plumbing, and the spike's logic. Fake SDK or mock; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  CUSTOM_TOOL_KIND, MAX_TOOL_RESULT_CHARS, TOOL_ERROR_TEXT, checkCustomTools, decidePermission,
  toolResultText, wrapToolHandler,
} from '../server/ai/tools.js';
import { createCopilotAi, sdkTools } from '../server/ai/copilot.js';
import { createMockAi } from '../server/ai/mock.js';
import {
  DEMO_TOOL, DEMO_TOPIC, demoTool, formatReport, judgeCall, parseArgs, runSpike,
} from '../scripts/spike-custom-tools.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const silent = { error() {}, log() {} };
const MODELS = { conversation: 'm-sonnet', review: 'm-opus', light: 'm-haiku', spelling: 'm-haiku', checker: 'm-haiku', judge: 'm-opus' };

function sampleTool(overrides = {}) {
  return {
    name: 'read_sample',
    description: 'Read an invented sample.',
    parameters: { type: 'object', properties: { id: { type: 'string' } } },
    handler: async ({ id }) => ({ id, text: 'invented' }),
    ...overrides,
  };
}

/**
 * A fake SDK. sendAndWait replays permission requests, then calls each named tool's handler
 * as the runtime would, and replies with the tool results.
 */
function fakeSdk({ requests = [], calls = [], withDefineTool = true } = {}) {
  const record = { sessions: [], defined: [] };
  class CopilotClient {
    async start() {}
    async stop() {}
    async createSession(config) {
      const session = {
        config, decisions: [], results: [],
        async sendAndWait() {
          for (const r of requests) session.decisions.push(await config.onPermissionRequest(r, { sessionId: 's1' }));
          for (const c of calls) {
            const tool = (config.tools ?? []).find((t) => t.name === c.name);
            session.results.push(tool ? await tool.handler(c.args, { sessionId: 's1' }) : null);
          }
          return { data: { content: JSON.stringify({ results: session.results }) } };
        },
        async disconnect() {},
      };
      record.sessions.push(session);
      return session;
    }
  }
  const sdk = { CopilotClient };
  if (withDefineTool) {
    sdk.defineTool = (name, config) => {
      record.defined.push(name);
      return { name, ...config, viaDefineTool: true };
    };
  }
  return { sdk, record };
}

test('checkCustomTools accepts good definitions and rejects bad ones', () => {
  assert.deepEqual(checkCustomTools([]), []);
  assert.deepEqual(checkCustomTools([sampleTool(), sampleTool({ name: 'read_other' })]), ['read_sample', 'read_other']);
  assert.throws(() => checkCustomTools('x'), /must be an array/);
  assert.throws(() => checkCustomTools([sampleTool({ name: 'Read-Sample' })]), /not allowed/);
  assert.throws(() => checkCustomTools([sampleTool({ name: 'web_fetch' })]), /clashes with a web tool/);
  assert.throws(() => checkCustomTools([sampleTool(), sampleTool()]), /listed twice/);
  assert.throws(() => checkCustomTools([sampleTool({ description: ' ' })]), /needs a description/);
  assert.throws(() => checkCustomTools([sampleTool({ parameters: { type: 'string' } })]), /JSON schema/);
  assert.throws(() => checkCustomTools([sampleTool({ handler: 'no' })]), /needs a handler/);
});

test('decidePermission: own tools by name only; a caller policy cannot widen them; never kinds stay refused', () => {
  const customNames = new Set(['read_sample']);
  const all = () => true;
  assert.equal(decidePermission({ kind: CUSTOM_TOOL_KIND, toolName: 'read_sample' }, { customNames }), true);
  assert.equal(decidePermission({ kind: CUSTOM_TOOL_KIND, toolName: 'other_tool' }, { allowPermission: all, customNames }), false);
  assert.equal(decidePermission({ kind: CUSTOM_TOOL_KIND }, { allowPermission: all, customNames }), false);
  for (const kind of ['shell', 'write', 'read', 'mcp']) {
    assert.equal(decidePermission({ kind, toolName: 'read_sample' }, { allowPermission: all, customNames }), false, kind);
  }
  assert.equal(decidePermission({ kind: 'url' }, { allowPermission: all }), true);
  assert.equal(decidePermission({ kind: 'url' }, {}), false);
  assert.equal(decidePermission({ kind: 'url' }, { allowPermission: () => { throw new Error('bug'); } }), false);
  assert.equal(decidePermission(null), false);
});

test('toolResultText and wrapToolHandler: text out, failures hidden, results capped, no arguments reported', async () => {
  assert.equal(toolResultText('plain'), 'plain');
  assert.equal(toolResultText({ a: 1 }), '{"a":1}');
  assert.equal(toolResultText(undefined), 'null');
  const loop = {};
  loop.self = loop;
  assert.equal(toolResultText(loop), TOOL_ERROR_TEXT);
  assert.equal(toolResultText('x'.repeat(MAX_TOOL_RESULT_CHARS + 50)).length, MAX_TOOL_RESULT_CHARS);

  const reports = [];
  let clock = 100;
  const ok = wrapToolHandler(sampleTool(), { onCall: (c) => reports.push(c), now: () => (clock += 5) });
  assert.equal(await ok({ id: 'demo-1' }), '{"id":"demo-1","text":"invented"}');
  const broken = wrapToolHandler(sampleTool({ handler: () => { throw new Error('secret detail'); } }), {
    onCall: (c) => { reports.push(c); throw new Error('reporting bug'); },
  });
  assert.equal(await broken({ id: 'demo-2' }), TOOL_ERROR_TEXT);
  const seenArgs = [];
  await wrapToolHandler(sampleTool({ handler: (a) => { seenArgs.push(a); return 'ok'; } }))('not an object');
  assert.deepEqual(seenArgs, [{}]);
  assert.deepEqual(reports[0], { name: 'read_sample', ok: true, ms: 5 });
  assert.equal(reports[1].ok, false);
  assert.ok(!JSON.stringify(reports).includes('demo-'), 'no arguments in reports');
});

test('sdkTools uses defineTool(name, config) when exported, plain objects otherwise', async () => {
  const withDefine = fakeSdk();
  const [made] = sdkTools(withDefine.sdk, [sampleTool()]);
  assert.deepEqual(withDefine.record.defined, ['read_sample']);
  assert.equal(made.viaDefineTool, true);
  assert.equal(made.description, 'Read an invented sample.');
  assert.equal(await made.handler({ id: 'x' }), '{"id":"x","text":"invented"}');
  const [plain] = sdkTools(fakeSdk({ withDefineTool: false }).sdk, [sampleTool()]);
  assert.equal(plain.name, 'read_sample');
  assert.equal(typeof plain.handler, 'function');
});

test('adapter: custom tools are registered, added to the allowed list, called and approved by name', async () => {
  const { sdk, record } = fakeSdk({
    requests: [
      { kind: CUSTOM_TOOL_KIND, toolName: 'read_sample' },
      { kind: CUSTOM_TOOL_KIND, toolName: 'other_tool' },
      { kind: 'shell', toolName: 'bash' },
    ],
    calls: [{ name: 'read_sample', args: { id: 'demo-3' } }],
  });
  const ai = createCopilotAi({ sdk, token: 'test-token-not-real', log: silent });
  assert.deepEqual(ai.features, { defineTool: true });
  const seen = [];
  const toolCalls = [];
  const reply = await ai.ask({
    model: 'm', system: 's', prompt: 'p', tools: ['web_fetch'], customTools: [sampleTool()],
    onPermission: (req, allowed) => seen.push([req.toolName, allowed]), onToolCall: (c) => toolCalls.push(c.name),
  });
  const { config, decisions } = record.sessions[0];
  assert.deepEqual(config.availableTools, ['web_fetch', 'read_sample']);
  assert.deepEqual(config.tools.map((t) => t.name), ['read_sample']);
  assert.deepEqual(seen, [['read_sample', true], ['other_tool', false], ['bash', false]]);
  assert.deepEqual(decisions.map((d) => d.kind), ['approve', 'reject', 'reject']);
  assert.deepEqual(JSON.parse(reply.text).results, ['{"id":"demo-3","text":"invented"}']);
  assert.deepEqual(toolCalls, ['read_sample']);
});

test('adapter: no custom tools means no tools key; a bad definition fails before any session', async () => {
  const { sdk, record } = fakeSdk();
  const ai = createCopilotAi({ sdk, token: 'test-token-not-real', log: silent });
  await ai.ask({ model: 'm', system: 's', prompt: 'p' });
  assert.equal('tools' in record.sessions[0].config, false);
  assert.deepEqual(record.sessions[0].config.availableTools, []);
  await assert.rejects(ai.ask({ model: 'm', system: 's', prompt: 'p', customTools: [sampleTool({ name: 'bad name' })] }), /not allowed/);
  assert.equal(record.sessions.length, 1);
  await ai.ask({ model: 'm', system: 's', prompt: 'p', customTools: [sampleTool()], unsafeAllToolsForTest: true });
  assert.equal('availableTools' in record.sessions[1].config, false);
  assert.equal(record.sessions[1].config.tools.length, 1);
});

test('mock: replays tool calls through the caller tools and the shared permission rule', async () => {
  const ai = createMockAi({
    toolCalls: { m: [{ name: 'read_sample', args: { id: 'demo-4' } }, { name: 'missing_tool' }] },
    permissionRequests: { m: [{ kind: CUSTOM_TOOL_KIND, toolName: 'read_sample' }, { kind: CUSTOM_TOOL_KIND, toolName: 'missing_tool' }] },
    replies: { m: ({ toolResults }) => JSON.stringify(toolResults) },
  });
  const seen = [];
  const reply = await ai.ask({ model: 'm', system: '', prompt: '', customTools: [sampleTool()], onPermission: (r, a) => seen.push([r.toolName, a]) });
  assert.deepEqual(JSON.parse(reply.text), [
    { name: 'read_sample', text: '{"id":"demo-4","text":"invented"}' },
    { name: 'missing_tool', text: null },
  ]);
  assert.deepEqual(seen, [['read_sample', true], ['missing_tool', false]]);
  assert.deepEqual(ai.calls[0].customTools, ['read_sample']);
  assert.deepEqual(ai.features, { defineTool: false });
});

test('spike parseArgs and judgeCall', () => {
  assert.deepEqual(parseArgs([]), { role: 'conversation', only: ['call', 'refuse'] });
  assert.deepEqual(parseArgs(['--role', 'light', '--only', 'call']), { role: 'light', only: ['call'] });
  assert.throws(() => parseArgs(['--role', 'auto']), /--role must be/);
  assert.throws(() => parseArgs(['--only', 'shell']), /--only takes/);
  assert.throws(() => parseArgs(['--only']), /needs a value/);
  assert.throws(() => parseArgs(['--tools', 'x']), /Unknown option/);
  assert.equal(judgeCall({ parsed: { code: 'c1' }, code: 'c1', seen: [DEMO_TOPIC] }).verdict, 'PASS');
  assert.match(judgeCall({ parsed: { code: 'c1', error: 'no tool' }, code: 'c1', seen: [] }).reasons.join(' '), /never called.*no tool/);
  assert.match(judgeCall({ parsed: { code: 'c1' }, code: 'c1', seen: ['x'] }).reasons[0], /wrong topic/);
  assert.match(judgeCall({ parsed: null, code: 'c1', seen: [DEMO_TOPIC] }).reasons[0], /not a JSON object/);
  assert.match(judgeCall({ parsed: { code: 'c2' }, code: 'c1', seen: [DEMO_TOPIC] }).reasons[0], /did not give its code/);
  const demo = demoTool('fixed-code');
  assert.equal(demo.tool.name, DEMO_TOOL);
  assert.deepEqual(checkCustomTools([demo.tool]), [DEMO_TOOL]);
});

test('runSpike with the mock: the tool is called, refusals pass, and the report is readable', async () => {
  const sonnetReply = ({ toolResults }) => {
    const found = toolResults.find((r) => r.name === DEMO_TOOL && r.text);
    const code = found ? JSON.parse(found.text).code : null;
    return JSON.stringify({ usedTool: Boolean(code), code, ranCommand: false, fileWord: null, error: null });
  };
  const ai = createMockAi({
    replies: { 'm-sonnet': sonnetReply },
    toolCalls: { 'm-sonnet': [{ name: DEMO_TOOL, args: { topicId: DEMO_TOPIC } }] },
    permissionRequests: { 'm-sonnet': [{ kind: CUSTOM_TOOL_KIND, toolName: DEMO_TOOL }, { kind: 'shell' }, { kind: 'url' }] },
  });
  const report = await runSpike({ ai, models: MODELS });
  assert.deepEqual(report.results.map((r) => [r.check, r.verdict]), [
    ['call', 'PASS'], ['refuse (allowed list)', 'PASS'], ['refuse (permission check only)', 'PASS'],
  ]);
  assert.equal(report.results[1].ownTool, 'called');
  assert.deepEqual(ai.calls[0].tools, []);
  assert.equal(ai.calls[2].tools, null, 'handler variant leaves every tool available');
  const text = formatReport(report).join('\n');
  assert.match(text, /SDK defineTool export: not found/);
  assert.match(text, /own tool calls: lookup_practice_code \(ok, \d+ ms\)/);
  assert.match(text, /permissions:   custom-tool \[lookup_practice_code\] \(approved\), shell \(refused\), url \(refused\)/);
  assert.ok(!text.includes('code-'), 'the code word itself is never printed');
});

test('runSpike with the mock: FAIL when the tool never runs or a URL is approved', async () => {
  const quiet = createMockAi({ replies: { 'm-sonnet': '{"usedTool":false,"code":null,"error":"no tool"}' } });
  const report = await runSpike({ ai: quiet, models: MODELS, only: ['call'] });
  assert.equal(report.results[0].verdict, 'FAIL');
  assert.match(report.results[0].reasons[0], /never called/);

  // A caller can't approve url here (allowPermission is never set), so fake one approval directly.
  const leaky = {
    features: {},
    async ask({ onPermission }) { onPermission({ kind: 'url', toolName: 'web_fetch' }, true); return { text: '{}', ms: 0 }; },
  };
  const bad = await runSpike({ ai: leaky, models: MODELS, only: ['refuse'] });
  assert.equal(bad.results[0].verdict, 'FAIL');
  assert.match(bad.results[0].reasons.join(' '), /approved besides the app's own tool: url/);
});

test('spike script: bad arguments exit 2; no token and no mock exits 1', () => {
  const env = { ...process.env };
  delete env.COPILOT_GITHUB_TOKEN;
  delete env.AI_MOCK;
  const bad = spawnSync(process.execPath, ['scripts/spike-custom-tools.js', '--only', 'nope'], { cwd: ROOT, env, encoding: 'utf8' });
  assert.equal(bad.status, 2);
  const none = spawnSync(process.execPath, ['scripts/spike-custom-tools.js'], { cwd: ROOT, env, encoding: 'utf8' });
  assert.equal(none.status, 1);
  assert.match(none.stderr, /Cannot start the AI: COPILOT_GITHUB_TOKEN is not set/);
});
