// WP-130 (A-013 §7): the invisible support ladder. No buttons: what he writes decides the step, the
// tutor chooses among the kinds of help the server allows, and the server records it as the buttons
// did. Mock AI and a temporary folder. Invented data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makeEvent } from '../server/storage/records.js';
import { createMockAi } from '../server/ai/mock.js';
import { matchApiRoute, handleApi } from '../server/api.js';
import { helpKind, ladderStep } from '../server/derived/ladder.js';
import { ACTION_INSTRUCTIONS, supportChoiceInstruction } from '../server/ai/conversation.js';
import { attemptPath } from '../server/domain/work.js';

const MODELS = Object.freeze({
  conversation: 'mock-conversation', review: 'mock-review', light: 'mock-light',
  spelling: 'mock-spelling', checker: 'mock-checker', judge: 'mock-judge',
});
const silent = { log() {}, error() {}, warn() {} };

test('help requests: short "stuck" messages, idk-style answers, and longer messages that also ask', () => {
  for (const t of ["I'm stuck", 'idk', 'Hint please', 'just tell me the answer pls', 'can you explain it?', 'I dont get it', 'help']) {
    assert.equal(helpKind(t), 'stuck', t);
  }
  assert.equal(helpKind("I think it's erosion but I'm stuck on the evidence"), 'ask');
  assert.equal(helpKind('ok just tell me'), 'stuck', 'filler words dropped');
  for (const t of ['The defences protect the town', 'nothing yet', 'Sea walls stop erosion in the centre', '']) assert.equal(helpKind(t), null, t);
});

test('the step table: attempt first on set work; stuck again after help is the next try; no task, no ladder', () => {
  const start = { pair: 0, waiting: true };
  const open = { pair: 1, waiting: false };
  const afterHelp = { pair: 1, waiting: true };
  assert.equal(ladderStep(start, 'stuck'), 'escape');
  assert.equal(ladderStep(start, 'ask'), 'attempt', 'a longer message has his own go in it');
  assert.equal(ladderStep(start, null), 'attempt');
  assert.equal(ladderStep(open, 'stuck'), 'support');
  assert.equal(ladderStep(open, 'ask'), 'support');
  assert.equal(ladderStep(open, null), 'message');
  assert.equal(ladderStep(afterHelp, 'stuck'), 'retry', 'WP-130b: stuck again opens the next help');
  assert.equal(ladderStep(afterHelp, null), 'attempt');
  for (const kind of ['stuck', 'ask', null]) assert.equal(ladderStep(start, kind, { taskLinked: false }), 'message', 'no task: just help');
});

test('the tutor is told which kinds are allowed, and to say which it gave', () => {
  const two = supportChoiceInstruction(['hint', 'breakdown']);
  assert.match(two, /- hint: Give one short nudge/);
  assert.match(two, /- breakdown: Split what they are stuck on/);
  assert.match(two, /"hint" or "breakdown"/);
  assert.doesNotMatch(two, /explain/i);
  assert.match(supportChoiceInstruction(['breakdown']), /^The student asked you to break it down\./);
  assert.doesNotMatch(ACTION_INSTRUCTIONS.attempt, /button/);
});

// ---------- through the routes ----------

async function fakeStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wp130-'));
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
    async logEvent(type, options = {}) { const e = makeEvent(type, options); events.push(e); return e; },
  };
}

/** claims: the replyType the tutor says it gave, in turn (last repeats). level: the wellbeing level. */
async function setup({ claims = ['other'], level = 0 } = {}) {
  const store = await fakeStore();
  const prompts = [];
  let n = 0;
  const ai = createMockAi({
    replies: {
      [MODELS.conversation]: ({ prompt }) => {
        prompts.push(prompt);
        return JSON.stringify({ reply: 'Invented tutor reply.', replyType: claims[Math.min(n++, claims.length - 1)], taskSpecific: false, sources: [], wellbeingLevel: level });
      },
      [MODELS.light]: () => JSON.stringify({ route: 'learn', wellbeingLevel: 0 }),
      [MODELS.checker]: () => JSON.stringify({ leak: false, reason: 'invented' }),
    },
  });
  const call = (method, url, body) => {
    const match = matchApiRoute(method, url);
    assert.ok(match?.route, `route ${method} ${url}`);
    return handleApi({ match, pass: { role: 'learner' }, store, body, getAi: () => ({ ai, models: MODELS }), log: silent });
  };
  const task = (await call('POST', '/api/tasks', { title: 'Invented coast task', questionText: 'Explain an invented spit.' })).body.task;
  const conv = (await call('POST', '/api/conversations', { route: 'learn', taskId: task.id })).body.conversation;
  const free = (await call('POST', '/api/conversations', { route: 'learn' })).body.conversation;
  const sayFree = async (text) => (await call('POST', `/api/conversations/${free.id}/messages`, { text })).body;
  const say = async (text) => (await call('POST', `/api/conversations/${conv.id}/messages`, { text })).body;
  const supports = () => store.events.filter((e) => e.type === 'support.requested').map((e) => e.payload.type);
  return { store, prompts, say, sayFree, supports, done: () => rm(store.dir, { recursive: true, force: true }) };
}

test('stuck at the start: like "I don\'t know where to start", a breakdown only, recorded as an escape', async () => {
  const s = await setup({ claims: ['explanation'] });
  try {
    const r = await s.say("I'm stuck");
    assert.deepEqual([r.turn.action, r.turn.type], ['support', 'breakdown'], 'one kind allowed: no second ask');
    assert.equal(s.prompts.length, 1);
    assert.ok(s.prompts[0].includes(ACTION_INSTRUCTIONS.breakdown));
    const attempt = await s.store.read(attemptPath(r.attemptId));
    assert.equal(attempt.escape, true);
    assert.deepEqual(s.supports(), ['breakdown']);
    assert.deepEqual([r.conversation.needsAttempt, r.conversation.offered], [true, []], 'now a fresh try first');
  } finally { await s.done(); }
});

test('after a go, "I\'m stuck" gets the first pair; stuck again counts as the next try and opens the second', async () => {
  const s = await setup({ claims: ['other', 'hint', 'pointer'] });
  try {
    const a = await s.say('Waves move sand along the beach I think');
    assert.equal(a.turn.action, 'attempt');
    const b = await s.say("I'm stuck");
    assert.deepEqual([b.turn.action, b.turn.type], ['support', 'hint']);
    assert.match(s.prompts[1], /"hint" or "breakdown"/);
    const c = await s.say('still stuck');
    assert.deepEqual([c.turn.action, c.turn.type], ['support', 'pointer']);
    assert.match(s.prompts[2], /"pointer" or "explanation"/);
    assert.ok(c.attemptId, 'recorded as his next try');
    assert.deepEqual(s.supports(), ['hint', 'pointer']);
  } finally { await s.done(); }
});

test('the second pair needs a fresh try; a kind not on offer is asked for again as the lightest allowed', async () => {
  const s = await setup({ claims: ['other', 'explanation', 'hint', 'other', 'answer', 'pointer'] });
  try {
    await s.say('Waves move sand along the beach I think');
    const first = await s.say('just tell me');
    // it claimed an explanation in the first pair: asked again for a hint, recorded as a hint
    assert.deepEqual([first.turn.action, first.turn.type], ['support', 'hint']);
    assert.match(s.prompts[2], /^[\s\S]*The student asked for a hint\./);
    await s.say('The sand moves the way the waves come in from');
    const second = await s.say('can you explain it?');
    assert.match(s.prompts[4], /"pointer" or "explanation"/, 'second pair after a fresh try');
    assert.deepEqual([second.turn.action, second.turn.type], ['support', 'pointer']);
    assert.deepEqual(s.supports(), ['hint', 'pointer']);
  } finally { await s.done(); }
});

test('a level-3 message asking for help is care, not coursework: no attempt and no help recorded', async () => {
  const s = await setup({ level: 3 });
  try {
    const r = await s.say("I'm stuck");
    assert.equal(r.turn.action, 'message');
    assert.equal(r.attemptId, null);
    assert.deepEqual(s.supports(), []);
    assert.equal(r.conversation.needsAttempt, true);
  } finally { await s.done(); }
});

test('a chat with no task is not set work: no attempt first, and the tutor just helps', async () => {
  const s = await setup();
  try {
    const r = await s.sayFree('what is osmosis?');
    assert.equal(r.turn.action, 'message');
    assert.equal(r.attemptId, null);
    assert.ok(!s.prompts[0].includes(ACTION_INSTRUCTIONS.attempt), 'not treated as his go');
    const stuck = await s.sayFree("I'm stuck");
    assert.equal(stuck.turn.action, 'message');
    assert.deepEqual(s.supports(), []);
  } finally { await s.done(); }
});
