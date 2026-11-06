// WP-114f (A-010 choice 3B): copies of a source attached as files or photos. Mock AI, a fake store and
// invented data only. The attached text is read from the Upload record and never logged or put in an event.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeEvent } from '../server/storage/records.js';
import { createMockAi } from '../server/ai/mock.js';
import { matchApiRoute, handleApi } from '../server/api.js';
import { INBOX_KINDS } from '../server/storage/inbox.js';
import { buildSnapshot } from '../server/storage/snapshot.js';
import { readUpload } from '../server/reader.js';
import { buildPrompt, LIMITS } from '../server/ai/prompt.js';
import { fileSummaryInstruction } from '../server/ai/sources.js';
import {
  MAX_ATTACHMENTS, ATTACHED_SOURCE_MAX_CHARS, ATTACH_MESSAGES, attachmentIds, mergeUploadIds, attachmentText, attachmentStatus,
} from '../server/domain/attachments.js';
import { sourcePath } from '../server/domain/sources.js';
import { INBOX_KINDS as SCREEN_KINDS, inboxItems } from '../web/shared/capture.js';
import { MAX_ATTACHMENTS as SCREEN_MAX } from '../web/shared/task-panel.js';
import { STAGES, STAGE_LABELS } from '../web/shared/upcoming.js';

const MODELS = Object.freeze({
  conversation: 'mock-conversation', review: 'mock-review', light: 'mock-light',
  spelling: 'mock-spelling', checker: 'mock-checker', judge: 'mock-judge',
});
const MARKER = 'INVENTED-FILE-MARKER';
const QUESTION = 'Evaluate how well the invented Sandy Point scheme manages coastal erosion.';

async function fakeStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wp114f-'));
  const events = [];
  const writes = [];
  return {
    dir, events, writes,
    status: () => ({ ready: true }),
    async put(rel, record) {
      writes.push(rel);
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

async function setup() {
  const store = await fakeStore();
  const logs = [];
  const log = { log: (l) => logs.push(l), error: (l) => logs.push(l), warn: (l) => logs.push(l) };
  const ai = createMockAi({
    replies: {
      [MODELS.conversation]: () => JSON.stringify({ readOriginal: false, summary: 'Invented summary of the attached copy.', section: 'Results' }),
      [MODELS.checker]: () => JSON.stringify({ leak: false, reason: 'invented' }),
    },
  });
  const handle = { ai, models: MODELS };
  const call = (method, url, body, { role = 'learner' } = {}) => {
    const [pathname, search = ''] = url.split('?');
    const match = matchApiRoute(method, pathname);
    assert.ok(match?.route, `route ${method} ${url}`);
    return handleApi({ match, pass: { role }, store, body, query: new URLSearchParams(search), getAi: () => handle, log });
  };
  const task = (await call('POST', '/api/tasks', {
    title: 'Invented coast task', questionText: QUESTION, topicIds: ['demo-geo-1a'], anchors: [{ type: 'location', text: 'Sandy Point' }],
  })).body.task;
  return { store, logs, ai, call, task };
}

const upload = (store, clientId, fields) => store.put(`uploads/up_${clientId}.json`, {
  id: `up_${clientId}`, contentKind: 'source', mimeType: 'application/pdf', ...fields,
});

// ---------- rules ----------

test('capture IDs become upload IDs, with no repeats and at most five', () => {
  assert.deepEqual(attachmentIds(['sinv0001-aa', 'sinv0001-aa', 'sinv0001-bb']), ['up_sinv0001-aa', 'up_sinv0001-bb']);
  assert.deepEqual(attachmentIds(undefined), []);
  assert.throws(() => attachmentIds('sinv0001-aa'), (e) => e.status === 400 && e.message === ATTACH_MESSAGES.badList);
  assert.throws(() => attachmentIds(['../escape']), (e) => e.status === 400);
  assert.throws(() => attachmentIds(Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => `sinv000${i}-aa`)), (e) => e.message === ATTACH_MESSAGES.tooMany);
  assert.deepEqual(mergeUploadIds(['up_sinv0001-aa'], ['up_sinv0001-aa', 'up_sinv0002-aa']), ['up_sinv0001-aa', 'up_sinv0002-aa']);
});

test('the attached text: waiting until every copy is read; parts joined in order; long text cut and flagged', async () => {
  const store = await fakeStore();
  const source = { uploadIds: ['up_sinv0001-aa', 'up_sinv0002-aa'] };
  assert.deepEqual(await attachmentText(store, {}), { state: 'none' });
  assert.deepEqual(await attachmentText(store, source), { state: 'waiting' }, 'still in the inbox');
  await upload(store, 'sinv0001-aa', { status: 'done', extractedText: { value: ' Page one ', author: 'source' } });
  await upload(store, 'sinv0002-aa', { status: 'processing' });
  assert.deepEqual(await attachmentText(store, source), { state: 'waiting' }, 'still being read');
  await upload(store, 'sinv0002-aa', { status: 'done', extractedText: { value: 'Page two', author: 'source' } });
  assert.deepEqual(await attachmentText(store, source), { state: 'ready', text: '[Part 1 of 2]\nPage one\n\n[Part 2 of 2]\nPage two', shortened: false });
  await upload(store, 'sinv0003-aa', { status: 'done', extractedText: { value: 'x'.repeat(ATTACHED_SOURCE_MAX_CHARS + 5), author: 'source' } });
  const long = await attachmentText(store, { uploadIds: ['up_sinv0003-aa'] });
  assert.deepEqual([long.text.length, long.shortened], [ATTACHED_SOURCE_MAX_CHARS, true]);
  await upload(store, 'sinv0004-aa', { status: 'failed', failureReason: 'unreadable' });
  await upload(store, 'sinv0005-aa', { status: 'done', contentKind: 'brief', extractedText: { value: 'A brief', author: 'source' } });
  const both = { uploadIds: ['up_sinv0004-aa', 'up_sinv0005-aa'] };
  assert.deepEqual(await attachmentText(store, both), { state: 'failed' }, 'a brief is never read out as a source');
  assert.deepEqual((await attachmentStatus(store, both)).map((a) => [a.status, a.failureReason]), [['failed', 'unreadable'], ['failed', 'not-attachment']]);
  await rm(store.dir, { recursive: true, force: true });
});

test('copies of the server rules match the screen and the Worker', () => {
  assert.ok(INBOX_KINDS.includes('source'));
  assert.deepEqual([...SCREEN_KINDS], [...INBOX_KINDS]);
  assert.equal(SCREEN_MAX, MAX_ATTACHMENTS);
  const worker = readFileSync(new URL('../wake/worker.js', import.meta.url), 'utf8');
  assert.ok(worker.includes("const INBOX_KINDS = Object.freeze(['brief', 'own', 'source']);"));
  assert.doesNotMatch(worker, /weekly wake \(WP-016\)/, 'the old weekly-wake comment is gone (A-004)');
  assert.match(worker, /\[repo-file\] failed: \$\{err\?\.name \?\? 'error'\}/, 'the /repo-file catch logs the error name only');
  const items = inboxItems({ items: [{ clientId: 'sinv0006-aa', bytes: 5 }, { clientId: 'pinv0006-aa', bytes: 5 }] });
  assert.deepEqual(items.map((i) => i.clientId), ['pinv0006-aa'], 'copies of a source show in the task panel, not in "Your photos and files"');
});

test('the prompt takes a longer source only when asked, and never more than 40,000 characters', () => {
  const long = 'y'.repeat(50_000);
  assert.match(buildPrompt({ sourceText: 'z'.repeat(LIMITS.sourceChars + 1) }), /\(shortened\)/);
  assert.doesNotMatch(buildPrompt({ sourceText: 'z'.repeat(30_000), sourceLimit: ATTACHED_SOURCE_MAX_CHARS }), /\(shortened\)/);
  const capped = buildPrompt({ sourceText: long, sourceLimit: 999_999 });
  assert.match(capped, /\(shortened\)/);
  assert.ok(capped.length < 41_000);
  assert.match(fileSummaryInstruction({ title: 'Invented', url: null, publisher: 'A. Inventor' }, { shortened: true }), /stops part-way/);
  assert.doesNotMatch(fileSummaryInstruction({ title: 'Invented' }), /stops part-way/);
});

test('the page has the stage control and the attach field, each labelled, inside the task panel', () => {
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const start = html.indexOf('<section id="task-panel"');
  const panel = html.slice(start, html.indexOf('</section>', start));
  assert.match(panel, /<details id="task-panel-stage" class="more">/, 'starts closed');
  assert.match(panel, /<label for="task-panel-stage-select">/);
  for (const stage of STAGES) assert.ok(panel.includes(`<option value="${stage}">${STAGE_LABELS[stage]}</option>`), stage);
  assert.match(panel, /<label for="own-source-files">/);
  assert.match(panel, /<input type="file" id="own-source-files"[^>]* multiple/);
});

// ---------- the routes ----------

test('add a source with copies: the capture IDs are linked; the list shows their status; events hold counts only', async () => {
  const { store, call, task } = await setup();
  const r = await call('POST', '/api/sources/own', { title: 'Invented student article', taskId: task.id, attachments: ['sinv0001-aa', 'sinv0001-bb'] });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.source.uploadIds, ['up_sinv0001-aa', 'up_sinv0001-bb']);
  assert.deepEqual(store.events.find((e) => e.type === 'source.added').payload, { origin: 'learner', link: false, files: 2 });
  const listed = await call('GET', `/api/sources?taskId=${task.id}`);
  assert.deepEqual(listed.body.sources[0].attachments.map((a) => a.status), ['waiting', 'waiting']);
  const plain = await call('POST', '/api/sources/own', { title: 'Invented book', taskId: task.id });
  assert.deepEqual(plain.body.source.uploadIds, []);
  assert.equal((await call('POST', '/api/sources/own', { title: 'x', attachments: 'nope' })).status, 400);
  await rm(store.dir, { recursive: true, force: true });
});

test('summary from an attached copy: waits while it is read, then summarises with no tools; the text is never logged', async () => {
  const { store, logs, ai, call, task } = await setup();
  const source = (await call('POST', '/api/sources/own', { title: 'Invented student article', taskId: task.id, attachments: ['sinv0002-aa', 'sinv0002-bb'] })).body.source;
  const early = await call('POST', `/api/sources/${source.id}/summary`, {});
  assert.deepEqual([early.status, early.body.error], [409, ATTACH_MESSAGES.waiting]);
  assert.equal(ai.calls.length, 0, 'no AI call while a copy is still being read');
  await upload(store, 'sinv0002-aa', { status: 'done', extractedText: { value: `${MARKER} page one of an invented article.`, author: 'source' } });
  await upload(store, 'sinv0002-bb', { status: 'done', extractedText: { value: 'Page two of an invented article.', author: 'source' } });
  const r = await call('POST', `/api/sources/${source.id}/summary`, {});
  assert.equal(r.status, 201);
  assert.deepEqual([r.body.outcome, r.body.checkResult], ['saved', 'passed']);
  const summaryCall = ai.calls.find((c) => c.model === MODELS.conversation);
  assert.deepEqual(summaryCall.tools, [], 'no web tools for an attached copy');
  assert.ok(summaryCall.prompt.includes(`<source_text>[Part 1 of 2]\n${MARKER}`));
  assert.ok(summaryCall.prompt.includes(fileSummaryInstruction(source, { shortened: false })));
  assert.deepEqual(store.events.find((e) => e.type === 'source.summary').payload, { outcome: 'saved', checkResult: 'passed', method: 'file' });
  assert.ok(logs.some((l) => /^\[sources\] summary from attached file: model said summary; \d+ s$/.test(l)));
  assert.equal(logs.join('\n').includes(MARKER) || JSON.stringify(store.events).includes(MARKER), false);
  const entry = await store.read(`notebook/${r.body.entry.id}.json`);
  assert.deepEqual([entry.type, entry.text.author, entry.sourceId], ['summary', 'ai', source.id]);
  assert.equal(entry.text.value.includes(MARKER), false);
  await rm(store.dir, { recursive: true, force: true });
});

test('a copy that could not be read gives a clear message and no AI call', async () => {
  const { store, ai, call, task } = await setup();
  const source = (await call('POST', '/api/sources/own', { title: 'Invented', taskId: task.id, url: 'https://invented.example.org/a', attachments: ['sinv0003-aa'] })).body.source;
  await upload(store, 'sinv0003-aa', { status: 'failed', failureReason: 'unreadable' });
  const r = await call('POST', `/api/sources/${source.id}/summary`, {});
  assert.deepEqual([r.status, r.body.error], [409, ATTACH_MESSAGES.failed]);
  assert.equal(ai.calls.length, 0);
  await rm(store.dir, { recursive: true, force: true });
});

test('attach copies to a saved source: linked, counted, at most five; videos, missing sources and the parent role refused', async () => {
  const { store, call, task } = await setup();
  const source = (await call('POST', '/api/sources/own', { title: 'Invented page', url: 'https://invented-council.example.gov.uk/coast', taskId: task.id })).body.source;
  const r = await call('POST', `/api/sources/${source.id}/attachments`, { attachments: ['sinv0004-aa', 'sinv0004-bb'] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.source.uploadIds, ['up_sinv0004-aa', 'up_sinv0004-bb']);
  assert.deepEqual((await store.read(sourcePath(source.id))).uploadIds, ['up_sinv0004-aa', 'up_sinv0004-bb']);
  assert.deepEqual(store.events.filter((e) => e.type === 'source.attached').map((e) => e.payload), [{ files: 2 }]);
  const again = await call('POST', `/api/sources/${source.id}/attachments`, { attachments: ['sinv0004-aa'] });
  assert.equal(again.status, 200);
  assert.equal(store.events.filter((e) => e.type === 'source.attached').length, 1, 'the same copy twice changes nothing');
  const tooMany = await call('POST', `/api/sources/${source.id}/attachments`, { attachments: ['sinv0004-cc', 'sinv0004-dd', 'sinv0004-ee', 'sinv0004-ff'] });
  assert.deepEqual([tooMany.status, tooMany.body.error], [400, ATTACH_MESSAGES.tooMany]);
  assert.equal((await call('POST', `/api/sources/${source.id}/attachments`, { attachments: [] })).status, 400);
  assert.equal((await call('POST', `/api/sources/${source.id}/attachments`, { attachments: ['sinv0004-gg'], extra: 1 })).status, 400);
  assert.equal((await call('POST', '/api/sources/src_missing/attachments', { attachments: ['sinv0004-hh'] })).status, 404);
  await store.put(sourcePath('src_vid'), { id: 'src_vid', url: 'https://video.invented.example.org/v', title: 'Invented video', category: 'video', topicIds: [] });
  assert.equal((await call('POST', '/api/sources/src_vid/attachments', { attachments: ['sinv0004-ii'] })).status, 409);
  const before = store.writes.length;
  assert.equal((await call('POST', `/api/sources/${source.id}/attachments`, { attachments: ['sinv0004-jj'] }, { role: 'parent' })).status, 403);
  assert.equal(store.writes.length, before);
  await rm(store.dir, { recursive: true, force: true });
});

// ---------- reading and the snapshot ----------

test('the reader reads a copy of a source exactly, as the source\'s words, with no AI call and no draft task', async () => {
  const store = await fakeStore();
  const record = {
    id: 'up_sinv0007-aa', clientId: 'sinv0007-aa', file: 'uploads/up_sinv0007-aa.pdf', mimeType: 'application/pdf', bytes: 9,
    contentKind: 'source', status: 'processing', createdAt: '2026-11-06T10:00:00+00:00', updatedAt: '2026-11-06T10:00:00+00:00',
  };
  await store.put(`uploads/${record.id}.json`, record);
  await writeFile(path.join(store.dir, record.file), 'invented');
  const ai = createMockAi();
  const result = await readUpload({
    store, handle: { ai, models: MODELS }, record,
    extract: async () => ({ ok: true, text: 'Invented article text, wrnog speling kept.', truncated: false, lowTextPages: [], scanned: false }),
  });
  assert.equal(result.status, 'done');
  const saved = await store.read(`uploads/${record.id}.json`);
  assert.deepEqual(saved.extractedText, { value: 'Invented article text, wrnog speling kept.', author: 'source' });
  assert.deepEqual([saved.proposal, saved.spellingCorrections], [null, []]);
  assert.equal(ai.calls.length, 0);
  await rm(store.dir, { recursive: true, force: true });
});

test('copies of a source stay out of the snapshot\'s recent list', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wp114f-snap-'));
  await mkdir(path.join(dir, 'uploads'), { recursive: true });
  const at = '2026-11-06T10:00:00+00:00';
  await writeFile(path.join(dir, 'uploads/up_sinv0008-aa.json'), JSON.stringify({ id: 'up_sinv0008-aa', origin: 'file', contentKind: 'source', status: 'done', updatedAt: at }));
  await writeFile(path.join(dir, 'uploads/up_finv0008-aa.json'), JSON.stringify({ id: 'up_finv0008-aa', origin: 'file', contentKind: 'brief', status: 'done', updatedAt: at }));
  const snapshot = await buildSnapshot({ dir });
  assert.deepEqual(snapshot.learner.recent.map((r) => r.id), ['up_finv0008-aa']);
  await rm(dir, { recursive: true, force: true });
});
