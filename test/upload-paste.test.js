// Pasted briefs and upload facts (WP-108a): the reader reads pasted text like a Word file's text (no
// extraction, no attachment); the snapshot labels pasted uploads and says why an upload failed and
// which task it became, never its text. Mock AI and a temporary folder. Invented text only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makeEvent } from '../server/storage/records.js';
import { createMockAi } from '../server/ai/mock.js';
import { DOC_SYSTEM } from '../server/ai/reading.js';
import { readUpload, pendingUploads, createLimitCache, uploadPath, isTextUpload } from '../server/reader.js';
import { addPastedBrief } from '../server/domain/uploads.js';
import { buildSnapshot } from '../server/storage/snapshot.js';

const MODELS = { light: 'demo-light', conversation: 'demo-conversation' };
const PASTED = 'Invented brief due 4 December 2026.\nQuestion: Explian why the imaginary river floods.';
const anyLimits = createLimitCache(async () => ({ vision: true, maxBytes: null, mediaTypes: null }));

async function tempStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'upload-paste-test-'));
  const events = [];
  return {
    dir,
    events,
    async put(rel, record) {
      const file = path.join(dir, rel);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(record));
      return record;
    },
    async read(rel) {
      try {
        return JSON.parse(await readFile(path.join(dir, rel), 'utf8'));
      } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
      }
    },
    async list(rel) {
      try {
        return (await readdir(path.join(dir, rel), { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name).sort();
      } catch {
        return [];
      }
    },
    async logEvent(type, options = {}) {
      const e = makeEvent(type, options);
      events.push(e);
      return e;
    },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

function demoCurriculum() {
  const qual = (id, title) => ({ id, title, record: { active: true }, status: { active: [], current: [] } });
  const topic = (id, qualId, title) => ({ id, qualId, unitId: null, title, kind: 'content' });
  return {
    qualifications: new Map([['demo-geo', qual('demo-geo', 'Demo Geography')]]),
    topics: new Map([['demo-geo-1', topic('demo-geo-1', 'demo-geo', 'Flood management')]]),
  };
}

const briefReply = JSON.stringify({
  confidence: 0.9,
  uncertain: [],
  corrections: [{ original: 'Explian', corrected: 'Explain', position: PASTED.indexOf('Explian') }],
  task: { title: 'Imaginary river floods', subject: null, kind: 'homework', question: 'Explian why the imaginary river floods.', deadline: '2026-12-04' },
  anchors: [{ type: 'location', text: 'Imaginary river' }],
  uncertainFields: [],
});

test('a pasted brief is read from its own text: no extraction, no attachment, a draft task with corrections', async () => {
  const store = await tempStore();
  try {
    const { upload } = await addPastedBrief(store, { clientId: 'tDemo0001', text: PASTED });
    assert.equal(isTextUpload(upload), true);
    assert.deepEqual((await pendingUploads(store)).map((r) => r.id), ['up_tDemo0001']);

    let extracted = 0;
    const extract = async () => {
      extracted += 1;
      return { ok: false, reason: 'empty' };
    };
    const ai = createMockAi({
      replies: { [MODELS.light]: ({ system }) => (system === DOC_SYSTEM ? briefReply : '{"topicIds": ["demo-geo-1"], "confidence": 0.8}') },
    });
    const result = await readUpload({
      store, handle: { ai, models: MODELS }, record: upload, curriculum: demoCurriculum(), limitsFor: anyLimits, extract,
    });
    assert.deepEqual(result, { status: 'done' });
    assert.equal(extracted, 0, 'pasted text is never sent to the extractor');
    assert.equal(ai.calls[0].system, DOC_SYSTEM);
    assert.equal(ai.calls[0].attachments, undefined);
    assert.match(ai.calls[0].prompt, /<source_text>\nInvented brief due[\s\S]*imaginary river floods\.\n<\/source_text>/);

    const saved = await store.read(uploadPath('up_tDemo0001'));
    assert.equal(saved.status, 'done');
    assert.deepEqual(saved.extractedText, { value: PASTED, author: 'source' });
    assert.deepEqual(saved.readBy, { role: 'text', model: null });
    assert.deepEqual(saved.spellingCorrections.map((c) => [c.original, c.corrected]), [['Explian', 'Explain']]);
    assert.equal(saved.proposal.question.corrected, 'Explain why the imaginary river floods.');
    assert.equal(saved.proposal.deadline, '2026-12-04');
    assert.deepEqual(saved.proposal.topicIds, ['demo-geo-1']);
    assert.deepEqual(store.events.map((e) => e.type), ['upload.received', 'upload.read']);
    assert.equal(store.events[1].payload.method, 'text');
    assert.equal(JSON.stringify(store.events).includes('imaginary'), false);
  } finally {
    await store.cleanup();
  }
});

test('a pasted upload with no text left is marked unreadable without an AI call', async () => {
  const store = await tempStore();
  try {
    const { upload } = await addPastedBrief(store, { clientId: 'tDemo0002', text: 'Invented text' });
    const emptied = { ...upload, extractedText: null };
    await store.put(uploadPath(upload.id), emptied);
    const ai = createMockAi();
    const result = await readUpload({ store, handle: { ai, models: MODELS }, record: emptied, limitsFor: anyLimits });
    assert.deepEqual(result, { status: 'failed', reason: 'unreadable' });
    assert.equal(ai.calls.length, 0);
  } finally {
    await store.cleanup();
  }
});

test('snapshot: pasted uploads are labelled; failed ones say why; confirmed ones name their task; never any text', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'upload-snapshot-test-'));
  const put = async (rel, value) => {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), JSON.stringify(value));
  };
  const at = (min) => `2026-11-02T09:0${min}:00+00:00`;
  try {
    await put('uploads/up_tDemo0001.json', { id: 'up_tDemo0001', origin: 'paste', status: 'done', taskId: 't_demo0001', extractedText: { value: 'PASTE-TEXT-VOLE', author: 'source' }, updatedAt: at(4) });
    await put('uploads/up_fDemo0002.json', { id: 'up_fDemo0002', origin: 'file', status: 'failed', failureReason: 'scanned-pdf', updatedAt: at(3) });
    await put('uploads/up_pDemo0003.json', { id: 'up_pDemo0003', origin: 'photo', status: 'processing', failureReason: null, updatedAt: at(2) });
    await put('uploads/up_fDemo0004.json', { id: 'up_fDemo0004', origin: 'file', status: 'failed', failureReason: 'Not A Code Word!', updatedAt: at(1) });
    const { learner, parent } = await buildSnapshot({ dir });
    const byId = Object.fromEntries(learner.recent.map((r) => [r.id, r]));
    assert.deepEqual(byId.up_tDemo0001, { type: 'upload', id: 'up_tDemo0001', title: 'Pasted text', updatedAt: at(4), status: 'done', taskId: 't_demo0001' });
    assert.deepEqual(byId.up_fDemo0002, { type: 'upload', id: 'up_fDemo0002', title: 'File', updatedAt: at(3), status: 'failed', failureReason: 'scanned-pdf' });
    assert.deepEqual(byId.up_pDemo0003, { type: 'upload', id: 'up_pDemo0003', title: 'Photo', updatedAt: at(2), status: 'processing' });
    assert.equal('failureReason' in byId.up_fDemo0004, false, 'only code words pass');
    const text = JSON.stringify({ learner, parent });
    assert.equal(text.includes('PASTE-TEXT-VOLE'), false);
    assert.equal(JSON.stringify(parent).includes('up_'), false, 'uploads never appear on the parent side');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
