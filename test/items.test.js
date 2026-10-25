// Items and snapshot through the server and the Worker: who can open what (blueprint §5.2, §6.3).
// Invented settings, accounts and records only.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import worker from '../wake/worker.js';
import { passSettings, mintPass } from '../server/auth.js';
import { loadConfig } from '../server/config.js';
import { createServer } from '../server/index.js';
import {
  extractItemBlock, itemPath, itemTypeAllowed, snapshotSection, itemResponse, SNAPSHOT_PATH,
} from '../server/storage/items.js';
import { runCheck, TEST_IDS } from '../scripts/item-check.js';

const KEY = 'test-only-signing-key-0123456789-abcdefghijklmnop';
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
  PASS_SIGNING_KEY: KEY,
  PASS_VERSION: '1',
  ALLOWED_ACCOUNTS: JSON.stringify({ 'Example-Parent': 'parent', 'example-learner': 'learner' }),
  STORAGE_TOKEN: 'test-storage-token-value',
  STORAGE_REPO: REPO,
});
const SECRETS = [KEY, ENV.GITHUB_TOKEN, ENV.OAUTH_CLIENT_SECRET, ENV.STORAGE_TOKEN];
const SETTINGS = passSettings(ENV).settings;
const silent = { error() {}, log() {} };
const realFetch = globalThis.fetch;

const SNAPSHOT = {
  generatedAt: '2026-11-02T18:04:11+00:00',
  learner: { appName: 'Example App', upcoming: [], recent: [], settings: {}, inboxPending: 0 },
  parent: { appName: 'Example App', upcoming: [], shared: [] },
};
const RECORDS = {
  'notebook/n-shared.json': { id: 'n-shared', title: 'Shared note', text: { value: 'Invented shared text', author: 'learner' }, sharedWithParent: '2026-11-01' },
  'notebook/n-private.json': { id: 'n-private', title: 'Private note', text: { value: 'Invented private text', author: 'learner' }, sharedWithParent: null },
  'tasks/t-1/plan.json': { id: 'p-1', sections: [], sharedWithParent: '2026-11-01' },
  'tasks/t-1/drafts/v1.json': { id: 'd-1', text: { value: 'Invented draft', author: 'learner' } },
  'tasks/t-1/feedback/f-1.json': { id: 'f-1', text: { value: 'Invented feedback', author: 'ai' }, sharedWithParent: '2026-11-01' },
  'tasks/t-1/task.json': { id: 't-1', title: 'Invented task', sharedWithParent: '2026-11-01' },
  [SNAPSHOT_PATH]: SNAPSHOT,
};

function pass(role) {
  return mintPass({ login: role === 'parent' ? 'Example-Parent' : 'example-learner', settings: SETTINGS });
}

// ---- The shared item rules ----

test('the Worker carries an identical copy of the item block', async () => {
  const workerSource = await readFile(new URL('../wake/worker.js', import.meta.url), 'utf8');
  const itemsSource = await readFile(new URL('../server/storage/items.js', import.meta.url), 'utf8');
  const block = extractItemBlock(workerSource);
  assert.ok(block, 'one start and one end marker in wake/worker.js');
  assert.equal(block, extractItemBlock(itemsSource), 'item blocks differ: change both copies together');
  assert.doesNotMatch(block, /^\s*(import|export)\s/m);
});

test('itemPath maps each type to its file and refuses anything that could leave its folder', () => {
  assert.deepEqual(itemPath('notebook', 'n-1', null), { path: 'notebook/n-1.json', error: null });
  assert.equal(itemPath('source', 's_1', null).path, 'sources/s_1.json');
  assert.equal(itemPath('task', 't-1', null).path, 'tasks/t-1/task.json');
  assert.equal(itemPath('plan', 'plan', 't-1').path, 'tasks/t-1/plan.json');
  assert.equal(itemPath('draft', 'v2', 't-1').path, 'tasks/t-1/drafts/v2.json');
  assert.equal(itemPath('feedback', 'f-1', 't-1').path, 'tasks/t-1/feedback/f-1.json');
  for (const [type, id, task] of [
    ['notebook', '../secret', null], ['notebook', 'a/b', null], ['notebook', '.git', null], ['notebook', '', null],
    ['notebook', 'x'.repeat(101), null], ['notebook', 'n-1', 't-1'], ['draft', 'v1', null], ['draft', 'v1', '../t'],
    ['events', 'n-1', null], ['__proto__', 'n-1', null], [null, 'n-1', null], ['notebook', null, null],
  ]) {
    const result = itemPath(type, id, task);
    assert.equal(result.path, null, `${type} ${id} ${task}`);
    assert.ok(result.error);
  }
});

test('itemTypeAllowed and snapshotSection give each role only its own share', () => {
  for (const type of ['notebook', 'plan', 'draft', 'feedback', 'task', 'source']) assert.equal(itemTypeAllowed('learner', type), true);
  assert.deepEqual(['notebook', 'plan', 'draft', 'feedback', 'task', 'source'].filter((t) => itemTypeAllowed('parent', t)), ['notebook', 'plan', 'draft']);
  assert.equal(itemTypeAllowed('someone', 'notebook'), false);
  assert.deepEqual(snapshotSection(SNAPSHOT, 'parent'), { generatedAt: SNAPSHOT.generatedAt, ...SNAPSHOT.parent });
  assert.ok(!('recent' in snapshotSection(SNAPSHOT, 'parent')));
  assert.ok(!('shared' in snapshotSection(SNAPSHOT, 'learner')));
  assert.equal(snapshotSection(SNAPSHOT, 'admin'), null);
  assert.equal(snapshotSection({ learner: [] }, 'learner'), null);
  assert.equal(snapshotSection(null, 'learner'), null);
});

// ---- Server: GET /api/item ----

function fakeStore(records = RECORDS, ready = true) {
  const reads = [];
  return {
    reads,
    status: () => ({ ready }),
    read: async (relPath) => { reads.push(relPath); return records[relPath] ?? null; },
  };
}

async function withServer(options, fn) {
  const config = loadConfig({ PORT: '0', HOST: '127.0.0.1' });
  const { server } = createServer(config, undefined, silent, options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function serverGet(base, route, role) {
  const headers = role ? { Authorization: `Bearer ${await pass(role)}` } : {};
  const response = await realFetch(`${base}${route}`, { headers });
  return { status: response.status, body: await response.json() };
}

test('server /api/item: the learner opens everything; the parent only shared notes, plans and drafts', async () => {
  const store = fakeStore();
  await withServer({ authSettings: SETTINGS, getStore: () => store }, async (base) => {
    const cases = [
      ['learner', '/api/item?type=notebook&id=n-private', 200],
      ['learner', '/api/item?type=feedback&id=f-1&task=t-1', 200],
      ['learner', '/api/item?type=draft&id=v1&task=t-1', 200],
      ['parent', '/api/item?type=notebook&id=n-shared', 200],
      ['parent', '/api/item?type=plan&id=plan&task=t-1', 200],
      ['parent', '/api/item?type=notebook&id=n-private', 404],
      ['parent', '/api/item?type=draft&id=v1&task=t-1', 404],
      ['parent', '/api/item?type=feedback&id=f-1&task=t-1', 404],
      ['parent', '/api/item?type=task&id=t-1', 404],
      ['learner', '/api/item?type=notebook&id=missing', 404],
      ['learner', '/api/item?type=notebook&id=../x', 400],
    ];
    for (const [role, route, status] of cases) {
      const result = await serverGet(base, route, role);
      assert.equal(result.status, status, `${role} ${route}`);
      if (status === 404) assert.deepEqual(result.body, { error: 'Not found.' }, 'unshared looks the same as missing');
    }
    const ok = await serverGet(base, '/api/item?type=notebook&id=n-shared', 'parent');
    assert.deepEqual(ok.body, { type: 'notebook', item: RECORDS['notebook/n-shared.json'] });
    // the parent's feedback and task requests never reach storage
    assert.equal(store.reads.filter((p) => p.includes('feedback')).length, 1, 'only the learner read feedback');
    assert.ok(!store.reads.includes('tasks/t-1/task.json'));
  });
});

test('server /api/item: pass first, then storage; wrong method refused', async () => {
  await withServer({ authSettings: SETTINGS, getStore: () => null }, async (base) => {
    const none = await serverGet(base, '/api/item?type=notebook&id=n-1');
    assert.equal(none.status, 401);
    assert.deepEqual(none.body, { error: 'Please sign in again.', reason: 'missing' });
    assert.equal((await serverGet(base, '/api/item?type=notebook&id=n-1', 'learner')).status, 503);
    const post = await realFetch(`${base}/api/item?type=notebook&id=n-1`, { method: 'POST' });
    assert.equal(post.status, 405);
  });
  await withServer({ authSettings: SETTINGS, getStore: () => fakeStore(RECORDS, false) }, async (base) => {
    assert.equal((await serverGet(base, '/api/item?type=notebook&id=n-1', 'learner')).status, 503);
  });
  await withServer({ authSettings: null, getStore: () => fakeStore() }, async (base) => {
    assert.equal((await serverGet(base, '/api/item?type=notebook&id=n-1', 'learner')).status, 503);
  });
  const other = passSettings({ ...ENV, PASS_VERSION: '2' }).settings;
  await withServer({ authSettings: other, getStore: () => fakeStore() }, async (base) => {
    const old = await serverGet(base, '/api/item?type=notebook&id=n-shared', 'parent');
    assert.equal(old.status, 401);
    assert.equal(old.body.reason, 'version');
  });
});

test('itemResponse never reads storage for a type the parent can never open', async () => {
  const store = fakeStore();
  const parentPass = { role: 'parent' };
  const result = await itemResponse({ store, pass: parentPass, query: new URLSearchParams('type=feedback&id=f-1&task=t-1') });
  assert.equal(result.status, 404);
  assert.deepEqual(store.reads, []);
});

// ---- Worker: GET /snapshot and GET /item against a fake GitHub contents API ----

const realConsole = { log: console.log, warn: console.warn, error: console.error };
let calls;
let logs;
let files;
let refuse;

function contentsUrl(relPath) {
  return `https://api.github.com/repos/${REPO}/contents/${relPath}`;
}

function fakeGitHub(input, init = {}) {
  const url = String(input);
  calls.push({ url, init });
  if (refuse) return new Response(JSON.stringify({ message: 'Resource not accessible' }), { status: refuse, headers: { 'x-accepted-github-permissions': 'contents=read' } });
  const prefix = `https://api.github.com/repos/${REPO}/contents/`;
  if (!url.startsWith(prefix)) throw new Error(`unexpected GitHub call: ${url}`);
  const relPath = url.slice(prefix.length);
  if (!(relPath in files)) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
  const value = files[relPath];
  return new Response(typeof value === 'string' ? value : JSON.stringify(value), { status: 200 });
}

beforeEach(() => {
  calls = [];
  logs = [];
  files = { ...RECORDS };
  refuse = 0;
  globalThis.fetch = async (input, init) => fakeGitHub(input, init);
  for (const name of ['log', 'warn', 'error']) console[name] = (...args) => logs.push(args.join(' '));
});

afterEach(() => {
  globalThis.fetch = realFetch;
  Object.assign(console, realConsole);
});

async function workerGet(route, role, env = ENV, headers = {}) {
  const auth = role ? { Authorization: `Bearer ${await pass(role)}` } : {};
  const response = await worker.fetch(new Request(`${BASE}${route}`, { headers: { ...auth, ...headers } }), env);
  return { status: response.status, body: await response.json(), headers: response.headers };
}

test('Worker /snapshot returns only the caller\'s section, read with the storage token', async () => {
  const learner = await workerGet('/snapshot', 'learner');
  assert.equal(learner.status, 200);
  assert.deepEqual(learner.body, { generatedAt: SNAPSHOT.generatedAt, ...SNAPSHOT.learner });
  const parent = await workerGet('/snapshot', 'parent');
  assert.deepEqual(parent.body, { generatedAt: SNAPSHOT.generatedAt, ...SNAPSHOT.parent });
  assert.equal(calls[0].url, contentsUrl(SNAPSHOT_PATH));
  const headers = calls[0].init.headers;
  assert.equal(headers.Authorization, `Bearer ${ENV.STORAGE_TOKEN}`);
  assert.equal(headers.Accept, 'application/vnd.github.raw');
  assert.equal(headers['X-GitHub-Api-Version'], '2022-11-28');
  assert.ok(headers['User-Agent']);
  assert.equal(learner.headers.get('Cache-Control'), 'no-store');
});

test('Worker /item: the learner opens everything; the parent only shared notes, plans and drafts', async () => {
  const cases = [
    ['learner', '/item?type=notebook&id=n-private', 200],
    ['learner', '/item?type=feedback&id=f-1&task=t-1', 200],
    ['parent', '/item?type=notebook&id=n-shared', 200],
    ['parent', '/item?type=plan&id=plan&task=t-1', 200],
    ['parent', '/item?type=notebook&id=n-private', 404],
    ['parent', '/item?type=draft&id=v1&task=t-1', 404],
    ['learner', '/item?type=notebook&id=missing', 404],
    ['learner', '/item?type=notebook&id=..%2Fsecret', 400],
    ['learner', '/item?type=draft&id=v1', 400],
  ];
  for (const [role, route, status] of cases) {
    const result = await workerGet(route, role);
    assert.equal(result.status, status, `${role} ${route}`);
    if (status === 404) assert.deepEqual(result.body, { error: 'That item was not found.' }, 'unshared looks the same as missing');
  }
  const ok = await workerGet('/item?type=notebook&id=n-shared', 'parent');
  assert.deepEqual(ok.body, { type: 'notebook', item: RECORDS['notebook/n-shared.json'] });
  calls = [];
  for (const route of ['/item?type=feedback&id=f-1&task=t-1', '/item?type=task&id=t-1', '/item?type=source&id=s-1']) {
    assert.equal((await workerGet(route, 'parent')).status, 404, route);
  }
  assert.equal(calls.length, 0, "the parent's requests for other types never reach GitHub");
});

test('Worker /snapshot and /item need a pass, GET, and the storage settings', async () => {
  const none = await workerGet('/snapshot');
  assert.equal(none.status, 401);
  assert.equal((await workerGet('/item?type=notebook&id=n-1')).status, 401);
  const post = await worker.fetch(new Request(`${BASE}/item?type=notebook&id=n-1`, { method: 'POST' }), ENV);
  assert.equal(post.status, 405);
  assert.equal((await workerGet('/snapshot', 'learner', { ...ENV, STORAGE_TOKEN: '' })).status, 503);
  assert.equal((await workerGet('/item?type=notebook&id=n-1', 'learner', { ...ENV, STORAGE_REPO: 'not a repo' })).status, 503);
  const removed = { ...ENV, ALLOWED_ACCOUNTS: JSON.stringify({ 'example-learner': 'learner' }) };
  const gone = await workerGet('/snapshot', 'parent', removed);
  assert.equal(gone.status, 401);
  assert.equal(gone.body.reason, 'account');
  assert.equal(calls.length, 0);
  const missing = await (await worker.fetch(new Request(`${BASE}/`), { ...ENV, STORAGE_TOKEN: '' })).json();
  assert.deepEqual(missing.missing, ['STORAGE_TOKEN']);
});

test('Worker storage problems: no snapshot yet, refusals with the permission hint, bad files', async () => {
  delete files[SNAPSHOT_PATH];
  const noSnap = await workerGet('/snapshot', 'learner');
  assert.equal(noSnap.status, 404);
  assert.match(noSnap.body.error, /no snapshot yet/);
  files[SNAPSHOT_PATH] = '{not json';
  assert.equal((await workerGet('/snapshot', 'learner')).status, 502);
  files[SNAPSHOT_PATH] = { generatedAt: 'x', learner: [] };
  assert.equal((await workerGet('/snapshot', 'learner')).status, 502);
  refuse = 403;
  const refused = await workerGet('/item?type=notebook&id=n-shared', 'learner');
  assert.equal(refused.status, 502);
  assert.deepEqual(refused.body, { error: 'GitHub refused the item request (403).', githubStatus: 403, acceptedPermissions: 'contents=read' });
  refuse = 503;
  assert.equal((await workerGet('/snapshot', 'learner')).status, 502);
  refuse = 0;
  globalThis.fetch = async () => { throw new TypeError('network'); };
  assert.equal((await workerGet('/snapshot', 'learner')).status, 502);
  const text = logs.join('\n');
  for (const secret of SECRETS) assert.ok(!text.includes(secret), 'a secret leaked');
  assert.ok(!text.includes(REPO), 'the storage repository name leaked');
});

test('Worker CORS still applies to the new routes', async () => {
  const allowed = await workerGet('/snapshot', 'learner', ENV, { Origin: ORIGIN });
  assert.equal(allowed.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  const other = await workerGet('/snapshot', 'learner', ENV, { Origin: 'https://evil.example' });
  assert.equal(other.status, 403);
});

// ---- scripts/item-check.js with a fake store and the real Worker ----

function fakeCheckStore() {
  return () => ({
    status: () => ({ ready: true, detail: 'up to date' }),
    init: async () => true,
    put: async (relPath, record) => { files[relPath] = record; },
    remove: async (relPath) => { delete files[relPath]; },
    flush: async () => ({ committed: 1, pulled: 0, pushed: true }),
  });
}

const CHECK_ENV = { ...ENV, STORAGE_DIR: '/tmp/item-check-test-storage' };

test('item-check passes against the Worker, then deletes its test notes', async () => {
  const lines = [];
  const ok = await runCheck({
    workerUrl: BASE, env: CHECK_ENV, makeStore: fakeCheckStore(), out: (l) => lines.push(l), sleep: async () => {},
    fetchImpl: (url, init) => worker.fetch(new Request(url, init), ENV),
  });
  assert.equal(ok, true, lines.join('\n'));
  assert.equal(lines.length, 8);
  assert.ok(lines.slice(0, 7).every((l) => /: OK/.test(l)), lines.join('\n'));
  assert.equal(lines[7], 'Result: PASS');
  assert.ok(!(`notebook/${TEST_IDS.shared}.json` in files) && !(`notebook/${TEST_IDS.unshared}.json` in files));
  const text = lines.join('\n');
  for (const secret of SECRETS) assert.ok(!text.includes(secret));
  assert.doesNotMatch(text, /example-learner|Example-Parent|example-owner/i);
});

test('item-check fails if the parent could open the unshared note, and still tidies up', async () => {
  const lines = [];
  // a broken Worker that treats the parent like the learner
  const leaky = (url, init) => {
    const headers = new Headers(init?.headers);
    return worker.fetch(new Request(url, { ...init, headers }), ENV).then(async (response) => {
      if (String(url).includes(TEST_IDS.unshared) && response.status === 404) {
        return new Response(JSON.stringify({ type: 'notebook', item: {} }), { status: 200 });
      }
      return response;
    });
  };
  const ok = await runCheck({
    workerUrl: BASE, env: CHECK_ENV, makeStore: fakeCheckStore(), out: (l) => lines.push(l), sleep: async () => {}, fetchImpl: leaky,
  });
  assert.equal(ok, false);
  assert.match(lines.join('\n'), /6\. Parent can't open the unshared note: FAIL/);
  assert.match(lines.join('\n'), /7\. Delete the test notes: OK/);
  assert.equal(lines.at(-1), 'Result: FAIL');
});

test('item-check names missing Codespace settings without printing values', async () => {
  const lines = [];
  const ok = await runCheck({ workerUrl: BASE, env: { ...CHECK_ENV, STORAGE_TOKEN: '' }, out: (l) => lines.push(l) });
  assert.equal(ok, false);
  assert.match(lines[0], /^1\. Codespace settings: FAIL \(STORAGE_REPO or STORAGE_TOKEN is not set\)$/);
  const noLearner = [];
  await runCheck({ workerUrl: BASE, env: { ...CHECK_ENV, ALLOWED_ACCOUNTS: JSON.stringify({ 'Example-Parent': 'parent' }) }, out: (l) => noLearner.push(l) });
  assert.match(noLearner[0], /no learner account/);
  assert.doesNotMatch(noLearner.join('\n'), /Example-Parent/);
});
