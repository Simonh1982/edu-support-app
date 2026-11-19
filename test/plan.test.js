// WP-116: Plan my answer (build spec §9.2, §23.6). The plan holds only his words; his main point is
// the task's thesis anchor; notebook entries are pinned, never inserted; gaps are his, or the tutor's
// questions after the live check. Mock AI and a temporary folder. Invented data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeEvent, newRecord } from '../server/storage/records.js';
import { createMockAi } from '../server/ai/mock.js';
import { matchApiRoute, handleApi } from '../server/api.js';
import * as server from '../server/domain/plan.js';
import { notebookEntryPath } from '../server/domain/notebook.js';
import { readTask } from '../server/domain/tasks.js';
import { PLAN_SECTIONS, PLAN_SECTION_MAX, GAP_MAX, PLAN_TEXT, planChanges, checkGap } from '../web/shared/plan.js';
import { createTaskPlan } from '../web/task-plan.js';

const MODELS = Object.freeze({
  conversation: 'mock-conversation', review: 'mock-review', light: 'mock-light',
  spelling: 'mock-spelling', checker: 'mock-checker', judge: 'mock-judge',
});
const silent = { log() {}, error() {}, warn() {} };
const curriculum = {
  qualifications: new Map([['demo-geo', { id: 'demo-geo', title: 'Invented Geography', awardingBody: null, specificationCode: null, units: [], aos: [], commandWords: [] }]]),
  topics: new Map([['demo-geo-1a', { id: 'demo-geo-1a', qualId: 'demo-geo', unitId: null, title: 'Invented coasts topic', record: { id: 'demo-geo-1a', title: 'Invented coasts topic' } }]]),
};

async function fakeStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wp116-'));
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

/** gaps: the tutor's gap lists in turn (last repeats); leaks: the checker's verdicts in turn (last repeats). */
function mockAi({ gaps = [['What evidence shows how far the invented defences worked?']], leaks = [false] } = {}) {
  let g = 0;
  let c = 0;
  const prompts = [];
  const ai = createMockAi({
    replies: {
      [MODELS.conversation]: ({ prompt }) => {
        prompts.push(prompt);
        if (prompt.includes('List up to three gaps')) return JSON.stringify({ gaps: gaps[Math.min(g++, gaps.length - 1)] });
        return JSON.stringify({ reply: 'Invented tutor reply.', replyType: 'question', taskSpecific: false, sources: [], wellbeingLevel: 0 });
      },
      [MODELS.light]: () => JSON.stringify({ route: 'plan', wellbeingLevel: 0 }),
      [MODELS.checker]: () => JSON.stringify({ leak: leaks[Math.min(c++, leaks.length - 1)], reason: 'invented' }),
    },
  });
  return { ai, prompts, handle: { ai, models: MODELS } };
}

async function setup(aiOptions) {
  const store = await fakeStore();
  const mock = mockAi(aiOptions);
  const call = (method, url, body, role = 'learner') => {
    const match = matchApiRoute(method, url);
    assert.ok(match?.route, `route ${method} ${url}`);
    return handleApi({ match, pass: { role }, store, body, getCurriculum: () => curriculum, getAi: () => mock.handle, log: silent });
  };
  const task = (await call('POST', '/api/tasks', {
    title: 'Invented coast essay', questionText: 'Evaluate an invented coastline.', topicIds: ['demo-geo-1a'],
    anchors: [{ type: 'location', text: 'Imaginary Bay' }],
  })).body.task;
  return { store, call, task, mock, done: () => rm(store.dir, { recursive: true, force: true }) };
}

const thesisOf = async (store, id) => (await readTask(store, id)).anchors.filter((a) => a.type === 'thesis');

test('the plan holds his words in five sections; his main point is the thesis anchor, kept in step', async () => {
  const { store, call, task, done } = await setup();
  try {
    const empty = await call('GET', `/api/tasks/${task.id}/plan`);
    assert.deepEqual(empty.body.plan.sections, { mainPoint: '', evidence: '', otherView: '', answersQuestion: '', judgement: '' });
    const r = await call('PATCH', `/api/tasks/${task.id}/plan`, { sections: { mainPoint: 'Invented defences mostly moved the problem.', evidence: 'Invented notes.' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.plan.sections.mainPoint, 'Invented defences mostly moved the problem.');
    const saved = await store.read(server.planPath(task.id));
    assert.deepEqual(saved.sections.evidence, { value: 'Invented notes.', author: 'learner' });
    for (const k of ['id', 'createdAt', 'updatedAt', 'createdBy', 'schemaVersion']) assert.ok(saved[k] !== undefined, k);
    assert.deepEqual((await thesisOf(store, task.id)).map((a) => [a.text.value, a.text.author, a.confirmed]), [['Invented defences mostly moved the problem.', 'learner', true]]);
    await call('PATCH', `/api/tasks/${task.id}/plan`, { sections: { mainPoint: 'A changed invented point.' } });
    assert.deepEqual((await thesisOf(store, task.id)).map((a) => a.text.value), ['A changed invented point.'], 'one thesis, updated');
    await call('PATCH', `/api/tasks/${task.id}/plan`, { sections: { mainPoint: '' } });
    assert.equal((await thesisOf(store, task.id)).length, 0, 'cleared with the main point');
    // only his words: the AI can't write a section
    assert.equal((await call('PATCH', `/api/tasks/${task.id}/plan`, { sections: { judgement: { value: 'x', author: 'ai' } } })).status, 400);
    assert.equal((await call('PATCH', `/api/tasks/${task.id}/plan`, { sections: { conclusion: 'x' } })).status, 400);
    assert.equal((await call('GET', `/api/tasks/${task.id}/plan`, null, 'parent')).status, 403);
    assert.ok(!JSON.stringify(store.events).includes('Invented defences'), 'events hold counts only');
  } finally { await done(); }
});

test('notebook entries are pinned as references; gaps can be added, ticked and removed', async () => {
  const { store, call, task, done } = await setup();
  try {
    const summary = newRecord('note', { type: 'summary', title: 'Invented study', text: { value: 'Invented AI summary.', author: 'ai' }, taskId: task.id, topicIds: [] }, { createdBy: 'ai' });
    await store.put(notebookEntryPath(summary.id), summary);
    const pinned = await call('PATCH', `/api/tasks/${task.id}/plan`, { pin: { entryId: summary.id, pinned: true } });
    assert.deepEqual(pinned.body.plan.pinned.map((p) => [p.id, p.type, p.author]), [[summary.id, 'summary', 'ai']]);
    assert.ok(!JSON.stringify(pinned.body.plan.sections).includes('Invented AI summary'), 'pinned, never inserted');
    assert.equal((await call('PATCH', `/api/tasks/${task.id}/plan`, { pin: { entryId: 'note_missing1', pinned: true } })).status, 404);
    const added = await call('PATCH', `/api/tasks/${task.id}/plan`, { addGap: 'Invented: find a second source' });
    const [gap] = added.body.plan.gaps;
    assert.deepEqual([gap.text, gap.author, gap.done], ['Invented: find a second source', 'learner', false]);
    const ticked = await call('PATCH', `/api/tasks/${task.id}/plan`, { gap: { id: gap.id, done: true } });
    assert.equal(ticked.body.plan.gaps[0].done, true);
    const removed = await call('PATCH', `/api/tasks/${task.id}/plan`, { gap: { id: gap.id, remove: true } });
    assert.deepEqual(removed.body.plan.gaps, []);
    const unpinned = await call('PATCH', `/api/tasks/${task.id}/plan`, { pin: { entryId: summary.id, pinned: false } });
    assert.deepEqual(unpinned.body.plan.pinned, []);
  } finally { await done(); }
});

test('his first Plan my answer attempt starts the plan with his main point, and never overwrites it', async () => {
  const { store, call, task, done } = await setup();
  try {
    const conv = (await call('POST', '/api/conversations', { route: 'plan', taskId: task.id })).body.conversation;
    const r = await call('POST', `/api/conversations/${conv.id}/messages`, { text: 'Invented main point in one sentence.' });
    assert.equal(r.status, 201);
    assert.equal((await store.read(server.planPath(task.id))).sections.mainPoint.value, 'Invented main point in one sentence.');
    assert.equal((await thesisOf(store, task.id))[0].text.value, 'Invented main point in one sentence.');
    await call('PATCH', `/api/tasks/${task.id}/plan`, { sections: { mainPoint: 'His own rewritten invented point.' } });
    const second = (await call('POST', '/api/conversations', { route: 'plan', taskId: task.id })).body.conversation;
    await call('POST', `/api/conversations/${second.id}/messages`, { text: 'Another invented attempt.' });
    assert.equal((await store.read(server.planPath(task.id))).sections.mainPoint.value, 'His own rewritten invented point.');
    // another route's attempt is not a main point
    const other = await setup();
    try {
      const research = (await other.call('POST', '/api/conversations', { route: 'research', taskId: other.task.id })).body.conversation;
      await other.call('POST', `/api/conversations/${research.id}/messages`, { text: 'Invented research attempt.' });
      assert.equal(await other.store.read(server.planPath(other.task.id)), null);
    } finally { await other.done(); }
  } finally { await done(); }
});

test("What's missing?: questions about his plan, checked first, saved as the tutor's; answers never asked for", async () => {
  const { store, call, task, mock, done } = await setup();
  try {
    assert.equal((await call('POST', `/api/tasks/${task.id}/plan/gaps`, {})).status, 409, 'needs some plan first');
    await call('PATCH', `/api/tasks/${task.id}/plan`, { sections: { mainPoint: 'Invented plan point.' }, addGap: 'My own invented gap' });
    const r = await call('POST', `/api/tasks/${task.id}/plan/gaps`, {});
    assert.deepEqual([r.status, r.body.outcome], [200, 'saved']);
    assert.deepEqual(r.body.plan.gaps.map((g) => [g.text, g.author]), [['My own invented gap', 'learner'], ['What evidence shows how far the invented defences worked?', 'ai']]);
    const prompt = mock.prompts.at(-1);
    assert.match(prompt, /<learner_draft>[\s\S]*Invented plan point\.[\s\S]*<\/learner_draft>/);
    assert.match(prompt, /Never answer the questions, never suggest/);
    // asking again replaces the tutor's open questions, keeps his
    const again = await call('POST', `/api/tasks/${task.id}/plan/gaps`, {});
    assert.equal(again.body.plan.gaps.filter((g) => g.author === 'ai').length, 1);
    assert.ok(!JSON.stringify(store.events).includes('invented defences'), 'events hold counts only');
  } finally { await done(); }

  const failing = await setup({ leaks: [true] });
  try {
    await failing.call('PATCH', `/api/tasks/${failing.task.id}/plan`, { sections: { mainPoint: 'Invented plan point.' } });
    const r = await failing.call('POST', `/api/tasks/${failing.task.id}/plan/gaps`, {});
    assert.deepEqual([r.body.outcome, r.body.message], ['too-close', server.PLAN_MESSAGES.tooClose]);
    assert.deepEqual(r.body.plan.gaps, [], 'nothing that failed the check is saved');
  } finally { await failing.done(); }
});

// ---------- the screen ----------

class FakeElement {
  constructor(tag) {
    Object.assign(this, { tagName: tag.toUpperCase(), children: [], attributes: {}, dataset: {}, listeners: {}, className: '', disabled: false, hidden: false, open: false, value: '', checked: false, readOnly: false, ownText: '' });
  }
  set textContent(v) { this.ownText = String(v); this.children = []; }
  get textContent() { return this.ownText + this.children.map((c) => c.textContent).join(''); }
  setAttribute(n, v) { this.attributes[n] = String(v); }
  getAttribute(n) { return this.attributes[n] ?? null; }
  append(...n) { this.children.push(...n); }
  replaceChildren(...n) { this.children = [...n]; }
  addEventListener(t, fn) { this.listeners[t] = fn; }
  focus() {}
  all(match) { const out = []; const walk = (el) => { for (const c of el.children) { if (match(c)) out.push(c); walk(c); } }; walk(this); return out; }
}
function pageDoc() {
  const els = Object.fromEntries(['task-panel-plan', 'task-panel-plan-body', 'task-panel-plan-status'].map((id) => [id, new FakeElement('div')]));
  return { els, doc: { createElement: (t) => new FakeElement(t), getElementById: (id) => els[id] ?? null } };
}
const ok = (body) => ({ kind: 'ok', status: 200, body });
const settle = async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r)); };
const byAction = (root, a) => root.all((el) => el.dataset.action === a);
const PLAN = { id: 'plan_x', taskId: 't_inv1', sections: { mainPoint: 'Invented point.', evidence: '', otherView: '', answersQuestion: '', judgement: '' }, pinned: [], gaps: [] };

test("the page's copies match the server; changes and gaps are checked", () => {
  assert.deepEqual(PLAN_SECTIONS.map((s) => [s.key, s.label]), server.PLAN_SECTIONS.map((s) => [s.key, s.label]));
  assert.equal(PLAN_SECTION_MAX, server.PLAN_LIMITS.section);
  assert.equal(GAP_MAX, server.PLAN_LIMITS.gapText);
  assert.deepEqual(planChanges({ mainPoint: 'Invented point.', evidence: ' New evidence ' }, PLAN.sections), { sections: { evidence: 'New evidence' } });
  assert.equal(planChanges({ judgement: 'x'.repeat(PLAN_SECTION_MAX + 1) }, {}).field, 'judgement');
  assert.deepEqual(checkGap('  find   more '), { text: 'find more' });
  assert.deepEqual(checkGap(''), { error: PLAN_TEXT.needText });
});

test('Your plan: the five prompts, labelled; Save sends only what changed; Pin and What\'s missing? call the tutor', async () => {
  const { els, doc } = pageDoc();
  const calls = [];
  const api = new Proxy({}, { get: (_, name) => async (...args) => {
    calls.push([name, ...args]);
    if (name === 'getPlan') return ok({ plan: PLAN });
    if (name === 'listNotebook') return ok({ entries: [{ id: 'note_q', type: 'quote', title: 'Quote: Invented', author: 'source' }] });
    if (name === 'updatePlan') return ok({ plan: { ...PLAN, sections: { ...PLAN.sections, evidence: 'Invented evidence.' } } });
    if (name === 'findGaps') return ok({ outcome: 'saved', plan: { ...PLAN, gaps: [{ id: 'gap_1', text: 'What would show it?', author: 'ai', done: false }] } });
    return ok({});
  } });
  const plan = createTaskPlan({ api, doc });
  plan.setTutor(true);
  await plan.show('t_inv1', { open: true });
  await settle();
  assert.equal(els['task-panel-plan'].open, true);
  const labels = els['task-panel-plan-body'].all((e) => e.tagName === 'LABEL').map((l) => l.textContent);
  assert.deepEqual(labels.slice(0, 5), PLAN_SECTIONS.map((s) => s.label));
  const areas = els['task-panel-plan-body'].all((e) => e.tagName === 'TEXTAREA');
  assert.equal(areas[0].value, 'Invented point.');
  areas[1].value = 'Invented evidence.';
  areas[1].listeners.input();
  assert.equal(els['task-panel-plan-status'].textContent, PLAN_TEXT.unsaved);
  const form = els['task-panel-plan-body'].all((e) => e.className === 'plan-form')[0];
  await form.listeners.submit({ preventDefault() {} });
  assert.deepEqual(calls.find((c) => c[0] === 'updatePlan').slice(1), ['t_inv1', { sections: { evidence: 'Invented evidence.' } }]);
  await byAction(els['task-panel-plan-body'], 'pin')[0].listeners.click();
  assert.deepEqual(calls.filter((c) => c[0] === 'updatePlan').at(-1).slice(1), ['t_inv1', { pin: { entryId: 'note_q', pinned: true } }]);
  await byAction(els['task-panel-plan-body'], 'find-gaps')[0].listeners.click();
  await settle();
  assert.match(els['task-panel-plan-body'].textContent, /Question from the tutor.*What would show it\?/);
});

test('the page has the plan part, and the conversation opens it for Plan my answer', () => {
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  assert.match(html, /<details id="task-panel-plan" class="more" hidden>\s*<summary>Your plan for this task<\/summary>/);
  const conversation = readFileSync(new URL('../web/conversation.js', import.meta.url), 'utf8');
  assert.match(conversation, /openPlan: route === "plan"/);
  for (const file of ['task-plan.js']) {
    assert.doesNotMatch(readFileSync(new URL(`../web/${file}`, import.meta.url), 'utf8'), /innerHTML|localStorage|sessionStorage|indexedDB|confirm\(/);
  }
});
