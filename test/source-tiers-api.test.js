// WP-114d (amendment A-009) through the API: preferred sites in the research prompt, access notes on
// cards, no summaries of videos, the subscription outcome and the summary diagnostics.
// Mock AI and invented data only: no real searches, no real pages, no real labels.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makeEvent } from '../server/storage/records.js';
import { createMockAi } from '../server/ai/mock.js';
import { matchApiRoute, handleApi } from '../server/api.js';
import { aiTurnPath } from '../server/domain/work.js';
import { SOURCE_MESSAGES, SUMMARY_FEATURE } from '../server/domain/sources.js';

const MODELS = Object.freeze({
  conversation: 'mock-conversation', review: 'mock-review', light: 'mock-light',
  spelling: 'mock-spelling', checker: 'mock-checker', judge: 'mock-judge',
});
const curriculum = {
  qualifications: new Map([['demo-geo', { id: 'demo-geo', title: 'Invented Geography', awardingBody: null, specificationCode: null, units: [], aos: [], commandWords: [] }]]),
  topics: new Map([['demo-geo-1a', { id: 'demo-geo-1a', qualId: 'demo-geo', unitId: null, title: 'Invented coasts topic', record: { id: 'demo-geo-1a', title: 'Invented coasts topic' } }]]),
};
const QUESTION = 'Evaluate the effectiveness of hard engineering at protecting the invented Imaginary Bay coastline.';
const LIBRARY = { title: 'Invented library guide', url: 'https://school-library.example.org/coasts', category: 'educational', why: 'A guide to coastal processes.' };
const VIDEO = { title: 'Invented explainer', url: 'https://video.example.com/v1', category: 'video', minutes: 7, why: 'A short video on longshore drift.' };
const JOURNAL = { title: 'Invented journal article', url: 'https://journal.example.org/a', category: 'academic', why: 'A detailed study of sea walls.', subscription: true };
const URL_PERMISSION = { kind: 'url', url: 'https://journal.example.org/a' };
const LABELS = { parent: 'Test Carer', parents: 'Test Carers' };

async function fakeStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wp114d-'));
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

async function writePrivate(store, rel, value) {
  await mkdir(path.dirname(path.join(store.dir, rel)), { recursive: true });
  await writeFile(path.join(store.dir, rel), JSON.stringify(value));
}

function models({ sources = [LIBRARY, VIDEO, JOURNAL], summaries = [] } = {}) {
  const tutorCalls = [];
  let s = 0;
  const ai = createMockAi({
    replies: {
      [MODELS.conversation]: ({ prompt }) => {
        if (prompt.includes('<source_ref>')) {
          const out = summaries[Math.min(s, summaries.length - 1)];
          s += 1;
          return JSON.stringify(out);
        }
        tutorCalls.push({ prompt });
        return JSON.stringify({ reply: 'Invented reply.', taskSpecific: false, wellbeingLevel: 0, sources });
      },
      [MODELS.checker]: () => JSON.stringify({ leak: false, reason: 'invented' }),
    },
    permissionRequests: { [MODELS.conversation]: [URL_PERMISSION] },
  });
  return { ai, tutorCalls, handle: { ai, models: MODELS } };
}

async function setup({ m = models(), log = { log() {}, error() {}, warn() {} } } = {}) {
  const store = await fakeStore();
  const call = async (method, url, body) => {
    const match = matchApiRoute(method, url);
    assert.ok(match?.route, `route ${method} ${url}`);
    return handleApi({
      match, pass: { role: 'learner' }, store, body, query: new URLSearchParams(''), getCurriculum: () => curriculum,
      getAi: () => m.handle, log,
    });
  };
  const task = (await call('POST', '/api/tasks', {
    title: 'Invented coast essay', questionText: QUESTION, topicIds: ['demo-geo-1a'],
    anchors: [{ type: 'location', text: 'Imaginary Bay' }],
  })).body.task;
  const start = async (body) => (await call('POST', '/api/conversations', body)).body.conversation;
  return { store, call, task, start, m };
}

async function summaryTurns(store) {
  const out = [];
  for (const rel of store.writes.filter((w) => w.startsWith('ai-turns/'))) {
    const turn = await store.read(rel);
    if (turn?.feature === SUMMARY_FEATURE) out.push(turn);
  }
  return out;
}

test('research: preferred sites for the task\'s qualification reach the prompt; the school list never does', async () => {
  const env = await setup();
  await writePrivate(env.store, 'profile/sources.json', {
    preferred: { all: ['learn.example.org'], 'demo-geo': ['geo.example.org/guides'], 'demo-other': ['other.example.org'] },
    school: ['school-library.example.org'],
  });
  const c = await env.start({ route: 'research', taskId: env.task.id });
  await env.call('POST', `/api/conversations/${c.id}/messages`, { text: 'invented go' });
  const prompt = env.m.tutorCalls[0].prompt;
  assert.match(prompt, /Preferred sites for "Start here"[^\n]*: learn\.example\.org, geo\.example\.org\/guides\./);
  assert.equal(prompt.includes('other.example.org'), false, 'another qualification\'s list');
  assert.equal(prompt.includes('school-library'), false, 'the school list only labels cards');
  await rm(env.store.dir, { recursive: true, force: true });
});

test('cards come in tier order with access notes worked out when shown; the stored cards have none', async () => {
  const env = await setup();
  await writePrivate(env.store, 'profile/learner.json', { labels: LABELS });
  await writePrivate(env.store, 'profile/sources.json', { school: ['school-library.example.org'] });
  const c = await env.start({ route: 'research' });
  const r = await env.call('POST', `/api/conversations/${c.id}/messages`, { text: 'invented question' });
  const shown = r.body.turn.sources;
  assert.deepEqual(shown.map((s) => s.title), [LIBRARY.title, VIDEO.title, JOURNAL.title]);
  assert.deepEqual(shown.map((s) => s.accessNote ?? null), [
    'Use your school login.', null, 'May need a subscription. Ask Test Carers if they can get you a copy.',
  ]);
  assert.equal(shown[1].minutes, 7);
  const stored = await env.store.read(aiTurnPath(r.body.turn.id));
  assert.equal(JSON.stringify(stored.sources).includes('accessNote'), false);
  assert.equal(stored.sources[2].subscription, true);
  const reopened = await env.call('GET', `/api/conversations/${c.id}`);
  assert.equal(reopened.body.conversation.turns[0].sources[2].accessNote, shown[2].accessNote);
  await rm(env.store.dir, { recursive: true, force: true });
});

test('videos can\'t be summarised: 409 with a message, and no AI call', async () => {
  const env = await setup();
  const c = await env.start({ route: 'research' });
  const turnId = (await env.call('POST', `/api/conversations/${c.id}/messages`, { text: 'invented question' })).body.turn.id;
  const video = (await env.call('POST', '/api/sources', { turnId, index: 1 })).body.source;
  assert.equal(video.category, 'video');
  const before = env.m.ai.calls.length;
  const r = await env.call('POST', `/api/sources/${video.id}/summary`, {});
  assert.deepEqual([r.status, r.body.error], [409, SOURCE_MESSAGES.video]);
  assert.equal(env.m.ai.calls.length, before);
  await rm(env.store.dir, { recursive: true, force: true });
});

test('a page behind a paywall: the subscription message with the private label; nothing saved', async () => {
  const lines = [];
  const log = { log: (l) => lines.push(l), error: (l) => lines.push(l), warn: (l) => lines.push(l) };
  const env = await setup({ m: models({ summaries: [{ unavailable: true, subscription: true }] }), log });
  await writePrivate(env.store, 'profile/learner.json', { labels: LABELS });
  const c = await env.start({ route: 'research' });
  const turnId = (await env.call('POST', `/api/conversations/${c.id}/messages`, { text: 'invented question' })).body.turn.id;
  const journal = (await env.call('POST', '/api/sources', { turnId, index: 2 })).body.source;
  const r = await env.call('POST', `/api/sources/${journal.id}/summary`, {});
  assert.deepEqual([r.status, r.body.outcome, r.body.entry], [200, 'subscription', null]);
  assert.equal(r.body.message, SOURCE_MESSAGES.subscription.replaceAll('{parents}', 'Test Carers'));
  assert.equal(env.store.writes.some((w) => w.startsWith('notebook/')), false);
  assert.deepEqual(env.store.events.find((e) => e.type === 'source.summary').payload, { outcome: 'subscription' });
  assert.ok(lines.includes('[sources] summary: model said subscription; web_fetch ran: yes; fetch result: unknown; 0 s'));
  assert.equal(lines.join('\n').includes('journal.example.org'), false, 'no addresses in the log');
  await rm(env.store.dir, { recursive: true, force: true });
});

test('"couldn\'t open": the AI turn records success false, so the owner can count them', async () => {
  const env = await setup({ m: models({ summaries: [{ unavailable: true }] }) });
  const c = await env.start({ route: 'research' });
  const turnId = (await env.call('POST', `/api/conversations/${c.id}/messages`, { text: 'invented question' })).body.turn.id;
  const source = (await env.call('POST', '/api/sources', { turnId, index: 0 })).body.source;
  const r = await env.call('POST', `/api/sources/${source.id}/summary`, {});
  assert.deepEqual([r.body.outcome, r.body.message], ['unavailable', SOURCE_MESSAGES.unavailable]);
  const turns = await summaryTurns(env.store);
  assert.deepEqual(turns.map((t) => t.success), [false]);
  await rm(env.store.dir, { recursive: true, force: true });
});
