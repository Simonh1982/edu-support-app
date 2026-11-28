// WP-114h: carrying on from his latest conversation for a task after a reload, for up to 60 days.
// Invented data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeEvent } from '../server/storage/records.js';
import { matchApiRoute, handleApi } from '../server/api.js';
import { RESUME_DAYS, conversationPath, latestConversation } from '../server/domain/conversations.js';
import { TALK_MESSAGES, conversationDay } from '../web/shared/conversation.js';
import { createApi } from '../web/shared/api.js';

async function fakeStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wp114h-'));
  return {
    dir,
    status: () => ({ ready: true }),
    async put(rel, record) {
      await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await writeFile(path.join(dir, rel), JSON.stringify(record));
      return record;
    },
    async read(rel) {
      try { return JSON.parse(await readFile(path.join(dir, rel), 'utf8')); } catch { return null; }
    },
    async logEvent(type, options = {}) { return makeEvent(type, options); },
  };
}

const silent = { log() {}, error() {}, warn() {} };
const call = (store, method, url, body, role = 'learner') => {
  const [p, search = ''] = url.split('?');
  const match = matchApiRoute(method, p);
  assert.ok(match?.route, `route ${method} ${p}`);
  return handleApi({ match, pass: { role }, store, body, query: new URLSearchParams(search), getAi: () => null, log: silent });
};

// a conversation as the server saves it, with replies and a last-used time
async function conversation(store, { taskId, route = 'research', turns = 1, usedAt }) {
  const conv = (await call(store, 'POST', '/api/conversations', { route, taskId })).body.conversation;
  const rel = conversationPath(conv.id);
  const saved = await store.read(rel);
  saved.turns = Array.from({ length: turns }, (_, i) => ({ turnId: `turn_invented${i}`, action: 'attempt', idk: false }));
  saved.updatedAt = usedAt;
  await store.put(rel, saved);
  return conv.id;
}

test('the latest conversation for a task and route comes back with its turns; others are left alone', async () => {
  const store = await fakeStore();
  try {
    const task = (await call(store, 'POST', '/api/tasks', { title: 'Invented task', questionText: 'Invented question?' })).body.task;
    const other = (await call(store, 'POST', '/api/tasks', { title: 'Other invented task', questionText: 'Other?' })).body.task;
    const now = new Date();
    const ago = (days) => new Date(now.getTime() - days * 86_400_000).toISOString();
    const older = await conversation(store, { taskId: task.id, usedAt: ago(3) });
    const newer = await conversation(store, { taskId: task.id, turns: 2, usedAt: ago(1) });
    await conversation(store, { taskId: task.id, turns: 0, usedAt: ago(0) }); // never answered
    await conversation(store, { taskId: task.id, route: 'plan', usedAt: ago(0) }); // another route
    await conversation(store, { taskId: other.id, usedAt: ago(0) }); // another task
    const r = await call(store, 'GET', `/api/conversations?taskId=${task.id}&route=research`);
    assert.equal(r.status, 200);
    assert.equal(r.body.conversation.id, newer);
    assert.equal(r.body.conversation.turns.length, 2);
    assert.notEqual(r.body.conversation.id, older);
    // nothing for a route he hasn't used on this task
    assert.equal((await call(store, 'GET', `/api/conversations?taskId=${task.id}&route=learn`)).body.conversation, null);
  } finally { await rm(store.dir, { recursive: true, force: true }); }
});

test('conversations come back for 60 days after they were last used, then a new one starts', async () => {
  const store = await fakeStore();
  try {
    assert.equal(RESUME_DAYS, 60);
    const task = (await call(store, 'POST', '/api/tasks', { title: 'Invented task', questionText: 'Invented question?' })).body.task;
    const now = new Date();
    await conversation(store, { taskId: task.id, usedAt: new Date(now.getTime() - 59 * 86_400_000).toISOString() });
    const kept = await latestConversation(store, { taskId: task.id, route: 'research' }, { now });
    assert.ok(kept, 'used 59 days ago');
    const later = new Date(now.getTime() + 2 * 86_400_000);
    assert.equal(await latestConversation(store, { taskId: task.id, route: 'research' }, { now: later }), null, '61 days on');
  } finally { await rm(store.dir, { recursive: true, force: true }); }
});

test('the lookup checks its question and is learner only', async () => {
  const store = await fakeStore();
  try {
    assert.equal((await call(store, 'GET', '/api/conversations?route=research')).status, 400);
    assert.equal((await call(store, 'GET', '/api/conversations?taskId=task_x&route=nonsense')).status, 400);
    assert.equal((await call(store, 'GET', '/api/conversations?taskId=task_x&route=research', null, 'parent')).status, 403);
  } finally { await rm(store.dir, { recursive: true, force: true }); }
});

test('the screen asks for it by task and route, says when it is from, and offers a new conversation', async () => {
  const urls = [];
  const api = createApi({
    getBackendUrl: () => 'https://example-codespace-3000.app.github.dev', getToken: () => 'invented-pass',
    fetchImpl: async (url) => { urls.push(String(url)); return new Response('{"conversation":null}', { status: 200, headers: { 'Content-Type': 'application/json' } }); },
  });
  const r = await api.latestConversation({ taskId: 'task_invented', route: 'research' });
  assert.equal(r.kind, 'ok');
  assert.match(urls[0], /\/api\/conversations\?taskId=task_invented&route=research$/);
  const now = new Date('2026-11-17T12:00:00Z');
  assert.equal(conversationDay('2026-11-17T08:00:00Z', now), 'from today');
  assert.equal(conversationDay('2026-11-16T08:00:00Z', now), 'from yesterday');
  assert.equal(conversationDay('2026-11-04T08:00:00Z', now), 'on Wednesday 4 November');
  assert.equal(TALK_MESSAGES.carriedOn('from today'), 'Carrying on with your conversation from today.');
  // WP-134a: the chat page lists a task's chats instead of carrying on with the latest one
});
