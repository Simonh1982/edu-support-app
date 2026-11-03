// WP-112: wellbeing levels 2–3. His words and the reply are dropped before saving, a disclosure event
// keeps the date and level only, the owner is alerted, and level-3 replies always show the UK
// helplines. Mock AI, a fake alert sender and invented data only: no real alert is ever sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makeEvent } from '../server/storage/records.js';
import { createMockAi } from '../server/ai/mock.js';
import { matchApiRoute, handleApi } from '../server/api.js';
import { buildSystem, loadSkill } from '../server/ai/prompt.js';
import { aiTurnPath } from '../server/domain/work.js';
import {
  DISCLOSURE_EVENT, HELPLINES, createWellbeing, isDisclosure, noteDisclosure, recordDisclosure,
} from '../server/wellbeing.js';
import * as screen from '../web/shared/conversation.js';

const MODELS = Object.freeze({
  conversation: 'mock-conversation', review: 'mock-review', light: 'mock-light',
  spelling: 'mock-spelling', checker: 'mock-checker', judge: 'mock-judge',
});
const silent = { log() {}, error() {}, warn() {} };
const curriculum = {
  qualifications: new Map([['demo-geo', { id: 'demo-geo', title: 'Invented Geography', awardingBody: null, specificationCode: null, units: [], aos: [], commandWords: [] }]]),
  topics: new Map([['demo-geo-1a', { id: 'demo-geo-1a', qualId: 'demo-geo', unitId: null, title: 'Invented coasts topic', record: { id: 'demo-geo-1a', title: 'Invented coasts topic' } }]]),
};
const PERSONAL = 'invented personal words for a test';
const KIND_REPLY = 'Invented caring reply.';

async function fakeStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wp112-'));
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

// Every saved file and every event, as text, so a test can prove his words went nowhere.
async function everythingSaved(store) {
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

// levels: the conversation model's wellbeingLevel for each call in turn (the last one repeats).
function tutor({ levels = [0], lightLevel = 0, reply = KIND_REPLY } = {}) {
  let n = 0;
  const ai = createMockAi({
    replies: {
      [MODELS.conversation]: () => {
        const level = levels[Math.min(n, levels.length - 1)];
        n += 1;
        return JSON.stringify({ reply, replyType: 'other', taskSpecific: false, wellbeingLevel: level, sources: [] });
      },
      [MODELS.light]: () => JSON.stringify({ route: 'research', wellbeingLevel: lightLevel }),
      // the live check (WP-113) passes every reply here; test/check.test.js covers failures
      [MODELS.checker]: () => JSON.stringify({ leak: false, reason: 'invented' }),
    },
  });
  return { ai, models: MODELS };
}

function fakeAlerts() {
  const sent = [];
  const wellbeing = createWellbeing({ send: async (args) => { sent.push({ kind: args.kind, level: args.level }); return { ok: true, status: 204 }; }, log: silent });
  return { sent, wellbeing };
}

async function setup({ ai = tutor(), wellbeing = fakeAlerts().wellbeing, log = silent } = {}) {
  const store = await fakeStore();
  const call = async (method, url, body) => {
    const match = matchApiRoute(method, url);
    assert.ok(match?.route, `route ${method} ${url}`);
    return handleApi({
      match, pass: { role: 'learner' }, store, body, getCurriculum: () => curriculum, getAi: () => ai, wellbeing, log,
    });
  };
  const task = (await call('POST', '/api/tasks', { title: 'Invented coast essay', questionText: 'Evaluate an invented sea wall.', topicIds: ['demo-geo-1a'] })).body.task;
  const conv = (await call('POST', '/api/conversations', { route: 'research', taskId: task.id })).body.conversation;
  return { store, call, task, conv };
}

// ---------- the rules ----------

test('levels 2 and 3 are disclosures; 0, 1, missing and odd values are not', () => {
  assert.deepEqual([0, 1, 2, 3, 4, null, undefined, '2', 2.5].map(isDisclosure), [false, false, true, true, false, false, false, false, false]);
});

test('the disclosure event holds the level only: no links, no text', async () => {
  const store = await fakeStore();
  assert.equal(await recordDisclosure(store, 1), null);
  const event = await recordDisclosure(store, 3);
  assert.equal(event.type, DISCLOSURE_EVENT);
  assert.deepEqual(event.links, {});
  assert.deepEqual(event.payload, { level: 3 });
  assert.match(event.time, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(store.events.length, 1);
  await rm(store.dir, { recursive: true, force: true });
});

test('alerts: levels 2 and 3 only; a failing send never throws', async () => {
  const { sent, wellbeing } = fakeAlerts();
  assert.equal(wellbeing.alert(1), null);
  assert.equal(wellbeing.alert(0), null);
  await wellbeing.alert(2);
  await wellbeing.alert(3);
  assert.deepEqual(sent, [{ kind: 'wellbeing', level: 2 }, { kind: 'wellbeing', level: 3 }]);
  const broken = createWellbeing({ send: async () => { throw new Error('invented outage'); }, log: silent });
  broken.alert(3);
  const [result] = await broken.settled();
  assert.equal(result.ok, false);
  assert.deepEqual(await broken.settled(), []);
});

test('with no alert sender the event is still recorded and the gap is logged', async () => {
  const store = await fakeStore();
  const lines = [];
  const result = await noteDisclosure(store, 3, { wellbeing: null, log: { log() {}, error: (m) => lines.push(m) } });
  assert.deepEqual(result, { recorded: true, alert: null });
  assert.match(lines.join('\n'), /alerts are not set up/);
  await rm(store.dir, { recursive: true, force: true });
});

test('the helplines match the core skill file and the screen\'s copy', async () => {
  const core = await loadSkill('core');
  for (const number of ['0800 1111', '85258', '116 123', '999']) {
    assert.ok(core.includes(number), number);
    assert.ok(HELPLINES.some((h) => h.how.includes(number)), number);
  }
  assert.deepEqual(screen.HELPLINES.map((h) => ({ ...h })), HELPLINES.map((h) => ({ ...h })));
  for (const h of HELPLINES) assert.match(h.href, /^(tel|sms):\d+$/);
});

test('the wellbeing wording uses {parents} and agrees with a plural label', async () => {
  const system = await buildSystem({ settings: { labels: { parent: 'Test Carer', parents: 'Test Carers' } } });
  assert.ok(system.includes('Test Carers are around'), 'level 2');
  assert.match(system, /I'll let\s+Test Carers know/, 'level 3 (the sentence wraps in the skill file)');
  assert.doesNotMatch(system, /\{parents?\}/);
  const defaults = await buildSystem({});
  assert.ok(defaults.includes('your parents are around'));
});

// ---------- the conversation ----------

test('level 2 as a first go: nothing of his saved, no Attempt, no help opened; event and alert sent', async () => {
  const { sent, wellbeing } = fakeAlerts();
  const { store, call, conv } = await setup({ ai: tutor({ levels: [2, 0] }), wellbeing });
  const r = await call('POST', `/api/conversations/${conv.id}/messages`, { text: PERSONAL });
  assert.equal(r.status, 201);
  assert.equal(r.body.turn.reply, KIND_REPLY, 'he still sees the reply');
  assert.equal(r.body.turn.wellbeingLevel, 2);
  assert.equal(r.body.turn.textRemoved, true);
  assert.equal(r.body.turn.action, 'message');
  assert.equal(r.body.attemptId, null);
  assert.equal(r.body.conversation.needsAttempt, true, 'a disclosure is not a go at the work');
  assert.deepEqual(r.body.conversation.offered, []);
  assert.equal(store.writes.some((w) => w.startsWith('attempts/')), false, 'no Attempt record');
  assert.equal(store.events.some((e) => e.type === 'attempt.recorded'), false);
  const turn = await store.read(aiTurnPath(r.body.turn.id));
  assert.deepEqual([turn.learnerText, turn.text, turn.textRemoved, turn.wellbeingLevel], [null, null, true, 2]);
  const saved = await everythingSaved(store);
  assert.equal(saved.includes(PERSONAL), false, 'his words are nowhere in storage or the events');
  assert.equal(saved.includes(KIND_REPLY), false, 'nor is the reply');
  const disclosures = store.events.filter((e) => e.type === DISCLOSURE_EVENT);
  assert.equal(disclosures.length, 1);
  assert.deepEqual([disclosures[0].links, disclosures[0].payload], [{}, { level: 2 }]);
  await wellbeing.settled();
  assert.deepEqual(sent, [{ kind: 'wellbeing', level: 2 }]);

  // he can carry on: his next go is an ordinary attempt and opens the first pair
  const next = await call('POST', `/api/conversations/${conv.id}/messages`, { text: 'maybe sea walls cost a lot' });
  assert.ok(next.body.attemptId);
  assert.deepEqual(next.body.conversation.offered, ['hint', 'breakdown']);
  assert.equal(sent.length, 1, 'no alert at level 0');
  await rm(store.dir, { recursive: true, force: true });
});

test('level 3 later on: state unchanged, the reply comes back without text, and the alert goes', async () => {
  const { sent, wellbeing } = fakeAlerts();
  const { store, call, conv } = await setup({ ai: tutor({ levels: [0, 3] }), wellbeing });
  await call('POST', `/api/conversations/${conv.id}/messages`, { text: 'invented first go' });
  const r = await call('POST', `/api/conversations/${conv.id}/messages`, { text: PERSONAL });
  assert.equal(r.status, 201);
  assert.equal(r.body.turn.wellbeingLevel, 3);
  assert.deepEqual(r.body.conversation.offered, ['hint', 'breakdown'], 'unchanged');
  await wellbeing.settled();
  assert.deepEqual(sent, [{ kind: 'wellbeing', level: 3 }]);
  const reopened = (await call('GET', `/api/conversations/${conv.id}`)).body.conversation;
  const last = reopened.turns.at(-1);
  assert.deepEqual([last.learnerText, last.reply, last.textRemoved, last.wellbeingLevel], [null, null, true, 3]);
  assert.equal(reopened.turns[0].wellbeingLevel, 0);
  assert.equal((await everythingSaved(store)).includes(PERSONAL), false);
  await rm(store.dir, { recursive: true, force: true });
});

test('levels 0 and 1: the normal study record, no event, no alert', async () => {
  const { sent, wellbeing } = fakeAlerts();
  const { store, call, conv } = await setup({ ai: tutor({ levels: [1, 0] }), wellbeing });
  const r = await call('POST', `/api/conversations/${conv.id}/messages`, { text: 'so stressed but maybe erosion' });
  assert.ok(r.body.attemptId);
  assert.equal(r.body.turn.textRemoved, false);
  const turn = await store.read(aiTurnPath(r.body.turn.id));
  assert.equal(turn.learnerText.value, 'so stressed but maybe erosion');
  assert.equal(store.events.some((e) => e.type === DISCLOSURE_EVENT), false);
  await wellbeing.settled();
  assert.deepEqual(sent, []);
  await rm(store.dir, { recursive: true, force: true });
});

test('without an alert sender a disclosure still saves no text, and the reply still arrives', async () => {
  const lines = [];
  const { store, call, conv } = await setup({ ai: tutor({ levels: [3] }), wellbeing: null, log: { log() {}, error: (m) => lines.push(m), warn() {} } });
  const r = await call('POST', `/api/conversations/${conv.id}/messages`, { text: PERSONAL });
  assert.equal(r.status, 201);
  assert.equal(r.body.turn.reply, KIND_REPLY);
  assert.equal(store.events.filter((e) => e.type === DISCLOSURE_EVENT).length, 1);
  assert.match(lines.join('\n'), /alerts are not set up/);
  assert.equal((await everythingSaved(store)).includes(PERSONAL), false);
  await rm(store.dir, { recursive: true, force: true });
});

test('route choice above level 1: the screen is told to send the message straight to the tutor', async () => {
  const { sent, wellbeing } = fakeAlerts();
  const high = await setup({ ai: tutor({ lightLevel: 2 }), wellbeing });
  const r = await high.call('POST', '/api/route', { message: PERSONAL });
  assert.equal(r.body.sendNow, true);
  assert.equal(r.body.route, 'research');
  assert.equal((await everythingSaved(high.store)).includes(PERSONAL), false);
  assert.equal(high.store.events.some((e) => e.type === DISCLOSURE_EVENT), false, 'the tutor\'s reply is the one that counts');
  await wellbeing.settled();
  assert.deepEqual(sent, [], 'so the alert goes once, from the conversation');
  await rm(high.store.dir, { recursive: true, force: true });

  const low = await setup({ ai: tutor({ lightLevel: 1 }) });
  const r2 = await low.call('POST', '/api/route', { message: 'invented stressy message' });
  assert.equal('sendNow' in r2.body, false);
  await rm(low.store.dir, { recursive: true, force: true });
});

// ---------- the screen ----------

test('the screen shows the helplines beside level-3 replies only, including reopened ones', () => {
  assert.equal(screen.showsCare({ wellbeingLevel: 3 }), true);
  for (const level of [0, 1, 2, null, undefined]) assert.equal(screen.showsCare({ wellbeingLevel: level }), false, String(level));
  const sent = screen.turnFromReply({ id: 'turn_c1', action: 'message', reply: 'Invented reply', wellbeingLevel: 3 }, { learnerText: 'x' });
  assert.equal(sent.wellbeingLevel, 3);
  const [reopened] = screen.turnsFromServer({ turns: [{ id: 'turn_c2', action: 'message', learnerText: null, reply: null, wellbeingLevel: 3 }] });
  assert.equal(screen.showsCare(reopened), true);
  assert.equal(screen.turnFromReply({ id: 'turn_c3', reply: 'x', wellbeingLevel: '3' }).wellbeingLevel, null);
});

test('the page wires the care box and the straight-to-tutor send', async () => {
  const page = await readFile(new URL('../web/conversation.js', import.meta.url), 'utf8');
  assert.match(page, /if \(showsCare\(turn\)\) tutor\.append\(careBox\(\)\)/);
  assert.match(page, /for \(const line of HELPLINES\)/);
  assert.match(page, /result\.body\?\.sendNow === true/);
  assert.match(page, /if \(sendNow\) await sendText\(checked\.text\)/);
  const css = await readFile(new URL('../web/app.css', import.meta.url), 'utf8');
  assert.match(css, /\.care a\s*\{[^}]*min-height: var\(--tap\)/);
  const index = await readFile(new URL('../server/index.js', import.meta.url), 'utf8');
  assert.match(index, /wellbeing: createWellbeing\(\)/, 'the running server sends alerts');
});
