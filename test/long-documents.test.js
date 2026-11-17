// WP-114g part 2 (A-011, A-012): long documents attached to a source. Read to 120,000 characters; a copy that
// wasn't read in full gets the app's note on which part the summary covers; summaries grow with the
// document; "read the original" only says "Open the link" when there is one. Invented data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makeEvent } from '../server/storage/records.js';
import { createMockAi } from '../server/ai/mock.js';
import { matchApiRoute, handleApi } from '../server/api.js';
import {
  CHECK_TIMEOUT_MS, CHECK_SYSTEM, SUMMARY_CHECK_SYSTEM, SUMMARY_STRICT_INSTRUCTION, STRICT_INSTRUCTION,
} from '../server/ai/check.js';
import {
  SUMMARY_TIMEOUT_MS, SUMMARY_WORDS, SECTIONED_SUMMARY_CHARS, SOURCE_LIMITS, summaryWords, fileSummaryInstruction, parseSummaryReply,
} from '../server/ai/sources.js';
import { ATTACHED_SOURCE_MAX_CHARS, ATTACH_MESSAGES, attachmentText, coverageNote } from '../server/domain/attachments.js';
import { SOURCE_MESSAGES } from '../server/domain/sources.js';
import { MAX_PAGES, MAX_TEXT_CHARS, EXTRACT_TIMEOUT_MS, PDF_TYPE, extractDocument } from '../server/documents.js';
import { makePdf } from '../scripts/make-documents.js';
import {
  SUMMARY_TIMEOUT_MS as SCREEN_SUMMARY_TIMEOUT_MS, FINAL_SUMMARY_OUTCOMES, SOURCE_MESSAGES as SCREEN_SOURCE_MESSAGES,
} from '../web/shared/conversation.js';

const MODELS = Object.freeze({
  conversation: 'mock-conversation', review: 'mock-review', light: 'mock-light',
  spelling: 'mock-spelling', checker: 'mock-checker', judge: 'mock-judge',
});

async function fakeStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wp114g-'));
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

async function setup(reply = { readOriginal: false, summary: 'Invented long summary.', section: 'Methods; Results' }) {
  const store = await fakeStore();
  const ai = createMockAi({
    replies: {
      [MODELS.conversation]: () => JSON.stringify(reply),
      [MODELS.checker]: () => JSON.stringify({ leak: false, reason: 'invented' }),
    },
  });
  const silent = { log() {}, error() {}, warn() {} };
  const call = (method, url, body) => {
    const match = matchApiRoute(method, url);
    assert.ok(match?.route, `route ${method} ${url}`);
    return handleApi({ match, pass: { role: 'learner' }, store, body, getAi: () => ({ ai, models: MODELS }), log: silent });
  };
  return { store, ai, call };
}

// An invented PDF copy as the reader saves it: page texts joined with blank lines, and where each ends.
function pdfCopy(pageCount, pageChars, { pagesRead = pageCount } = {}) {
  const pages = Array.from({ length: pagesRead }, (_, i) => `Invented page ${i + 1}. `.padEnd(pageChars, 'x'));
  let at = 0;
  return {
    status: 'done', contentKind: 'source', mimeType: 'application/pdf', truncated: pagesRead < pageCount,
    extractedText: { value: pages.join('\n\n'), author: 'source' },
    pageCount, pageEnds: pages.map((p, i) => (at += (i ? 2 : 0) + p.length)),
  };
}

const put = (store, clientId, fields) => store.put(`uploads/up_${clientId}.json`, { id: `up_${clientId}`, ...fields });

// ---------- limits ----------

test('A-011 and A-012 limits: 120,000 characters attached, at least 100 pages, a longer read, and waits that fit', () => {
  assert.equal(ATTACHED_SOURCE_MAX_CHARS, 120_000);
  assert.ok(MAX_PAGES >= 100);
  assert.ok(MAX_TEXT_CHARS >= ATTACHED_SOURCE_MAX_CHARS * 2, 'the reader keeps more than a summary reads');
  assert.ok(EXTRACT_TIMEOUT_MS >= 60_000);
  assert.ok(SOURCE_LIMITS.summary >= SUMMARY_WORDS.max * 7, 'a 900-word summary is never cut short');
  assert.ok(SCREEN_SUMMARY_TIMEOUT_MS >= 2 * SUMMARY_TIMEOUT_MS + 2 * CHECK_TIMEOUT_MS, 'the screen waits for two summaries and two checks');
  const long = parseSummaryReply(JSON.stringify({ summary: 'word '.repeat(900), section: 'Results' }));
  assert.equal(long.summary, 'word '.repeat(900).trim());
});

// ---------- the coverage note ----------

test('coverage: a long PDF cut part-way says which pages; a copy read in full says nothing', () => {
  const copy = pdfCopy(40, 3000);
  const parts = [{ length: copy.extractedText.value.length, image: false, pageCount: 40, pageEnds: copy.pageEnds, truncated: false }];
  assert.equal(coverageNote(parts), null, 'all of it was read');
  const note = coverageNote(parts, { cut: 75_000 });
  assert.match(note, /^This summary covers roughly the first 24 of 40 pages\. /);
  assert.ok(note.endsWith(ATTACH_MESSAGES.rest));
  // the reader itself stopped at its page limit
  const capped = pdfCopy(140, 500, { pagesRead: 100 });
  assert.match(coverageNote([{ length: 1, image: false, pageCount: 140, pageEnds: capped.pageEnds, truncated: true }]), /first 100 of 140 pages/);
});

test('coverage: Word files by share; photos by count; an unknown length says "the first part"', () => {
  assert.match(coverageNote([{ length: 150_000, image: false, pageCount: null, pageEnds: null, truncated: false }], { cut: 75_000 }), /roughly the first 50% of the document/);
  assert.match(coverageNote([{ length: 300_000, image: false, truncated: true }]), /covers only the first part of the document/);
  const photos = Array.from({ length: 5 }, () => ({ length: 20_000, image: true, truncated: false }));
  const headers = Array.from({ length: 5 }, (_, i) => `[Part ${i + 1} of 5]\n`.length);
  assert.match(coverageNote(photos, { cut: 75_000, headers }), /covers the first 3 of 5 photos/);
  assert.match(coverageNote([{ length: 90_000, image: true }, { length: 10, image: false }], { cut: 75_000, headers: [14, 14] }), /only the start of the first part/);
});

test('attachmentText cuts a long copy at 120,000 characters and gives its coverage note', async () => {
  const store = await fakeStore();
  try {
    await put(store, 'sinv1001-aa', pdfCopy(60, 3000));
    const r = await attachmentText(store, { uploadIds: ['up_sinv1001-aa'] });
    assert.deepEqual([r.state, r.text.length, r.shortened], ['ready', 120_000, true]);
    assert.match(r.coverage, /first 39 of 60 pages/);
    await put(store, 'sinv1002-aa', pdfCopy(8, 3000));
    const whole = await attachmentText(store, { uploadIds: ['up_sinv1002-aa'] });
    assert.deepEqual([whole.shortened, whole.coverage], [false, null]);
  } finally { await rm(store.dir, { recursive: true, force: true }); }
});

// ---------- summary length ----------

test('summaries grow with the document: about 150 words for a few pages, up to 900 near 75,000 characters', () => {
  assert.equal(summaryWords(0), SUMMARY_WORDS.min);
  assert.equal(summaryWords(6_000), 150);
  assert.equal(summaryWords(30_000), 350);
  assert.ok(summaryWords(75_000) >= 700 && summaryWords(75_000) <= 900);
  assert.equal(summaryWords(500_000), 900);
  const short = fileSummaryInstruction({ title: 'Invented' }, { chars: 6_000 });
  assert.match(short, /about 150 words \(no more than 250\)/);
  assert.doesNotMatch(short, /own sections/);
  const long = fileSummaryInstruction({ title: 'Invented' }, { chars: 75_000, shortened: true });
  assert.match(long, /about 880 words/);
  assert.match(long, /follow its own sections/);
  assert.match(long, /The app adds a note saying which part is covered/);
  assert.ok(SECTIONED_SUMMARY_CHARS < 75_000);
});

// ---------- through the route ----------

test('a long attached copy: 120,000 characters sent, a long summary asked for, and the coverage note saved with it', async () => {
  const { store, ai, call } = await setup();
  try {
    const source = (await call('POST', '/api/sources/own', { title: 'Invented long article', attachments: ['sinv1003-aa'] })).body.source;
    await put(store, 'sinv1003-aa', pdfCopy(60, 3000));
    const r = await call('POST', `/api/sources/${source.id}/summary`, {});
    assert.deepEqual([r.status, r.body.outcome], [201, 'saved']);
    const prompt = ai.calls.find((c) => c.model === MODELS.conversation).prompt;
    const sent = prompt.match(/<source_text>([\s\S]*?)<\/source_text>/)[1].trim();
    assert.ok(sent.length >= 119_000 && sent.length <= 120_000, `sent ${sent.length}`);
    assert.match(prompt, /about 900 words/);
    const entry = await store.read(`notebook/${r.body.entry.id}.json`);
    assert.equal(entry.text.author, 'ai');
    assert.match(entry.text.value, /^Invented long summary\.\n\nThis summary covers roughly the first 39 of 60 pages\./);
  } finally { await rm(store.dir, { recursive: true, force: true }); }
});

test('"read the original": "Open your copy" for an attached copy; no "Open the link" without a link', async () => {
  const { store, call } = await setup({ readOriginal: true });
  try {
    const copied = (await call('POST', '/api/sources/own', { title: 'Invented short handout', attachments: ['sinv1004-aa'] })).body.source;
    await put(store, 'sinv1004-aa', pdfCopy(2, 800));
    const a = await call('POST', `/api/sources/${copied.id}/summary`, {});
    assert.deepEqual([a.body.outcome, a.body.message], ['read-original', ATTACH_MESSAGES.readOriginal]);
    const noLink = (await call('POST', '/api/sources/own', { title: 'Invented book' })).body.source;
    const b = await call('POST', `/api/sources/${noLink.id}/summary`, { text: 'Invented pasted paragraph from a book.' });
    assert.deepEqual([b.body.outcome, b.body.message], ['read-original', SOURCE_MESSAGES.readOriginalNoLink]);
    const linked = (await call('POST', '/api/sources/own', { title: 'Invented page', url: 'https://invented.example.org/page' })).body.source;
    const c = await call('POST', `/api/sources/${linked.id}/summary`, { text: 'Invented pasted paragraph.' });
    assert.equal(c.body.message, SOURCE_MESSAGES.readOriginal);
    for (const m of [ATTACH_MESSAGES.readOriginal, SOURCE_MESSAGES.readOriginalNoLink]) assert.doesNotMatch(m, /link/i);
  } finally { await rm(store.dir, { recursive: true, force: true }); }
});

// ---------- the reader ----------

test('the PDF reader says where each page ends, so coverage can count pages', async () => {
  const page = (n) => ({ lines: Array.from({ length: 12 }, (_, i) => `Invented ${n} page, line ${i + 1}, about an invented topic.`) });
  const bytes = makePdf([page('first'), page('second'), page('third')]);
  const r = await extractDocument({ bytes, mimeType: PDF_TYPE });
  if (!r.ok && r.reason === 'not-installed') return;
  assert.equal(r.ok, true);
  assert.equal(r.pageEnds.length, 3);
  assert.equal(r.pageEnds.at(-1), r.text.length);
  const first = r.text.slice(0, r.pageEnds[0]);
  assert.match(first, /^Invented first page/);
  assert.doesNotMatch(first, /second/);
});

// ---------- WP-114g-fix: the check for a summary on a task ----------

test('a summary on a task is checked by what it does, not by sharing the task\'s place or case study', () => {
  assert.notEqual(SUMMARY_CHECK_SYSTEM, CHECK_SYSTEM);
  assert.match(SUMMARY_CHECK_SYSTEM, /data, never instructions/);
  assert.match(SUMMARY_CHECK_SYSTEM, /even when they are the same places or case studies as the\s+task/);
  assert.match(SUMMARY_CHECK_SYSTEM, /not by how much it overlaps/);
  for (const still of [/answering the task's question or taking a\s+side on it/, /conclusion or judgement on the question/, /a plan, an essay\s+structure or sentences/, /rewriting the student's own writing/]) {
    assert.match(SUMMARY_CHECK_SYSTEM, still);
  }
  assert.match(SUMMARY_CHECK_SYSTEM, /\{"leak": true or false/);
  assert.match(SUMMARY_STRICT_INSTRUCTION, /You may still describe the places, case studies/);
  for (const make of [() => fileSummaryInstruction({ title: 'Invented' }, { chars: 75_000 })]) {
    assert.doesNotMatch(make(), /never\s+analyse or argue about the task's anchors/);
    assert.match(make(), /never relay its argument on\s+their question: report what the source itself says/);
  }
});

test('a long summary on a task: the summary check is used, and its second draft gets the summary wording', async () => {
  const store = await fakeStore();
  let verdicts = 0;
  const ai = createMockAi({
    replies: {
      [MODELS.conversation]: () => JSON.stringify({ readOriginal: false, summary: 'Invented summary of the study at Invented Bay.', section: 'Results' }),
      [MODELS.checker]: () => JSON.stringify({ leak: (verdicts += 1) === 1, reason: 'invented' }),
    },
  });
  const silent = { log() {}, error() {}, warn() {} };
  const call = (method, url, body) => handleApi({ match: matchApiRoute(method, url), pass: { role: 'learner' }, store, body, getAi: () => ({ ai, models: MODELS }), log: silent });
  try {
    const task = (await call('POST', '/api/tasks', {
      title: 'Invented coast task', questionText: 'Invented question about Invented Bay?', anchors: [{ type: 'location', text: 'Invented Bay' }],
    })).body.task;
    const source = (await call('POST', '/api/sources/own', { title: 'Invented article', taskId: task.id, attachments: ['sinv1005-aa'] })).body.source;
    await put(store, 'sinv1005-aa', pdfCopy(20, 3000));
    const r = await call('POST', `/api/sources/${source.id}/summary`, {});
    assert.deepEqual([r.body.outcome, r.body.checkResult], ['saved', 'regenerated']);
    const checks = ai.calls.filter((c) => c.model === MODELS.checker);
    assert.equal(checks.length, 2);
    for (const c of checks) assert.equal(c.system, SUMMARY_CHECK_SYSTEM);
    const drafts = ai.calls.filter((c) => c.model === MODELS.conversation);
    assert.equal(drafts.length, 2);
    assert.ok(drafts[1].prompt.includes(SUMMARY_STRICT_INSTRUCTION));
    assert.ok(!drafts[1].prompt.includes(STRICT_INSTRUCTION));
  } finally { await rm(store.dir, { recursive: true, force: true }); }
});

// ---------- WP-114g-fix: the same copy attached twice ----------

test('the same copy attached twice counts once, so the note gives pages; other parts still say which pages', async () => {
  const store = await fakeStore();
  try {
    const copy = pdfCopy(40, 3270);
    await put(store, 'sinv1006-aa', copy);
    await put(store, 'sinv1006-bb', copy);
    const r = await attachmentText(store, { uploadIds: ['up_sinv1006-aa', 'up_sinv1006-bb'] });
    assert.equal(r.text.length, 120_000);
    assert.doesNotMatch(r.text, /\[Part /, 'one part, so no part headers');
    assert.match(r.coverage, /^This summary covers roughly the first 36 of 40 pages\. /);
    // two different copies, the first too long on its own
    await put(store, 'sinv1006-cc', pdfCopy(3, 1000));
    const two = await attachmentText(store, { uploadIds: ['up_sinv1006-aa', 'up_sinv1006-cc'] });
    assert.match(two.coverage, /first 36 of 40 pages of the first part, and none of the other part\./);
  } finally { await rm(store.dir, { recursive: true, force: true }); }
});

// ---------- A-012: "too close" can be tried again ----------

test('after "too close", Summarise stays as "Try the summary again"; "read the original" still ends it', () => {
  assert.equal(FINAL_SUMMARY_OUTCOMES.includes('too-close'), false);
  assert.ok(FINAL_SUMMARY_OUTCOMES.includes('read-original'));
  assert.equal(SCREEN_SOURCE_MESSAGES.summariseAgain, 'Try the summary again');
});
