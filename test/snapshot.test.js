// The snapshot writer (blueprint §4.3): titles, dates and counts only, never note, feedback or
// draft text; written once per batch. Invented records only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSnapshot } from '../server/storage/snapshot.js';
import { createStore } from '../server/storage/store.js';
import { snapshotStep, startStorage } from '../server/storage/index.js';
import { SNAPSHOT_PATH } from '../server/storage/items.js';

// Text that must never appear in the snapshot
const SECRET = ['NOTE-TEXT-ZEBRA', 'FEEDBACK-TEXT-OTTER', 'DRAFT-TEXT-HERON', 'PLAN-TEXT-BADGER', 'QUESTION-TEXT-LYNX',
  'ANCHOR-TEXT-NEWT', 'UPLOAD-TEXT-WREN', 'DISPLAY-NAME-MOLE'];

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'snapshot-test-'));
  const put = async (relPath, value) => {
    await mkdir(path.dirname(path.join(dir, relPath)), { recursive: true });
    await writeFile(path.join(dir, relPath), typeof value === 'string' ? value : JSON.stringify(value));
  };
  const at = (day) => `2026-11-${day}T10:00:00+00:00`;
  await put('profile/app.json', { id: 'app', displayName: '  Example   Study App ' });
  await put('profile/accessibility.json', { id: 'acc', schemaVersion: 1, textSize: 'large', lineSpacing: 1.8, reducedMotion: true, notes: 'x'.repeat(200), nested: { a: 1 } });
  await put('profile/learner.json', { id: 'learner', displayName: SECRET[7], presentation: { paragraphLength: 'short', numberedSteps: true } });
  await put('tasks/t-1/task.json', { id: 't-1', title: 'Coasts essay', subject: 'Geography', kind: 'assignment', stage: 'planning', deadline: '2026-11-20', questionText: SECRET[4], anchors: [{ text: SECRET[5], author: 'learner' }] });
  await put('tasks/t-1/plan.json', { id: 'p-1', sections: [{ text: SECRET[3], author: 'learner' }], sharedWithParent: '2026-11-03' });
  await put('tasks/t-1/drafts/v1.json', { id: 'd-1', text: SECRET[2], sharedWithParent: '2026-11-04', updatedAt: at('04') });
  await put('tasks/t-1/drafts/v2.json', { id: 'd-2', text: SECRET[2], updatedAt: at('05') });
  await put('tasks/t-1/feedback/f-1.json', { id: 'f-1', text: { value: SECRET[1], author: 'ai' }, sharedWithParent: '2026-11-05', updatedAt: at('06') });
  await put('tasks/t-2/task.json', { id: 't-2', title: 'Finished worksheet', subject: 'Drama', stage: 'done', deadline: '2026-11-01' });
  await put('tasks/t-3/task.json', { id: 't-3', title: 'Early task', subject: 'Music', stage: 'not started', deadline: '2026-11-10' });
  await put('notebook/n-1.json', { id: 'n-1', text: { value: SECRET[0], author: 'learner' }, updatedAt: at('07') });
  await put('notebook/n-2.json', { id: 'n-2', title: 'Sea walls', text: { value: SECRET[0], author: 'ai' }, sharedWithParent: '2026-11-08', updatedAt: at('08') });
  await put('notebook/bad.json', '{not json');
  await put('notebook/.gitkeep', '');
  await put('inbox/c-1.json', { clientId: 'c-1', extractedText: SECRET[6] });
  await put('inbox/c-1.jpg', 'binary');
  return dir;
}

test('snapshot: learner and parent sections from the records', async () => {
  const dir = await fixture();
  try {
    const snap = await buildSnapshot({ dir, now: new Date('2026-11-09T12:00:00Z') });
    assert.equal(snap.generatedAt, '2026-11-09T12:00:00+00:00');
    const { learner, parent } = snap;
    assert.equal(learner.appName, 'Example Study App');
    assert.equal(parent.appName, 'Example Study App');
    assert.deepEqual(learner.upcoming.map((t) => t.taskId), ['t-3', 't-1'], 'open tasks only, soonest first');
    assert.deepEqual(learner.upcoming[1], { taskId: 't-1', title: 'Coasts essay', subject: 'Geography', deadline: '2026-11-20', stage: 'planning', kind: 'assignment' });
    assert.deepEqual(parent.upcoming[1], { title: 'Coasts essay', subject: 'Geography', deadline: '2026-11-20' });
    assert.deepEqual(learner.settings, {
      accessibility: { textSize: 'large', lineSpacing: 1.8, reducedMotion: true },
      presentation: { paragraphLength: 'short', numberedSteps: true },
    });
    assert.deepEqual(learner.recent.map((r) => `${r.type}:${r.id}:${r.title}`), [
      'notebook:n-2:Sea walls', 'notebook:n-1:Note', 'feedback:f-1:Feedback: Coasts essay',
    ]);
    assert.equal(learner.recent[2].task, 't-1');
    assert.equal(learner.inboxPending, 1);
    assert.equal(learner.planStatus, null);
    assert.equal(learner.nextSession, null);
    // shared: notes, plans and drafts with sharedWithParent; never feedback
    assert.deepEqual(parent.shared.map((s) => `${s.type}:${s.id}`), ['notebook:n-2', 'draft:v1', 'plan:plan']);
    assert.deepEqual(parent.shared[2], { type: 'plan', id: 'plan', task: 't-1', title: 'Plan: Coasts essay', sharedAt: '2026-11-03' });
    assert.deepEqual(Object.keys(parent).sort(), ['appName', 'planStatus', 'shared', 'upcoming']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('snapshot never contains note, feedback, draft, plan, question, anchor or inbox text', async () => {
  const dir = await fixture();
  try {
    const text = JSON.stringify(await buildSnapshot({ dir }));
    for (const secret of SECRET) assert.ok(!text.includes(secret), `${secret} leaked into the snapshot`);
    assert.ok(text.length < 4000, 'a small contents page');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('snapshot of an empty or missing clone is valid and empty', async () => {
  const dir = path.join(os.tmpdir(), 'snapshot-missing-folder-test');
  const snap = await buildSnapshot({ dir });
  assert.deepEqual(snap.learner, {
    appName: null, upcoming: [], planStatus: null, nextSession: null,
    settings: { accessibility: {}, presentation: {} }, recent: [], inboxPending: 0,
  });
  assert.deepEqual(snap.parent, { appName: null, upcoming: [], planStatus: null, shared: [] });
});

// A fake git that succeeds at everything; enough to drive a batch.
function fakeGit(log) {
  return async (args) => {
    log.push(args[0]);
    if (args[0] === 'diff') return { code: 0, stdout: 'a-file\n', stderr: '' };
    if (args[0] === 'rev-list') return { code: 0, stdout: '0\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
}

test('store: the before-commit step runs once per batch, inside the batch, and only when something changed', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'store-hook-test-'));
  const gitLog = [];
  let runs = 0;
  try {
    const store = createStore({
      dir: path.join(dir, 'clone'), remoteUrl: 'https://github.com/example-owner/example-data.git', env: {},
      runGit: fakeGit(gitLog), batchMs: 60_000, log: { log() {}, error() {} },
      beforeCommit: async ({ write }) => { runs += 1; await write(SNAPSHOT_PATH, { runs }); },
    });
    assert.equal(await store.init(), true);
    await store.put('notebook/n-1.json', { id: 'n-1' });
    await store.put('notebook/n-2.json', { id: 'n-2' });
    gitLog.length = 0;
    await store.flush();
    assert.equal(runs, 1, 'once for the whole batch');
    assert.deepEqual(gitLog.slice(0, 2), ['add', 'diff'], 'written before git add, so it is in the same commit');
    assert.deepEqual(JSON.parse(await readFile(path.join(store.dir, SNAPSHOT_PATH), 'utf8')), { runs: 1 });
    await store.flush();
    assert.equal(runs, 1, 'nothing changed, so no rewrite');
    await assert.rejects(
      createStore({ dir: path.join(dir, 'x'), env: {}, runGit: fakeGit([]) }).put('notebook/a.json', { id: 'a' }),
      /not ready/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('store: a failing before-commit step is logged and never blocks saving', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'store-hook-fail-'));
  const errors = [];
  try {
    const store = createStore({
      dir: path.join(dir, 'clone'), env: {}, runGit: fakeGit([]), batchMs: 60_000,
      log: { log() {}, error: (m) => errors.push(m) },
      beforeCommit: async () => { throw new Error('invented failure'); },
    });
    await store.init();
    await store.put('notebook/n-1.json', { id: 'n-1' });
    const result = await store.flush();
    assert.equal(result.committed, 1);
    assert.equal(result.error, undefined);
    assert.match(errors.join('\n'), /before-commit step failed: invented failure/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('store.remove deletes a file (or accepts that it has gone) and marks it for the next commit', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'store-remove-'));
  try {
    const store = createStore({ dir: path.join(dir, 'clone'), env: {}, runGit: fakeGit([]), batchMs: 60_000, log: { log() {}, error() {} } });
    await store.init();
    await store.put('notebook/n-1.json', { id: 'n-1' });
    await store.flush();
    await store.remove('notebook/n-1.json');
    assert.equal(existsSync(path.join(store.dir, 'notebook/n-1.json')), false);
    assert.equal(store.status().pending, 1);
    await store.remove('notebook/never-there.json');
    await assert.rejects(store.remove('inbox/c-1.json'), /Worker only/);
    await assert.rejects(store.remove('../outside.json'), /invalid storage path/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('startStorage gives the store a snapshot step that writes index/snapshot.json', async () => {
  const dir = await fixture();
  let options;
  const state = {};
  await startStorage({
    state,
    config: { port: 3000 },
    env: { NODE_TEST_CONTEXT: 'child', STORAGE_ALLOW_IN_TESTS: '1', STORAGE_REPO: 'example-owner/example-data', STORAGE_TOKEN: 'test-token', STORAGE_DIR: dir },
    log: { log() {}, error() {} },
    makeStore: (opts) => {
      options = opts;
      return { status: () => ({ ok: true, ready: true, detail: 'up to date' }), init: async () => true, logEvent: async () => {} };
    },
  });
  try {
    assert.equal(typeof options.beforeCommit, 'function');
    const written = {};
    await options.beforeCommit({ write: async (relPath, data) => { written[relPath] = data; } });
    assert.deepEqual(Object.keys(written), [SNAPSHOT_PATH]);
    assert.equal(written[SNAPSHOT_PATH].learner.appName, 'Example Study App');
    const custom = snapshotStep('/nowhere', { build: async ({ dir: d }) => ({ d }) });
    const out = {};
    await custom({ write: async (p, data) => { out[p] = data; } });
    assert.deepEqual(out, { [SNAPSHOT_PATH]: { d: '/nowhere' } });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
