// WP-115c: one "Type or paste it" form (a due date he picks wins over one read from the text, and it
// can wait on the device while the tutor wakes), topics matched once for tasks that have none, and
// earlier research found through a task's current topics. Mock AI, temporary folders, invented text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makeEvent, newRecord } from '../server/storage/records.js';
import { createMockAi } from '../server/ai/mock.js';
import { DOC_SYSTEM } from '../server/ai/reading.js';
import { readUpload, createLimitCache, uploadPath, matchMissingTopics } from '../server/reader.js';
import { addPastedBrief } from '../server/domain/uploads.js';
import { createTask, readTask } from '../server/domain/tasks.js';
import { earlierResearch, notebookEntryPath } from '../server/domain/notebook.js';
import { pasteBody, CHECK_MESSAGES } from '../web/shared/task-check.js';

const MODELS = { light: 'demo-light', conversation: 'demo-conversation' };
const anyLimits = createLimitCache(async () => ({ vision: true, maxBytes: null, mediaTypes: null }));

async function tempStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wp115c-'));
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
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

function demoCurriculum() {
  const qual = (id, title) => ({ id, title, record: { active: true }, status: { active: [], current: [] } });
  const topic = (id, qualId, title) => ({ id, qualId, unitId: null, title, kind: 'content' });
  return {
    qualifications: new Map([['demo-geo', qual('demo-geo', 'Demo Geography')]]),
    topics: new Map([['demo-geo-1', topic('demo-geo-1', 'demo-geo', 'Coastal management')]]),
  };
}

const reply = (deadline) => JSON.stringify({
  confidence: 0.9, uncertain: [], corrections: [],
  task: { title: 'Invented coast question', subject: null, kind: 'homework', question: 'Assess an invented coastline.', deadline },
  anchors: [], uncertainFields: [],
});

test('the due date picked on the form wins over one read from the text; a bad date is refused', async () => {
  const store = await tempStore();
  try {
    const { upload } = await addPastedBrief(store, { clientId: 'tDemo1001', text: 'Invented brief, due 4 December 2026.', deadline: '2026-12-11' });
    assert.equal(upload.givenDeadline, '2026-12-11');
    const ai = createMockAi({ replies: { [MODELS.light]: ({ system }) => (system === DOC_SYSTEM ? reply('2026-12-04') : '{"topicIds": ["demo-geo-1"], "confidence": 0.9}') } });
    assert.deepEqual(await readUpload({ store, handle: { ai, models: MODELS }, record: upload, curriculum: demoCurriculum(), limitsFor: anyLimits }), { status: 'done' });
    const saved = await store.read(uploadPath(upload.id));
    assert.equal(saved.proposal.deadline, '2026-12-11');
    assert.ok(!saved.proposal.uncertainFields.includes('deadline'));
    // without a date on the form, the text's date stands
    const { upload: plain } = await addPastedBrief(store, { clientId: 'tDemo1002', text: 'Invented brief, due 4 December 2026.' });
    await readUpload({ store, handle: { ai, models: MODELS }, record: plain, curriculum: demoCurriculum(), limitsFor: anyLimits });
    assert.equal((await store.read(uploadPath(plain.id))).proposal.deadline, '2026-12-04');
    await assert.rejects(addPastedBrief(store, { clientId: 'tDemo1003', text: 'Invented', deadline: '2026-02-30' }), /deadline must be a date/);
  } finally { await store.cleanup(); }
});

test('topics are matched once for tasks that have none; qualification and subject fill in only when empty', async () => {
  const store = await tempStore();
  try {
    const typed = await createTask(store, { title: 'Invented coast task', questionText: 'Assess an invented coastline.', confirmed: true });
    const matched = await createTask(store, { title: 'Invented matched task', topicIds: ['demo-geo-1'], confirmed: true });
    const ai = createMockAi({ replies: { [MODELS.light]: () => '{"topicIds": ["demo-geo-1"], "confidence": 0.9}' } });
    const r = await matchMissingTopics({ store, handle: { ai, models: MODELS }, curriculum: demoCurriculum() });
    assert.deepEqual(r, { matched: 1, tried: 1 });
    const t = await readTask(store, typed.id);
    assert.deepEqual([t.topicIds, t.qualificationId, t.subject], [['demo-geo-1'], 'demo-geo', 'Demo Geography']);
    assert.ok(t.topicsCheckedAt);
    assert.match(ai.calls[0].prompt, /<source_text>[\s\S]*Assess an invented coastline\.[\s\S]*<\/source_text>/, 'task text is data, in tags');
    assert.equal((await readTask(store, matched.id)).topicsCheckedAt, undefined, 'tasks with topics are left alone');
    // never twice
    assert.deepEqual(await matchMissingTopics({ store, handle: { ai, models: MODELS }, curriculum: demoCurriculum() }), { matched: 0, tried: 0 });
    assert.equal(ai.calls.length, 1);
    // a task the model can't place is still marked, so it isn't asked about again
    const vague = await createTask(store, { title: 'Invented other task', confirmed: true });
    const none = createMockAi({ replies: { [MODELS.light]: () => '{"topicIds": [], "confidence": 0}' } });
    assert.deepEqual(await matchMissingTopics({ store, handle: { ai: none, models: MODELS }, curriculum: demoCurriculum() }), { matched: 0, tried: 1 });
    assert.ok((await readTask(store, vague.id)).topicsCheckedAt);
    assert.ok(!JSON.stringify(store.events).includes('invented coastline'), 'events hold counts only');
  } finally { await store.cleanup(); }
});

test('earlier research uses a task\'s current topics, so research saved before its task had topics is found', async () => {
  const store = await tempStore();
  try {
    const old = await createTask(store, { title: 'Invented older task', confirmed: true });
    const summary = newRecord('note', {
      type: 'summary', title: 'Invented study', text: { value: 'Invented AI summary.', author: 'ai' }, taskId: old.id, topicIds: [], sharedWithParent: null,
    }, { createdBy: 'ai' });
    await store.put(notebookEntryPath(summary.id), summary);
    const fresh = await createTask(store, { title: 'Invented new task', topicIds: ['demo-geo-1'], confirmed: true });
    assert.equal((await earlierResearch(store, fresh.id)).count, 0, 'no topics anywhere yet');
    const ai = createMockAi({ replies: { [MODELS.light]: () => '{"topicIds": ["demo-geo-1"], "confidence": 0.9}' } });
    await matchMissingTopics({ store, handle: { ai, models: MODELS }, curriculum: demoCurriculum() });
    const found = await earlierResearch(store, fresh.id);
    assert.deepEqual([found.count, found.entries[0].id], [1, summary.id]);
  } finally { await store.cleanup(); }
});

test('the form: text and an optional real date', async () => {
  assert.deepEqual(pasteBody({ text: '  Invented task.  ', deadline: '' }), { text: 'Invented task.', deadline: null });
  assert.deepEqual(pasteBody({ text: 'Invented task.', deadline: '2026-12-11' }), { text: 'Invented task.', deadline: '2026-12-11' });
  assert.deepEqual(pasteBody({ text: ' ', deadline: '' }), { error: CHECK_MESSAGES.pasteEmpty, field: 'text' });
  assert.deepEqual(pasteBody({ text: 'Invented', deadline: '2026-13-01' }), { error: CHECK_MESSAGES.badDate, field: 'deadline' });

});
