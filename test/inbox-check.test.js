// scripts/inbox-check.js against the real Worker code and a fake GitHub contents API. Invented data only.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../wake/worker.js';
import { runCheck, checkIds, captures, LARGE_BYTES } from '../scripts/inbox-check.js';
import { INBOX_MAX_BYTES } from '../server/storage/inbox.js';

const REPO = 'example-owner/example-data';
const ENV = Object.freeze({
  GITHUB_TOKEN: 'test-lifecycle-token-value',
  CODESPACE_NAME: 'example-codespace-abc123',
  ALLOWED_ORIGIN: 'https://example.github.io',
  APP_URL: 'https://example.github.io/edu-support-app/',
  OAUTH_CLIENT_ID: 'test-client-id',
  OAUTH_CLIENT_SECRET: 'test-client-secret-value',
  PASS_SIGNING_KEY: 'test-only-signing-key-0123456789-abcdefghijklmnop',
  PASS_VERSION: '1',
  ALLOWED_ACCOUNTS: JSON.stringify({ 'Example-Parent': 'parent', 'example-learner': 'learner' }),
  STORAGE_TOKEN: 'test-storage-token-value',
  STORAGE_REPO: REPO,
  STORAGE_DIR: '/tmp/inbox-check-test-storage-not-used',
});
const CONTENTS = `https://api.github.com/repos/${REPO}/contents/`;
const realFetch = globalThis.fetch;
const realConsole = { log: console.log, warn: console.warn, error: console.error };
let remote;

// Fake GitHub: PUT stores inbox files; GET lists them.
beforeEach(() => {
  remote = new Map();
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (!url.startsWith(CONTENTS)) throw new Error(`unexpected call: ${url}`);
    const rel = decodeURIComponent(url.slice(CONTENTS.length));
    if ((init.method ?? 'GET') === 'PUT') {
      remote.set(rel, JSON.parse(init.body).content.length);
      return new Response('{}', { status: 201 });
    }
    const items = [...remote.keys()].filter((k) => k.startsWith('inbox/')).map((k) => ({ name: k.slice(6), size: remote.get(k), type: 'file' }));
    return new Response(JSON.stringify(items), { status: 200 });
  };
  for (const name of ['log', 'warn', 'error']) console[name] = () => {};
});

afterEach(() => {
  globalThis.fetch = realFetch;
  Object.assign(console, realConsole);
});

// A stand-in for the running server: takes captures out of the fake inbox and returns their records.
function fakeServer({ largeStatus = 'failed', sizeCheck = 'failed' } = {}) {
  return async (id) => {
    for (const key of [...remote.keys()]) if (key.startsWith(`inbox/${id}.`)) remote.delete(key);
    return id.includes('large')
      ? { status: largeStatus, failureReason: largeStatus === 'failed' ? 'too-large' : null, sizeCheck }
      : { status: 'processing', sizeCheck: 'passed' };
  };
}

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
  fetchImpl: (url, init) => worker.fetch(new Request(url, init), ENV),
  sleep: async () => {},
  clock: () => (tick += 1000),
  largeBytes: 4096,
  ...overrides,
});

test('captures: a small PNG and a just-under-8 MB invented file; IDs are device-style and unique per run', () => {
  assert.ok(LARGE_BYTES < INBOX_MAX_BYTES);
  const files = captures(1000);
  assert.equal(files.small.type, 'image/png');
  assert.equal(files.large.type, 'image/jpeg');
  assert.equal(Buffer.from(files.large.base64, 'base64').length, 1000);
  const ids = checkIds(new Date('2026-11-02T18:00:00Z'));
  assert.match(ids.small, /^inbox-check-small-[a-z0-9]+$/);
  assert.notEqual(ids.small, checkIds(new Date('2026-11-02T18:00:01Z')).small);
});

test('inbox-check passes end to end, tidies up, and prints no secrets, logins or repository name', async () => {
  const store = fakeStore();
  const lines = [];
  const ok = await runCheck(options({ makeStore: store.make, readRecord: fakeServer(), out: (l) => lines.push(l) }));
  assert.equal(ok, true, lines.join('\n'));
  assert.equal(lines.length, 9);
  assert.ok(lines.slice(0, 8).every((l) => /: OK/.test(l)), lines.join('\n'));
  assert.equal(lines.at(-1), 'Result: PASS');
  assert.equal(store.removed.length, 8, 'inbox and uploads files for both captures');
  assert.ok(store.removed.every((p) => /^(inbox|uploads)\//.test(p)));
  const text = lines.join('\n');
  for (const secret of [ENV.PASS_SIGNING_KEY, ENV.STORAGE_TOKEN, REPO, 'example-learner', 'Example-Parent']) {
    assert.ok(!text.includes(secret), `printed: ${secret}`);
  }
});

test('inbox-check reports a Worker stopped by Cloudflare and an unchecked image limit', async () => {
  const lines = [];
  const stoppedLarge = (url, init) => (String(url).includes('large')
    ? Promise.resolve(new Response('error code: 1102', { status: 503 }))
    : worker.fetch(new Request(url, init), ENV));
  const ok = await runCheck(options({ fetchImpl: stoppedLarge, makeStore: fakeStore().make, readRecord: fakeServer(), out: (l) => lines.push(l) }));
  assert.equal(ok, false);
  assert.match(lines.find((l) => l.startsWith('3.')), /FAIL \(Cloudflare stopped the Worker, probably its CPU limit\)/);
  assert.match(lines.find((l) => l.startsWith('7.')), /not tested/);

  const unchecked = [];
  await runCheck(options({ makeStore: fakeStore().make, readRecord: fakeServer({ largeStatus: 'processing', sizeCheck: 'not-checked' }), out: (l) => unchecked.push(l) }));
  assert.match(unchecked.find((l) => l.startsWith('7.')), /couldn't read the model's limits/);
});

test('inbox-check says when the server is not taking captures in', async () => {
  const lines = [];
  const ok = await runCheck(options({ makeStore: fakeStore().make, readRecord: async () => null, waitMs: 5000, out: (l) => lines.push(l) }));
  assert.equal(ok, false);
  assert.match(lines.find((l) => l.startsWith('5.')), /is the server running/);
  assert.match(lines.find((l) => l.startsWith('8.')), /OK/);
});

test('inbox-check stops at step 1 when the Codespace settings are missing', async () => {
  const lines = [];
  const ok = await runCheck(options({ env: { ...ENV, STORAGE_TOKEN: '' }, out: (l) => lines.push(l) }));
  assert.equal(ok, false);
  assert.deepEqual(lines, ['1. Codespace settings: FAIL (STORAGE_REPO or STORAGE_TOKEN is not set)', 'Result: FAIL']);
});
