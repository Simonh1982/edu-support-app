// WP-111a: conversations, attempt before help, the support pairs in order, the escape, the
// disengagement trigger, route choice and reply votes. Mock AI and invented data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makeEvent } from '../server/storage/records.js';
import { createMockAi } from '../server/ai/mock.js';
import { createAiCeiling } from '../server/rate-limits.js';
import { matchApiRoute, handleApi } from '../server/api.js';
import { ROUTES } from '../server/ai/prompt.js';
import { loadConfig } from '../server/config.js';
import { createServer } from '../server/index.js';
import { passSettings, mintPass } from '../server/auth.js';
import { isIdkStyle, idkCount, isDisengaged, normaliseAnswer } from '../server/derived/engagement.js';
import { routeFromTask, WORK_ROUTES } from '../server/derived/route.js';
import { DISENGAGED_INSTRUCTION, ACTION_INSTRUCTIONS, parseTutorReply, parseRouteReply } from '../server/ai/conversation.js';
import { advance, offeredSupport, conversationPath, FIRST_PAIR, SECOND_PAIR } from '../server/domain/conversations.js';
import { aiTurnPath, attemptPath } from '../server/domain/work.js';

const MODELS = Object.freeze({
  conversation: 'mock-conversation', review: 'mock-review', light: 'mock-light',
  spelling: 'mock-spelling', checker: 'mock-checker', judge: 'mock-judge',
});
const silent = { log() {}, error() {}, warn() {} };
// shaped like loadCurriculum()'s result, because the real topicExtract() reads it
const curriculum = {
  qualifications: new Map([['demo-geo', { id: 'demo-geo', title: 'Invented Geography', awardingBody: null, specificationCode: null, units: [], aos: [], commandWords: [] }]]),
  topics: new Map([['demo-geo-1a', { id: 'demo-geo-1a', qualId: 'demo-geo', unitId: null, title: 'Invented coasts topic', record: { id: 'demo-geo-1a', title: 'Invented coasts topic' } }]]),
};
const QUESTION = 'Evaluate hard engineering at an invented coastline.';
const ANCHOR = 'Imaginary Bay';
const LEARNER_WORDS = 'maybe sea walls stop erosion';

async function fakeStore({ ready = true } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wp111-'));
  const events = [];
  const writes = [];
  return {
    dir, events, writes,
    status: () => ({ ready }),
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

// A mock tutor: records every prompt; replies with a set wellbeing level (or none).
function tutor({ level = 0, reply = 'Invented tutor reply.', route = 'learn', fail = false } = {}) {
  const prompts = [];
  const ai = createMockAi({
    replies: {
      [MODELS.conversation]: ({ system, prompt }) => {
        prompts.push({ system, prompt });
        const body = { reply, replyType: 'explanation', taskSpecific: false, sources: [] };
        if (level !== null) body.wellbeingLevel = level;
        return JSON.stringify(body);
      },
      [MODELS.light]: () => JSON.stringify({ route, wellbeingLevel: 0 }),
      // the live check (WP-113) passes every reply here; test/check.test.js covers failures
      [MODELS.checker]: () => JSON.stringify({ leak: false, reason: 'invented' }),
    },
    failures: fail ? { [MODELS.conversation]: 'invented outage' } : {},
  });
  return { ai, prompts, handle: { ai, models: MODELS } };
}

async function setup({ ai = tutor(), ceiling = null, settings = {}, store } = {}) {
  const s = store ?? await fakeStore();
  const call = async (method, url, body, { role = 'learner', aiHandle = ai.handle } = {}) => {
    const match = matchApiRoute(method, url);
    assert.ok(match?.route, `route ${method} ${url}`);
    return handleApi({
      match, pass: { role }, store: s, body, getCurriculum: () => curriculum,
      getAi: () => aiHandle, aiCeiling: ceiling, settings, log: silent,
    });
  };
  const task = (await call('POST', '/api/tasks', {
    title: 'Invented coast essay', questionText: QUESTION, topicIds: ['demo-geo-1a'],
    anchors: [{ type: 'location', text: ANCHOR }],
  })).body.task;
  return { store: s, call, task, ai };
}

const start = async (call, body) => (await call('POST', '/api/conversations', body)).body.conversation;

// ---------- pure rules ----------

test('support pairs: none before an attempt; first pair; second only after a fresh attempt; never out of order', () => {
  let s = { pair: 0, waiting: true, escape: false };
  assert.deepEqual(offeredSupport(s), []);
  for (const type of [...FIRST_PAIR, ...SECOND_PAIR]) assert.throws(() => advance(s, { action: 'support', type }), (e) => e.status === 409);
  s = advance(s, { action: 'attempt' });
  assert.deepEqual(offeredSupport(s), ['hint', 'breakdown']);
  for (const type of SECOND_PAIR) assert.throws(() => advance(s, { action: 'support', type }), (e) => e.status === 409);
  s = advance(s, { action: 'support', type: 'hint' });
  assert.deepEqual(offeredSupport(s), [], 'after help: a fresh attempt first');
  assert.throws(() => advance(s, { action: 'support', type: 'breakdown' }), (e) => e.status === 409);
  s = advance(s, { action: 'attempt' });
  assert.deepEqual(offeredSupport(s), ['pointer', 'explanation']);
  assert.throws(() => advance(s, { action: 'support', type: 'hint' }), (e) => e.status === 409);
  s = advance(s, { action: 'support', type: 'explanation' });
  assert.deepEqual(offeredSupport(s), []);
  s = advance(s, { action: 'attempt' });
  assert.deepEqual(offeredSupport(s), ['pointer', 'explanation'], 'the second pair stays after more attempts');
});

test('escape: Break it down only, and only at the start', () => {
  let s = advance({ pair: 0, waiting: true, escape: false }, { action: 'attempt', escape: true });
  assert.deepEqual(offeredSupport(s), ['breakdown']);
  assert.throws(() => advance(s, { action: 'support', type: 'hint' }), (e) => e.status === 409);
  s = advance(s, { action: 'support', type: 'breakdown' });
  assert.throws(() => advance(s, { action: 'attempt', escape: true }), (e) => e.status === 409);
  s = advance(s, { action: 'attempt' });
  assert.deepEqual(offeredSupport(s), ['pointer', 'explanation']);
});

test('idk-style answers: whole answers only; the escape wording and "nothing yet" never count', () => {
  for (const t of ['idk', 'IDK.', 'i dont know', "I don't know lol", 'dunno', 'no idea tbh', 'not sure', '??', 'um idk']) {
    assert.equal(isIdkStyle(t), true, t);
  }
  for (const t of ["I don't know where to start", 'Nothing yet', 'not sure but maybe erosion', 'no', '', null, 'erosion?']) {
    assert.equal(isIdkStyle(t), false, String(t));
  }
  assert.equal(normaliseAnswer("Um, I don't know, sorry!"), 'i dont know');
  const turns = [{ idk: true }, { idk: false }, { idk: true }, {}];
  assert.equal(idkCount(turns), 2);
  assert.equal(isDisengaged(turns, 2), true);
  assert.equal(isDisengaged(turns, 3), false);
});

test('route rules from the task stage; work routes are conversation routes', () => {
  assert.deepEqual(routeFromTask({ stage: 'not-started' }), { route: 'research', options: ['research', 'plan', 'review'] });
  assert.deepEqual(routeFromTask({ stage: 'planning' }).options, ['plan', 'research', 'review']);
  assert.equal(routeFromTask({ stage: 'drafting' }).route, 'review');
  assert.deepEqual(routeFromTask({ stage: 'done' }), { route: null, options: ['research', 'plan', 'review'] });
  for (const r of WORK_ROUTES) assert.ok(ROUTES.includes(r));
});

test('reply parsing: the model\'s reply type is ignored; levels must be 0–3', () => {
  assert.deepEqual(parseTutorReply('```json\n{"reply":" Hi ","replyType":"answer","wellbeingLevel":1,"taskSpecific":true}\n```'),
    { reply: 'Hi', taskSpecific: true, wellbeingLevel: 1 });
  assert.equal(parseTutorReply('{"reply":"Hi","wellbeingLevel":7}').wellbeingLevel, null);
  assert.equal(parseTutorReply('{"reply":"  "}'), null);
  assert.equal(parseTutorReply('not json'), null);
  assert.deepEqual(parseRouteReply('{"route":"essay-writer","wellbeingLevel":0}'), { route: null, wellbeingLevel: 0 });
});

// ---------- the routes ----------

test('start: route required, task must exist, topic taken from the task; event without text', async () => {
  const { call, task, store } = await setup();
  assert.equal((await call('POST', '/api/conversations', { taskId: task.id })).status, 400);
  assert.equal((await call('POST', '/api/conversations', { route: 'essay' })).status, 400);
  assert.equal((await call('POST', '/api/conversations', { route: 'plan', taskId: 't_missing' })).status, 404);
  const r = await call('POST', '/api/conversations', { route: 'research', taskId: task.id });
  assert.equal(r.status, 201);
  const c = r.body.conversation;
  assert.match(c.id, /^conv_/);
  assert.equal(c.topicId, 'demo-geo-1a');
  assert.deepEqual([c.needsAttempt, c.canEscape, c.offered, c.turns], [true, true, [], []]);
  assert.ok(await store.read(conversationPath(c.id)));
  const ev = store.events.find((e) => e.type === 'conversation.started');
  assert.deepEqual(ev.payload, { route: 'research' });
  assert.equal(ev.links.conversationId, c.id);
  await rm(store.dir, { recursive: true, force: true });
});

test('attempt before help: support refused until something is written; the attempt opens the first pair', async () => {
  const { call, task, store, ai } = await setup();
  const c = await start(call, { route: 'research', taskId: task.id });
  const early = await call('POST', `/api/conversations/${c.id}/support`, { type: 'hint' });
  assert.equal(early.status, 409);
  assert.equal(ai.prompts.length, 0, 'no AI call for a refused button');
  assert.equal((await call('POST', `/api/conversations/${c.id}/messages`, { text: '   ' })).status, 400);

  const r = await call('POST', `/api/conversations/${c.id}/messages`, { text: LEARNER_WORDS });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.conversation.offered, ['hint', 'breakdown']);
  assert.equal(r.body.conversation.needsAttempt, false);
  assert.equal(r.body.turn.reply, 'Invented tutor reply.');
  assert.equal(r.body.turn.replyType, 'other', 'set by the server, not the model');
  assert.equal(r.body.turn.wellbeingLevel, 0);
  const { system, prompt } = ai.prompts[0];
  assert.match(system, /Route skill:/);
  assert.match(prompt, /<task>[\s\S]*Evaluate hard engineering[\s\S]*location: Imaginary Bay[\s\S]*<\/task>/);
  assert.match(prompt, /<curriculum>[\s\S]*demo-geo-1a/);
  assert.match(prompt, new RegExp(`<learner_message>${LEARNER_WORDS}</learner_message>`));
  assert.ok(prompt.includes(ACTION_INSTRUCTIONS.attempt));

  const attempt = await store.read(attemptPath(r.body.attemptId));
  assert.deepEqual(attempt.text, { value: LEARNER_WORDS, author: 'learner' });
  const turn = await store.read(aiTurnPath(r.body.turn.id));
  assert.deepEqual([turn.feature, turn.role, turn.model, turn.attemptId, turn.wellbeingLevel], ['research', 'conversation', MODELS.conversation, attempt.id, 0]);
  assert.deepEqual(turn.learnerText, { value: LEARNER_WORDS, author: 'learner' });
  assert.equal(JSON.stringify(store.events).includes('sea walls'), false, 'events hold no text');
  await rm(store.dir, { recursive: true, force: true });
});

test('second pair only after a fresh attempt; outcome logged; support turns carry no learner text', async () => {
  const { call, task, store, ai } = await setup();
  const c = await start(call, { route: 'plan', taskId: task.id });
  await call('POST', `/api/conversations/${c.id}/messages`, { text: 'my main point is cost' });
  assert.equal((await call('POST', `/api/conversations/${c.id}/support`, { type: 'pointer' })).status, 409);
  const hint = await call('POST', `/api/conversations/${c.id}/support`, { type: 'hint' });
  assert.equal(hint.status, 201);
  assert.equal(hint.body.turn.replyType, 'hint');
  assert.deepEqual(hint.body.conversation.offered, []);
  assert.equal(hint.body.conversation.needsAttempt, true);
  assert.ok(ai.prompts[1].prompt.includes('<learner_attempt>my main point is cost</learner_attempt>'));
  assert.ok(ai.prompts[1].prompt.includes(ACTION_INSTRUCTIONS.hint));
  assert.equal((await call('POST', `/api/conversations/${c.id}/support`, { type: 'breakdown' })).status, 409);
  assert.equal((await call('POST', `/api/conversations/${c.id}/support`, { type: 'explanation' })).status, 409);

  const fresh = await call('POST', `/api/conversations/${c.id}/messages`, { text: 'cost and who pays' });
  assert.deepEqual(fresh.body.conversation.offered, ['pointer', 'explanation']);
  const explain = await call('POST', `/api/conversations/${c.id}/support`, { type: 'explanation' });
  assert.equal(explain.status, 201);
  const turn = await store.read(aiTurnPath(explain.body.turn.id));
  assert.equal(turn.learnerText, null);
  assert.equal(turn.wellbeingLevel, null, 'a button press is not rated');
  assert.equal(turn.attemptId, fresh.body.attemptId);

  const types = store.events.map((e) => e.type);
  assert.deepEqual(types.filter((t) => t.startsWith('support.')), ['support.requested', 'support.outcome', 'support.requested']);
  const outcome = store.events.find((e) => e.type === 'support.outcome');
  assert.equal(outcome.links.supportEventId, store.events.find((e) => e.type === 'support.requested').id);
  assert.deepEqual(outcome.payload, { outcome: 'tried-again' });
  assert.equal(types.filter((t) => t === 'attempt.recorded').length, 2);
  assert.equal(JSON.stringify(store.events).includes('cost'), false);
  await rm(store.dir, { recursive: true, force: true });
});

test('a free message after the first pair is offered is not an attempt and changes nothing', async () => {
  const { call, store } = await setup();
  const c = await start(call, { route: 'learn', topicId: 'demo-geo-1a' });
  await call('POST', `/api/conversations/${c.id}/messages`, { text: 'Nothing yet' });
  const r = await call('POST', `/api/conversations/${c.id}/messages`, { text: 'what is a groyne?' });
  assert.equal(r.body.attemptId, null);
  assert.deepEqual(r.body.conversation.offered, ['hint', 'breakdown']);
  assert.equal(store.events.filter((e) => e.type === 'attempt.recorded').length, 1);
  await rm(store.dir, { recursive: true, force: true });
});

test('escape: no AI call, Break it down only, recorded as an escape attempt', async () => {
  const { call, task, store, ai } = await setup();
  const c = await start(call, { route: 'research', taskId: task.id });
  assert.equal((await call('POST', `/api/conversations/${c.id}/messages`, { escape: true, text: 'x' })).status, 400);
  const r = await call('POST', `/api/conversations/${c.id}/messages`, { escape: true });
  assert.equal(r.status, 201);
  assert.equal(r.body.turn, null);
  assert.equal(ai.prompts.length, 0);
  assert.deepEqual(r.body.conversation.offered, ['breakdown']);
  assert.equal(r.body.conversation.canEscape, false);
  assert.equal((await store.read(attemptPath(r.body.attemptId))).escape, true);
  assert.equal((await call('POST', `/api/conversations/${c.id}/support`, { type: 'hint' })).status, 409);
  assert.equal((await call('POST', `/api/conversations/${c.id}/support`, { type: 'breakdown' })).status, 201);
  assert.equal((await call('POST', `/api/conversations/${c.id}/messages`, { escape: true })).status, 409);
  await rm(store.dir, { recursive: true, force: true });
});

test('disengagement: shorter replies after the set number of idk-style answers; one event; escape not counted', async () => {
  const { call, store, ai } = await setup({ settings: { disengageAfter: 3 } });
  const c = await start(call, { route: 'learn' });
  await call('POST', `/api/conversations/${c.id}/messages`, { escape: true });
  await call('POST', `/api/conversations/${c.id}/messages`, { text: 'idk' });
  await call('POST', `/api/conversations/${c.id}/messages`, { text: 'dunno' });
  assert.equal(ai.prompts.some((p) => p.prompt.includes(DISENGAGED_INSTRUCTION)), false);
  const third = await call('POST', `/api/conversations/${c.id}/messages`, { text: 'no idea' });
  assert.equal(third.body.conversation.disengaged, true);
  assert.equal(third.body.conversation.idkCount, 3);
  assert.ok(ai.prompts.at(-1).prompt.includes(DISENGAGED_INSTRUCTION));
  await call('POST', `/api/conversations/${c.id}/messages`, { text: 'ok erosion then' });
  assert.ok(ai.prompts.at(-1).prompt.includes(DISENGAGED_INSTRUCTION), 'stays shorter for the rest of the conversation');
  const evs = store.events.filter((e) => e.type === 'conversation.disengaged');
  assert.equal(evs.length, 1);
  assert.deepEqual(evs[0].payload, { route: 'learn', count: 3 });
  await rm(store.dir, { recursive: true, force: true });

  const two = await setup({ settings: { disengageAfter: 2 } });
  const c2 = await start(two.call, { route: 'learn' });
  await two.call('POST', `/api/conversations/${c2.id}/messages`, { text: 'idk' });
  const r = await two.call('POST', `/api/conversations/${c2.id}/messages`, { text: '?' });
  assert.equal(r.body.conversation.disengaged, true, 'the trigger is a setting');
  await rm(two.store.dir, { recursive: true, force: true });
});

test('wellbeing level: asked once more if missing, then recorded as unknown; levels 2–3 keep no text', async () => {
  const missing = await setup({ ai: tutor({ level: null }) });
  const c = await start(missing.call, { route: 'learn' });
  const r = await missing.call('POST', `/api/conversations/${c.id}/messages`, { text: 'invented question' });
  assert.equal(r.status, 201);
  assert.equal(missing.ai.prompts.length, 2, 'asked once more');
  assert.equal(r.body.turn.wellbeingLevel, null);
  assert.equal((await missing.store.read(aiTurnPath(r.body.turn.id))).wellbeingLevel, null);
  await rm(missing.store.dir, { recursive: true, force: true });

  const upset = await setup({ ai: tutor({ level: 2, reply: 'Invented kind reply.' }) });
  const c2 = await start(upset.call, { route: 'learn' });
  const r2 = await upset.call('POST', `/api/conversations/${c2.id}/messages`, { text: 'invented personal words' });
  assert.equal(r2.body.turn.reply, 'Invented kind reply.', 'he still sees the reply');
  assert.equal(r2.body.turn.textRemoved, true);
  const turn = await upset.store.read(aiTurnPath(r2.body.turn.id));
  assert.equal(JSON.stringify(turn).includes('invented personal words'), false);
  assert.equal(JSON.stringify(turn).includes('Invented kind reply'), false);
  await rm(upset.store.dir, { recursive: true, force: true });
});

test('AI not ready, AI failing or the daily ceiling reached: nothing saved, state unchanged', async () => {
  const off = await setup();
  const c = await start(off.call, { route: 'learn' });
  const before = off.store.writes.length;
  const r = await off.call('POST', `/api/conversations/${c.id}/messages`, { text: 'invented' }, { aiHandle: null });
  assert.equal(r.status, 503);
  assert.equal(off.store.writes.length, before);
  await rm(off.store.dir, { recursive: true, force: true });

  const failing = await setup({ ai: tutor({ fail: true }) });
  const c2 = await start(failing.call, { route: 'learn' });
  const n = failing.store.writes.length;
  const r2 = await failing.call('POST', `/api/conversations/${c2.id}/messages`, { text: 'invented' });
  assert.equal(r2.status, 502);
  assert.doesNotMatch(r2.body.error, /invented outage/);
  assert.equal(failing.store.writes.length, n);
  assert.equal((await failing.call('GET', `/api/conversations/${c2.id}`)).body.conversation.needsAttempt, true);
  await rm(failing.store.dir, { recursive: true, force: true });

  const ceiling = createAiCeiling({ limit: 1 });
  const capped = await setup({ ceiling });
  const c3 = await start(capped.call, { route: 'learn' });
  assert.equal((await capped.call('POST', `/api/conversations/${c3.id}/messages`, { text: 'one' })).status, 201);
  const m = capped.store.writes.length;
  const over = await capped.call('POST', `/api/conversations/${c3.id}/messages`, { text: 'two' });
  assert.equal(over.status, 429);
  assert.equal(capped.store.writes.length, m);
  await rm(capped.store.dir, { recursive: true, force: true });
});

test('resume: the conversation comes back with its turns; missing ones 404', async () => {
  const { call, store } = await setup();
  const c = await start(call, { route: 'learn' });
  await call('POST', `/api/conversations/${c.id}/messages`, { text: 'invented first go' });
  await call('POST', `/api/conversations/${c.id}/support`, { type: 'breakdown' });
  const r = await call('GET', `/api/conversations/${c.id}`);
  assert.equal(r.status, 200);
  const turns = r.body.conversation.turns;
  assert.deepEqual(turns.map((t) => [t.action, t.type]), [['attempt', null], ['support', 'breakdown']]);
  assert.equal(turns[0].learnerText, 'invented first go');
  assert.equal(turns[1].reply, 'Invented tutor reply.');
  assert.equal((await call('GET', '/api/conversations/conv_missing')).status, 404);
  assert.equal((await call('POST', '/api/conversations/conv_missing/messages', { text: 'x' })).status, 404);
  await rm(store.dir, { recursive: true, force: true });
});

test('votes: up, down and removed are events with the turn and route only, never sent to the model', async () => {
  const { call, store, ai } = await setup();
  const c = await start(call, { route: 'learn' });
  const r = await call('POST', `/api/conversations/${c.id}/messages`, { text: 'invented go' });
  const id = r.body.turn.id;
  for (const vote of ['up', 'down', 'removed']) {
    const v = await call('POST', `/api/turns/${id}/vote`, { vote });
    assert.equal(v.status, 200);
    assert.deepEqual(v.body, { turnId: id, route: 'learn', vote });
  }
  const votes = store.events.filter((e) => e.type === 'reply.feedback');
  assert.deepEqual(votes.map((e) => e.payload), [{ route: 'learn', vote: 'up' }, { route: 'learn', vote: 'down' }, { route: 'learn', vote: 'removed' }]);
  assert.deepEqual(votes[0].links, { turnId: id });
  assert.equal((await call('POST', `/api/turns/${id}/vote`, { vote: 'love' })).status, 400);
  assert.equal((await call('POST', '/api/turns/turn_missing/vote', { vote: 'up' })).status, 404);
  await call('POST', `/api/conversations/${c.id}/messages`, { text: 'another invented go' });
  assert.doesNotMatch(ai.prompts.at(-1).prompt, /vote|thumb|reply\.feedback/i);
  await rm(store.dir, { recursive: true, force: true });
});

test('route choice: from the task without AI; from a message by the light model, saving no text', async () => {
  const { call, task, store } = await setup();
  const byTask = await call('POST', '/api/route', { taskId: task.id });
  assert.deepEqual(byTask.body, { route: 'research', options: ['research', 'plan', 'review'], by: 'task' });
  await call('PATCH', `/api/tasks/${task.id}`, { stage: 'planning' });
  assert.equal((await call('POST', '/api/route', { taskId: task.id })).body.route, 'plan');
  assert.equal((await call('POST', '/api/route', { taskId: 't_missing' })).status, 404);

  const byMessage = await call('POST', '/api/route', { message: 'I want to learn about invented rivers' });
  assert.deepEqual(byMessage.body, { route: 'learn', options: ['learn', 'research', 'plan', 'review'], by: 'light' });
  const turnFile = store.writes.find((w) => w.startsWith('ai-turns/'));
  const turn = await store.read(turnFile);
  assert.deepEqual([turn.feature, turn.role, turn.learnerText, turn.text, turn.wellbeingLevel], ['route-choice', 'light', null, null, 0]);
  assert.equal((await call('POST', `/api/turns/${turn.id}/vote`, { vote: 'up' })).status, 404, 'not a reply he reads');

  const none = await call('POST', '/api/route', { message: 'invented' }, { aiHandle: null });
  assert.deepEqual(none.body, { route: null, options: ['research', 'plan', 'review', 'learn'], by: 'none' });
  await rm(store.dir, { recursive: true, force: true });
});

test('the parent role is refused on every conversation route, and nothing is written', async () => {
  const { call, store } = await setup();
  const c = await start(call, { route: 'learn' });
  const r = await call('POST', `/api/conversations/${c.id}/messages`, { text: 'invented go' });
  const before = [store.writes.length, store.events.length];
  for (const [method, url, body] of [
    ['POST', '/api/route', { message: 'x' }], ['POST', '/api/conversations', { route: 'learn' }],
    ['GET', `/api/conversations/${c.id}`], ['POST', `/api/conversations/${c.id}/messages`, { text: 'x' }],
    ['POST', `/api/conversations/${c.id}/support`, { type: 'hint' }], ['POST', `/api/turns/${r.body.turn.id}/vote`, { vote: 'up' }],
  ]) {
    const res = await call(method, url, body, { role: 'parent' });
    assert.equal(res.status, 403, `${method} ${url}`);
    assert.equal(JSON.stringify(res.body).includes('invented'), false);
  }
  assert.deepEqual([store.writes.length, store.events.length], before);
  await rm(store.dir, { recursive: true, force: true });
});

test('the server passes the AI, the ceiling and the setting through to the routes', async () => {
  const store = await fakeStore();
  const { settings } = passSettings({
    PASS_SIGNING_KEY: 'k'.repeat(40), PASS_VERSION: '1', ALLOWED_ACCOUNTS: JSON.stringify({ 'test-learner': 'learner' }),
  });
  const ai = tutor();
  const config = loadConfig({ PORT: '0', HOST: '127.0.0.1', DISENGAGE_AFTER: '1' });
  assert.equal(config.disengageAfter, 1);
  assert.equal(loadConfig({}).disengageAfter, 3);
  const { server } = createServer(config, undefined, silent, {
    authSettings: settings, getStore: () => store, getCurriculum: () => curriculum,
    getAi: () => ai.handle, aiCeiling: createAiCeiling({ limit: 5 }),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const pass = await mintPass({ login: 'test-learner', settings });
  const post = async (url, body) => {
    const res = await fetch(`${base}${url}`, {
      method: 'POST', headers: { Authorization: `Bearer ${pass}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  try {
    const c = (await post('/api/conversations', { route: 'learn' })).body.conversation;
    const r = await post(`/api/conversations/${c.id}/messages`, { text: 'idk' });
    assert.equal(r.status, 201);
    assert.equal(r.body.conversation.disengaged, true, 'DISENGAGE_AFTER=1 reached the route');
    assert.equal((await fetch(`${base}/api/conversations/${c.id}`)).status, 401, 'a pass is needed');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(store.dir, { recursive: true, force: true });
  }
});
