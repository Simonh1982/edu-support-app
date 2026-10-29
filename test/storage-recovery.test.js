// WP-014a-fix: storage settles sync clashes on server-made files by itself, and stops with a clear
// message (instead of retrying for ever) on anything else. Invented data only. The fake-git tests
// run everywhere; the real-git tests run wherever git is installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore, conflictRule, unionLines, parseUnmerged } from '../server/storage/store.js';
import { runGit, gitEnv } from '../server/storage/git.js';
import { waitForServerPush } from '../scripts/inbox-check.js';

const silent = { log() {}, error() {} };
const REMOTE = 'https://github.com/example-owner/example-data.git';

test('conflictRule: only server-made paths are settled automatically', () => {
  assert.equal(conflictRule('events/2026-10.jsonl'), 'union');
  assert.equal(conflictRule('index/snapshot.json'), 'generated');
  assert.equal(conflictRule('inbox/cap-abcdef12.json'), 'prefer-remote');
  assert.equal(conflictRule('uploads/up_cap-abcdef12.jpg'), 'prefer-local');
  for (const p of ['notebook/n1.json', 'tasks/t1/task.json', 'profile/app.json', 'events/sub/x.jsonl', 'index/other.json', null]) {
    assert.equal(conflictRule(p), null, String(p));
  }
});

test('unionLines keeps every line once: remote first, then local additions', () => {
  assert.equal(unionLines('a\nb\n', 'a\nc\n'), 'a\nb\nc\n');
  assert.equal(unionLines('', 'x\n'), 'x\n');
  assert.equal(unionLines('a\n', 'a\n'), 'a\n');
  assert.equal(unionLines('', ''), '');
  assert.equal(unionLines('a\nb', 'c\nc\n'), 'a\nb\nc\n');
});

test('parseUnmerged groups git stages by path', () => {
  const out = parseUnmerged([
    '100644 1111111111111111111111111111111111111111 1\tevents/2026-10.jsonl',
    '100644 2222222222222222222222222222222222222222 2\tevents/2026-10.jsonl',
    '100644 3333333333333333333333333333333333333333 3\tevents/2026-10.jsonl',
    '100644 4444444444444444444444444444444444444444 2\tinbox/cap-abcdef12.json',
    '',
  ].join('\n'));
  assert.deepEqual(out.map((c) => [c.path, [...c.stages].sort()]), [
    ['events/2026-10.jsonl', [1, 2, 3]],
    ['inbox/cap-abcdef12.json', [2]],
  ]);
});

/** A scripted git: `conflicts` is the ls-files -u text until the rebase continues. */
function scriptedGit({ conflicts, show = {}, pullCode = 1, stagedCode = 1, continueCode = 0 }) {
  const calls = [];
  let rebasing = false;
  const runGitFake = async (args) => {
    const cmd = args.join(' ');
    calls.push(cmd);
    const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
    if (args[0] === 'pull') {
      rebasing = pullCode !== 0 && conflicts !== '';
      return { code: pullCode, stdout: '', stderr: 'CONFLICT (content): Merge conflict' };
    }
    if (args[0] === 'ls-files') return ok(rebasing ? conflicts : '');
    if (args[0] === 'show') return ok(show[args[1]] ?? '');
    if (args[0] === 'diff' && args.includes('--quiet')) return { code: stagedCode, stdout: '', stderr: '' };
    if (args[0] === 'diff' && args.includes('--name-only')) return ok('notebook/n2.json\n');
    if (cmd.includes('rebase --continue') || cmd === 'rebase --skip') {
      rebasing = false;
      return { code: continueCode, stdout: '', stderr: '' };
    }
    if (args[0] === 'rebase') { rebasing = false; return ok(); }
    if (args[0] === 'rev-list') return ok(cmd.includes('@{u}..HEAD') ? '1' : '0');
    if (args[0] === 'rev-parse') return ok('abc123');
    return ok();
  };
  return { calls, runGit: runGitFake };
}

async function fakeStore(git) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recovery-test-'));
  const dir = path.join(root, 'clone');
  await mkdir(path.join(dir, '.git'), { recursive: true });
  const store = createStore({ dir, remoteUrl: REMOTE, env: {}, runGit: git.runGit, batchMs: 60_000, retryDelays: [60_000], log: silent });
  return { store, dir, root };
}

test('fake git: an event-log and snapshot clash is settled, merged, pushed, and the snapshot rebuilt', async () => {
  const git = scriptedGit({
    conflicts: [
      '100644 aaaa 2\tevents/2026-10.jsonl', '100644 bbbb 3\tevents/2026-10.jsonl',
      '100644 cccc 2\tindex/snapshot.json', '100644 dddd 3\tindex/snapshot.json',
    ].join('\n'),
    show: { ':2:events/2026-10.jsonl': '{"id":"e1"}\n{"id":"e2"}\n', ':3:events/2026-10.jsonl': '{"id":"e1"}\n{"id":"e3"}\n' },
  });
  const { store, dir, root } = await fakeStore(git);
  try {
    assert.equal(await store.init(), true);
    const status = store.status();
    assert.equal(status.ok, true, status.detail);
    assert.equal(await readFile(path.join(dir, 'events/2026-10.jsonl'), 'utf8'), '{"id":"e1"}\n{"id":"e2"}\n{"id":"e3"}\n');
    assert.ok(git.calls.includes('checkout --ours -- index/snapshot.json'), 'snapshot takes the remote side');
    assert.ok(git.calls.includes('-c core.editor=true rebase --continue'));
    assert.ok(git.calls.includes('push --quiet origin HEAD'));
    assert.ok(!git.calls.includes('rebase --abort'));
    assert.equal(status.pending, 1, 'the snapshot is queued to be rebuilt');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('fake git: inbox keeps the remote copy, uploads keep the local copy, empty commits are skipped', async () => {
  const git = scriptedGit({
    conflicts: [
      '100644 aaaa 3\tinbox/cap-onlylocal.json',
      '100644 bbbb 2\tinbox/cap-bothside.json', '100644 cccc 3\tinbox/cap-bothside.json',
      '100644 dddd 2\tuploads/up_cap-x1234567.jpg', '100644 eeee 3\tuploads/up_cap-x1234567.jpg',
      '100644 ffff 2\tuploads/up_cap-remote01.json',
    ].join('\n'),
    stagedCode: 0,
  });
  const { store, root } = await fakeStore(git);
  try {
    await store.init();
    assert.equal(store.status().ok, true, store.status().detail);
    assert.ok(git.calls.includes('checkout --theirs -- inbox/cap-onlylocal.json'));
    assert.ok(git.calls.includes('checkout --ours -- inbox/cap-bothside.json'));
    assert.ok(git.calls.includes('checkout --theirs -- uploads/up_cap-x1234567.jpg'));
    assert.ok(git.calls.includes('checkout --ours -- uploads/up_cap-remote01.json'), 'a photo is never deleted by a clash');
    assert.ok(git.calls.includes('rebase --skip'));
    assert.ok(!git.calls.some((c) => c.startsWith('rm ')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('fake git: a clash on a learner record stops syncing with a clear message, keeps local work, and does not loop', async () => {
  const git = scriptedGit({ conflicts: '100644 aaaa 2\tnotebook/n1.json\n100644 bbbb 3\tnotebook/n1.json' });
  const { store, root } = await fakeStore(git);
  try {
    assert.equal(await store.init(), true, 'the clone is still usable');
    const status = store.status();
    assert.equal(status.ok, false);
    assert.match(status.detail, /^needs attention: sync clash in notebook\/n1\.json/);
    assert.doesNotMatch(status.detail, /example-owner|example-data/);
    assert.ok(git.calls.includes('rebase --abort'));
    assert.ok(!git.calls.some((c) => c.startsWith('checkout')), 'nothing is settled when a person must look');
    git.calls.length = 0;
    const again = await store.sync();
    assert.equal(again.attention, true);
    assert.deepEqual(git.calls, [], 'no git commands until the server restarts');
    await store.put('notebook/n2.json', { id: 'n2' });
    const flushed = await store.flush();
    assert.equal(flushed.committed, 1, 'saving still works locally');
    assert.ok(!git.calls.some((c) => c.startsWith('pull')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('fake git: a pull that fails without a clash (offline) is retried as before', async () => {
  const git = scriptedGit({ conflicts: '', pullCode: 128 });
  const { store, root } = await fakeStore(git);
  try {
    await store.init();
    assert.match(store.status().detail, /^pull failed/);
    git.calls.length = 0;
    await store.sync();
    assert.ok(git.calls.some((c) => c.startsWith('pull')), 'still retries');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('waitForServerPush waits for nothing pending, and gives up if the server is unreachable', async () => {
  let t = 0;
  const clock = () => t;
  const sleep = async (ms) => { t += ms; };
  const replies = [{ storage: { ok: true, pending: 2 } }, { storage: { ok: false, pending: 0 } }, { storage: { ok: true, pending: 0 } }];
  assert.equal(await waitForServerPush({ serverHealth: async () => replies.shift(), clock, sleep, stepMs: 1000, waitMs: 30_000 }), true);
  assert.equal(t, 2000);
  assert.equal(await waitForServerPush({ serverHealth: async () => null, clock, sleep }), false);
  assert.equal(await waitForServerPush({ serverHealth: async () => { throw new Error('refused'); }, clock, sleep }), false);
  t = 0;
  assert.equal(await waitForServerPush({ serverHealth: async () => ({ storage: { ok: true, pending: 1 } }), clock, sleep, stepMs: 1000, waitMs: 5000 }), false);
});

// ---- Real git: a local bare repository stands in for GitHub ----
const GIT_ENV = gitEnv({ env: process.env });
const hasGit = (await runGit(['--version'], { env: GIT_ENV })).code === 0;
const skip = hasGit ? false : 'git is not installed';

async function sh(args, cwd) {
  const r = await runGit(args, { cwd, env: GIT_ENV });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r;
}

async function realSetup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'recovery-git-'));
  const bare = path.join(root, 'remote.git');
  await sh(['init', '--quiet', '--bare', '-b', 'main', bare], root);
  const seed = path.join(root, 'seed');
  await sh(['init', '--quiet', '-b', 'main', seed], root);
  await writeFile(path.join(seed, 'README.md'), 'invented storage\n');
  await sh(['add', '-A'], seed);
  await sh(['commit', '--quiet', '-m', 'seed'], seed);
  await sh(['push', '--quiet', bare, 'main'], seed);
  const pulls = { count: 0 };
  const counting = (args, opts) => { if (args[0] === 'pull') pulls.count += 1; return runGit(args, opts); };
  const store = createStore({ dir: path.join(root, 'server'), remoteUrl: bare, env: GIT_ENV, runGit: counting, batchMs: 60_000, retryDelays: [60_000], log: silent });
  assert.equal(await store.init(), true);
  const other = path.join(root, 'other');
  await sh(['clone', '--quiet', bare, other], root);
  // another writer (the Worker or a check script): write, commit and push from its own clone
  const otherCommit = async (files) => {
    await sh(['pull', '--quiet'], other);
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(other, rel)), { recursive: true });
      await writeFile(path.join(other, rel), text);
    }
    await sh(['add', '-A'], other);
    await sh(['commit', '--quiet', '-m', 'other writer'], other);
    await sh(['push', '--quiet', 'origin', 'HEAD'], other);
  };
  return { root, store, other, otherCommit, pulls };
}

test('real git: both sides append to the event log; every line survives and storage keeps pushing', { skip }, async () => {
  const { root, store, other, otherCommit } = await realSetup();
  try {
    await store.append('events/2026-10.jsonl', { id: 'ev_local', type: 'system.start' });
    await otherCommit({ 'events/2026-10.jsonl': '{"id":"ev_other","type":"storage.check"}\n' });
    const result = await store.flush();
    assert.equal(result.error, undefined, result.error);
    assert.equal(result.pushed, true);
    assert.deepEqual(result.recovered, ['events/2026-10.jsonl']);
    await sh(['pull', '--quiet'], other);
    const lines = (await readFile(path.join(other, 'events/2026-10.jsonl'), 'utf8')).trim().split('\n');
    assert.deepEqual(lines.map((l) => JSON.parse(l).id).sort(), ['ev_local', 'ev_other']);
    assert.equal(store.status().ok, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('real git: inbox and uploads clashes keep the Worker\'s capture and the server\'s upload', { skip }, async () => {
  const { root, store, otherCommit } = await realSetup();
  try {
    await otherCommit({ 'inbox/cap-abcdef12.json': '{"v":1}\n' });
    assert.equal((await store.sync()).error, undefined);
    await store.remove('inbox/cap-abcdef12.json', { allowInbox: true });
    await store.put('uploads/up_cap-abcdef12.json', { id: 'up_cap-abcdef12', side: 'server' });
    await otherCommit({ 'inbox/cap-abcdef12.json': '{"v":2}\n', 'uploads/up_cap-abcdef12.json': '{"id":"up_cap-abcdef12","side":"other"}\n' });
    const result = await store.flush();
    assert.equal(result.error, undefined, result.error);
    assert.equal(result.pushed, true);
    assert.equal((await store.read('uploads/up_cap-abcdef12.json')).side, 'server');
    assert.deepEqual(await store.read('inbox/cap-abcdef12.json'), { v: 2 }, 'a repeat capture is kept, then dropped as a duplicate');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('real git: a learner-record clash stops cleanly, keeps the local commit and stops pulling', { skip }, async () => {
  const { root, store, otherCommit, pulls } = await realSetup();
  try {
    await store.put('notebook/n1.json', { id: 'n1', side: 'server' });
    await otherCommit({ 'notebook/n1.json': '{"id":"n1","side":"other"}\n' });
    const result = await store.flush();
    assert.equal(result.attention, true);
    assert.match(store.status().detail, /needs attention: sync clash in notebook\/n1\.json/);
    assert.ok(!existsSync(path.join(store.dir, '.git', 'rebase-merge')), 'no rebase left half-done');
    assert.ok(!existsSync(path.join(store.dir, '.git', 'rebase-apply')));
    assert.equal((await store.read('notebook/n1.json')).side, 'server');
    const ahead = await sh(['rev-list', '--count', '@{u}..HEAD'], store.dir);
    assert.equal(ahead.stdout.trim(), '1', 'the local commit is kept');
    const before = pulls.count;
    await store.flush();
    await store.sync();
    assert.equal(pulls.count, before, 'no endless retries');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
