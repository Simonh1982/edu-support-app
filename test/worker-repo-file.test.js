// WP-014c: the Worker's read-only /repo-file route. Fake fetch only; invented settings.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../wake/worker.js';

const BASE = 'https://wake.example.dev';
const SOURCE = 'https://raw.githubusercontent.com/Simonh1982/edu-support-app/main/';
const ENV = Object.freeze({ STORAGE_REPO: 'invented-owner/invented-private', STORAGE_TOKEN: 'invented-token-value' });
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Replaces fetch; reply(url, init) returns a Response or throws. Records every call. */
function fakeFetch(reply) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return reply(String(url), init);
  };
  return calls;
}

const text = (body, status = 200, headers = {}) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...headers } });

const get = (query, headers = {}) => worker.fetch(new Request(`${BASE}/repo-file${query}`, { headers }), ENV);
const post = (body, query = '', headers = {}) =>
  worker.fetch(new Request(`${BASE}/repo-file${query}`, { method: 'POST', body, headers: { 'Content-Type': 'application/json', ...headers } }), ENV);

test('GET returns the public file as plain text with an end line', async () => {
  const calls = fakeFetch(() => text('line one\nline two\nline three\n'));
  const res = await get('?path=docs/STATE.md');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/plain; charset=utf-8/);
  assert.equal(res.headers.get('access-control-allow-origin'), null, 'no CORS headers');
  assert.equal(await res.text(), 'line one\nline two\nline three\n--- end of docs/STATE.md (3 lines) ---\n');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${SOURCE}docs/STATE.md`);
});

test('never sends a token or reads the private repository setting', async () => {
  const calls = fakeFetch(() => text('x\n'));
  await get('?path=README.md');
  const headers = new Headers(calls[0].init.headers ?? {});
  assert.equal(headers.get('authorization'), null);
  const sent = JSON.stringify({ url: calls[0].url, headers: [...headers] });
  assert.ok(!sent.includes(ENV.STORAGE_REPO) && !sent.includes(ENV.STORAGE_TOKEN));
  assert.ok(calls[0].url.startsWith(SOURCE));
});

test('a file with no final newline still gets the end line on its own line', async () => {
  fakeFetch(() => text('alpha\nbeta'));
  assert.equal(await (await get('?path=a/b.js')).text(), 'alpha\nbeta\n--- end of a/b.js (2 lines) ---\n');
  fakeFetch(() => text(''));
  assert.equal(await (await get('?path=empty.txt')).text(), '--- end of empty.txt (0 lines) ---\n');
});

test('works with no Origin header and with any Origin (the content is public)', async () => {
  fakeFetch(() => text('ok\n'));
  assert.equal((await get('?path=package.json')).status, 200);
  const res = await get('?path=package.json', { Origin: 'https://elsewhere.example' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('POST takes the path from a JSON body, or from the query if the body has none', async () => {
  const calls = fakeFetch(() => text('one\n'));
  const res = await post(JSON.stringify({ path: 'web/app.js' }));
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'one\n--- end of web/app.js (1 lines) ---\n');
  assert.equal(calls.at(-1).url, `${SOURCE}web/app.js`);

  assert.equal((await post('', '?path=web/app.css')).status, 200);
  assert.equal(calls.at(-1).url, `${SOURCE}web/app.css`);
  assert.equal((await post('not json', '?path=web/index.html')).status, 200);
  assert.equal(calls.at(-1).url, `${SOURCE}web/index.html`);

  const bad = await post('not json');
  assert.equal(bad.status, 400);
  assert.equal((await post('{"path":"x"}'.padEnd(2000, ' '))).status, 413);
});

test('refuses bad paths with 400 and never calls GitHub', async () => {
  const calls = fakeFetch(() => text('should not be read'));
  const bad = [
    '', '?path=', '?path=/docs/STATE.md', '?path=../secret', '?path=docs/../x', '?path=docs/..',
    '?path=%2e%2e/x', '?path=docs//STATE.md', '?path=docs/', '?path=./docs', '?path=a b',
    '?path=docs%5CSTATE.md', '?path=a?b', '?path=a%3Ab', '?path=%7E/x', `?path=${'a'.repeat(201)}`,
  ];
  for (const query of bad) {
    const res = await get(query);
    assert.equal(res.status, 400, query);
    const body = await res.json();
    assert.equal(typeof body.error, 'string', query);
    assert.equal(typeof body.reason, 'string', query);
  }
  assert.equal(calls.length, 0);
  fakeFetch(() => text('ok'));
  assert.equal((await get(`?path=${'a'.repeat(200)}`)).status, 200, '200 characters is allowed');
});

test('missing file → 404; GitHub error or no answer → 502', async () => {
  fakeFetch(() => text('404: Not Found', 404));
  const missing = await get('?path=nope.md');
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).path, 'nope.md');
  fakeFetch(() => text('busy', 503));
  const busy = await get('?path=docs/STATE.md');
  assert.equal(busy.status, 502);
  assert.equal((await busy.json()).githubStatus, 503);
  fakeFetch(() => {
    throw new TypeError('fetch failed');
  });
  assert.equal((await get('?path=docs/STATE.md')).status, 502);
});

test('over 1 MB → 413, whether or not GitHub gives a length; exactly 1 MB is fine', async () => {
  const MB = 1024 * 1024;
  fakeFetch(() => text('x', 200, { 'Content-Length': String(MB + 1) }));
  assert.equal((await get('?path=big.json')).status, 413);

  const streamed = (size) => () => {
    let sent = 0;
    const chunk = new Uint8Array(64 * 1024).fill(0x61);
    return new Response(new ReadableStream({
      pull(controller) {
        if (sent >= size) return controller.close();
        const part = chunk.subarray(0, Math.min(chunk.length, size - sent));
        sent += part.length;
        controller.enqueue(part);
      },
    }), { status: 200 });
  };
  fakeFetch(streamed(MB + 10));
  assert.equal((await get('?path=big.json')).status, 413);
  fakeFetch(streamed(MB));
  const ok = await get('?path=edge.txt');
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /--- end of edge\.txt \(1 lines\) ---\n$/);
});

test('other methods → 405', async () => {
  fakeFetch(() => text('x'));
  const res = await worker.fetch(new Request(`${BASE}/repo-file?path=a.md`, { method: 'PUT', body: 'x' }), ENV);
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('allow'), 'GET, POST');
});

test('other addresses still reach the existing Worker routes', async () => {
  const calls = fakeFetch(() => text('unexpected', 500));
  const res = await worker.fetch(new Request(`${BASE}/`), ENV);
  assert.match(res.headers.get('content-type') ?? '', /json/);
  assert.ok(!calls.some((c) => c.url.startsWith(SOURCE)), 'the root route never reads repo files');
  const near = await worker.fetch(new Request(`${BASE}/repo-file/docs/STATE.md`), ENV);
  assert.ok(!(await near.text()).includes('--- end of'), 'only the exact /repo-file address is this route');
});

test('the route block uses no settings, tokens or the storage repository', () => {
  const source = readFileSync(new URL('../wake/worker.js', import.meta.url), 'utf8');
  const start = source.indexOf('// ===== REPO FILE ROUTE START');
  const end = source.indexOf('// ===== REPO FILE ROUTE END =====');
  assert.ok(start >= 0 && end > start, 'block markers present once');
  assert.equal(source.indexOf('// ===== REPO FILE ROUTE START', start + 1), -1);
  const block = source.slice(start, end);
  assert.doesNotMatch(block, /\benv\b|STORAGE|Authorization|GITHUB_TOKEN|api\.github\.com/);
  assert.match(block, /'https:\/\/raw\.githubusercontent\.com\/Simonh1982\/edu-support-app\/main\/'/);
});
