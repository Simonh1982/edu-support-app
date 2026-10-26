// Worker POST /inbox and GET /inbox against a fake GitHub contents API. Invented settings only.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import worker from '../wake/worker.js';
import { passSettings, mintPass } from '../server/auth.js';
import { extractInboxBlock, INBOX_MAX_BASE64, checkInboxMetadata } from '../server/storage/inbox.js';
import { ukIso } from '../server/storage/records.js';

const ORIGIN = 'https://example.github.io';
const BASE = 'https://wake.example.workers.dev';
const REPO = 'example-owner/example-data';
const ENV = Object.freeze({
  GITHUB_TOKEN: 'test-lifecycle-token-value',
  CODESPACE_NAME: 'example-codespace-abc123',
  ALLOWED_ORIGIN: ORIGIN,
  APP_URL: 'https://example.github.io/edu-support-app/',
  OAUTH_CLIENT_ID: 'test-client-id',
  OAUTH_CLIENT_SECRET: 'test-client-secret-value',
  PASS_SIGNING_KEY: 'test-only-signing-key-0123456789-abcdefghijklmnop',
  PASS_VERSION: '1',
  ALLOWED_ACCOUNTS: JSON.stringify({ 'Example-Parent': 'parent', 'example-learner': 'learner' }),
  STORAGE_TOKEN: 'test-storage-token-value',
  STORAGE_REPO: REPO,
});
const CONTENTS = `https://api.github.com/repos/${REPO}/contents`;
const FIXED_NOW = Date.parse('2026-07-01T09:30:00Z'); // summer time, so UK time is +01:00

const realFetch = globalThis.fetch;
const realNow = Date.now;
const realConsole = { log: console.log, warn: console.warn, error: console.error };
let calls;
let routes;
let logs;

function reply(status, body) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  calls = [];
  routes = {};
  logs = [];
  Date.now = () => FIXED_NOW;
  globalThis.fetch = async (input, init = {}) => {
    const key = `${init.method ?? 'GET'} ${String(input)}`;
    calls.push({ key, init });
    const route = routes[key];
    if (!route) throw new Error(`unexpected GitHub call: ${key}`);
    return route(init, calls.filter((c) => c.key === key).length);
  };
  for (const name of ['log', 'warn', 'error']) console[name] = (...args) => logs.push(args.join(' '));
});

afterEach(() => {
  globalThis.fetch = realFetch;
  Date.now = realNow;
  Object.assign(console, realConsole);
});

async function passFor(login) {
  return mintPass({ login, settings: passSettings(ENV).settings, now: FIXED_NOW });
}

async function post(query, body, { login = 'example-learner', env = ENV, headers = {} } = {}) {
  const auth = login ? { Authorization: `Bearer ${await passFor(login)}` } : {};
  return worker.fetch(new Request(`${BASE}/inbox?${new URLSearchParams(query)}`, {
    method: 'POST', headers: { 'Content-Type': 'text/plain', Origin: ORIGIN, ...auth, ...headers }, body,
  }), env);
}

const QUERY = { clientId: 'cap-test0001', type: 'image/jpeg', source: 'camera', kind: 'brief', capturedAt: '2026-07-01T10:29:00+01:00' };
const PHOTO = Buffer.from('an invented photo, not a real one').toString('base64');

function acceptPuts() {
  routes[`PUT ${CONTENTS}/inbox/cap-test0001.jpg`] = () => reply(201, { content: { path: 'inbox/cap-test0001.jpg' } });
  routes[`PUT ${CONTENTS}/inbox/cap-test0001.json`] = () => reply(201, { content: { path: 'inbox/cap-test0001.json' } });
}

test('worker carries an identical copy of the inbox block', async () => {
  const workerSource = await readFile(new URL('../wake/worker.js', import.meta.url), 'utf8');
  const inboxSource = await readFile(new URL('../server/storage/inbox.js', import.meta.url), 'utf8');
  const block = extractInboxBlock(workerSource);
  assert.ok(block, 'one start and one end marker in wake/worker.js');
  assert.equal(block, extractInboxBlock(inboxSource), 'inbox blocks differ: change both copies together');
});

test('POST /inbox writes the file first, then metadata the server accepts, and never echoes content', async () => {
  acceptPuts();
  const response = await post(QUERY, PHOTO);
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { clientId: 'cap-test0001', uploadId: 'up_cap-test0001', bytes: 33, status: 'received' });
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.deepEqual(calls.map((c) => c.key), [`PUT ${CONTENTS}/inbox/cap-test0001.jpg`, `PUT ${CONTENTS}/inbox/cap-test0001.json`]);
  const fileBody = JSON.parse(calls[0].init.body);
  assert.equal(fileBody.content, PHOTO);
  assert.equal(fileBody.message, 'inbox: add capture');
  assert.equal(fileBody.sha, undefined);
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${ENV.STORAGE_TOKEN}`);
  assert.ok(calls[0].init.headers['User-Agent']);
  const meta = JSON.parse(Buffer.from(JSON.parse(calls[1].init.body).content, 'base64').toString('utf8'));
  assert.equal(meta.receivedAt, ukIso(new Date(FIXED_NOW)), 'same UK-time format as the server');
  assert.equal(meta.receivedAt, '2026-07-01T10:30:00+01:00');
  assert.equal(meta.capturedAt, QUERY.capturedAt);
  assert.equal(meta.kind, 'brief');
  assert.equal(meta.uploaderRole, 'learner');
  assert.ok(checkInboxMetadata(meta, 'cap-test0001').meta, 'the server accepts what the Worker writes');
  assert.doesNotMatch(JSON.stringify(meta), new RegExp(PHOTO));
  const text = logs.join('\n');
  assert.doesNotMatch(text, new RegExp(`${REPO}|${ENV.STORAGE_TOKEN}|example-learner|cap-test0001`));
});

test('POST /inbox: only the learner, only with a pass, only allowed IDs, types and base64', async () => {
  const parent = await post(QUERY, PHOTO, { login: 'Example-Parent' });
  assert.equal(parent.status, 403);
  assert.equal((await post(QUERY, PHOTO, { login: null })).status, 401);
  for (const bad of [{ clientId: 'short' }, { clientId: '../../x/escape' }, { type: 'text/html' }, { source: 'scanner' }, { kind: 'essay' }]) {
    assert.equal((await post({ ...QUERY, ...bad }, PHOTO)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await post(QUERY, 'not base64!')).status, 400);
  assert.equal((await post(QUERY, 'QUJ')).status, 400);
  const injected = await post(QUERY, `QUJD","sha":"x${'A'.repeat(2048)}`);
  assert.equal(injected.status, 400);
  assert.equal(calls.length, 0, 'GitHub is never called for a refused capture');
});

test('POST /inbox refuses anything over 8 MB before reading it', async () => {
  const tooBig = await post(QUERY, 'AAAA', { headers: { 'Content-Length': String(INBOX_MAX_BASE64 + 4) } });
  assert.equal(tooBig.status, 413);
  assert.equal(calls.length, 0);
});

test('POST /inbox accepts a full 8 MB file in one request', async () => {
  acceptPuts();
  const eight = Buffer.alloc(8 * 1024 * 1024, 65).toString('base64');
  assert.ok(eight.length <= INBOX_MAX_BASE64);
  const response = await post(QUERY, eight);
  assert.equal(response.status, 201);
  assert.equal((await response.json()).bytes, 8 * 1024 * 1024);
});

test('POST /inbox: a retry overwrites the same file using its sha; a moved branch is tried once more', async () => {
  routes[`PUT ${CONTENTS}/inbox/cap-test0001.jpg`] = (init, n) => (n === 1 ? reply(422, { message: '"sha" wasn\'t supplied.' }) : reply(200, {}));
  routes[`GET ${CONTENTS}/inbox/cap-test0001.jpg`] = () => reply(200, { sha: 'abc123', content: '', encoding: 'none' });
  routes[`PUT ${CONTENTS}/inbox/cap-test0001.json`] = (init, n) => (n === 1 ? reply(409, { message: 'conflict' }) : reply(201, {}));
  const response = await post(QUERY, PHOTO);
  assert.equal(response.status, 201);
  const filePuts = calls.filter((c) => c.key === `PUT ${CONTENTS}/inbox/cap-test0001.jpg`);
  assert.equal(JSON.parse(filePuts[1].init.body).sha, 'abc123');
  assert.equal(calls.filter((c) => c.key === `PUT ${CONTENTS}/inbox/cap-test0001.json`).length, 2);
});

test('POST /inbox: GitHub refusals become 502 without secrets or the repository name in logs', async () => {
  routes[`PUT ${CONTENTS}/inbox/cap-test0001.jpg`] = () => reply(403, { message: 'Resource not accessible' });
  const response = await post(QUERY, PHOTO);
  assert.equal(response.status, 502);
  assert.equal((await response.json()).githubStatus, 403);
  assert.equal(calls.length, 1, 'no metadata without its file');
  routes[`PUT ${CONTENTS}/inbox/cap-test0001.jpg`] = () => { throw new TypeError('network'); };
  assert.equal((await post(QUERY, PHOTO)).status, 502);
  assert.doesNotMatch(logs.join('\n'), new RegExp(`${REPO}|${ENV.STORAGE_TOKEN}`));
});

test('GET /inbox lists complete captures from the folder listing, for either role', async () => {
  routes[`GET ${CONTENTS}/inbox`] = () => reply(200, [
    { name: 'cap-done0001.jpg', size: 1234, type: 'file' },
    { name: 'cap-done0001.json', size: 200, type: 'file' },
    { name: 'cap-half0001.png', size: 99, type: 'file' },
    { name: '.gitkeep', size: 0, type: 'file' },
  ]);
  for (const login of ['example-learner', 'Example-Parent']) {
    const response = await worker.fetch(new Request(`${BASE}/inbox`, { headers: { Authorization: `Bearer ${await passFor(login)}` } }), ENV);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { items: [{ clientId: 'cap-done0001', uploadId: 'up_cap-done0001', bytes: 1234 }], count: 1 });
  }
  routes[`GET ${CONTENTS}/inbox`] = () => reply(404, { message: 'Not Found' });
  const empty = await worker.fetch(new Request(`${BASE}/inbox`, { headers: { Authorization: `Bearer ${await passFor('example-learner')}` } }), ENV);
  assert.deepEqual(await empty.json(), { items: [], count: 0 });
});

test('/inbox: wrong method, missing storage settings and other origins', async () => {
  const headers = { Authorization: `Bearer ${await passFor('example-learner')}` };
  assert.equal((await worker.fetch(new Request(`${BASE}/inbox`, { method: 'DELETE', headers }), ENV)).status, 405);
  assert.equal((await worker.fetch(new Request(`${BASE}/inbox`, { headers }), { ...ENV, STORAGE_TOKEN: '' })).status, 503);
  assert.equal((await worker.fetch(new Request(`${BASE}/inbox`, { headers: { ...headers, Origin: 'https://evil.example' } }), ENV)).status, 403);
  const pre = await worker.fetch(new Request(`${BASE}/inbox`, { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' } }), ENV);
  assert.equal(pre.status, 204);
  assert.equal(calls.length, 0);
});
