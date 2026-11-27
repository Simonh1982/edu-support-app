// WP-131a (A-013 §3–§4): the side menu's lists (subjects, chats, tasks, topics worked on), chat
// names and renaming, and the same lists in the snapshot. Mock AI, temporary folder, invented data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makeEvent, newRecord } from '../server/storage/records.js';
import { createMockAi } from '../server/ai/mock.js';
import { matchApiRoute, handleApi } from '../server/api.js';
import { buildSnapshot } from '../server/storage/snapshot.js';
import { shortLabel, subjectsFor, chatName, parseName, SUBJECTS_FILE, MENU_MESSAGES } from '../server/domain/menu.js';

const MODELS = Object.freeze({
  conversation: 'mock-conversation', review: 'mock-review', light: 'mock-light',
  spelling: 'mock-spelling', checker: 'mock-checker', judge: 'mock-judge',
});
const silent = { log() {}, error() {}, warn() {} };
const qual = (id, title, active = true) => ({ id, title, awardingBody: 'Exampleboard', record: { active }, units: [], aos: [], commandWords: [] });
const topic = (id, qualId, title) => ({ id, qualId, unitId: null, title, record: { id, title } });
const curriculum = {
  qualifications: new Map([
    ['inv-geo', qual('inv-geo', 'Exampleboard A-level Invented Geography')],
    ['inv-his', qual('inv-his', 'Exampleboard A-level Invented History')],
    ['inv-old', qual('inv-old', 'Exampleboard Old Course', false)],
  ]),
  topics: new Map([
    ['inv-geo-1', topic('inv-geo-1', 'inv-geo', 'Invented coasts')],
    ['inv-geo-2', topic('inv-geo-2', 'inv-geo', 'Invented rivers')],
    ['inv-his-1', topic('inv-his-1', 'inv-his', 'Invented treaties')],
  ]),
};

async function fakeStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wp131a-'));
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
    async logEvent(type, options = {}) { const e = makeEvent(type, options); events.push(e); return e; },
  };
}

async function setup({ light = () => JSON.stringify({ title: 'Osmosis in plant cells.' }), level = 0 } = {}) {
  const store = await fakeStore();
  const ai = createMockAi({
    replies: {
      [MODELS.conversation]: () => JSON.stringify({ reply: 'Invented reply.', replyType: 'other', taskSpecific: false, sources: [], wellbeingLevel: level }),
      [MODELS.light]: light,
      [MODELS.checker]: () => JSON.stringify({ leak: false, reason: 'invented' }),
    },
  });
  const call = (method, url, body, role = 'learner') => {
    const match = matchApiRoute(method, url);
    assert.ok(match?.route, `route ${method} ${url}`);
    return handleApi({ match, pass: { role }, store, body, getCurriculum: () => curriculum, getAi: () => ({ ai, models: MODELS }), log: silent });
  };
  return { store, ai, call, done: () => rm(store.dir, { recursive: true, force: true }) };
}

test('subject labels: private settings first, in their order; otherwise shortened titles; inactive left out', async () => {
  assert.equal(shortLabel('Exampleboard A-level Invented Geography', 'Exampleboard'), 'Invented Geography');
  assert.equal(shortLabel('Pearson BTEC Level 3 National Extended Certificate in Invented Studies'), 'Invented Studies');
  assert.ok(shortLabel('A very long invented qualification title that goes on and on').length <= 24);
  const store = await fakeStore();
  try {
    assert.deepEqual(await subjectsFor(store, curriculum), [{ id: 'inv-geo', label: 'Invented Geography' }, { id: 'inv-his', label: 'Invented History' }]);
    await store.put(SUBJECTS_FILE, { subjects: [{ qualificationId: 'inv-his', label: 'Hist' }, { qualificationId: 'inv-geo', label: 'Geog' }] });
    assert.deepEqual((await subjectsFor(store, curriculum)).map((s) => s.label), ['Hist', 'Geog']);
  } finally { await rm(store.dir, { recursive: true, force: true }); }
});

test('chat names: from the task for a task chat; the AI\'s or his for others; a date when there is none', () => {
  assert.equal(chatName({ route: 'plan' }, { title: 'Invented coast essay' }), 'Invented coast essay – plan');
  assert.equal(chatName({ route: 'learn', name: { value: 'Osmosis', author: 'ai' } }), 'Osmosis');
  assert.match(chatName({ route: 'learn', createdAt: '2026-11-17T10:00:00Z' }), /^Chat, 17 Nov$/);
  assert.equal(parseName('{"title": "“Longshore drift explained.”"}'), 'Longshore drift explained');
  assert.equal(parseName('nonsense'), null);
});

test('the menu: tasks by due date (done ones too), chats with replies newest first, topics worked on', async () => {
  const { store, call, done } = await setup();
  try {
    const later = (await call('POST', '/api/tasks', { title: 'Invented later task', deadline: '2026-12-20', topicIds: ['inv-geo-2'] })).body.task;
    const soon = (await call('POST', '/api/tasks', { title: 'Invented soon task', deadline: '2026-12-01', topicIds: ['inv-geo-1'] })).body.task;
    await call('PATCH', `/api/tasks/${later.id}`, { stage: 'done' });
    const onTask = (await call('POST', '/api/conversations', { route: 'research', taskId: soon.id })).body.conversation;
    await call('POST', `/api/conversations/${onTask.id}/messages`, { text: 'Invented first go at the question' });
    const free = (await call('POST', '/api/conversations', { route: 'learn', topicId: 'inv-his-1' })).body.conversation;
    await call('POST', `/api/conversations/${free.id}/messages`, { text: 'what is osmosis' });
    await call('POST', '/api/conversations', { route: 'learn' }); // never answered: not listed
    const note = newRecord('note', { type: 'note', title: 'Invented note', text: { value: 'Invented.', author: 'learner' }, topicIds: ['inv-geo-2'] }, { createdBy: 'learner' });
    await store.put(`notebook/${note.id}.json`, note);
    const r = await call('GET', '/api/menu');
    assert.equal(r.status, 200);
    const { menu } = r.body;
    assert.deepEqual(menu.tasks.map((t) => [t.title, t.stage, t.qualId]), [['Invented soon task', 'not-started', 'inv-geo'], ['Invented later task', 'done', 'inv-geo']]);
    // saved in the same second here, so compared in name order (the menu sorts newest first)
    assert.deepEqual(menu.chats.map((c) => [c.name, c.taskId, c.qualId, c.renamable]).sort((a, b) => b[0].localeCompare(a[0])), [
      ['Osmosis in plant cells', null, 'inv-his', true],
      ['Invented soon task – research', soon.id, 'inv-geo', false],
    ]);
    assert.deepEqual(menu.topics.map((t) => t.id).sort(), ['inv-geo-1', 'inv-geo-2', 'inv-his-1']);
    assert.deepEqual(menu.subjects.map((s) => s.id), ['inv-geo', 'inv-his']);
    assert.equal((await call('GET', '/api/menu', null, 'parent')).status, 403);
  } finally { await done(); }
});

test('renaming: chats with no task only; the new name shows in the menu; events carry no text', async () => {
  const { store, call, done } = await setup();
  try {
    const task = (await call('POST', '/api/tasks', { title: 'Invented task' })).body.task;
    const free = (await call('POST', '/api/conversations', { route: 'learn' })).body.conversation;
    await call('POST', `/api/conversations/${free.id}/messages`, { text: 'what is osmosis' });
    const r = await call('PATCH', `/api/conversations/${free.id}`, { name: '  My invented osmosis chat ' });
    assert.deepEqual([r.status, r.body.conversation.name], [200, 'My invented osmosis chat']);
    assert.equal((await call('GET', '/api/menu')).body.menu.chats[0].name, 'My invented osmosis chat');
    const onTask = (await call('POST', '/api/conversations', { route: 'research', taskId: task.id })).body.conversation;
    const refused = await call('PATCH', `/api/conversations/${onTask.id}`, { name: 'x' });
    assert.deepEqual([refused.status, refused.body.error], [409, MENU_MESSAGES.taskChat]);
    assert.equal((await call('PATCH', `/api/conversations/${free.id}`, { name: '   ' })).status, 400);
    assert.ok(!JSON.stringify(store.events).includes('osmosis chat'));
  } finally { await done(); }
});

test('naming: only a chat with no task, only from the first message, never from a level 2–3 message', async () => {
  const upset = await setup({ level: 3 });
  try {
    const c = (await upset.call('POST', '/api/conversations', { route: 'learn' })).body.conversation;
    const r = await upset.call('POST', `/api/conversations/${c.id}/messages`, { text: 'invented upsetting message' });
    assert.equal(r.body.conversation.name, null);
    assert.equal(upset.ai.calls.filter((x) => x.model === MODELS.light && x.system?.startsWith('You name a study chat')).length, 0);
  } finally { await upset.done(); }
  const { ai, call, done } = await setup();
  try {
    const task = (await call('POST', '/api/tasks', { title: 'Invented task' })).body.task;
    const onTask = (await call('POST', '/api/conversations', { route: 'research', taskId: task.id })).body.conversation;
    await call('POST', `/api/conversations/${onTask.id}/messages`, { text: 'Invented go' });
    const free = (await call('POST', '/api/conversations', { route: 'learn' })).body.conversation;
    await call('POST', `/api/conversations/${free.id}/messages`, { text: 'what is osmosis' });
    await call('POST', `/api/conversations/${free.id}/messages`, { text: 'and diffusion?' });
    const naming = ai.calls.filter((x) => x.model === MODELS.light && x.system?.startsWith('You name a study chat'));
    assert.equal(naming.length, 1, 'named once, for the chat with no task');
    assert.match(naming[0].prompt, /<learner_message>what is osmosis<\/learner_message>/);
  } finally { await done(); }
});

test('the snapshot carries the menu: names and titles, never chat text', async () => {
  const { store, call, done } = await setup();
  try {
    const free = (await call('POST', '/api/conversations', { route: 'learn' })).body.conversation;
    await call('POST', `/api/conversations/${free.id}/messages`, { text: 'Invented private chat words' });
    const snap = await buildSnapshot({ dir: store.dir, curriculum });
    assert.deepEqual(snap.learner.menu.chats.map((c) => c.name), ['Osmosis in plant cells']);
    assert.deepEqual(snap.learner.menu.subjects.map((s) => s.label), ['Invented Geography', 'Invented History']);
    assert.ok(!JSON.stringify(snap).includes('Invented private chat words'));
    assert.equal(snap.parent.menu, undefined);
  } finally { await done(); }
});
