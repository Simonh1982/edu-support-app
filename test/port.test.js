// Port visibility (server/port.js) and the server's start-up diagnostics. gh is never run:
// a fake runner stands in for it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  managePort, visibilityArgs, ghEnv, shortError, appendPortLog, ATTEMPTS, DELAY_MS,
} from '../server/port.js';
import { processChain } from '../server/index.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const silent = { log() {}, error() {} };
const FAKE_TOKEN = 'test-ports-token-not-real';
const CODESPACE = { codespaceName: 'example-space-abc', port: 3000 };

function harness({ results = [], env = { GH_PORTS_TOKEN: FAKE_TOKEN, PATH: '/usr/bin', HOME: '/home/x' }, config = CODESPACE } = {}) {
  const calls = [];
  const sleeps = [];
  const lines = [];
  const state = { port: { visibility: 'unknown', detail: 'not managed yet' } };
  const handle = managePort({
    state, config, port: config.port, env, log: silent,
    run: async (args, options) => {
      calls.push({ args, env: options.env });
      return results[Math.min(calls.length - 1, results.length - 1)] ?? { code: 0, stdout: '', stderr: '' };
    },
    sleep: async (ms) => { sleeps.push(ms); },
    writeLog: async (line) => { lines.push(line); },
    now: () => new Date('2026-10-21T10:00:00.000Z'),
  });
  return { state, handle, calls, sleeps, lines };
}

const fail = (stderr, code = 1) => ({ code, stdout: '', stderr });

test('defaults: 18 attempts, 10 seconds apart (blueprint §3.3)', () => {
  assert.equal(ATTEMPTS, 18);
  assert.equal(DELAY_MS, 10_000);
});

test('visibilityArgs: the proven gh command', () => {
  assert.deepEqual(visibilityArgs(3000, 'example-space-abc'),
    ['codespace', 'ports', 'visibility', '3000:public', '-c', 'example-space-abc']);
});

test('ghEnv: passes the ports token as GH_TOKEN and leaves the Codespace GITHUB_TOKEN out', () => {
  const env = ghEnv(FAKE_TOKEN, { PATH: '/bin', HOME: '/h', GITHUB_TOKEN: 'codespace-own', COPILOT_GITHUB_TOKEN: 'x' });
  assert.deepEqual(env, { GH_TOKEN: FAKE_TOKEN, GH_PROMPT_DISABLED: '1', NO_COLOR: '1', PATH: '/bin', HOME: '/h' });
});

test('not in a Codespace: nothing is run', async () => {
  const h = harness({ config: { codespaceName: '', port: 3000 } });
  const port = await h.handle.done;
  assert.equal(port.visibility, 'n/a');
  assert.equal(h.calls.length, 0);
  assert.equal(h.lines.length, 0);
});

test('a test server on port 0 never touches the Codespace ports', async () => {
  const h = harness({ config: { codespaceName: 'example-space-abc', port: 0 } });
  assert.equal((await h.handle.done).visibility, 'n/a');
  assert.equal(h.calls.length, 0);
});

test('no GH_PORTS_TOKEN: reported as Private, gh not run, logged', async () => {
  const h = harness({ env: { PATH: '/bin' } });
  const port = await h.handle.done;
  assert.equal(port.visibility, 'private');
  assert.match(port.detail, /GH_PORTS_TOKEN is not set/);
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.lines, ['Private: GH_PORTS_TOKEN is not set']);
});

test('success on the first attempt: Public, one log line', async () => {
  const h = harness();
  const port = await h.handle.done;
  assert.equal(port.visibility, 'public');
  assert.equal(port.attempts, 1);
  assert.equal(port.updatedAt, '2026-10-21T10:00:00.000Z');
  assert.deepEqual(h.calls[0].args, visibilityArgs(3000, 'example-space-abc'));
  assert.equal(h.calls[0].env.GH_TOKEN, FAKE_TOKEN);
  assert.deepEqual(h.lines, ['Public (attempt 1)']);
  assert.equal(h.sleeps.length, 0);
});

test('retries until it works; logs only the first failure and the result', async () => {
  const h = harness({ results: [fail('port not found'), fail('port not found'), { code: 0, stdout: '', stderr: '' }] });
  const port = await h.handle.done;
  assert.equal(port.visibility, 'public');
  assert.equal(port.attempts, 3);
  assert.deepEqual(h.sleeps, [10_000, 10_000]);
  assert.deepEqual(h.lines, ['attempt 1 failed: port not found', 'Public (attempt 3)']);
});

test('gives up after 18 attempts and reports Private with the first error', async () => {
  const h = harness({ results: [fail('HTTP 403: Resource not accessible')] });
  const port = await h.handle.done;
  assert.equal(h.calls.length, 18);
  assert.equal(h.sleeps.length, 17);
  assert.equal(port.visibility, 'private');
  assert.equal(port.attempts, 18);
  assert.match(port.detail, /gave up after 18 attempts: HTTP 403/);
  assert.deepEqual(h.lines, ['attempt 1 failed: HTTP 403: Resource not accessible', 'Private: gave up after 18 attempts']);
});

test('gh missing (127): stops at once with a clear reason', async () => {
  const h = harness({ results: [fail('spawn gh ENOENT', 127)] });
  const port = await h.handle.done;
  assert.equal(h.calls.length, 1);
  assert.equal(port.visibility, 'private');
  assert.match(port.detail, /gh is not installed/);
});

test('tokens in gh output never reach state or the log', async () => {
  const leaked = `bad credentials for ghp_${'a'.repeat(36)}`;
  const h = harness({ results: [fail(leaked)] });
  const port = await h.handle.done;
  const all = JSON.stringify(port) + h.lines.join('\n');
  assert.ok(!all.includes('ghp_'), all);
  assert.match(all, /\[redacted\]/);
  assert.equal(shortError({ code: 4, stdout: '', stderr: '' }), 'exit 4');
});

test('stop() ends the retries', async () => {
  const calls = [];
  const state = { port: {} };
  let handle;
  handle = managePort({
    state, config: CODESPACE, port: 3000, env: { GH_PORTS_TOKEN: FAKE_TOKEN }, log: silent,
    run: async () => { calls.push(1); if (calls.length === 2) handle.stop(); return fail('not yet'); },
    sleep: async () => {}, writeLog: async () => {},
  });
  await handle.done;
  assert.equal(calls.length, 2);
});

test('appendPortLog writes timestamped lines', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'portlog-'));
  try {
    const file = path.join(dir, 'sub', 'port.log');
    await appendPortLog('Public (attempt 1)', file);
    await appendPortLog('second', file);
    const lines = (await readFile(file, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^\d{4}-\d\d-\d\dT[\d:.]+Z Public \(attempt 1\)$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('processChain follows parents through /proc and hides tokens', () => {
  const proc = {
    '/proc/30/cmdline': 'tail\0-n\0' + '40\0-f\0/x/.server/server.log\0',
    '/proc/30/stat': '30 (tail) S 20 30 30 0',
    '/proc/20/cmdline': `sh\0-c\0bash scripts/start-server.sh ghp_${'b'.repeat(36)}\0`,
    '/proc/20/stat': '20 (my (odd) sh) S 10 20 20 0',
    '/proc/10/cmdline': 'npm run server\0',
    '/proc/10/stat': '10 (npm) S 1 10 10 0',
  };
  const read = (p) => { if (!(p in proc)) throw new Error('ENOENT'); return proc[p]; };
  const chain = processChain(30, { read });
  assert.equal(chain.split(' ← ').length, 3);
  assert.match(chain, /^tail -n 40 -f \/x\/\.server\/server\.log \(30\) ← sh -c bash scripts\/start-server\.sh \[redacted\] \(20\) ← npm run server \(10\)$/);
  assert.equal(processChain(99, { read }), 'unknown');
  const multi = { '/proc/5/cmdline': 'bash\0-c\0line one\nline two\0', '/proc/5/stat': '5 (bash) S 1 5 5 0' };
  assert.equal(processChain(5, { read: (p) => multi[p] }), 'bash -c line one line two (5)');
});

test('a second server on a taken port exits 1 with a one-line reason', { timeout: 15_000 }, async () => {
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  const { port } = blocker.address();
  try {
    const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', CODESPACE_NAME: '', AI_MOCK: '1' };
    delete env.GH_PORTS_TOKEN;
    const child = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const code = await new Promise((r) => child.on('exit', r));
    assert.equal(code, 1);
    assert.match(out, /starting: pid \d+; started by: /);
    assert.match(out, new RegExp(`port ${port} is already in use by another server`));
    assert.ok(!out.includes('Unhandled'), out);
  } finally {
    await new Promise((r) => blocker.close(r));
  }
});
