// WP-114a: web tools on the research route (the tutor decides when to search), the source filter,
// source cards through the live check, Source records and AI summary cards. Mock AI and invented
// data only: no real searches, no real pages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makeEvent } from '../server/storage/records.js';
import { createMockAi } from '../server/ai/mock.js';
import { createAiCeiling } from '../server/rate-limits.js';
import { matchApiRoute, handleApi } from '../server/api.js';
import { WEB_TOOLS } from '../server/ai/tools.js';
import {
  WEB_ROUTES, WEB_INSTRUCTION, parseSources, cleanUrl, filterSources, isBlockedHost, hostOf, sourceLines,
  parseSummaryReply, SOURCE_LIMITS,
} from '../server/ai/sources.js';
import { FALLBACK_REPLIES, CHECK_FEATURE } from '../server/ai/check.js';
import { aiTurnPath, newAiTurn } from '../server/domain/work.js';
import { SOURCE_MESSAGES, SUMMARY_FEATURE, notebookPath, sourcePath } from '../server/domain/sources.js';
import { notebookEntryForModel } from '../server/ai/read-tools.js';

const MODELS = Object.freeze({
  conversation: 'mock-conversation', review: 'mock-review', light: 'mock-light',
  spelling: 'mock-spelling', checker: 'mock-checker', judge: 'mock-judge',
});
const silent = { log() {}, error() {}, warn() {} };
const curriculum = {
  qualifications: new Map([['demo-geo', { id: 'demo-geo', title: 'Invented Geography', awardingBody: null, specificationCode: null, units: [], aos: [], commandWords: [] }]]),
  topics: new Map([['demo-geo-1a', { id: 'demo-geo-1a', qualId: 'demo-geo', unitId: null, title: 'Invented coasts topic', record: { id: 'demo-geo-1a', title: 'Invented coasts topic' } }]]),
};
const QUESTION = 'Evaluate the effectiveness of hard engineering at protecting the invented Imaginary Bay coastline.';
const CARD = { title: 'Invented guide to coastal processes', url: 'https://invented-geography.example.org/coasts', publisher: 'Invented Society', category: 'introduction', why: 'Covers how waves erode cliffs, with diagrams.' };
const CARD2 = { title: 'Invented coastal data series', url: 'https://data.invented.example.gov.uk/coast', publisher: null, category: 'data', why: 'Tables of erosion rates by year.' };
const ESSAY = { title: 'Invented essay', url: 'https://www.ukessays.com/essays/geography/x.php', category: 'other', why: 'An essay.' };
const URL_PERMISSION = { kind: 'url', url: 'https://invented-geography.example.org/coasts' };

async function fakeStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wp114-'));
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

/**
 * tutor: { reply, sources, level, searched } for every tutor reply; searched = a web tool asked for a
 * 'url' permission on each call. verdicts: the checker's in turn (last repeats). summaries: summary
 * replies in turn (last repeats).
 */
function models({
  reply = 'Invented reply.', sources = [CARD, CARD2], level = 0, searched = true, verdicts = [false], summaries = [],
} = {}) {
  const tutorCalls = [];
  const checkPrompts = [];
  let s = 0;
  const ai = createMockAi({
    replies: {
      [MODELS.conversation]: ({ prompt, tools }) => {
        if (prompt.includes('<source_ref>')) {
          const out = summaries[Math.min(s, summaries.length - 1)];
          s += 1;
          return typeof out === 'string' ? out : JSON.stringify(out);
        }
        tutorCalls.push({ prompt, tools });
        return JSON.stringify({ reply, replyType: 'other', taskSpecific: false, wellbeingLevel: level, sources });
      },
      [MODELS.checker]: ({ prompt }) => {
        const v = verdicts[Math.min(checkPrompts.length, verdicts.length - 1)];
        checkPrompts.push(prompt);
        return JSON.stringify({ leak: v, reason: 'invented' });
      },
    },
    permissionRequests: searched ? { [MODELS.conversation]: [URL_PERMISSION, { kind: 'shell' }] } : {},
  });
  return { ai, tutorCalls, checkPrompts, handle: { ai, models: MODELS } };
}

async function setup({ m = models(), ceiling = null } = {}) {
  const store = await fakeStore();
  const call = async (method, url, body, { role = 'learner' } = {}) => {
    const [pathname, search = ''] = url.split('?');
    const match = matchApiRoute(method, pathname);
    assert.ok(match?.route, `route ${method} ${url}`);
    return handleApi({
      match, pass: { role }, store, body, query: new URLSearchParams(search), getCurriculum: () => curriculum,
      getAi: () => m.handle, aiCeiling: ceiling, log: silent,
    });
  };
  const task = (await call('POST', '/api/tasks', {
    title: 'Invented coast essay', questionText: QUESTION, topicIds: ['demo-geo-1a'],
    anchors: [{ type: 'location', text: 'Imaginary Bay' }],
  })).body.task;
  const start = async (body) => (await call('POST', '/api/conversations', body)).body.conversation;
  return { store, call, task, start, m };
}

async function savedText(store) {
  const texts = [JSON.stringify(store.events)];
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

// ---------- pure rules ----------

test('source cards: cleaned, http(s) only, one per address, at most five; "why" is AI-authored', () => {
  assert.equal(cleanUrl('javascript:alert(1)'), null);
  assert.equal(cleanUrl('https://user:pw@invented.example.org/x'), null);
  assert.equal(cleanUrl('ftp://invented.example.org/x'), null);
  assert.equal(cleanUrl('https://localhost/x'), null);
  assert.equal(cleanUrl('https://invented.example.org/a b'), 'https://invented.example.org/a%20b');
  const cards = parseSources([
    CARD, CARD, { ...CARD2, category: 'blog', why: `  ${'w'.repeat(400)}  ` }, { title: 'No address', why: 'x' },
    { url: 'https://invented.example.org/1', title: 'One', why: 'a' }, { url: 'https://invented.example.org/2', title: 'Two', why: 'b' },
    { url: 'https://invented.example.org/3', title: 'Three', why: 'c' }, { url: 'https://invented.example.org/4', title: 'Four', why: 'd' },
  ]);
  assert.equal(cards.length, SOURCE_LIMITS.cards);
  assert.deepEqual(cards[0], { ...CARD, why: { value: CARD.why, author: 'ai' } });
  assert.equal(cards[1].category, 'other', 'unknown categories become other');
  assert.equal(cards[1].why.value.length, SOURCE_LIMITS.why);
  assert.deepEqual(parseSources('not a list'), []);
  assert.deepEqual(parseSources([{ ...CARD, why: { value: CARD.why, author: 'ai' } }])[0].why, { value: CARD.why, author: 'ai' }, 'saved cards re-clean');
});

test('source filter (A-009): page by page; answer pages go only when they closely match an open task', () => {
  assert.equal(isBlockedHost(hostOf('https://www.ukessays.com/x')), true);
  assert.equal(isBlockedHost(hostOf('https://uk.studocu.com/x')), true, 'subdomains too');
  assert.equal(isBlockedHost(hostOf('https://notukessays.com/x')), false);
  const modelAnswer = { title: 'Model answer: hard engineering effectiveness at a coastline', url: 'https://invented.example.org/a', why: 'x' };
  const sameTitle = { title: 'Evaluate the effectiveness of hard engineering protecting Imaginary Bay coastline', url: 'https://invented.example.org/b', why: 'x' };
  const inPath = { title: 'Invented page', url: 'https://invented.example.org/example-essay-hard-engineering-effectiveness-coastline', why: 'x' };
  const otherModel = { title: 'Model answers on river flooding', url: 'https://invented.example.org/c', why: 'x' };
  const useful = { title: 'Hard engineering explained', url: 'https://invented.example.org/d', why: 'x' };
  const anchorAnswer = { title: 'Imaginary Bay sea walls: a sample essay', url: 'https://invented.example.org/e', why: 'x' };
  // two lists, because one reply keeps at most five cards
  const all = [...parseSources([ESSAY, modelAnswer, sameTitle]), ...parseSources([inPath, otherModel, useful, anchorAnswer])];
  const { kept, dropped } = filterSources(all, { tasks: [{ question: QUESTION, anchors: ['Imaginary Bay'] }] });
  // an essay-bank page and a model answer on other questions may be linked (A-009 point 3)
  assert.deepEqual(kept.map((c) => c.title), ['Invented essay', 'Model answers on river flooding', 'Hard engineering explained']);
  assert.equal(dropped, 4);
  assert.equal(filterSources(all, {}).dropped, 0, 'with no open task, nothing is dropped');
  assert.equal(filterSources(all, { question: QUESTION }).dropped, 3, 'a question alone: the anchor rule needs the anchors');
});

test('summary replies: a summary, read the original, unavailable, or nothing usable', () => {
  assert.deepEqual(parseSummaryReply('{"readOriginal": false, "summary": " Invented. ", "section": "Part 2"}'), { kind: 'summary', summary: 'Invented.', section: 'Part 2' });
  assert.deepEqual(parseSummaryReply('{"readOriginal": true}'), { kind: 'read-original' });
  assert.deepEqual(parseSummaryReply('{"unavailable": true, "readOriginal": true}'), { kind: 'unavailable' });
  assert.equal(parseSummaryReply('{"readOriginal": false, "summary": ""}'), null);
  assert.equal(parseSummaryReply('nope'), null);
  assert.match(sourceLines(parseSources([CARD])), /Invented guide to coastal processes \(Invented Society\): Covers how waves/);
  assert.equal(sourceLines([]), '');
});

test('AI turns keep source cards, except at wellbeing levels 2–3', () => {
  const kept = newAiTurn({ feature: 'research', role: 'conversation', model: 'm', text: 'x', sources: [CARD] });
  assert.equal(kept.sources.length, 1);
  const care = newAiTurn({ feature: 'research', role: 'conversation', model: 'm', text: 'x', wellbeingLevel: 2, sources: [CARD] });
  assert.deepEqual(care.sources, []);
  assert.deepEqual(newAiTurn({ feature: 'plan', role: 'conversation', model: 'm', text: 'x' }).sources, []);
});

// ---------- in the conversation ----------

test('research: web tools offered (allowed list only); other routes never; the tutor decides', async () => {
  const { call, task, start, store, m } = await setup();
  assert.deepEqual(WEB_ROUTES, ['research']);
  const c = await start({ route: 'research', taskId: task.id });
  const r = await call('POST', `/api/conversations/${c.id}/messages`, { text: 'invented first go' });
  assert.equal(r.status, 201);
  const firstCall = m.ai.calls.find((x) => x.model === MODELS.conversation);
  assert.deepEqual(firstCall.tools, [...WEB_TOOLS]);
  assert.ok(m.tutorCalls[0].prompt.includes(WEB_INSTRUCTION));
  assert.deepEqual(r.body.turn.sources.map((s) => s.title), [CARD.title, CARD2.title]);
  const turn = await store.read(aiTurnPath(r.body.turn.id));
  assert.equal(turn.sources.length, 2);
  assert.equal(turn.checkResult, 'passed');
  // the checker reads the cards with the reply
  assert.match(m.checkPrompts[0], /Source cards shown with this reply:[\s\S]*Invented coastal data series/);

  for (const route of ['plan', 'learn']) {
    const other = await start({ route, taskId: task.id });
    const before = m.ai.calls.length;
    const o = await call('POST', `/api/conversations/${other.id}/messages`, { text: 'invented go' });
    const calls = m.ai.calls.slice(before).filter((x) => x.model === MODELS.conversation);
    assert.ok(calls.every((x) => x.tools.length === 0), `${route}: no web tools`);
    assert.deepEqual(o.body.turn.sources, [], `${route}: no cards`);
    assert.equal(m.tutorCalls.at(-1).prompt.includes(WEB_INSTRUCTION), false);
  }
  await rm(store.dir, { recursive: true, force: true });
});

test('cards count only when a web tool really ran; shell is still refused', async () => {
  const { call, start, store, m } = await setup({ m: models({ searched: false }) });
  const c = await start({ route: 'research' });
  const r = await call('POST', `/api/conversations/${c.id}/messages`, { text: 'invented question' });
  assert.deepEqual(r.body.turn.sources, [], 'remembered sources are not shown');
  await rm(store.dir, { recursive: true, force: true });

  const decisions = [];
  const policy = models();
  const res = await policy.ai.ask({
    model: MODELS.conversation, system: 's', prompt: 'p', tools: [...WEB_TOOLS],
    allowPermission: (await import('../server/ai/tools.js')).permissionPolicy(['url']),
    onPermission: (req, ok) => decisions.push([req.kind, ok]),
  });
  assert.ok(res.text);
  assert.deepEqual(decisions, [['url', true], ['shell', false]]);
});

test('the source filter runs on cards from the tutor against every open task; dropped cards are counted, never logged with text', async () => {
  const logs = [];
  const anchorAnswer = { title: 'Imaginary Bay sea walls: a sample essay', url: 'https://revision.invented.example.org/imaginary-bay-sample', category: 'other', why: 'An answer.' };
  const m = models({ sources: [anchorAnswer, ESSAY, CARD] });
  const store = await fakeStore();
  const ctxCall = (method, url, body) => handleApi({
    match: matchApiRoute(method, url), pass: { role: 'learner' }, store, body, getCurriculum: () => curriculum,
    getAi: () => m.handle, log: { log: (l) => logs.push(l), error: (l) => logs.push(l) },
  });
  await ctxCall('POST', '/api/tasks', {
    title: 'Invented coast essay', questionText: QUESTION, topicIds: ['demo-geo-1a'], anchors: [{ type: 'location', text: 'Imaginary Bay' }],
  });
  // a conversation with no task: the open task's anchors still count (A-009 point 3)
  const c = (await ctxCall('POST', '/api/conversations', { route: 'research' })).body.conversation;
  const r = await ctxCall('POST', `/api/conversations/${c.id}/messages`, { text: 'invented question' });
  // tier order: the introduction first; the essay-bank page on another question stays
  assert.deepEqual(r.body.turn.sources.map((s) => s.url), [CARD.url, ESSAY.url]);
  assert.ok(logs.includes('[sources] 1 dropped by the source filter'));
  assert.equal(logs.join('\n').includes('sample essay'), false);
  await rm(store.dir, { recursive: true, force: true });
});

test('a reply that fails the check loses its cards; the second draft never searches', async () => {
  const { call, task, start, store, m } = await setup({ m: models({ verdicts: [true, false] }) });
  const c = await start({ route: 'research', taskId: task.id });
  const r = await call('POST', `/api/conversations/${c.id}/messages`, { text: 'invented go' });
  assert.deepEqual(r.body.turn.sources, []);
  const tutorCalls = m.ai.calls.filter((x) => x.model === MODELS.conversation);
  assert.equal(tutorCalls.length, 2);
  assert.deepEqual(tutorCalls[1].tools, [], 'the stricter draft has no web tools');
  const turn = await store.read(aiTurnPath(r.body.turn.id));
  assert.deepEqual([turn.checkResult, turn.sources], ['regenerated', []]);
  await rm(store.dir, { recursive: true, force: true });

  const twice = await setup({ m: models({ verdicts: [true] }) });
  const c2 = await twice.start({ route: 'research', taskId: twice.task.id });
  const r2 = await twice.call('POST', `/api/conversations/${c2.id}/messages`, { text: 'invented go' });
  assert.equal(r2.body.turn.reply, FALLBACK_REPLIES.research);
  assert.deepEqual(r2.body.turn.sources, []);
  await rm(twice.store.dir, { recursive: true, force: true });
});

test('a reply to a level 2–3 message shows no cards and saves none', async () => {
  const { call, start, store } = await setup({ m: models({ level: 3 }) });
  const c = await start({ route: 'research' });
  const r = await call('POST', `/api/conversations/${c.id}/messages`, { text: 'invented personal words' });
  assert.deepEqual(r.body.turn.sources, []);
  assert.equal((await savedText(store)).includes('invented-geography'), false);
  await rm(store.dir, { recursive: true, force: true });
});

test('a support reply on research can carry cards; reopening the conversation returns them', async () => {
  const { call, task, start, store } = await setup();
  const c = await start({ route: 'research', taskId: task.id });
  await call('POST', `/api/conversations/${c.id}/messages`, { text: 'invented go' });
  const hint = await call('POST', `/api/conversations/${c.id}/support`, { type: 'hint' });
  assert.equal(hint.body.turn.sources.length, 2);
  const open = await call('GET', `/api/conversations/${c.id}`);
  assert.deepEqual(open.body.conversation.turns.map((t) => t.sources.length), [2, 2]);
  await rm(store.dir, { recursive: true, force: true });
});

test('a missing wellbeing level: the second try has no web tools, so its cards are not kept', async () => {
  let n = 0;
  const ai = createMockAi({
    replies: {
      [MODELS.conversation]: () => {
        n += 1;
        const body = { reply: 'Invented.', taskSpecific: false, sources: [CARD] };
        if (n > 1) body.wellbeingLevel = 0;
        return JSON.stringify(body);
      },
    },
    permissionRequests: { [MODELS.conversation]: [URL_PERMISSION] },
  });
  const { call, start, store } = await setup({ m: { ai, handle: { ai, models: MODELS } } });
  const c = await start({ route: 'research' });
  const r = await call('POST', `/api/conversations/${c.id}/messages`, { text: 'invented question' });
  const tutorCalls = ai.calls.filter((x) => x.model === MODELS.conversation);
  assert.deepEqual(tutorCalls.map((x) => x.tools.length), [2, 0]);
  assert.equal(r.body.turn.wellbeingLevel, 0);
  assert.deepEqual(r.body.turn.sources, []);
  await rm(store.dir, { recursive: true, force: true });
});

// ---------- Source records ----------

test('save a card as a Source record: copied from the turn; same address twice is the same record', async () => {
  const { call, task, start, store } = await setup();
  const c = await start({ route: 'research', taskId: task.id });
  const turnId = (await call('POST', `/api/conversations/${c.id}/messages`, { text: 'invented go' })).body.turn.id;
  const r = await call('POST', '/api/sources', { turnId, index: 1 });
  assert.equal(r.status, 201);
  const s = r.body.source;
  assert.match(s.id, /^src_/);
  assert.deepEqual([s.url, s.title, s.category, s.taskId, s.topicIds, s.selected, s.fromTurnId, s.createdBy],
    [CARD2.url, CARD2.title, 'data', task.id, ['demo-geo-1a'], true, turnId, 'learner']);
  assert.deepEqual(s.why, { value: CARD2.why, author: 'ai' });
  assert.deepEqual(await store.read(sourcePath(s.id)), s);
  const again = await call('POST', '/api/sources', { turnId, index: 1 });
  assert.deepEqual([again.status, again.body.duplicate, again.body.source.id], [200, true, s.id]);
  const ev = store.events.filter((e) => e.type === 'source.saved');
  assert.equal(ev.length, 1);
  assert.deepEqual(ev[0].payload, { category: 'data' });
  assert.equal(JSON.stringify(ev).includes('invented'), false, 'events hold no text or addresses');

  assert.equal((await call('POST', '/api/sources', { turnId, index: 4 })).status, 404);
  assert.equal((await call('POST', '/api/sources', { turnId, index: 9 })).status, 400);
  assert.equal((await call('POST', '/api/sources', { turnId })).status, 400);
  assert.equal((await call('POST', '/api/sources', { turnId: 'turn_missing', index: 0 })).status, 404);
  assert.equal((await call('POST', '/api/sources', { turnId, index: 0, url: 'https://x.example.org' })).status, 400, 'no made-up cards');

  const list = await call('GET', `/api/sources?taskId=${task.id}`);
  assert.deepEqual(list.body.sources.map((x) => x.id), [s.id]);
  assert.deepEqual((await call('GET', '/api/sources?taskId=t_other')).body.sources, []);
  assert.equal((await call('GET', '/api/sources?taskId=../x')).status, 400);
  await rm(store.dir, { recursive: true, force: true });
});

test('the parent role is refused on every source route, and nothing is written', async () => {
  const { call, store } = await setup();
  const before = [store.writes.length, store.events.length];
  for (const [method, url, body] of [['GET', '/api/sources'], ['POST', '/api/sources', { turnId: 'turn_x', index: 0 }], ['POST', '/api/sources/src_x/summary', {}]]) {
    assert.equal((await call(method, url, body, { role: 'parent' })).status, 403, `${method} ${url}`);
  }
  assert.deepEqual([store.writes.length, store.events.length], before);
  await rm(store.dir, { recursive: true, force: true });
});

// ---------- AI summary cards ----------

async function savedSource(m, { taskLinked = true } = {}) {
  const env = await setup({ m });
  const c = await env.start(taskLinked ? { route: 'research', taskId: env.task.id } : { route: 'research' });
  const turnId = (await env.call('POST', `/api/conversations/${c.id}/messages`, { text: 'invented go' })).body.turn.id;
  const source = (await env.call('POST', '/api/sources', { turnId, index: 0 })).body.source;
  return { ...env, source };
}

test('a summary is saved as a notebook entry by the AI, with the source attached; read_notebook can use it', async () => {
  const m = models({ summaries: [{ readOriginal: false, summary: 'Invented summary of the guide.', section: 'Part 2' }] });
  const { call, store, source, task } = await savedSource(m);
  const r = await call('POST', `/api/sources/${source.id}/summary`, {});
  assert.equal(r.status, 201);
  assert.equal(r.body.outcome, 'saved');
  assert.equal(r.body.checkResult, 'passed');
  const entry = await store.read(notebookPath(r.body.entry.id));
  assert.deepEqual([entry.type, entry.title, entry.text, entry.section, entry.taskId, entry.sourceId, entry.createdBy, entry.sharedWithParent],
    ['summary', CARD.title, { value: 'Invented summary of the guide.', author: 'ai' }, { value: 'Part 2', author: 'ai' }, task.id, source.id, 'ai', null]);
  assert.deepEqual(entry.source, { title: CARD.title, author: CARD.publisher, url: CARD.url });
  assert.equal((await store.read(sourcePath(source.id))).summaryId, entry.id);
  const forModel = notebookEntryForModel(entry);
  assert.deepEqual([forModel.type, forModel.text.author, forModel.source.url], ['summary', 'ai', CARD.url]);
  // web_fetch only, never search, for a summary
  const summaryCall = m.ai.calls.find((x) => x.prompt.includes('<source_ref>'));
  assert.deepEqual(summaryCall.tools, ['web_fetch']);
  const turns = (await savedText(store)).includes(SUMMARY_FEATURE);
  assert.ok(turns, 'an AI turn is saved for the summary');
  const ev = store.events.find((e) => e.type === 'source.summary');
  assert.deepEqual(ev.payload, { outcome: 'saved', checkResult: 'passed' });
  assert.equal(JSON.stringify(store.events).includes('Invented summary'), false);
  await rm(store.dir, { recursive: true, force: true });
});

test('short and readable: read the original, and nothing is saved', async () => {
  const m = models({ summaries: [{ readOriginal: true }] });
  const { call, store, source } = await savedSource(m);
  const r = await call('POST', `/api/sources/${source.id}/summary`, {});
  assert.deepEqual([r.status, r.body.outcome, r.body.message, r.body.entry], [200, 'read-original', SOURCE_MESSAGES.readOriginal, null]);
  assert.equal(store.writes.some((w) => w.startsWith('notebook/')), false);
  await rm(store.dir, { recursive: true, force: true });

});

test('a summary written without the page being fetched is not saved', async () => {
  // the first call (the tutor) searched; the summary call doesn't fetch
  let calls = 0;
  const ai = createMockAi({
    replies: {
      [MODELS.conversation]: ({ prompt }) => (prompt.includes('<source_ref>')
        ? JSON.stringify({ readOriginal: false, summary: 'From memory.' })
        : JSON.stringify({ reply: 'Invented.', taskSpecific: false, wellbeingLevel: 0, sources: [CARD] })),
    },
  });
  const realAsk = ai.ask;
  ai.ask = async (req) => {
    calls += 1;
    if (calls === 1) req.onPermission?.(URL_PERMISSION, req.allowPermission?.(URL_PERMISSION) === true);
    return realAsk(req);
  };
  const { call, store, source } = await savedSource({ ai, handle: { ai, models: MODELS } }, { taskLinked: false });
  const r = await call('POST', `/api/sources/${source.id}/summary`, {});
  assert.deepEqual([r.body.outcome, r.body.message], ['unavailable', SOURCE_MESSAGES.unavailable]);
  assert.equal(store.writes.some((w) => w.startsWith('notebook/')), false);
  await rm(store.dir, { recursive: true, force: true });
});

test('on a task, a summary that fails the check twice is never saved', async () => {
  const m = models({ verdicts: [false, true], summaries: [{ readOriginal: false, summary: 'Invented leaky summary about Imaginary Bay.' }] });
  const { call, store, source } = await savedSource(m);
  const r = await call('POST', `/api/sources/${source.id}/summary`, {});
  assert.deepEqual([r.status, r.body.outcome, r.body.message, r.body.checkResult], [200, 'too-close', SOURCE_MESSAGES.tooClose, 'fallback']);
  assert.equal((await savedText(store)).includes('leaky summary'), false);
  const checks = store.writes.filter((w) => w.startsWith('ai-turns/')).length;
  assert.ok(checks >= 4, 'tutor, checker, summaries and their checks each have an AI turn');
  assert.ok((await savedText(store)).includes(CHECK_FEATURE));
  await rm(store.dir, { recursive: true, force: true });
});

test('a summary with no task is not checked', async () => {
  const m = models({ verdicts: [true], summaries: [{ readOriginal: false, summary: 'Invented summary.' }] });
  const { call, store, source } = await savedSource(m, { taskLinked: false });
  const before = m.checkPrompts.length;
  const r = await call('POST', `/api/sources/${source.id}/summary`, {});
  assert.equal(r.body.outcome, 'saved');
  assert.equal(r.body.checkResult, null);
  assert.equal(m.checkPrompts.length, before);
  await rm(store.dir, { recursive: true, force: true });
});

test('summaries: missing source 404, AI not ready 503, daily limit 429, unusable reply 502', async () => {
  const m = models({ summaries: ['not json'] });
  const { call, store, source } = await savedSource(m, { taskLinked: false });
  assert.equal((await call('POST', '/api/sources/src_missing/summary', {})).status, 404);
  assert.equal((await call('POST', `/api/sources/${source.id}/summary`, {})).status, 502);
  await rm(store.dir, { recursive: true, force: true });

  const off = await setup();
  const match = matchApiRoute('POST', '/api/sources/src_x/summary');
  await off.store.put(sourcePath('src_x'), { id: 'src_x', url: CARD.url, title: CARD.title, topicIds: [] });
  const r = await handleApi({ match, pass: { role: 'learner' }, store: off.store, body: {}, getAi: () => null, log: silent });
  assert.equal(r.status, 503);
  const capped = await handleApi({
    match, pass: { role: 'learner' }, store: off.store, body: {}, getAi: () => off.m.handle,
    aiCeiling: createAiCeiling({ limit: 0 }), log: silent,
  });
  assert.equal(capped.status, 429);
  await rm(off.store.dir, { recursive: true, force: true });
});
