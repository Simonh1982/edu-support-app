// Work records and limits (WP-105): AI turns, support events, field checks, rate limit, AI ceiling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEvent } from '../server/storage/records.js';
import { ukDate, textField, idDate, DomainError } from '../server/domain/fields.js';
import { newTask, applyTaskChanges, newAnchor } from '../server/domain/tasks.js';
import { newAiTurn, saveAiTurn, aiTurnPath, attemptPath, logSupport, logSupportOutcome } from '../server/domain/work.js';
import { ROUTES } from '../server/ai/prompt.js';
import { createRateLimiter, createAiCeiling, passKey } from '../server/rate-limits.js';
import { loadConfig } from '../server/config.js';

function memoryStore() {
  const files = new Map();
  const events = [];
  return {
    files,
    events,
    async put(rel, record) { files.set(rel, record); return record; },
    async logEvent(type, options = {}) { const e = makeEvent(type, options); events.push(e); return e; },
  };
}
const throws400 = (fn, pattern) => assert.throws(fn, (e) => e instanceof DomainError && e.status === 400 && pattern.test(e.message));

const TURN = {
  feature: 'research', role: 'conversation', model: 'demo-model', taskId: 't_demo',
  learnerText: 'An invented question', text: 'An invented reply', wellbeingLevel: 0, latencyMs: 1200,
  tokens: { input: 900, output: 120 }, taskSpecific: true,
};

test('AI turn: record shape, UK month path, text kept at levels 0 and 1', async () => {
  const store = memoryStore();
  const turn = await saveAiTurn(store, { ...TURN, wellbeingLevel: 1 }, { now: new Date('2026-11-03T10:00:00Z') });
  assert.match(turn.id, /^turn_/);
  assert.equal(turn.createdBy, 'ai');
  assert.deepEqual(turn.learnerText, { value: 'An invented question', author: 'learner' });
  assert.deepEqual(turn.text, { value: 'An invented reply', author: 'ai' });
  assert.equal(turn.textRemoved, false);
  assert.equal(turn.checkResult, null);
  assert.equal(turn.success, true);
  assert.deepEqual([...store.files.keys()], [`ai-turns/2026-11/${turn.id}.json`]);
  assert.equal(aiTurnPath(turn.id), `ai-turns/2026-11/${turn.id}.json`);
});

test('AI turn: levels 2 and 3 never keep the text (backstop for WP-112)', () => {
  for (const level of [2, 3]) {
    const turn = newAiTurn({ ...TURN, wellbeingLevel: level });
    assert.equal(turn.learnerText, null);
    assert.equal(turn.text, null);
    assert.equal(turn.textRemoved, true);
    assert.equal(JSON.stringify(turn).includes('invented'), false);
  }
});

test('AI turn: bad role, level, check result or unknown field are refused', () => {
  throws400(() => newAiTurn({ ...TURN, role: 'wizard' }), /role/);
  throws400(() => newAiTurn({ ...TURN, wellbeingLevel: 4 }), /wellbeingLevel/);
  throws400(() => newAiTurn({ ...TURN, checkResult: 'maybe' }), /checkResult/);
  throws400(() => newAiTurn({ ...TURN, diagnosis: 'x' }), /unknown field diagnosis/);
  throws400(() => newAiTurn({ ...TURN, text: { value: 'x', author: 'learner' } }), /author/);
});

test('support events: ids and types only; outcome linked to the support event', async () => {
  const store = memoryStore();
  const ev = await logSupport(store, { type: 'hint', route: 'plan', attemptId: 'att_demo', taskId: 't_demo' });
  assert.equal(ev.type, 'support.requested');
  assert.deepEqual(ev.links, { attemptId: 'att_demo', taskId: 't_demo' });
  assert.deepEqual(ev.payload, { type: 'hint', route: 'plan' });
  const out = await logSupportOutcome(store, { supportEventId: ev.id, outcome: 'tried-again' });
  assert.deepEqual(out.links, { supportEventId: ev.id });
  await assert.rejects(logSupport(store, { type: 'answer', route: 'plan', attemptId: 'att_demo' }), /support type/);
  await assert.rejects(logSupport(store, { type: 'hint', route: 'plan' }), /attemptId is required/);
  await assert.rejects(logSupportOutcome(store, { supportEventId: ev.id, outcome: 'meh' }), /outcome/);
  assert.equal(store.events.length, 2);
});

test('the attempt routes match the skill-file routes', async () => {
  const { newAttempt } = await import('../server/domain/work.js');
  for (const route of ROUTES) assert.equal(newAttempt({ route, text: 'x' }).route, route);
});

test('paths: the month folder comes from the id, in UK time', () => {
  // 23:30 UTC on 31 Oct 2026 is still 31 Oct in the UK (GMT from 25 Oct), but 00:30 BST on 1 Oct is September UTC
  const id = (iso) => `att_${new Date(iso).getTime().toString(36)}_0000abcd`;
  assert.equal(attemptPath(id('2026-10-31T23:30:00Z')), `attempts/2026-10/${id('2026-10-31T23:30:00Z')}.json`);
  assert.equal(attemptPath(id('2026-09-30T23:30:00Z')), `attempts/2026-10/${id('2026-09-30T23:30:00Z')}.json`);
  assert.equal(attemptPath('../etc'), null);
  assert.equal(idDate('nonsense'), null);
});

test('fields: dates, text with author', () => {
  assert.equal(ukDate('2028-02-29', 'd'), '2028-02-29');
  throws400(() => ukDate('2027-02-29', 'd'), /date/);
  throws400(() => ukDate('20/11/2026', 'd'), /date/);
  assert.deepEqual(textField('  hi  ', 't', { max: 10, defaultAuthor: 'learner' }), { value: 'hi', author: 'learner' });
  throws400(() => textField({ value: 'x', author: 'robot' }, 't', { max: 10, defaultAuthor: 'learner' }), /author/);
});

test('task records: new task stages, anchors and changes', () => {
  const now = new Date('2026-11-02T09:00:00Z');
  const t = newTask({ title: 'Invented', stage: 'done' }, { now });
  assert.equal(t.completedAt, '2026-11-02T09:00:00+00:00');
  throws400(() => newTask({ title: 'Invented', anchors: 'x' }), /anchors must be a list/);
  const a = newAnchor({ type: 'location', text: { value: 'Imaginary town', author: 'source' } }, { createdBy: 'ai' });
  assert.equal(a.confirmed, false);
  assert.equal(a.createdBy, 'ai');
  const { changed, stage } = applyTaskChanges(t, { stage: 'done', subject: 'Geography' });
  assert.deepEqual(changed, ['subject']);
  assert.equal(stage, null);
});

test('rate limiter: fixed window, separate keys, bounded memory', () => {
  let t = 0;
  const limiter = createRateLimiter({ limit: 2, windowMs: 1000, now: () => t, maxKeys: 3 });
  assert.equal(limiter.take('a').ok, true);
  assert.equal(limiter.take('a').ok, true);
  assert.deepEqual(limiter.take('a'), { ok: false, retryAfterS: 1 });
  assert.equal(limiter.take('b').ok, true);
  t = 1000;
  assert.equal(limiter.take('a').ok, true);
  for (const k of ['c', 'd', 'e', 'f']) limiter.take(k);
  assert.equal(limiter.size(), 3);
});

test('pass key: account and sign-in time only', () => {
  assert.equal(passKey({ sub: 'Test-Learner', iat: 123, role: 'learner' }), 'test-learner:123');
});

test('AI ceiling: counts per UK day and resets at UK midnight', () => {
  let now = new Date('2026-07-01T22:30:00Z'); // 23:30 BST on 1 July
  const ceiling = createAiCeiling({ limit: 2, now: () => now });
  assert.equal(ceiling.take().ok, true);
  assert.equal(ceiling.take().ok, true);
  const refused = ceiling.take();
  assert.equal(refused.ok, false);
  assert.match(refused.message, /today's limit/);
  now = new Date('2026-07-01T23:30:00Z'); // 00:30 BST on 2 July: a new UK day
  assert.equal(ceiling.take().ok, true);
  assert.deepEqual(ceiling.status(), { day: '2026-07-02', used: 1, limit: 2 });
});

test('config: limit settings with safe fallbacks', () => {
  const c = loadConfig({});
  assert.equal(c.rateLimitPerMin, 120);
  assert.equal(c.aiDailyCeiling, 300);
  const d = loadConfig({ RATE_LIMIT_PER_MIN: '30', AI_DAILY_CEILING: 'lots' });
  assert.equal(d.rateLimitPerMin, 30);
  assert.equal(d.aiDailyCeiling, 300);
});
