// WP-114c: a web search counts as run when the SDK reports the tool running, even with no
// permission request (live check, 4 Nov 2026: web_search ran and asked for no permission, so the
// cards were thrown away). Mock AI and invented data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockAi } from '../server/ai/mock.js';
import { askTutor } from '../server/ai/conversation.js';
import { webToolRan, webTracker, askSummary } from '../server/ai/sources.js';

const MODEL = 'mock-conversation';
const CARD = { title: 'Invented guide to coastal processes', url: 'https://invented-geography.example.org/coasts', publisher: 'Invented Society', category: 'introduction', why: 'Covers how waves erode cliffs.' };
const CARD2 = { title: 'Invented coastal data series', url: 'https://data.invented.example.gov.uk/coast', category: 'data', why: 'Tables of erosion rates.' };
// Shapes like the SDK's tool events; the spike reads the tool name from event.data.
const SEARCH_EVENT = { type: 'tool.execution_start', data: { toolName: 'web_search' } };
const FETCH_EVENT = { type: 'tool.execution_complete', data: { tool_name: 'web_fetch' } };

function logger() {
  const lines = [];
  return { lines, log: (l) => lines.push(l), error: (l) => lines.push(l), warn: (l) => lines.push(l) };
}

function tutorAi({ events = [], permissions = [] } = {}) {
  return createMockAi({
    replies: { [MODEL]: JSON.stringify({ reply: 'Invented reply.', taskSpecific: false, wellbeingLevel: 0, sources: [CARD, CARD2] }) },
    events: { [MODEL]: events },
    permissionRequests: { [MODEL]: permissions },
  });
}

const ask = (ai, log, web = true) => askTutor({ ai, model: MODEL, system: 's', prompt: 'p', needLevel: true, web, log });

test('webToolRan: a tool event naming a web tool; nothing else', () => {
  assert.equal(webToolRan(SEARCH_EVENT), true);
  assert.equal(webToolRan(FETCH_EVENT), true);
  assert.equal(webToolRan({ type: 'tool.execution_start', data: { name: 'web_search' } }), true);
  assert.equal(webToolRan({ type: 'tool.execution_start', data: { toolName: 'bash' } }), false, 'other tools');
  assert.equal(webToolRan({ type: 'tool.execution_start', data: { toolName: 'read_notebook' } }), false, 'our own tools');
  assert.equal(webToolRan({ type: 'assistant.message', data: { name: 'web_search' } }), false, 'not a tool event');
  assert.equal(webToolRan({ type: 'tool.execution_start' }), false, 'no data');
  assert.equal(webToolRan(null), false);
  assert.equal(webToolRan(SEARCH_EVENT, ['web_fetch']), false, 'only the tools offered');
});

test('webTracker: a tool event or an approved url permission; a refused one does not count', () => {
  const byEvent = webTracker();
  byEvent.onEvent(SEARCH_EVENT);
  assert.equal(byEvent.state.used, true);
  const byPermission = webTracker();
  byPermission.onPermission({ kind: 'url' }, true);
  assert.equal(byPermission.state.used, true);
  const refused = webTracker();
  refused.onPermission({ kind: 'url' }, false);
  refused.onPermission({ kind: 'shell' }, true);
  refused.onEvent({ type: 'session.idle', data: {} });
  assert.equal(refused.state.used, false);
});

test('research reply: web_search ran with no permission request, so the cards are kept', async () => {
  const log = logger();
  const ai = tutorAi({ events: [SEARCH_EVENT] });
  const r = await ask(ai, log);
  assert.deepEqual(r.sources.map((s) => s.title), [CARD.title, CARD2.title]);
  assert.deepEqual(ai.calls[0].tools, ['web_fetch', 'web_search']);
  assert.equal(log.lines.some((l) => l.includes('cards dropped')), false);
});

test('the url permission still counts on its own', async () => {
  const r = await ask(tutorAi({ permissions: [{ kind: 'url', url: CARD.url }] }), logger());
  assert.equal(r.sources.length, 2);
});

test('no sign that a web tool ran: cards dropped, and a count (never text) is logged', async () => {
  const log = logger();
  const r = await ask(tutorAi({ events: [{ type: 'assistant.message', data: {} }] }), log);
  assert.deepEqual(r.sources, []);
  assert.ok(log.lines.includes('[sources] 2 cards dropped: no web tool ran'));
  assert.equal(log.lines.join('\n').includes('invented'), false, 'no titles or addresses in the log');
});

test('without the web tools (other routes), tool events are ignored and nothing is logged', async () => {
  const log = logger();
  const ai = tutorAi({ events: [SEARCH_EVENT] });
  const r = await ask(ai, log, false);
  assert.deepEqual(r.sources, []);
  assert.deepEqual(ai.calls[0].tools, []);
  assert.equal(log.lines.some((l) => l.includes('cards dropped')), false);
});

function summaryAi(events) {
  return createMockAi({
    replies: { [MODEL]: JSON.stringify({ readOriginal: false, unavailable: false, summary: 'Invented summary.', section: 'Part 2' }) },
    events: { [MODEL]: events },
  });
}

test('summary: a web_fetch tool event counts as the page being opened', async () => {
  const ai = summaryAi([FETCH_EVENT]);
  const r = await askSummary({ ai, model: MODEL, system: 's', prompt: 'p', log: logger(), failedMessage: 'x' });
  assert.equal(r.result.kind, 'summary');
  assert.deepEqual(ai.calls[0].tools, ['web_fetch']);
});

test('summary: no fetch (or only a search event) means unavailable, so nothing comes from memory', async () => {
  for (const events of [[], [SEARCH_EVENT]]) {
    const r = await askSummary({ ai: summaryAi(events), model: MODEL, system: 's', prompt: 'p', log: logger(), failedMessage: 'x' });
    assert.equal(r.result.kind, 'unavailable');
  }
});
