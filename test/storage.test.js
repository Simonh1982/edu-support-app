// Storage module (server/storage/) and the storage check. Logic tests use a fake git; the
// "real git" tests use a temporary bare repository and are skipped only where git is missing.
// All data here is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, mkdir, readFile, writeFile, appendFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ukIso, ukMonth, newId, newRecord, updateRecord, makeEvent, eventsPath, SCHEMA_VERSION,
} from '../server/storage/records.js';
import { gitEnv, cleanGitText, createLock, IDENTITY } from '../server/storage/git.js';
import { createStore, checkPath } from '../server/storage/store.js';
import { storageSettings, startStorage, APP_ROOT } from '../server/storage/index.js';
import { runCheck, parseArgs, INBOX_TEST_FILE } from '../scripts/storage-check.js';

const silent = { log() {}, error() {} };
const FAKE_TOKEN = `github_pat_${'x'.repeat(40)}`;

async function tmp(name) {
  return mkdtemp(path.join(os.tmpdir(), `${name}-`));
}

// ---------- a fake git that behaves like a clone with one remote ----------
async function filesIn(dir, base = dir, out = new Map()) {
  for (const name of await readdir(dir)) {
    if (name === '.git') continue;
    const full = path.join(dir, name);
    if ((await stat(full)).isDirectory()) await filesIn(full, base, out);
    else out.set(path.relative(base, full), await readFile(full, 'utf8'));
  }
  return out;
}

function fakeGit({ pullFails = 0, pushFails = 0, pulledCount = 0, ahead = 0 } = {}) {
  const calls = [];
  const fake = { calls, ahead, committed: new Map(), staged: [], messages: [], pullFails, pushFails, pulledCount };
  fake.run = async (args, { cwd, env }) => {
    calls.push({ args: [...args], env });
    const [cmd] = args;
    const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
    if (cmd === 'clone') { await mkdir(path.join(args[args.length - 1], '.git'), { recursive: true }); return ok(); }
    if (cmd === 'rev-parse') return ok('abc123\n');
    if (cmd === 'pull') {
      if (fake.pullFails > 0) { fake.pullFails -= 1; return { code: 1, stdout: '', stderr: 'fatal: could not read from remote' }; }
      return ok();
    }
    if (cmd === 'rebase') return ok();
    if (cmd === 'rev-list') return ok(`${args[2].endsWith('..HEAD') ? fake.ahead : fake.pulledCount}\n`);
    if (cmd === 'push') {
      if (fake.pushFails > 0) {
        fake.pushFails -= 1;
        return { code: 1, stdout: '', stderr: `remote: denied for basic ${Buffer.from(`x:${FAKE_TOKEN}`).toString('base64')}` };
      }
      fake.ahead = 0;
      return ok();
    }
    if (cmd === 'add') {
      const now = await filesIn(cwd);
      fake.staged = [...now].filter(([f, text]) => fake.committed.get(f) !== text).map(([f]) => f);
      fake.snapshot = now;
      return ok();
    }
    if (cmd === 'diff') return ok(fake.staged.map((f) => `${f}\n`).join(''));
    if (cmd === 'commit') {
      fake.messages.push(args[args.indexOf('-m') + 1]);
      fake.committed = new Map(fake.snapshot);
      fake.staged = [];
      fake.ahead += 1;
      return ok();
    }
    return { code: 1, stdout: '', stderr: `fake git: unexpected ${cmd}` };
  };
  fake.commands = () => calls.map((c) => c.args[0]);
  return fake;
}

async function fakeStore(options = {}, storeOptions = {}) {
  const base = await tmp('store');
  const fake = fakeGit(options);
  const statuses = [];
  const store = createStore({
    dir: path.join(base, 'clone'), remoteUrl: 'https://github.com/example-owner/example-data.git', env: { PATH: '/bin' },
    runGit: fake.run, log: silent, batchMs: 60_000, retryDelays: [60_000], sleep: async () => {},
    onStatus: (s) => statuses.push(s), ...storeOptions,
  });
  return { base, fake, store, statuses, cleanup: () => rm(base, { recursive: true, force: true }) };
}

// ---------- records ----------
test('ukIso uses UK time with the right offset in summer and winter', () => {
  assert.equal(ukIso(new Date('2026-07-01T12:00:00Z')), '2026-07-01T13:00:00+01:00');
  assert.equal(ukIso(new Date('2026-12-01T12:00:00Z')), '2026-12-01T12:00:00+00:00');
  assert.equal(ukIso(new Date('2026-10-25T00:59:59Z')), '2026-10-25T01:59:59+01:00');
  assert.equal(ukIso(new Date('2026-10-25T01:00:00Z')), '2026-10-25T01:00:00+00:00');
});

test('ukMonth and eventsPath file events by the UK month, not the UTC month', () => {
  const lateJuneUtc = new Date('2026-06-30T23:30:00Z'); // 00:30 on 1 July in BST
  assert.equal(ukMonth(lateJuneUtc), '2026-07');
  assert.equal(eventsPath(lateJuneUtc), 'events/2026-07.jsonl');
});

test('newRecord adds the standard fields; updateRecord keeps id and createdAt', () => {
  const t1 = new Date('2026-11-02T18:00:00Z');
  const rec = newRecord('t', { title: 'Invented task' }, { createdBy: 'learner', now: t1 });
  assert.match(rec.id, /^t_[a-z0-9]+_[0-9a-f]{8}$/);
  assert.equal(rec.createdAt, '2026-11-02T18:00:00+00:00');
  assert.equal(rec.updatedAt, rec.createdAt);
  assert.equal(rec.createdBy, 'learner');
  assert.equal(rec.schemaVersion, SCHEMA_VERSION);
  const later = updateRecord(rec, { title: 'Renamed', id: 'hacked', createdAt: 'x' }, { now: new Date('2026-11-03T09:00:00Z') });
  assert.equal(later.id, rec.id);
  assert.equal(later.createdAt, rec.createdAt);
  assert.equal(later.title, 'Renamed');
  assert.equal(later.updatedAt, '2026-11-03T09:00:00+00:00');
  assert.throws(() => newRecord('t', {}, { createdBy: 'someone' }), /createdBy/);
  assert.throws(() => newId('Bad-Prefix'), /prefix/);
});

test('makeEvent: small facts only, never text content', () => {
  const ev = makeEvent('task.created', { links: { taskId: 't_1' }, payload: { stage: 'planning' }, createdBy: 'learner' });
  for (const key of ['id', 'type', 'time', 'links', 'payload', 'createdAt', 'updatedAt', 'createdBy', 'schemaVersion']) {
    assert.ok(key in ev, key);
  }
  assert.throws(() => makeEvent('Bad Type'), /bad event type/);
  assert.throws(() => makeEvent('note.saved', { payload: { text: 'a'.repeat(201) } }), /too long/);
  assert.throws(() => makeEvent('x.y', { payload: { list: Array.from({ length: 60 }, (_, i) => `item-${i}-padding`) } }), /over 1024 bytes/);
});

// ---------- git helpers ----------
test('gitEnv: the token only travels as an auth header in the environment; Codespace git settings ignored', () => {
  const env = gitEnv({ token: FAKE_TOKEN, env: { PATH: '/bin', HOME: '/h', GITHUB_TOKEN: 'codespace-own', GIT_TRACE: '1' } });
  assert.equal(env.GIT_CONFIG_COUNT, '1');
  assert.equal(env.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraheader');
  assert.equal(env.GIT_CONFIG_VALUE_0, `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${FAKE_TOKEN}`).toString('base64')}`);
  assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null');
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.GIT_TRACE, undefined);
  assert.equal(env.GIT_AUTHOR_NAME, IDENTITY.name);
  const plain = gitEnv({ env: { PATH: '/bin' } });
  assert.equal(plain.GIT_CONFIG_COUNT, undefined);
  assert.ok(!Object.values(env).some((v) => v.includes(FAKE_TOKEN)), 'raw token must not appear');
});

test('cleanGitText hides tokens, auth headers and credentials in URLs', () => {
  const basic = Buffer.from(`x-access-token:${FAKE_TOKEN}`).toString('base64');
  const text = cleanGitText(`fatal: ${FAKE_TOKEN}\nAUTHORIZATION: basic ${basic}\nhttps://user:pw@github.com/x`);
  assert.ok(!text.includes(FAKE_TOKEN) && !text.includes(basic) && !text.includes('user:pw'), text);
  assert.ok(!text.includes('\n'));
});

test('createLock runs jobs one at a time, even after a failure', async () => {
  const lock = createLock();
  const order = [];
  let running = 0;
  const job = (name, fail = false) => lock.run(async () => {
    running += 1;
    assert.equal(running, 1, 'two git jobs overlapped');
    order.push(name);
    await new Promise((r) => setTimeout(r, 5));
    running -= 1;
    if (fail) throw new Error('boom');
    return name;
  });
  const results = await Promise.allSettled([job('a'), job('b', true), job('c')]);
  assert.deepEqual(order, ['a', 'b', 'c']);
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[2].value, 'c');
});

test('checkPath keeps writes inside the clone and out of inbox/ and .git', () => {
  assert.equal(checkPath('tasks/t_1/task.json'), 'tasks/t_1/task.json');
  for (const bad of ['/etc/passwd', '../x.json', 'tasks/../../x.json', '.git/config', 'a//b.json', 'a b.json', '', 'inbox/x.json']) {
    assert.throws(() => checkPath(bad), /invalid storage path|Worker only/, bad);
  }
  assert.equal(checkPath('inbox/x.json', { allowInbox: true }), 'inbox/x.json');
});

// ---------- store with the fake git ----------
test('init clones when there is no clone yet, then pulls', async () => {
  const h = await fakeStore();
  try {
    assert.equal(await h.store.init(), true);
    assert.deepEqual(h.fake.commands().slice(0, 3), ['clone', 'rev-parse', 'pull']);
    const s = h.store.status();
    assert.equal(s.ok, true);
    assert.equal(s.ready, true);
    assert.ok(s.lastPull);
  } finally { await h.cleanup(); }
});

test('put writes the file at once but commits only on flush; pull always comes before push', async () => {
  const h = await fakeStore();
  try {
    await h.store.init();
    const rec = newRecord('t', { title: 'Invented task' }, { createdBy: 'learner' });
    await h.store.put(`tasks/${rec.id}/task.json`, rec);
    assert.deepEqual(await h.store.read(`tasks/${rec.id}/task.json`), rec);
    assert.ok(!h.fake.commands().includes('commit'), 'nothing committed before the batch ends');
    assert.equal(h.store.status().pending, 1);
    const result = await h.store.flush();
    assert.equal(result.committed, 1);
    assert.equal(result.pushed, true);
    const cmds = h.fake.commands();
    const order = ['add', 'commit', 'pull', 'push'].map((c) => cmds.lastIndexOf(c));
    assert.deepEqual([...order].sort((a, b) => a - b), order, `order was ${cmds.join(',')}`);
    const pull = h.fake.calls.find((c) => c.args[0] === 'pull').args;
    assert.ok(pull.includes('--rebase') && pull.includes('--autostash'), pull.join(' '));
    assert.equal(h.fake.messages[0], 'server: save 1 file');
    assert.ok(!h.fake.messages[0].includes(rec.id), 'commit messages never name records');
    assert.equal(h.store.status().pending, 0);
    assert.ok(h.store.status().lastPush);
  } finally { await h.cleanup(); }
});

test('changes within one batch become one commit', async () => {
  const h = await fakeStore({}, { batchMs: 30 });
  try {
    await h.store.init();
    await h.store.put('sessions/s_1.json', { id: 's_1' });
    await h.store.put('sessions/s_2.json', { id: 's_2' });
    await h.store.logEvent('session.started', { links: { sessionId: 's_1' } });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(h.fake.messages.length, 1);
    assert.equal(h.fake.messages[0], 'server: save 3 files');
  } finally { await h.cleanup(); }
});

test('a failed push keeps the commit, reports a token-free error and retries', async () => {
  const h = await fakeStore({ pushFails: 1 });
  try {
    await h.store.init();
    await h.store.put('sessions/s_1.json', { id: 's_1' });
    const first = await h.store.flush();
    assert.equal(first.pushed, false);
    assert.match(first.error, /^push failed/);
    const s = h.store.status();
    assert.equal(s.ok, false);
    assert.ok(!JSON.stringify(h.statuses).includes(Buffer.from(`x:${FAKE_TOKEN}`).toString('base64')), 'auth header leaked');
    const second = await h.store.flush(); // what the scheduled retry does
    assert.equal(second.committed, 0, 'the commit was kept, not redone');
    assert.equal(second.pushed, true);
    assert.equal(h.store.status().ok, true);
  } finally { await h.cleanup(); }
});

test('a failed pull aborts the rebase and never pushes', async () => {
  const h = await fakeStore();
  try {
    await h.store.init();
    h.fake.pullFails = 1;
    await h.store.put('sessions/s_1.json', { id: 's_1' });
    const result = await h.store.flush();
    assert.match(result.error, /^pull failed/);
    const cmds = h.fake.commands();
    const lastPull = cmds.lastIndexOf('pull');
    assert.equal(cmds[lastPull + 1], 'rebase');
    assert.ok(!cmds.slice(lastPull).includes('push'));
  } finally { await h.cleanup(); }
});

test('commitLocal on shutdown commits without pushing; the next start pushes it', async () => {
  const h = await fakeStore();
  try {
    await h.store.init();
    await h.store.put('sessions/s_1.json', { id: 's_1' });
    assert.equal(await h.store.commitLocal(), 1);
    assert.ok(!h.fake.commands().includes('push'));
    // a new server on the same clone: init sees one unpushed commit and pushes it
    const again = createStore({ dir: h.store.dir, remoteUrl: 'x', env: {}, runGit: h.fake.run, log: silent, sleep: async () => {} });
    await again.init();
    assert.equal(h.fake.commands().at(-1), 'push');
    assert.equal(h.fake.ahead, 0);
  } finally { await h.cleanup(); }
});

test('writes are refused before storage is ready, and inbox/ is never written', async () => {
  const h = await fakeStore();
  try {
    await assert.rejects(h.store.put('sessions/s_1.json', { id: 's_1' }), /not ready/);
    await h.store.init();
    await assert.rejects(h.store.put('inbox/c_1.json', { id: 'c_1' }), /Worker only/);
    await assert.rejects(h.store.put('sessions/s_1.txt', { id: 's_1' }), /\.json/);
    await assert.rejects(h.store.put('sessions/s_1.json', { title: 'no id' }), /needs an id/);
    assert.equal(await h.store.read('sessions/missing.json'), null);
    assert.deepEqual(await h.store.list('nothing-here'), []);
  } finally { await h.cleanup(); }
});

// ---------- settings and start-up ----------
test('storageSettings: name from STORAGE_REPO only, clone outside the app repo, no token in the URL', () => {
  const env = { STORAGE_REPO: 'example-owner/example-data', STORAGE_TOKEN: FAKE_TOKEN };
  const s = storageSettings(env);
  assert.equal(s.remoteUrl, 'https://github.com/example-owner/example-data.git');
  assert.equal(s.dir, '/workspaces/storage');
  assert.ok(!s.remoteUrl.includes(FAKE_TOKEN));
  assert.match(storageSettings({}).skip, /not set/);
  assert.match(storageSettings({ ...env, STORAGE_REPO: 'not a repo' }).skip, /owner\/name/);
  assert.match(storageSettings({ ...env, STORAGE_DIR: path.join(APP_ROOT, 'data') }).skip, /outside the app repository/);
});

test('startStorage stays off under the test runner and for port-0 servers', async () => {
  const env = { STORAGE_REPO: 'example-owner/example-data', STORAGE_TOKEN: FAKE_TOKEN, NODE_TEST_CONTEXT: 'child' };
  const state = {};
  assert.equal(await startStorage({ state, config: { port: 3000 }, env, log: silent, makeStore: () => assert.fail('must not start') }), null);
  assert.match(state.storage.detail, /test runner/);
  const state2 = {};
  await startStorage({ state: state2, config: { port: 0 }, env: { ...env, NODE_TEST_CONTEXT: '' }, log: silent, makeStore: () => assert.fail('must not start') });
  assert.match(state2.storage.detail, /port 0/);
  const state3 = {};
  await startStorage({ state: state3, config: { port: 3000 }, env: {}, log: silent });
  assert.equal(state3.storage.ok, false);
  assert.match(state3.storage.detail, /not set/);
});

test('startStorage: clones, records a system.start event and shows progress in state.storage', async () => {
  const base = await tmp('start');
  try {
    const fake = fakeGit();
    const state = {};
    let passedEnv;
    const store = await startStorage({
      state, config: { port: 3000 }, log: silent,
      env: { STORAGE_REPO: 'example-owner/example-data', STORAGE_TOKEN: FAKE_TOKEN, STORAGE_DIR: path.join(base, 'clone'), PATH: '/bin' },
      makeStore: (opts) => { passedEnv = opts.env; return createStore({ ...opts, runGit: fake.run, batchMs: 60_000, sleep: async () => {} }); },
    });
    assert.ok(store);
    assert.equal(state.storage.ok, true);
    assert.equal(state.storage.pending, 1);
    assert.ok(passedEnv.GIT_CONFIG_VALUE_0.startsWith('AUTHORIZATION: basic '));
    const month = (await store.list('events'))[0];
    const line = JSON.parse((await readFile(path.join(base, 'clone', 'events', month), 'utf8')).trim());
    assert.equal(line.type, 'system.start');
    assert.equal(line.createdBy, 'system');
    assert.deepEqual(Object.keys(state.storage).sort(), ['detail', 'lastPull', 'lastPush', 'ok', 'pending', 'ready']);
  } finally { await rm(base, { recursive: true, force: true }); }
});

// ---------- storage check script ----------
test('storage check: PASS when the second push follows a pulled inbox commit', async () => {
  const fake = fakeGit();
  const out = [];
  let waited = false;
  const result = await runCheck({
    settings: { remoteUrl: 'x', env: {} }, out: (l) => out.push(l),
    makeStore: (opts) => createStore({ ...opts, runGit: fake.run, sleep: async () => {} }),
    waitForOwner: async () => {
      waited = true;
      fake.pulledCount = 1;
      // simulate the commit made on GitHub arriving with the next pull
      const clone = fake.calls.find((c) => c.args[0] === 'clone').args.at(-1);
      await mkdir(path.join(clone, 'inbox'), { recursive: true });
      await writeFile(path.join(clone, INBOX_TEST_FILE), 'test\n');
      fake.committed.set(INBOX_TEST_FILE, 'test\n');
    },
  });
  assert.equal(waited, true);
  assert.equal(result.verdict, 'PASS');
  assert.match(out.join('\n'), /pulled 1 new commit first/);
});

test('storage check: CHECK when nothing new was pulled; --no-wait stops after the first push', async () => {
  const fake = fakeGit();
  const make = (opts) => createStore({ ...opts, runGit: fake.run, sleep: async () => {} });
  const check = await runCheck({ settings: { remoteUrl: 'x', env: {} }, out: () => {}, makeStore: make, waitForOwner: async () => {} });
  assert.match(check.verdict, /^CHECK/);
  const quick = await runCheck({ settings: { remoteUrl: 'x', env: {} }, wait: false, out: () => {}, makeStore: make });
  assert.match(quick.verdict, /^PASS \(steps 1–2 only/);
  assert.deepEqual(parseArgs(['--no-wait']), { wait: false });
  assert.throws(() => parseArgs(['--bogus']), /Unknown option/);
});

// ---------- real git against a temporary bare repository ----------
let gitAvailable = true;
try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { gitAvailable = false; }
const realGit = { skip: gitAvailable ? false : 'git is not installed here' };

function sh(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: { ...gitEnv({ env: process.env }) }, encoding: 'utf8' }).trim();
}

async function bareRemote() {
  const base = await tmp('bare');
  const remote = path.join(base, 'remote.git');
  sh(base, 'init', '--quiet', '--bare', remote);
  const seed = path.join(base, 'seed');
  sh(base, 'clone', '--quiet', remote, seed);
  await mkdir(path.join(seed, 'events'), { recursive: true });
  await writeFile(path.join(seed, 'events', '.gitkeep'), '');
  sh(seed, 'add', '-A');
  sh(seed, 'commit', '--quiet', '-m', 'seed');
  sh(seed, 'push', '--quiet', 'origin', 'HEAD');
  return { base, remote };
}

test('real git: clone, write, batch-commit and push to a bare repository', realGit, async () => {
  const { base, remote } = await bareRemote();
  try {
    const store = createStore({ dir: path.join(base, 'server-clone'), remoteUrl: remote, env: gitEnv({ token: FAKE_TOKEN, env: process.env }), log: silent });
    assert.equal(await store.init(), true);
    await store.put('sessions/s_1.json', newRecord('s', { type: 'learn' }, { createdBy: 'learner' }));
    await store.logEvent('session.started', { links: { sessionId: 's_1' } });
    const result = await store.flush();
    assert.equal(result.pushed, true, result.error);
    assert.equal(sh(remote, 'log', '-1', '--format=%s'), 'server: save 2 files');
    assert.equal(sh(remote, 'log', '-1', '--format=%an'), IDENTITY.name);
    const config = await readFile(path.join(store.dir, '.git', 'config'), 'utf8');
    assert.ok(!config.includes(FAKE_TOKEN) && !config.includes('extraheader'), 'no token or header in .git/config');
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('real git: pull-before-push succeeds after a simulated Worker commit to inbox/', realGit, async () => {
  const { base, remote } = await bareRemote();
  try {
    const store = createStore({ dir: path.join(base, 'server-clone'), remoteUrl: remote, env: gitEnv({ env: process.env }), log: silent });
    await store.init();
    await store.put('sessions/s_1.json', { id: 's_1' });
    // meanwhile the Worker commits a capture to inbox/
    const worker = path.join(base, 'worker');
    sh(base, 'clone', '--quiet', remote, worker);
    await mkdir(path.join(worker, 'inbox'), { recursive: true });
    await writeFile(path.join(worker, 'inbox', 'c_1.json'), '{"id":"c_1"}\n');
    sh(worker, 'add', '-A');
    sh(worker, 'commit', '--quiet', '-m', 'inbox: capture');
    sh(worker, 'push', '--quiet', 'origin', 'HEAD');
    const result = await store.flush();
    assert.equal(result.pushed, true, result.error);
    assert.equal(result.pulled, 1);
    assert.ok(existsSync(path.join(store.dir, 'inbox', 'c_1.json')));
    const files = sh(remote, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n');
    assert.ok(files.includes('inbox/c_1.json') && files.includes('sessions/s_1.json'), files.join(','));
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('real git: a commit left by a stopped server is pushed by the next start', realGit, async () => {
  const { base, remote } = await bareRemote();
  try {
    const dir = path.join(base, 'server-clone');
    const first = createStore({ dir, remoteUrl: remote, env: gitEnv({ env: process.env }), log: silent });
    await first.init();
    await first.put('sessions/s_1.json', { id: 's_1' });
    assert.equal(await first.commitLocal(), 1);
    assert.equal(sh(remote, 'log', '-1', '--format=%s'), 'seed');
    const second = createStore({ dir, remoteUrl: remote, env: gitEnv({ env: process.env }), log: silent });
    await second.init();
    assert.equal(sh(remote, 'log', '-1', '--format=%s'), 'server: save 1 file');
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('real git: an event appended during a sync does not block the pull (autostash)', realGit, async () => {
  const { base, remote } = await bareRemote();
  try {
    const store = createStore({ dir: path.join(base, 'server-clone'), remoteUrl: remote, env: gitEnv({ env: process.env }), log: silent });
    await store.init();
    await store.logEvent('test.one');
    await store.flush();
    // the Worker commits, then the server appends to the (tracked) events file before it next pulls
    const worker = path.join(base, 'worker');
    sh(base, 'clone', '--quiet', remote, worker);
    await mkdir(path.join(worker, 'inbox'), { recursive: true });
    await writeFile(path.join(worker, 'inbox', 'c_2.json'), '{"id":"c_2"}\n');
    sh(worker, 'add', '-A');
    sh(worker, 'commit', '--quiet', '-m', 'inbox: capture');
    sh(worker, 'push', '--quiet', 'origin', 'HEAD');
    const events = path.join(store.dir, eventsPath());
    await appendFile(events, '{"id":"ev_unsaved"}\n'); // written outside the lock, not yet committed
    const result = await store.flush(); // nothing marked dirty, so this is a pull and no push
    assert.equal(result.error, undefined, result.error);
    assert.equal(result.pulled, 1);
    assert.match(await readFile(events, 'utf8'), /ev_unsaved/);
  } finally { await rm(base, { recursive: true, force: true }); }
});
