// Upload routes (WP-108a): open what was read, confirm the draft task (A-001 undo, anchor chips),
// paste a brief. Learner only. Calls handleApi directly with a fake store. Invented data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makeEvent } from '../server/storage/records.js';
import { matchApiRoute, handleApi } from '../server/api.js';
import { fieldsToAsk, UPLOAD_MESSAGES, PASTE_MAX_CHARS } from '../server/domain/uploads.js';
import { uploadPath, PASTE_TYPE } from '../server/reader.js';

const curriculum = {
  qualifications: new Map([['demo-geo', {}]]),
  topics: new Map([['demo-geo-1a', {}], ['demo-geo-2b', {}]]),
};
const TEXT = 'Homework due soon.\nQuestion: Asess the flood defences at Imaginary Vale and explian their impact.';
const VERBATIM = 'Asess the flood defences at Imaginary Vale and explian their impact.';
const CORRECTED = 'Assess the flood defences at Imaginary Vale and explain their impact.';
const UNDONE = 'Assess the flood defences at Imaginary Vale and explian their impact.';
const PRIVATE_WORDS = ['Asess', 'Imaginary', 'flood', 'Invented', 'pasted'];
const corr = (original, corrected) => ({ original, corrected, position: TEXT.indexOf(original), undone: false });
const draftAnchor = (type, value) => ({ type, text: { value, author: 'source' }, confirmed: false });

function proposal(extra = {}) {
  return {
    title: 'Flood defences homework', subject: null, qualificationId: 'demo-geo', kind: 'homework', workType: null,
    question: { verbatim: VERBATIM, corrected: CORRECTED }, deadline: null, marks: 12, wordCount: null,
    anchors: [draftAnchor('question', CORRECTED), draftAnchor('location', 'Imaginary Vale')],
    topicIds: ['demo-geo-1a'], uncertainFields: ['workType'], ...extra,
  };
}

function upload(id = 'up_pDemo0001', extra = {}) {
  return {
    id, createdAt: '2026-11-02T09:00:00+00:00', updatedAt: '2026-11-02T09:00:00+00:00', createdBy: 'learner', schemaVersion: 1,
    clientId: id.slice(3), file: `uploads/${id}.jpg`, mimeType: 'image/jpeg', bytes: 1000, origin: 'photo', source: 'camera',
    contentKind: 'brief', status: 'done', failureReason: null, extractedText: { value: TEXT, author: 'source' },
    truncated: false, uncertain: [], spellingCorrections: [corr('Asess', 'Assess'), corr('explian', 'explain')],
    proposal: proposal(), readAt: '2026-11-02T09:01:00+00:00', taskId: null, ...extra,
  };
}

async function fakeStore(records = []) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wp108a-'));
  const events = [];
  const store = {
    dir,
    events,
    status: () => ({ ready: true }),
    async put(rel, record) {
      await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await writeFile(path.join(dir, rel), JSON.stringify(record));
      return record;
    },
    async read(rel) {
      try { return JSON.parse(await readFile(path.join(dir, rel), 'utf8')); } catch { return null; }
    },
    async list(rel) {
      try { return (await readdir(path.join(dir, rel))).sort(); } catch { return []; }
    },
    async logEvent(type, options = {}) {
      const event = makeEvent(type, options);
      events.push(event);
      return event;
    },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
  for (const r of records) await store.put(uploadPath(r.id), r);
  return store;
}

async function call(store, method, url, { role = 'learner', body } = {}) {
  const match = matchApiRoute(method, url);
  assert.ok(match?.route, `${method} ${url} is a route`);
  return handleApi({ match, pass: { role }, store, body: body ?? null, getCurriculum: () => curriculum });
}

const taskDirs = async (store) => (await readdir(path.join(store.dir, 'tasks')).catch(() => []));

test('routes: paste, open and confirm are matched; the confirm path refuses GET', () => {
  assert.equal(matchApiRoute('POST', '/api/uploads/paste').route.name, 'pasteBrief');
  assert.deepEqual(matchApiRoute('GET', '/api/uploads/up_pDemo0001').params, ['up_pDemo0001']);
  assert.equal(matchApiRoute('POST', '/api/uploads/up_pDemo0001/confirm').route.name, 'confirmUpload');
  assert.deepEqual(matchApiRoute('GET', '/api/uploads/up_pDemo0001/confirm'), { status: 405, allow: ['POST'] });
});

test('the parent role is refused on every upload route, and nothing is written', async () => {
  const store = await fakeStore([upload()]);
  try {
    for (const [method, url, body] of [
      ['GET', '/api/uploads/up_pDemo0001'],
      ['POST', '/api/uploads/up_pDemo0001/confirm', {}],
      ['POST', '/api/uploads/paste', { clientId: 'tDemo0001', text: 'Invented pasted brief' }],
    ]) {
      const r = await call(store, method, url, { role: 'parent', body });
      assert.equal(r.status, 403, `${method} ${url}`);
      assert.equal(JSON.stringify(r.body).includes('Imaginary'), false);
    }
    assert.equal(store.events.length, 0);
    assert.deepEqual(await taskDirs(store), []);
    assert.equal(await store.read(uploadPath('up_tDemo0001')), null);
  } finally {
    await store.cleanup();
  }
});

test('open: the reading, corrections, draft task and the fields to ask about; 404 for unknown ids', async () => {
  const store = await fakeStore([
    upload(),
    upload('up_pDemo0002', { status: 'processing', extractedText: null, proposal: null, spellingCorrections: [] }),
    upload('up_fDemo0003', { status: 'failed', failureReason: 'scanned-pdf', extractedText: null, proposal: null }),
  ]);
  try {
    const r = await call(store, 'GET', '/api/uploads/up_pDemo0001');
    assert.equal(r.status, 200);
    const u = r.body.upload;
    assert.equal(u.text, TEXT);
    assert.equal(u.contentKind, 'brief');
    assert.deepEqual(u.spellingCorrections.map((c) => c.corrected), ['Assess', 'explain']);
    assert.equal(u.proposal.question.corrected, CORRECTED);
    assert.deepEqual(u.ask, ['subject', 'workType', 'deadline'], 'unsure fields and missing essentials, in a fixed order');
    assert.equal(u.taskId, null);

    const waiting = (await call(store, 'GET', '/api/uploads/up_pDemo0002')).body.upload;
    assert.equal(waiting.status, 'processing');
    assert.equal(waiting.text, null);
    assert.deepEqual(waiting.ask, []);
    const failed = (await call(store, 'GET', '/api/uploads/up_fDemo0003')).body.upload;
    assert.equal(failed.failureReason, 'scanned-pdf');

    for (const url of ['/api/uploads/up_missing01', '/api/uploads/paste', '/api/uploads/up_x', '/api/uploads/t_notupload1']) {
      const miss = await call(store, 'GET', url);
      assert.equal(miss.status, 404, url);
      assert.equal(miss.body.error, UPLOAD_MESSAGES.notFound);
    }
  } finally {
    await store.cleanup();
  }
});

test('fieldsToAsk: essentials are always asked for when missing; nothing for a full draft', () => {
  assert.deepEqual(fieldsToAsk(null), []);
  assert.deepEqual(fieldsToAsk({ title: null, subject: null, deadline: null, question: null, uncertainFields: ['topics', 'nonsense'] }),
    ['title', 'subject', 'question', 'deadline', 'topics']);
  assert.deepEqual(fieldsToAsk(proposal({ subject: 'Geography', deadline: '2026-11-20', uncertainFields: [] })), []);
});

test('confirm: undo a correction, edit and add chips, fill the missing fields; the Task links back to the upload', async () => {
  const store = await fakeStore([upload()]);
  try {
    const r = await call(store, 'POST', '/api/uploads/up_pDemo0001/confirm', {
      body: {
        subject: 'Geography',
        deadline: '2026-11-20',
        workType: 'worksheet',
        undoneCorrections: [TEXT.indexOf('explian')],
        anchors: [
          { type: 'question', text: { value: CORRECTED, author: 'source' } },
          { type: 'location', text: { value: 'Imaginary Vale estuary', author: 'source' } },
          { type: 'location', text: 'Invented Bay' },
        ],
      },
    });
    assert.equal(r.status, 201);
    const t = r.body.task;
    assert.match(t.id, /^t_/);
    assert.equal(t.title, 'Flood defences homework', 'kept from the draft');
    assert.equal(t.subject, 'Geography');
    assert.equal(t.deadline, '2026-11-20');
    assert.equal(t.kind, 'homework');
    assert.equal(t.workType, 'worksheet');
    assert.equal(t.marks, 12);
    assert.equal(t.qualificationId, 'demo-geo');
    assert.deepEqual(t.topicIds, ['demo-geo-1a']);
    assert.equal(t.confirmed, true);
    assert.equal(t.createdBy, 'ai');
    assert.deepEqual(t.sourceUploads, ['up_pDemo0001']);
    assert.deepEqual(t.questionText, { value: UNDONE, author: 'source' }, 'the undone correction is not applied');
    assert.deepEqual(t.anchors.map((a) => [a.type, a.text.value, a.text.author, a.confirmed]), [
      ['question', UNDONE, 'source', true],
      ['location', 'Imaginary Vale estuary', 'source', true],
      ['location', 'Invented Bay', 'learner', true],
    ]);
    assert.deepEqual(await store.read(`tasks/${t.id}/task.json`), t);

    const saved = await store.read(uploadPath('up_pDemo0001'));
    assert.equal(saved.taskId, t.id);
    assert.ok(saved.confirmedAt);
    assert.deepEqual(saved.spellingCorrections.map((c) => c.undone), [false, true]);
    assert.equal(saved.extractedText.value, TEXT, 'the verbatim text stays on the upload');
    assert.equal(r.body.upload.taskId, t.id);
    assert.deepEqual(r.body.upload.ask, []);

    assert.deepEqual(store.events.map((e) => e.type), ['task.created', 'upload.confirmed']);
    const ev = store.events[1];
    assert.deepEqual(ev.links, { uploadId: 'up_pDemo0001', taskId: t.id });
    assert.deepEqual(ev.payload.changed.sort(), ['anchors', 'deadline', 'subject', 'workType']);
    assert.equal(ev.payload.undone, 1);
    const eventText = JSON.stringify(store.events);
    for (const word of PRIVATE_WORDS) assert.equal(eventText.includes(word), false, word);

    const again = await call(store, 'POST', '/api/uploads/up_pDemo0001/confirm', { body: {} });
    assert.equal(again.status, 409);
    assert.equal(again.body.taskId, t.id);
    assert.equal((await taskDirs(store)).length, 1);
  } finally {
    await store.cleanup();
  }
});

test('confirm with no changes uses the draft; a missing title must be given', async () => {
  const store = await fakeStore([upload(), upload('up_pDemo0002', { proposal: proposal({ title: null }) })]);
  try {
    const r = await call(store, 'POST', '/api/uploads/up_pDemo0001/confirm', { body: {} });
    assert.equal(r.status, 201);
    assert.equal(r.body.task.questionText.value, CORRECTED);
    assert.deepEqual(r.body.task.anchors.map((a) => [a.type, a.text.value, a.confirmed]), [
      ['question', CORRECTED, true], ['location', 'Imaginary Vale', true],
    ]);
    assert.equal(r.body.task.deadline, null);
    assert.deepEqual(store.events.at(-1).payload.changed, []);

    const noTitle = await call(store, 'POST', '/api/uploads/up_pDemo0002/confirm', { body: {} });
    assert.equal(noTitle.status, 400);
    assert.match(noTitle.body.error, /title is required/);
    assert.equal((await store.read(uploadPath('up_pDemo0002'))).taskId, null);
    const ok = await call(store, 'POST', '/api/uploads/up_pDemo0002/confirm', { body: { title: 'Invented title' } });
    assert.equal(ok.status, 201);
  } finally {
    await store.cleanup();
  }
});

test('confirm: the learner can fix the question; a question chip left alone follows it', async () => {
  const store = await fakeStore([upload()]);
  try {
    const fixed = 'Assess the flood defences at Imaginary Vale.';
    const r = await call(store, 'POST', '/api/uploads/up_pDemo0001/confirm', { body: { questionText: fixed } });
    assert.equal(r.status, 201);
    assert.deepEqual(r.body.task.questionText, { value: fixed, author: 'source' });
    assert.equal(r.body.task.anchors[0].text.value, fixed);
    assert.deepEqual(store.events.at(-1).payload.changed, ['question']);
  } finally {
    await store.cleanup();
  }
});

test('two confirmations at once make one task', async () => {
  const store = await fakeStore([upload()]);
  try {
    const results = await Promise.all([1, 2].map(() => call(store, 'POST', '/api/uploads/up_pDemo0001/confirm', { body: {} })));
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
    assert.equal((await taskDirs(store)).length, 1);
  } finally {
    await store.cleanup();
  }
});

test('confirm refuses: not read yet, own writing, unknown upload, bad undo list, thesis chips, unknown fields', async () => {
  const store = await fakeStore([
    upload(),
    upload('up_pDemo0002', { status: 'processing' }),
    upload('up_pDemo0003', { contentKind: 'own', proposal: null }),
  ]);
  try {
    const url = '/api/uploads/up_pDemo0001/confirm';
    const cases = [
      ['/api/uploads/up_pDemo0002/confirm', {}, 409, UPLOAD_MESSAGES.notRead],
      ['/api/uploads/up_pDemo0003/confirm', {}, 409, UPLOAD_MESSAGES.notBrief],
      ['/api/uploads/up_missing01/confirm', {}, 404, /Upload not found/],
      [url, { undoneCorrections: [9999] }, 400, /unknown correction/],
      [url, { undoneCorrections: 'all' }, 400, /must be a list/],
      [url, { anchors: [{ type: 'thesis', text: 'An invented claim' }] }, 400, /anchor type/],
      [url, { anchors: [{ type: 'location' }] }, 400, /anchor text is required/],
      [url, { stage: 'done' }, 400, /unknown field stage/],
      [url, { deadline: '2026-02-30' }, 400, /deadline/],
      [url, { topicIds: ['demo-unknown-9'] }, 400, /not a known topic/],
      [url, { questionText: 42 }, 400, /questionText must be text/],
    ];
    for (const [u, body, status, message] of cases) {
      const r = await call(store, 'POST', u, { body });
      assert.equal(r.status, status, `${u} ${JSON.stringify(body)}`);
      if (message instanceof RegExp) assert.match(r.body.error, message);
      else assert.equal(r.body.error, message);
      for (const word of PRIVATE_WORDS) assert.equal(r.body.error.includes(word), false, word);
    }
    assert.equal((await call(store, 'POST', url)).status, 400, 'a body is required');
    assert.equal(store.events.length, 0);
    assert.deepEqual(await taskDirs(store), []);
  } finally {
    await store.cleanup();
  }
});

test('paste: saved as a brief waiting to be read; a retry returns the same upload; bad input refused', async () => {
  const store = await fakeStore([upload()]);
  try {
    const text = '  Invented pasted brief:\r\ndescribe an imaginary river.  ';
    const r = await call(store, 'POST', '/api/uploads/paste', { body: { clientId: 'tDemo0001', text } });
    assert.equal(r.status, 201);
    assert.equal(r.body.duplicate, false);
    assert.equal(r.body.upload.id, 'up_tDemo0001');
    assert.equal(r.body.upload.status, 'processing');
    assert.equal(r.body.upload.origin, 'paste');
    assert.equal(r.body.upload.text, null, 'shown once read');
    const saved = await store.read(uploadPath('up_tDemo0001'));
    assert.equal(saved.mimeType, PASTE_TYPE);
    assert.equal(saved.contentKind, 'brief');
    assert.equal(saved.file, null);
    const clean = 'Invented pasted brief:\ndescribe an imaginary river.';
    assert.deepEqual(saved.extractedText, { value: clean, author: 'source' }, 'line endings tidied, ends trimmed');
    for (const key of ['createdAt', 'updatedAt', 'createdBy', 'schemaVersion']) assert.ok(key in saved, key);
    assert.deepEqual(store.events.map((e) => [e.type, e.payload.source, e.payload.chars]), [['upload.received', 'paste', clean.length]]);
    for (const word of PRIVATE_WORDS) assert.equal(JSON.stringify(store.events).includes(word), false, word);

    const retry = await call(store, 'POST', '/api/uploads/paste', { body: { clientId: 'tDemo0001', text } });
    assert.equal(retry.status, 200);
    assert.equal(retry.body.duplicate, true);
    assert.equal(store.events.length, 1);

    const cases = [
      [{ clientId: 'pDemo0001', text: 'x' }, 409, /already used/],
      [{ clientId: 'short', text: 'x' }, 400, /clientId/],
      [{ clientId: 'tDemo0002' }, 400, /text is required/],
      [{ clientId: 'tDemo0002', text: '   ' }, 400, /text is required/],
      [{ clientId: 'tDemo0002', text: 5 }, 400, /text must be text/],
      [{ clientId: 'tDemo0002', text: 'y'.repeat(PASTE_MAX_CHARS + 1) }, 400, /longer than/],
      [{ clientId: 'tDemo0002', text: 'x', kind: 'own' }, 400, /unknown field kind/],
    ];
    for (const [body, status, message] of cases) {
      const res = await call(store, 'POST', '/api/uploads/paste', { body });
      assert.equal(res.status, status, JSON.stringify(body).slice(0, 60));
      assert.match(res.body.error, message);
    }
    assert.equal((await store.read(uploadPath('up_pDemo0001'))).origin, 'photo', 'an existing capture is never replaced');
  } finally {
    await store.cleanup();
  }
});
