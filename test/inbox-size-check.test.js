// scripts/inbox-size-check.js (WP-114g, A-011) against the real Worker code and a fake GitHub contents
// API that accepts both the buffered and the streamed upload. Invented settings and data only.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../wake/worker.js';
import { runSizeCheck, sizeIds, invented, sendHint, SIZES } from '../scripts/inbox-size-check.js';
import { INBOX_MAX_BYTES, uploadIdFor } from '../server/storage/inbox.js';

const REPO = 'example-owner/example-data';
const ENV = Object.freeze({
  ALLOWED_ORIGIN: 'https://example.github.io',
  PASS_SIGNING_KEY: 'test-only-signing-key-0123456789-abcdefghijklmnop',
  PASS_VERSION: '1',
  ALLOWED_ACCOUNTS: JSON.stringify({ 'Example-Parent': 'parent', 'example-learner': 'learner' }),
  STORAGE_TOKEN: 'test-storage-token-value',
  STORAGE_REPO: REPO,
  STORAGE_DIR: '/tmp/inbox-size-check-test-storage-not-used',
});
const CONTENTS = `https://api.github.com/repos/${REPO}/contents/`;
const MB = 1024 * 1024;
const realFetch = globalThis.fetch;
const realConsole = { log: console.log, warn: console.warn, error: console.error };
let remote;
let refuseLarge;

// Fake GitHub: PUT stores each inbox file's decoded size (buffered or streamed body); GET says not found.
beforeEach(() => {
  remote = new Map();
  refuseLarge = false;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (!url.startsWith(CONTENTS)) throw new Error(`unexpected call: ${url}`);
    const rel = decodeURIComponent(url.slice(CONTENTS.length));
    if ((init.method ?? 'GET') !== 'PUT') return new Response('{}', { status: 404 });
    const body = typeof init.body === 'string' ? init.body : await new Response(init.body).text();
    if (refuseLarge && body.length > 9 * MB) return new Response('{}', { status: 422 });
    remote.set(rel, Buffer.from(JSON.parse(body).content, 'base64').length);
    return new Response('{}', { status: 201 });
  };
  for (const name of ['log', 'warn', 'error']) console[name] = () => {};
});

afterEach(() => {
  globalThis.fetch = realFetch;
  Object.assign(console, realConsole);
});

// A stand-in for the running server: its Upload record carries the size from the Worker's metadata.
const fakeServer = () => async (id) => {
  const file = [...remote.keys()].find((k) => k.startsWith(`inbox/${id}.`) && !k.endsWith('.json'));
  return file ? { status: 'failed', failureReason: 'too-large', bytes: remote.get(file) } : null;
};

function fakeStore() {
  const removed = [];
  return {
    removed,
    make: () => ({
      init: async () => true,
      status: () => ({ ready: true, detail: 'up to date' }),
      remove: async (p) => { removed.push(p); },
      flush: async () => ({ committed: removed.length }),
    }),
  };
}

let tick = 0;
const options = (overrides = {}) => ({
  workerUrl: 'https://wake.example.workers.dev',
  env: ENV,
  // a request sent over the network carries its Content-Length; an in-memory Request doesn't
  fetchImpl: (url, init) => worker.fetch(new Request(url, {
    ...init, headers: { ...init.headers, ...(typeof init.body === 'string' ? { 'Content-Length': String(init.body.length) } : {}) },
  }), ENV),
  sleep: async () => {},
  clock: () => (tick += 1000),
  sizes: [4096, 9 * MB + 1],
  ...overrides,
});

test('sizes: about 8, 14 and 20 MB, the largest just under the limit; IDs are device-style and unique', () => {
  assert.equal(SIZES.length, 3);
  assert.ok(SIZES[0] < 8 * MB && SIZES[2] < INBOX_MAX_BYTES && SIZES[2] > 19 * MB);
  const ids = sizeIds(new Date('2026-11-17T18:00:00Z'));
  assert.match(ids[2], /^size-check-20mb-[a-z0-9]+$/);
  assert.ok(uploadIdFor(ids[0]), 'valid client IDs');
  assert.notEqual(ids[0], sizeIds(new Date('2026-11-17T18:00:01Z'))[0]);
  assert.equal(Buffer.from(invented(1001), 'base64').length, 1001);
  assert.match(sendHint(413), /paste the new wake\/worker\.js/);
  assert.match(sendHint(503), /CPU or memory/);
});

test('size check passes end to end through both Worker routes, tidies up, and prints no secrets', async () => {
  const store = fakeStore();
  const lines = [];
  const ok = await runSizeCheck(options({ makeStore: store.make, readRecord: fakeServer(), out: (l) => lines.push(l) }));
  assert.equal(ok, true, lines.join('\n'));
  assert.deepEqual(lines.map((l) => l.replace(/ \(.*\)$/, '')), [
    '1. Codespace settings: OK', '2. 0.0 MB capture to the Worker inbox: OK', '3. 9.0 MB capture to the Worker inbox: OK',
    '4. Server took the captures in: OK', '5. Delete the test captures: OK', 'Result: PASS',
  ]);
  assert.equal(store.removed.length, 8, 'inbox and uploads files for both captures');
  const text = lines.join('\n');
  for (const secret of [ENV.PASS_SIGNING_KEY, ENV.STORAGE_TOKEN, REPO, 'example-learner']) assert.ok(!text.includes(secret), secret);
});

test('size check reports a refused large file and still tidies up', async () => {
  refuseLarge = true;
  const store = fakeStore();
  const lines = [];
  const ok = await runSizeCheck(options({ makeStore: store.make, readRecord: fakeServer(), out: (l) => lines.push(l) }));
  assert.equal(ok, false);
  assert.match(lines[2], /9\.0 MB capture to the Worker inbox: FAIL \(GitHub didn't accept the file\)/);
  assert.match(lines[3], /Server took the captures in: OK/, 'the one that arrived is still checked');
  assert.match(lines.at(-2), /Delete the test captures: OK/);
  assert.equal(lines.at(-1), 'Result: FAIL');
});

test('size check stops at step 1 when the Codespace settings are missing', async () => {
  const lines = [];
  const ok = await runSizeCheck(options({ env: {}, out: (l) => lines.push(l) }));
  assert.equal(ok, false);
  assert.match(lines[0], /^1\. Codespace settings: FAIL/);
});
