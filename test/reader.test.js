// The photo reader (WP-106): backlog, blob attachments, re-reading, failures, the daily ceiling and
// privacy. Mock AI and a temporary folder only; invented text only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makeEvent } from '../server/storage/records.js';
import { uploadRecord } from '../server/storage/inbox.js';
import { createMockAi } from '../server/ai/mock.js';
import { READ_SYSTEM, MATCH_SYSTEM } from '../server/ai/reading.js';
import {
  readUpload, processBacklog, pendingImageUploads, pendingUploads, startReader, createLimitCache, uploadPath, MAX_READ_TRIES,
} from '../server/reader.js';

const MODELS = { light: 'demo-light', conversation: 'demo-conversation' };
const SECRET_WORDS = ['Evalaute', 'Imaginary', 'shoreline', 'My own invented paragraph'];
const BRIEF_TEXT = 'Homework.\nQuestion: Evalaute how well the sea wall at Imaginary Bay protects the shoreline.';

async function tempStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'reader-test-'));
  const events = [];
  const store = {
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
  return store;
}

async function addUpload(store, { clientId = 'pDemo0001', kind = 'brief', mimeType = 'image/jpeg', bytes = 2048, writeFileToo = true } = {}) {
  const meta = { clientId, mimeType, bytes, source: 'camera', kind, capturedAt: null, receivedAt: null };
  const record = uploadRecord({ meta, sizeCheck: { state: 'not-checked', reason: null }, now: new Date('2026-11-02T09:00:00Z') });
  await store.put(uploadPath(record.id), record);
  if (writeFileToo) {
    await mkdir(path.join(store.dir, 'uploads'), { recursive: true });
    await writeFile(path.join(store.dir, record.file), Buffer.from('invented image bytes'));
  }
  return record;
}

const briefReply = (confidence) => JSON.stringify({
  text: BRIEF_TEXT,
  confidence,
  uncertain: [],
  corrections: [{ original: 'Evalaute', corrected: 'Evaluate', position: 20 }, { original: 'Imaginary', corrected: 'Imagined', position: 54 }],
  task: { title: 'Sea wall evaluation', subject: 'Geography', qualificationId: 'demo-geo', kind: 'homework', question: 'Evalaute how well the sea wall at Imaginary Bay protects the shoreline.', deadline: '2026-11-13' },
  anchors: [{ type: 'location', text: 'Imaginary Bay' }],
  uncertainFields: [],
});

function demoCurriculum() {
  return {
    qualifications: new Map([['demo-geo', { id: 'demo-geo', title: 'Demo Geography', record: { active: true }, status: { active: [], current: [] } }]]),
    topics: new Map([
      ['demo-geo-1', { id: 'demo-geo-1', qualId: 'demo-geo', unitId: null, title: 'Coastal management', kind: 'content' }],
      ['demo-geo-2', { id: 'demo-geo-2', qualId: 'demo-geo', unitId: null, title: 'River landforms', kind: 'content' }],
    ]),
  };
}

function handleWith(replies, extra = {}) {
  const ai = createMockAi({ replies, ...extra });
  return { ai, models: MODELS };
}
const anyLimits = createLimitCache(async () => ({ vision: true, maxBytes: null, mediaTypes: null }));
const quiet = { log: () => {}, error: () => {} };

test('a brief is read by the light model as a blob, corrected, anchored and matched to a topic', async () => {
  const store = await tempStore();
  try {
    const record = await addUpload(store);
    const handle = handleWith({
      [MODELS.light]: ({ system }) => (system === READ_SYSTEM ? briefReply(0.95) : '{"topicIds": ["demo-geo-1"], "confidence": 0.9}'),
    });
    const result = await readUpload({ store, handle, record, curriculum: demoCurriculum(), limitsFor: anyLimits });
    assert.deepEqual(result, { status: 'done' });
    const calls = handle.ai.calls;
    assert.equal(calls.length, 2);
    assert.equal(calls[0].model, MODELS.light);
    assert.equal(calls[0].attachments.length, 1);
    const att = calls[0].attachments[0];
    assert.equal(att.type, 'blob');
    assert.equal(att.mimeType, 'image/jpeg');
    assert.equal(Buffer.from(att.data, 'base64').toString(), 'invented image bytes');
    assert.equal('path' in att, false);
    assert.equal(att.displayName.includes('/'), false);
    assert.match(calls[0].prompt, /- demo-geo = Demo Geography/);
    assert.equal(calls[1].system, MATCH_SYSTEM);
    assert.equal(calls[1].attachments, undefined);
    assert.match(calls[1].prompt, /Question: Evaluate how well/);

    const saved = await store.read(uploadPath(record.id));
    assert.equal(saved.status, 'done');
    assert.deepEqual(saved.extractedText, { value: BRIEF_TEXT, author: 'source' });
    assert.deepEqual(saved.spellingCorrections.map((c) => c.corrected), ['Evaluate']);
    assert.equal(saved.reread, false);
    assert.deepEqual(saved.readBy, { role: 'light', model: MODELS.light });
    assert.equal(saved.proposal.deadline, '2026-11-13');
    assert.equal(saved.proposal.qualificationId, 'demo-geo');
    assert.deepEqual(saved.proposal.topicIds, ['demo-geo-1']);
    assert.equal(saved.proposal.uncertainFields.includes('topics'), false);
    assert.equal(saved.proposal.question.verbatim.startsWith('Evalaute'), true);
    assert.deepEqual(saved.proposal.anchors.map((a) => [a.type, a.text.value]), [
      ['question', 'Evaluate how well the sea wall at Imaginary Bay protects the shoreline.'],
      ['location', 'Imaginary Bay'],
    ]);

    // events and AI turn records hold ids and counts only
    assert.deepEqual(store.events.map((e) => e.type), ['upload.read']);
    assert.deepEqual(store.events[0].payload, {
      uploadId: record.id, kind: 'brief', method: 'image', role: 'light', reread: false, chars: BRIEF_TEXT.length,
      uncertain: 0, corrections: 1, anchors: 2, topics: 1,
    });
    const turnFolders = await readdir(path.join(store.dir, 'ai-turns'));
    const turns = [];
    for (const month of turnFolders) {
      for (const name of await readdir(path.join(store.dir, 'ai-turns', month))) {
        turns.push(JSON.parse(await readFile(path.join(store.dir, 'ai-turns', month, name), 'utf8')));
      }
    }
    assert.deepEqual(turns.map((t) => t.feature).sort(), ['match-topics', 'read-upload']);
    const privateText = JSON.stringify([store.events, turns]);
    for (const word of SECRET_WORDS) assert.equal(privateText.includes(word), false, word);
  } finally {
    await store.cleanup();
  }
});

test('an unsure reading is read again by the conversation model, and the better one is kept', async () => {
  const store = await tempStore();
  try {
    const record = await addUpload(store);
    const handle = handleWith({
      [MODELS.light]: ({ system }) => (system === READ_SYSTEM ? briefReply(0.4) : '{"topicIds": [], "confidence": 0}'),
      [MODELS.conversation]: briefReply(0.9),
    });
    assert.deepEqual(await readUpload({ store, handle, record, curriculum: demoCurriculum(), limitsFor: anyLimits }), { status: 'done' });
    assert.deepEqual(handle.ai.calls.map((c) => c.model), [MODELS.light, MODELS.conversation, MODELS.light]);
    assert.equal(handle.ai.calls[1].attachments[0].type, 'blob');
    const saved = await store.read(uploadPath(record.id));
    assert.equal(saved.reread, true);
    assert.equal(saved.readBy.role, 'conversation');
    assert.deepEqual(saved.proposal.topicIds, []);
    assert.equal(saved.proposal.uncertainFields.includes('topics'), true);
  } finally {
    await store.cleanup();
  }
});

test("the learner's own writing is copied exactly: no corrections, no draft task, no topic call", async () => {
  const store = await tempStore();
  try {
    const record = await addUpload(store, { kind: 'own' });
    const reply = JSON.stringify({ text: 'My own invented paragraph wiht a slip.', confidence: 0.9, corrections: [{ original: 'wiht', corrected: 'with' }] });
    const handle = handleWith({ [MODELS.light]: reply });
    assert.deepEqual(await readUpload({ store, handle, record, curriculum: demoCurriculum(), limitsFor: anyLimits }), { status: 'done' });
    assert.equal(handle.ai.calls.length, 1);
    assert.match(handle.ai.calls[0].prompt, /Never correct, improve or finish it/);
    const saved = await store.read(uploadPath(record.id));
    assert.deepEqual(saved.extractedText, { value: 'My own invented paragraph wiht a slip.', author: 'learner' });
    assert.deepEqual(saved.spellingCorrections, []);
    assert.equal(saved.proposal, null);
  } finally {
    await store.cleanup();
  }
});

test("a photo over the model's limit is marked failed without being sent", async () => {
  const store = await tempStore();
  try {
    const record = await addUpload(store, { bytes: 5000 });
    const handle = handleWith({});
    const small = createLimitCache(async () => ({ vision: true, maxBytes: 4000, mediaTypes: null }));
    assert.deepEqual(await readUpload({ store, handle, record, limitsFor: small }), { status: 'failed', reason: 'too-large' });
    assert.equal(handle.ai.calls.length, 0);
    const saved = await store.read(uploadPath(record.id));
    assert.equal(saved.status, 'failed');
    assert.equal(saved.failureReason, 'too-large');
    assert.equal(saved.sizeCheck, 'failed');
    assert.deepEqual(store.events.map((e) => [e.type, e.payload.reason]), [['upload.failed', 'too-large']]);
    // a missing file is a failure too, and limits not yet known means wait
    const lost = await addUpload(store, { clientId: 'pDemo0002', writeFileToo: false });
    assert.deepEqual(await readUpload({ store, handle, record: lost, limitsFor: anyLimits }), { status: 'failed', reason: 'file-missing' });
    const later = await addUpload(store, { clientId: 'pDemo0003' });
    assert.deepEqual(await readUpload({ store, handle, record: later, limitsFor: createLimitCache(async () => null) }), { status: 'waiting', reason: 'limits-unknown' });
  } finally {
    await store.cleanup();
  }
});

test('AI errors leave the photo waiting; unusable replies count, then fail it', async () => {
  const store = await tempStore();
  try {
    await addUpload(store);
    await addUpload(store, { clientId: 'pDemo0002' });
    const failing = handleWith({}, { failures: { [MODELS.light]: 'invented outage' } });
    const errored = await processBacklog({ store, handle: failing, limitsFor: anyLimits, log: quiet });
    assert.equal(errored.error, 1);
    assert.equal(errored.reason, 'ai-error');
    assert.equal(failing.ai.calls.length, 1, 'the cycle stops at the first AI error');
    assert.equal((await pendingImageUploads(store)).length, 2);

    const junk = handleWith({ [MODELS.light]: 'no json here', [MODELS.conversation]: '{"text": ""}' });
    for (let i = 1; i < MAX_READ_TRIES; i += 1) {
      const s = await processBacklog({ store, handle: junk, limitsFor: anyLimits, log: quiet, limit: 1 });
      assert.equal(s.again, 1);
    }
    const last = await processBacklog({ store, handle: junk, limitsFor: anyLimits, log: quiet, limit: 1 });
    assert.equal(last.failed, 1);
    const failed = (await store.read(uploadPath('up_pDemo0001')));
    assert.equal(failed.status, 'failed');
    assert.equal(failed.failureReason, 'unreadable');
    assert.equal(failed.readTries, MAX_READ_TRIES);
  } finally {
    await store.cleanup();
  }
});

test('the daily AI ceiling pauses reading without touching the photo', async () => {
  const store = await tempStore();
  try {
    const record = await addUpload(store);
    const handle = handleWith({ [MODELS.light]: briefReply(0.95) });
    const ceiling = { take: () => ({ ok: false }) };
    assert.deepEqual(await readUpload({ store, handle, record, aiCeiling: ceiling, limitsFor: anyLimits }), { status: 'waiting', reason: 'ai-ceiling' });
    assert.equal(handle.ai.calls.length, 0);
    assert.equal((await store.read(uploadPath(record.id))).status, 'processing');
  } finally {
    await store.cleanup();
  }
});

test('only waiting uploads are picked up: photos and (WP-107) documents; done and failed are left alone', async () => {
  const store = await tempStore();
  try {
    await addUpload(store, { clientId: 'fDemo0001', mimeType: 'application/pdf' });
    const done = await addUpload(store, { clientId: 'pDemo0002' });
    await store.put(uploadPath(done.id), { ...done, status: 'done' });
    await addUpload(store, { clientId: 'pDemo0003' });
    await store.put('uploads/not-an-upload.json', { id: 'not-an-upload', status: 'processing', mimeType: 'image/jpeg' });
    assert.deepEqual((await pendingImageUploads(store)).map((r) => r.id), ['up_pDemo0003']);
    assert.deepEqual((await pendingUploads(store)).map((r) => r.id).sort(), ['up_fDemo0001', 'up_pDemo0003']);
  } finally {
    await store.cleanup();
  }
});

test('startReader: waits until ready, reads, logs counts only, and stops', async () => {
  const store = await tempStore();
  try {
    await addUpload(store);
    const handle = handleWith({ [MODELS.light]: ({ system }) => (system === READ_SYSTEM ? briefReply(0.95) : '{"topicIds": [], "confidence": 0}') });
    const lines = [];
    const log = { log: (l) => lines.push(l), error: (l) => lines.push(l) };
    let ready = false;
    let timers = 0;
    const reader = startReader({
      getStore: () => store, getAi: () => handle, getCurriculum: () => null, isReady: () => ready, log,
      loadLimits: async () => ({ vision: true, maxBytes: null, mediaTypes: null }),
      setTimer: () => { timers += 1; return { unref() {} }; }, clearTimer: () => {},
    });
    assert.equal(timers, 1);
    assert.deepEqual(await reader.runOnce(), { ok: true, skipped: true });
    assert.equal(handle.ai.calls.length, 0);
    ready = true;
    const result = await reader.runOnce();
    assert.equal(result.done, 1);
    assert.deepEqual(lines, ['[reader] read 1 upload; 0 could not be read']);
    reader.stop();
    for (const word of SECRET_WORDS) assert.equal(lines.join('\n').includes(word), false);
  } finally {
    await store.cleanup();
  }
});
