// Server skeleton: health, CORS, limits, routing, and SIGHUP survival.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { loadConfig, isAllowedOrigin, PAGES_ORIGIN } from '../server/config.js';
import { createServer, createState, readJson, HttpError } from '../server/index.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const silent = { error() {}, log() {} };

async function withServer(env, fn) {
  const config = loadConfig({ PORT: '0', HOST: '127.0.0.1', ...env });
  const { server, state } = createServer(config, undefined, silent);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, state);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('loadConfig: defaults and fallbacks', () => {
  const c = loadConfig({});
  assert.equal(c.port, 3000);
  assert.equal(c.idleTimeoutMin, 30);
  assert.equal(c.devOrigins, false);
  assert.equal(c.jsonBodyLimit, 256 * 1024);
  assert.equal(c.uploadBodyLimit, 8 * 1024 * 1024);
  assert.equal(c.publicUrl, '');
  assert.equal(loadConfig({ IDLE_TIMEOUT_MIN: 'abc' }).idleTimeoutMin, 30);
  assert.equal(loadConfig({ IDLE_TIMEOUT_MIN: '-5' }).idleTimeoutMin, 30);
  assert.equal(loadConfig({ IDLE_TIMEOUT_MIN: '45' }).idleTimeoutMin, 45);
  assert.ok(Object.isFrozen(c));
});

test('loadConfig: public address is built from the Codespace variables', () => {
  const c = loadConfig({ CODESPACE_NAME: 'example-space-abc', GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: 'app.github.dev' });
  assert.equal(c.publicUrl, 'https://example-space-abc-3000.app.github.dev');
});

test('isAllowedOrigin: Pages always; localhost only with DEV_ORIGINS=1', () => {
  const prod = loadConfig({});
  const dev = loadConfig({ DEV_ORIGINS: '1' });
  assert.equal(isAllowedOrigin(PAGES_ORIGIN, prod), true);
  assert.equal(isAllowedOrigin('http://localhost:8080', prod), false);
  assert.equal(isAllowedOrigin('http://localhost:8080', dev), true);
  assert.equal(isAllowedOrigin('http://127.0.0.1:5500', dev), true);
  assert.equal(isAllowedOrigin('https://evil.example', dev), false);
  assert.equal(isAllowedOrigin(`${PAGES_ORIGIN}.evil.example`, prod), false);
  assert.equal(isAllowedOrigin('http://localhost.evil.example', dev), false);
  assert.equal(isAllowedOrigin(undefined, dev), false);
});

test('createState: restsAt is startedAt plus the idle timeout', () => {
  const now = new Date('2026-10-20T09:00:00.000Z');
  const s = createState(loadConfig({}), now);
  assert.equal(s.startedAt, '2026-10-20T09:00:00.000Z');
  assert.equal(s.restsAt, '2026-10-20T09:30:00.000Z');
});

test('GET /api/health answers with the blueprint shape', async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), ['ai', 'ok', 'port', 'restsAt', 'startedAt', 'storage']);
    assert.equal(body.ok, true);
    assert.deepEqual(body.ai, { ready: false, roles: {}, errors: [] });
    assert.deepEqual(body.storage, { ok: false, lastPush: null });
    assert.equal(Date.parse(body.restsAt) - Date.parse(body.startedAt), 30 * 60_000);
  });
});

test('health reflects later updates to shared state', async () => {
  await withServer({}, async (base, state) => {
    state.ai.ready = true;
    const body = await (await fetch(`${base}/api/health`)).json();
    assert.equal(body.ai.ready, true);
  });
});

test('POST /api/health is refused with 405 JSON', async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/api/health`, { method: 'POST' });
    assert.equal(res.status, 405);
    assert.ok((await res.json()).error);
  });
});

test('unknown routes return 404 JSON', async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/api/nothing-here`);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'Not found' });
  });
});

test('CORS: allowed origin is echoed; others are not', async () => {
  await withServer({}, async (base) => {
    const ok = await fetch(`${base}/api/health`, { headers: { Origin: PAGES_ORIGIN } });
    assert.equal(ok.headers.get('access-control-allow-origin'), PAGES_ORIGIN);
    assert.match(ok.headers.get('vary'), /Origin/);
    const bad = await fetch(`${base}/api/health`, { headers: { Origin: 'https://evil.example' } });
    assert.equal(bad.headers.get('access-control-allow-origin'), null);
  });
});

test('CORS preflight: 204 for allowed origin, 403 otherwise', async () => {
  await withServer({}, async (base) => {
    const ok = await fetch(`${base}/api/anything`, {
      method: 'OPTIONS',
      headers: { Origin: PAGES_ORIGIN, 'Access-Control-Request-Method': 'POST' },
    });
    assert.equal(ok.status, 204);
    assert.equal(ok.headers.get('access-control-allow-headers'), 'Content-Type, Authorization');
    const bad = await fetch(`${base}/api/anything`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' },
    });
    assert.equal(bad.status, 403);
  });
});

function fakeReq(body, headers = {}) {
  const req = Readable.from(body === null ? [] : [Buffer.from(body)]);
  req.headers = headers;
  return req;
}

test('readJson: parses, enforces the limit and rejects bad JSON', async () => {
  assert.deepEqual(await readJson(fakeReq('{"a":1}'), 100), { a: 1 });
  assert.equal(await readJson(fakeReq(null), 100), null);
  await assert.rejects(readJson(fakeReq('x'.repeat(101)), 100), (e) => e instanceof HttpError && e.status === 413);
  await assert.rejects(readJson(fakeReq('{}', { 'content-length': '999' }), 100), (e) => e.status === 413);
  await assert.rejects(readJson(fakeReq('{not json'), 100), (e) => e.status === 400);
});

test('server process ignores SIGHUP and stops on SIGTERM', { timeout: 15_000 }, async () => {
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no listen line: ${out}`)), 10_000);
    child.stdout.on('data', (d) => {
      out += d;
      const m = out.match(/listening on (\d+)/);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    child.on('exit', (code) => reject(new Error(`exited early (${code}): ${out}`)));
  });
  child.kill('SIGHUP');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(child.exitCode, null, 'still running after SIGHUP');
  const res = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(res.status, 200);
  const exited = new Promise((r) => child.on('exit', r));
  child.kill('SIGTERM');
  assert.equal(await exited, 0);
  assert.match(out, /SIGHUP received: ignored/);
});
