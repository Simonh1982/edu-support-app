// WP-114e (A-010): paste to summarise, and sources the learner adds himself. Mock AI and invented
// data only: no real pages. Pasted text must never be stored, logged or put in an event.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makeEvent } from '../server/storage/records.js';
import { createMockAi } from '../server/ai/mock.js';
import { matchApiRoute, handleApi } from '../server/api.js';
import { LIMITS } from '../server/ai/prompt.js';
import { PASTED_SOURCE_MAX_CHARS, pastedSummaryInstruction } from '../server/ai/sources.js';
import { SOURCE_MESSAGES, notebookPath, sourcePath } from '../server/domain/sources.js';

const MODELS = Object.freeze({
  conversation: 'mock-conversation', review: 'mock-review', light: 'mock-light',
  spelling: 'mock-spelling', checker: 'mock-checker', judge: 'mock-judge',
});
const PASTED = 'INVENTED-PASTED-MARKER: an invented passage about longshore drift moving sand along an invented beach.';
const QUESTION = 'Evaluate how well the invented Sandy Point scheme manages coastal erosion.';

async function fakeStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wp114e-'));
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

async function everything(store, logs = []) {
  const texts = [JSON.stringify(store.events), logs.join('\n')];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else texts.push(await readFile(full, 'utf8'));
    }
  }
  await walk(store.dir);
  return texts.join('\n');
}

/** summaries: the summary replies in turn (last repeats); verdicts: the checker's (last repeats). */
async function setup({ summaries = [{ readOriginal: false, summary: 'Invented summary of the pasted part.', section: 'Paragraph 2' }], verdicts = [false] } = {}) {
  const store = await fakeStore();
  const logs = [];
  const log = { log: (l) => logs.push(l), error: (l) => logs.push(l), warn: (l) => logs.push(l) };
  let s = 0;
  let c = 0;
  const ai = createMockAi({
    replies: {
      [MODELS.conversation]: () => {
        const out = summaries[Math.min(s, summaries.length - 1)];
        s += 1;
        return typeof out === 'string' ? out : JSON.stringify(out);
      },
      [MODELS.checker]: () => {
        const v = verdicts[Math.min(c, verdicts.length - 1)];
        c += 1;
        return JSON.stringify({ leak: v, reason: 'invented' });
      },
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

// ---------- sources he adds himself ----------

test('add a source I found myself: title, author and link; taken from his task; the same link twice is one record', async () => {
  const { store, call, task } = await setup();
  const r = await call('POST', '/api/sources/own', {
    title: 'Invented book on coasts', author: 'A. Inventor', url: 'https://invented-library.example.org/coasts', taskId: task.id,
  });
  assert.equal(r.status, 201);
  const s = r.body.source;
  assert.match(s.id, /^src_/);
  assert.deepEqual([s.title, s.publisher, s.url, s.category, s.origin, s.taskId, s.topicIds, s.fromTurnId, s.summaryId, s.createdBy],
    ['Invented book on coasts', 'A. Inventor', 'https://invented-library.example.org/coasts', 'other', 'learner', task.id, ['demo-geo-1a'], null, null, 'learner']);
  assert.deepEqual(await store.read(sourcePath(s.id)), s);
  const again = await call('POST', '/api/sources/own', { title: 'Same link', url: 'https://invented-library.example.org/coasts', taskId: task.id });
  assert.deepEqual([again.status, again.body.duplicate, again.body.source.id], [200, true, s.id]);
  const ev = store.events.filter((e) => e.type === 'source.added');
  assert.equal(ev.length, 1);
  assert.deepEqual(ev[0].payload, { origin: 'learner', link: true });
  assert.equal(JSON.stringify(ev).includes('Invented book'), false, 'events hold no titles');
  const listed = await call('GET', `/api/sources?taskId=${task.id}`);
  assert.deepEqual(listed.body.sources.map((x) => x.id), [s.id]);
  await rm(store.dir, { recursive: true, force: true });
});

test('a source with no link is fine; bad links, missing titles, unknown fields and missing tasks are refused', async () => {
  const { store, call, task } = await setup();
  const book = await call('POST', '/api/sources/own', { title: 'Invented textbook, chapter 4', taskId: task.id });
  assert.equal(book.status, 201);
  assert.deepEqual([book.body.source.url, book.body.source.publisher], [null, null]);
  const second = await call('POST', '/api/sources/own', { title: 'Invented textbook, chapter 4', taskId: task.id });
  assert.equal(second.status, 201, 'with no link there is nothing to match, so it is a new record');
  const bad = await call('POST', '/api/sources/own', { title: 'x', url: 'javascript:alert(1)', taskId: task.id });
  assert.deepEqual([bad.status, bad.body.error], [400, SOURCE_MESSAGES.badLink]);
  assert.equal((await call('POST', '/api/sources/own', { title: 'x', url: 'invented.example.org/no-scheme' })).status, 400);
  assert.equal((await call('POST', '/api/sources/own', { author: 'No title' })).status, 400);
  assert.equal((await call('POST', '/api/sources/own', { title: 'x'.repeat(201) })).status, 400);
  assert.equal((await call('POST', '/api/sources/own', { title: 'x', why: 'made up' })).status, 400);
  assert.equal((await call('POST', '/api/sources/own', { title: 'x', taskId: 't_missing' })).status, 404);
  assert.equal((await call('POST', '/api/sources/own', { title: 'No task is fine' })).status, 201);
  await rm(store.dir, { recursive: true, force: true });
});

test('the parent role is refused on the new route and on pasted summaries, and nothing is written', async () => {
  const { store, call } = await setup();
  const before = [store.writes.length, store.events.length];
  assert.equal((await call('POST', '/api/sources/own', { title: 'x' }, { role: 'parent' })).status, 403);
  assert.equal((await call('POST', '/api/sources/src_x/summary', { text: PASTED }, { role: 'parent' })).status, 403);
  assert.deepEqual([store.writes.length, store.events.length], before);
  await rm(store.dir, { recursive: true, force: true });
});

// ---------- paste to summarise ----------

async function ownSource(env, extra = {}) {
  return (await env.call('POST', '/api/sources/own', { title: 'Invented report', taskId: env.task.id, ...extra })).body.source;
}

test('paste to summarise: no tools offered, the text goes in <source_text>, and only the summary is kept', async () => {
  const env = await setup();
  const source = await ownSource(env);
  const r = await env.call('POST', `/api/sources/${source.id}/summary`, { text: `  ${PASTED}  ` });
  assert.equal(r.status, 201);
  assert.deepEqual([r.body.outcome, r.body.checkResult], ['saved', 'passed']);
  const summaryCall = env.ai.calls.find((x) => x.model === MODELS.conversation);
  assert.deepEqual(summaryCall.tools, [], 'no web tools for pasted text');
  assert.match(summaryCall.prompt, /<source_text>INVENTED-PASTED-MARKER/);
  assert.ok(summaryCall.prompt.includes(pastedSummaryInstruction(source)));
  assert.match(summaryCall.prompt, /Question: Evaluate how well/, 'the task goes with it, for the anchor rules');
  const entry = await env.store.read(notebookPath(r.body.entry.id));
  assert.deepEqual([entry.type, entry.text.author, entry.sourceId, entry.source.url], ['summary', 'ai', source.id, null]);
  assert.equal((await env.store.read(sourcePath(source.id))).summaryId, entry.id);
  const ev = env.store.events.find((e) => e.type === 'source.summary');
  assert.deepEqual(ev.payload, { outcome: 'saved', checkResult: 'passed', method: 'paste' });
  assert.ok(env.logs.some((l) => /^\[sources\] summary from pasted text: model said summary; \d+ s$/.test(l)));
  assert.equal((await everything(env.store, env.logs)).includes('INVENTED-PASTED-MARKER'), false, 'pasted text is never stored or logged');
  await rm(env.store.dir, { recursive: true, force: true });
});

test('pasted text that is short and readable: read the original; unreadable: unclear; nothing saved either way', async () => {
  const env = await setup({ summaries: [{ readOriginal: true }, { unavailable: true }, { unavailable: true, subscription: true }] });
  const source = await ownSource(env);
  const first = await env.call('POST', `/api/sources/${source.id}/summary`, { text: PASTED });
  assert.deepEqual([first.status, first.body.outcome, first.body.message], [200, 'read-original', SOURCE_MESSAGES.readOriginal]);
  const second = await env.call('POST', `/api/sources/${source.id}/summary`, { text: PASTED });
  assert.deepEqual([second.body.outcome, second.body.message], ['unclear', SOURCE_MESSAGES.pasteUnclear]);
  const third = await env.call('POST', `/api/sources/${source.id}/summary`, { text: PASTED });
  assert.equal(third.body.outcome, 'unclear', 'a paywall answer makes no sense for pasted text');
  assert.equal(env.store.writes.some((w) => w.startsWith('notebook/')), false);
  const turns = [];
  for (const w of env.store.writes.filter((x) => x.startsWith('ai-turns/'))) turns.push(await env.store.read(w));
  assert.deepEqual(turns.map((t) => t.success), [true, false, true]);
  assert.equal((await everything(env.store, env.logs)).includes('INVENTED-PASTED-MARKER'), false);
  await rm(env.store.dir, { recursive: true, force: true });
});

test('a pasted summary on a task still goes through the live check; one that fails twice is never saved', async () => {
  const env = await setup({ verdicts: [true] });
  const source = await ownSource(env);
  const r = await env.call('POST', `/api/sources/${source.id}/summary`, { text: PASTED });
  assert.deepEqual([r.body.outcome, r.body.message, r.body.checkResult], ['too-close', SOURCE_MESSAGES.tooClose, 'fallback']);
  const tutorCalls = env.ai.calls.filter((x) => x.model === MODELS.conversation);
  assert.equal(tutorCalls.length, 2);
  assert.ok(tutorCalls.every((x) => x.tools.length === 0 && x.prompt.includes('<source_text>')), 'the second draft also has the text, and no tools');
  assert.equal(env.store.writes.some((w) => w.startsWith('notebook/')), false);
  await rm(env.store.dir, { recursive: true, force: true });
});

test('pasted text: empty, too long and unknown fields are refused before any AI call', async () => {
  const env = await setup();
  const source = await ownSource(env);
  const empty = await env.call('POST', `/api/sources/${source.id}/summary`, { text: '   ' });
  assert.deepEqual([empty.status, empty.body.error], [400, SOURCE_MESSAGES.pasteEmpty]);
  const long = await env.call('POST', `/api/sources/${source.id}/summary`, { text: 'x'.repeat(PASTED_SOURCE_MAX_CHARS + 1) });
  assert.deepEqual([long.status, long.body.error], [400, SOURCE_MESSAGES.pasteTooLong]);
  assert.equal((await env.call('POST', `/api/sources/${source.id}/summary`, { text: 7 })).status, 400);
  assert.equal((await env.call('POST', `/api/sources/${source.id}/summary`, { text: PASTED, url: 'x' })).status, 400);
  assert.equal(env.ai.calls.length, 0);
  assert.equal(PASTED_SOURCE_MAX_CHARS, LIMITS.sourceChars, 'nothing he may paste is cut short in the prompt');
  await rm(env.store.dir, { recursive: true, force: true });
});

test('a source with no link can only be summarised from pasted text; videos never', async () => {
  const env = await setup();
  const source = await ownSource(env);
  const r = await env.call('POST', `/api/sources/${source.id}/summary`, {});
  assert.deepEqual([r.status, r.body.error], [409, SOURCE_MESSAGES.noLink]);
  await env.store.put(sourcePath('src_vid'), { id: 'src_vid', url: 'https://video.invented.example.org/v', title: 'Invented video', category: 'video', topicIds: [] });
  const v = await env.call('POST', '/api/sources/src_vid/summary', { text: PASTED });
  assert.deepEqual([v.status, v.body.error], [409, SOURCE_MESSAGES.video]);
  assert.equal(env.ai.calls.length, 0);
  await rm(env.store.dir, { recursive: true, force: true });
});

test('a source with a link still fetches when nothing is pasted, exactly as before', async () => {
  const env = await setup();
  const source = await ownSource(env, { url: 'https://invented.example.org/report' });
  const r = await env.call('POST', `/api/sources/${source.id}/summary`, {});
  assert.equal(r.body.outcome, 'unavailable', 'the mock never fetches, so nothing is summarised from memory');
  const summaryCall = env.ai.calls.find((x) => x.model === MODELS.conversation);
  assert.deepEqual(summaryCall.tools, ['web_fetch']);
  assert.equal(summaryCall.prompt.includes('<source_text>'), false);
  assert.deepEqual(env.store.events.find((e) => e.type === 'source.summary').payload, { outcome: 'unavailable' });
  await rm(env.store.dir, { recursive: true, force: true });
});
