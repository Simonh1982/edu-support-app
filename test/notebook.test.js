// WP-115a: the research notebook's server side (build spec §29). Invented data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makeEvent, newRecord } from '../server/storage/records.js';
import { matchApiRoute, handleApi } from '../server/api.js';
import { buildSnapshot } from '../server/storage/snapshot.js';
import { NOTEBOOK_MESSAGES, citation, quoteForNote, notebookEntryPath } from '../server/domain/notebook.js';

async function fakeStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wp115a-'));
  const events = [];
  return {
    dir, events,
    status: () => ({ ready: true }),
    async put(rel, record) {
      await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await writeFile(path.join(dir, rel), JSON.stringify(record));
      return record;
    },
    async read(rel) {
      try { return JSON.parse(await readFile(path.join(dir, rel), 'utf8')); } catch { return null; }
    },
    async logEvent(type, options = {}) {
      const event = makeEvent(type, options);
      events.push(event);
      return event;
    },
  };
}

const silent = { log() {}, error() {}, warn() {} };
const caller = (store) => (method, url, body, role = 'learner') => {
  const [p, search = ''] = url.split('?');
  const match = matchApiRoute(method, p);
  assert.ok(match?.route, `route ${method} ${p}`);
  return handleApi({ match, pass: { role }, store, body, query: new URLSearchParams(search), getAi: () => null, log: silent });
};

async function setup() {
  const store = await fakeStore();
  const call = caller(store);
  const task = (await call('POST', '/api/tasks', {
    title: 'Invented coast task', subject: 'Invented Geography', questionText: 'Invented question?', topicIds: ['demo-geo-1a'],
  })).body.task;
  const later = (await call('POST', '/api/tasks', {
    title: 'Invented later coast task', subject: 'Invented Geography', questionText: 'Another invented question?', topicIds: ['demo-geo-1a'],
  })).body.task;
  const source = (await call('POST', '/api/sources/own', {
    title: 'Invented Shoreline Study', author: 'A. Inventor', url: 'https://invented.example.org/study', taskId: task.id,
  })).body.source;
  // an AI summary, as server/domain/sources.js saves it
  const summary = newRecord('note', {
    type: 'summary', title: 'Invented Shoreline Study', text: { value: 'Invented AI summary of the study.', author: 'ai' },
    taskId: task.id, topicIds: ['demo-geo-1a'], source: { title: 'Invented Shoreline Study', author: 'A. Inventor', url: null },
    sourceId: source.id, sharedWithParent: null,
  }, { createdBy: 'ai' });
  await store.put(notebookEntryPath(summary.id), summary);
  return { store, call, task, later, source, summary };
}

const done = (store) => rm(store.dir, { recursive: true, force: true });

test('a note holds only his words, with every record field; its task gives the topics; events hold no text', async () => {
  const { store, call, task } = await setup();
  try {
    const r = await call('POST', '/api/notebook/notes', { title: 'Invented first thoughts', text: 'Invented note in my own words.', taskId: task.id });
    assert.equal(r.status, 201);
    const e = r.body.entry;
    assert.deepEqual([e.type, e.text, e.taskId, e.topicIds, e.quoteIds, e.pinnedTo], ['note', { value: 'Invented note in my own words.', author: 'learner' }, task.id, ['demo-geo-1a'], [], []]);
    for (const k of ['id', 'createdAt', 'updatedAt', 'createdBy', 'schemaVersion']) assert.ok(e[k] !== undefined, k);
    assert.equal(e.createdBy, 'learner');
    // a note can't claim to be by the AI or a source
    assert.equal((await call('POST', '/api/notebook/notes', { text: { value: 'Invented', author: 'ai' } })).status, 400);
    assert.equal((await call('POST', '/api/notebook/notes', { text: '' })).status, 400);
    assert.ok(!JSON.stringify(store.events).includes('Invented note'), 'no text in events');
    assert.equal((await call('GET', '/api/notebook', null, 'parent')).status, 403);
  } finally { await done(store); }
});

test('a quote keeps the source\'s words and its citation; it goes into a note only with that citation', async () => {
  const { store, call, task, source } = await setup();
  try {
    const q = (await call('POST', '/api/notebook/quotes', { sourceId: source.id, text: 'Invented passage from the study.', page: '12' })).body.entry;
    assert.deepEqual([q.type, q.text.author, q.taskId, q.citation], ['quote', 'source', task.id, '(A. Inventor, “Invented Shoreline Study”, p. 12)']);
    assert.equal(citation({ title: 'Invented' }), '(“Invented”)');
    assert.equal((await call('POST', '/api/notebook/quotes', { sourceId: 'src_missing', text: 'x' })).status, 404);
    const inserted = `My invented point. ${quoteForNote(q)}`;
    const note = (await call('POST', '/api/notebook/notes', { text: inserted, taskId: task.id, quoteIds: [q.id] })).body.entry;
    assert.deepEqual(note.quoteIds, [q.id]);
    assert.match(note.text.value, /“Invented passage from the study\.” \(A\. Inventor, “Invented Shoreline Study”, p\. 12\)/);
    const missing = await call('POST', '/api/notebook/notes', { text: 'No quote here.', quoteIds: [q.id] });
    assert.deepEqual([missing.status, missing.body.error], [400, NOTEBOOK_MESSAGES.quoteNotInNote]);
  } finally { await done(store); }
});

test('his notes can be changed; AI summaries and quotes can\'t be edited, only pinned', async () => {
  const { store, call, task, later, summary } = await setup();
  try {
    const note = (await call('POST', '/api/notebook/notes', { text: 'Invented draft note.', taskId: task.id })).body.entry;
    const changed = await call('PATCH', `/api/notebook/notes/${note.id}`, { text: 'Invented better note.', title: 'Invented title' });
    assert.deepEqual([changed.status, changed.body.entry.text.value, changed.body.entry.title], [200, 'Invented better note.', 'Invented title']);
    const refused = await call('PATCH', `/api/notebook/notes/${summary.id}`, { text: 'Rewritten by me.' });
    assert.deepEqual([refused.status, refused.body.error], [409, NOTEBOOK_MESSAGES.notYours]);
    const pinned = await call('POST', `/api/notebook/${summary.id}/pin`, { taskId: later.id, pinned: true });
    assert.deepEqual(pinned.body.entry.pinnedTo, [later.id]);
    assert.equal(pinned.body.entry.text.author, 'ai', 'pinning never changes the text or its author');
    const forLater = (await call('GET', `/api/notebook?taskId=${later.id}`)).body.entries;
    assert.deepEqual(forLater.map((e) => e.id), [summary.id], 'a pinned entry shows with the task it is pinned to');
    const unpinned = await call('POST', `/api/notebook/${summary.id}/pin`, { taskId: later.id, pinned: false });
    assert.deepEqual(unpinned.body.entry.pinnedTo, []);
  } finally { await done(store); }
});

test('history and search: by task, topic, subject, type and words; excerpts only', async () => {
  const { store, call, task, summary } = await setup();
  try {
    const own = (await call('POST', '/api/tasks', { title: 'Invented poem task', subject: 'Invented English', questionText: 'Invented?' })).body.task;
    await call('POST', '/api/notebook/notes', { text: 'Invented thoughts about longshore drift.', taskId: task.id });
    await call('POST', '/api/notebook/notes', { text: `Invented poem note ${'word '.repeat(80)}`, taskId: own.id });
    const list = async (qs) => (await call('GET', `/api/notebook${qs}`)).body.entries;
    assert.equal((await list('')).length, 3);
    assert.equal((await list(`?taskId=${task.id}`)).length, 2);
    assert.equal((await list('?topicId=demo-geo-1a')).length, 2);
    assert.equal((await list('?subject=invented%20english')).length, 1);
    assert.deepEqual((await list('?type=summary')).map((e) => e.id), [summary.id]);
    assert.equal((await list('?q=LONGSHORE%20drift')).length, 1);
    assert.equal((await list('?q=longshore%20poem')).length, 0, 'every word must match');
    assert.equal((await list('?q=shoreline')).length, 1, 'source titles are searched too');
    const poem = (await list('?q=poem'))[0];
    assert.ok(poem.excerpt.length <= 241 && poem.excerpt.endsWith('…'));
    assert.equal(poem.text, undefined, 'the list never carries full text');
    assert.equal((await call('GET', '/api/notebook?type=nonsense')).status, 400);
  } finally { await done(store); }
});

test('earlier research on the same topics is offered for a new task, until he pins it there', async () => {
  const { store, call, later, summary } = await setup();
  try {
    const r = await call('GET', `/api/notebook/earlier?taskId=${later.id}`);
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.count, r.body.entries[0].id], [1, summary.id]);
    await call('POST', `/api/notebook/${summary.id}/pin`, { taskId: later.id, pinned: true });
    assert.equal((await call('GET', `/api/notebook/earlier?taskId=${later.id}`)).body.count, 0);
    assert.equal((await call('GET', '/api/notebook/earlier')).status, 400);
  } finally { await done(store); }
});

test('the snapshot lists notebook titles and kinds, never their text', async () => {
  const { store, call, task } = await setup();
  try {
    await call('POST', '/api/notebook/notes', { text: 'Invented private note text.', taskId: task.id });
    const snap = await buildSnapshot({ dir: store.dir });
    assert.equal(snap.learner.notebook.length, 2);
    assert.deepEqual(snap.learner.notebook.map((e) => e.kind).sort(), ['note', 'summary']);
    const text = JSON.stringify(snap);
    assert.ok(!text.includes('Invented private note text') && !text.includes('Invented AI summary'), 'no notebook text');
    assert.equal(snap.parent.notebook, undefined);
  } finally { await done(store); }
});
