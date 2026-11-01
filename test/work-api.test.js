// Work routes (WP-105): pass and role checks, tasks, anchors, attempts, rate limit. Invented data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../server/config.js';
import { createServer } from '../server/index.js';
import { passSettings, mintPass } from '../server/auth.js';
import { makeEvent } from '../server/storage/records.js';
import { createRateLimiter } from '../server/rate-limits.js';
import { matchApiRoute } from '../server/api.js';

const silent = { error() {}, log() {}, warn() {} };
const { settings } = passSettings({
  PASS_SIGNING_KEY: 'k'.repeat(40),
  PASS_VERSION: '1',
  ALLOWED_ACCOUNTS: JSON.stringify({ 'test-learner': 'learner', 'test-parent': 'parent' }),
});
const curriculum = {
  qualifications: new Map([['demo-geo', {}]]),
  topics: new Map([['demo-geo-1a', {}], ['demo-geo-2b', {}]]),
};
const SECRET_TEXT = 'Invented brief: compare two imaginary rivers';

// A store with the same surface as server/storage/store.js, on a temporary folder, without git.
async function fakeStore({ ready = true } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wp105-'));
  const events = [];
  return {
    dir,
    events,
    status: () => ({ ready }),
    async put(rel, record) {
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

async function withApi({ store, rateLimiter, auth = settings } = {}, fn) {
  const config = loadConfig({ PORT: '0', HOST: '127.0.0.1' });
  const { server } = createServer(config, undefined, silent, {
    authSettings: auth, getStore: () => store, getCurriculum: () => curriculum, rateLimiter,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const learner = await mintPass({ login: 'test-learner', settings });
  const parent = await mintPass({ login: 'test-parent', settings });
  const call = async (method, url, { pass = learner, body } = {}) => {
    const headers = pass ? { Authorization: `Bearer ${pass}` } : {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${base}${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, headers: res.headers, body: await res.json() };
  };
  try {
    await fn({ call, learner, parent });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (store) await rm(store.dir, { recursive: true, force: true });
  }
}

test('routes: matching, 405 for a known path, null for an unknown one', () => {
  assert.equal(matchApiRoute('GET', '/api/tasks').route.name, 'listTasks');
  assert.deepEqual(matchApiRoute('PATCH', '/api/tasks/t_abc/anchors/anc_1').params, ['t_abc', 'anc_1']);
  assert.deepEqual(matchApiRoute('DELETE', '/api/tasks'), { status: 405, allow: ['GET', 'POST'] });
  assert.equal(matchApiRoute('GET', '/api/tasks/bad$id'), null);
  assert.equal(matchApiRoute('GET', '/api/nothing'), null);
});

test('no pass: 401; sign-in not set up: 503; unknown path: 404 without a pass', async () => {
  const store = await fakeStore();
  await withApi({ store }, async ({ call }) => {
    assert.equal((await call('GET', '/api/tasks', { pass: null })).status, 401);
    assert.equal((await call('POST', '/api/attempts', { pass: 'not.a-pass', body: {} })).status, 401);
    assert.equal((await call('GET', '/api/unknown', { pass: null })).status, 404);
    const r = await call('DELETE', '/api/tasks', { pass: null });
    assert.equal(r.status, 405);
    assert.equal(r.headers.get('allow'), 'GET, POST');
  });
  await withApi({ store: await fakeStore(), auth: null }, async ({ call }) => {
    assert.equal((await call('GET', '/api/tasks')).status, 503);
  });
});

test('the parent role is refused on every work route, and nothing is written', async () => {
  const store = await fakeStore();
  await withApi({ store }, async ({ call, parent }) => {
    const created = await call('POST', '/api/tasks', { body: { title: 'Invented task' } });
    const id = created.body.task.id;
    const before = store.events.length;
    for (const [method, url, body] of [
      ['GET', '/api/tasks'], ['POST', '/api/tasks', { title: 'x' }], ['GET', `/api/tasks/${id}`],
      ['PATCH', `/api/tasks/${id}`, { stage: 'done' }], ['POST', `/api/tasks/${id}/anchors`, { type: 'thesis', text: 'x' }],
      ['POST', '/api/attempts', { route: 'learn', text: 'x' }],
    ]) {
      const r = await call(method, url, { pass: parent, body });
      assert.equal(r.status, 403, `${method} ${url}`);
      assert.equal(JSON.stringify(r.body).includes('Invented task'), false);
    }
    assert.equal(store.events.length, before);
  });
});

test('storage not ready: 503', async () => {
  await withApi({ store: await fakeStore({ ready: false }) }, async ({ call }) => {
    assert.equal((await call('GET', '/api/tasks')).status, 503);
  });
});

test('a typed task needs only a title (and usually a deadline); record and event shapes', async () => {
  const store = await fakeStore();
  await withApi({ store }, async ({ call }) => {
    const r = await call('POST', '/api/tasks', { body: { title: '  Invented   essay ', deadline: '2026-11-20', questionText: SECRET_TEXT } });
    assert.equal(r.status, 201);
    const t = r.body.task;
    assert.match(t.id, /^t_/);
    assert.equal(t.title, 'Invented essay');
    assert.equal(t.stage, 'not-started');
    assert.equal(t.confirmed, true);
    assert.deepEqual(t.questionText, { value: SECRET_TEXT, author: 'learner' });
    assert.deepEqual(t.anchors, []);
    assert.equal(t.completedAt, null);
    for (const key of ['createdAt', 'updatedAt', 'createdBy', 'schemaVersion']) assert.ok(key in t, key);
    assert.match(t.createdAt, /[+-]\d{2}:\d{2}$/);
    assert.deepEqual(await store.read(`tasks/${t.id}/task.json`), t);
    const ev = store.events.find((e) => e.type === 'task.created');
    assert.equal(ev.links.taskId, t.id);
    assert.equal(JSON.stringify(store.events).includes('Invented'), false, 'events hold no text');
  });
});

test('task validation: 400s that never echo learner text', async () => {
  const store = await fakeStore();
  await withApi({ store }, async ({ call }) => {
    const cases = [
      [{ deadline: '2026-11-20' }, /title is required/],
      [{ title: 'x', deadline: '2026-02-30' }, /deadline/],
      [{ title: 'x', kind: 'chore' }, /kind/],
      [{ title: 'x', topicIds: ['demo-unknown-9'] }, /not a known topic/],
      [{ title: 'x', qualificationId: 'nope' }, /qualification/],
      [{ title: 'x', [SECRET_TEXT]: 1 }, /unknown field$/],
      [{ title: 'x', questionText: { value: SECRET_TEXT, author: 'ai' } }, /author/],
      [{ title: 'x'.repeat(121) }, /longer than 120/],
    ];
    for (const [body, pattern] of cases) {
      const r = await call('POST', '/api/tasks', { body });
      assert.equal(r.status, 400, JSON.stringify(body).slice(0, 60));
      assert.match(r.body.error, pattern);
      assert.equal(r.body.error.includes('Invented'), false);
    }
    assert.equal((await call('POST', '/api/tasks', { body: [] })).status, 400);
    const big = await call('POST', '/api/tasks', { body: { title: 'x', questionText: 'y'.repeat(300 * 1024) } });
    assert.equal(big.status, 413);
    assert.equal(store.events.length, 0);
  });
});

test('list, read and update: deadline order, open filter, stage events, first completedAt kept', async () => {
  const store = await fakeStore();
  await withApi({ store }, async ({ call }) => {
    const mk = async (title, deadline) => (await call('POST', '/api/tasks', { body: { title, deadline } })).body.task;
    const later = await mk('Later task', '2026-12-01');
    const none = await mk('No date', null);
    const soon = await mk('Soon task', '2026-11-05');
    assert.deepEqual((await call('GET', '/api/tasks')).body.tasks.map((t) => t.id), [soon.id, later.id, none.id]);
    assert.equal((await call('GET', `/api/tasks/${soon.id}`)).body.task.title, 'Soon task');
    assert.equal((await call('GET', '/api/tasks/t_missing')).status, 404);

    const done = await call('PATCH', `/api/tasks/${soon.id}`, { body: { stage: 'submitted', topicIds: ['demo-geo-1a'] } });
    assert.equal(done.status, 200);
    const first = done.body.task.completedAt;
    assert.ok(first);
    await call('PATCH', `/api/tasks/${soon.id}`, { body: { stage: 'drafting' } });
    const again = await call('PATCH', `/api/tasks/${soon.id}`, { body: { stage: 'done' } });
    assert.equal(again.body.task.completedAt, first, 'the retention clock starts the first time only');
    const stages = store.events.filter((e) => e.type === 'task.stage').map((e) => e.payload);
    assert.deepEqual(stages, [
      { from: 'not-started', to: 'submitted' }, { from: 'submitted', to: 'drafting' }, { from: 'drafting', to: 'done' },
    ]);
    assert.deepEqual(store.events.find((e) => e.type === 'task.updated').payload.fields.sort(), ['stage', 'topicIds']);
    assert.deepEqual((await call('GET', '/api/tasks?open=1')).body.tasks.map((t) => t.id), [later.id, none.id]);

    const count = store.events.length;
    const same = await call('PATCH', `/api/tasks/${later.id}`, { body: { title: 'Later task' } });
    assert.equal(same.status, 200);
    assert.equal(store.events.length, count, 'no change, no event');
    assert.equal((await call('PATCH', `/api/tasks/${later.id}`, { body: { stage: null } })).status, 400);
    assert.equal((await call('PATCH', '/api/tasks/t_missing', { body: { stage: 'done' } })).status, 404);
  });
});

test('two quick edits to one task both land', async () => {
  const store = await fakeStore();
  await withApi({ store }, async ({ call }) => {
    const t = (await call('POST', '/api/tasks', { body: { title: 'Invented task' } })).body.task;
    await Promise.all([
      call('POST', `/api/tasks/${t.id}/anchors`, { body: { type: 'location', text: 'Imaginary bay' } }),
      call('POST', `/api/tasks/${t.id}/anchors`, { body: { type: 'thesis', text: 'An invented claim' } }),
      call('PATCH', `/api/tasks/${t.id}`, { body: { workType: 'essay' } }),
    ]);
    const saved = await store.read(`tasks/${t.id}/task.json`);
    assert.equal(saved.anchors.length, 2);
    assert.equal(saved.workType, 'essay');
  });
});

test('anchors: add, confirm, edit, remove; learner anchors start confirmed, source ones do not', async () => {
  const store = await fakeStore();
  await withApi({ store }, async ({ call }) => {
    const t = (await call('POST', '/api/tasks', {
      body: { title: 'Invented task', anchors: [{ type: 'question', text: { value: SECRET_TEXT, author: 'source' } }] },
    })).body.task;
    assert.equal(t.anchors[0].confirmed, false);
    assert.match(t.anchors[0].id, /^anc_/);
    const added = await call('POST', `/api/tasks/${t.id}/anchors`, { body: { type: 'thesis', text: 'An invented claim' } });
    assert.equal(added.status, 201);
    assert.equal(added.body.anchor.confirmed, true);
    assert.deepEqual(added.body.anchor.text, { value: 'An invented claim', author: 'learner' });
    const qid = t.anchors[0].id;
    const ok = await call('PATCH', `/api/tasks/${t.id}/anchors/${qid}`, { body: { confirmed: true } });
    assert.equal(ok.body.anchor.confirmed, true);
    assert.equal(ok.body.anchor.text.author, 'source');
    assert.equal((await call('POST', `/api/tasks/${t.id}/anchors`, { body: { type: 'mood', text: 'x' } })).status, 400);
    assert.equal((await call('POST', `/api/tasks/${t.id}/anchors`, { body: { type: 'thesis' } })).status, 400);
    assert.equal((await call('PATCH', `/api/tasks/${t.id}/anchors/anc_missing`, { body: { confirmed: true } })).status, 404);
    const removed = await call('DELETE', `/api/tasks/${t.id}/anchors/${qid}`);
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.body.task.anchors.map((a) => a.type), ['thesis']);
    assert.deepEqual(store.events.filter((e) => e.type.startsWith('anchor.')).map((e) => e.type),
      ['anchor.added', 'anchor.updated', 'anchor.removed']);
    assert.equal(JSON.stringify(store.events).includes('invented claim'), false);
  });
});

test('attempts: something written or the escape; stored by UK month; event without text', async () => {
  const store = await fakeStore();
  await withApi({ store }, async ({ call }) => {
    const t = (await call('POST', '/api/tasks', { body: { title: 'Invented task' } })).body.task;
    assert.equal((await call('POST', '/api/attempts', { body: { route: 'plan', text: '   ' } })).status, 400);
    assert.equal((await call('POST', '/api/attempts', { body: { route: 'nap', text: 'x' } })).status, 400);
    assert.equal((await call('POST', '/api/attempts', { body: { route: 'plan', text: 'x', taskId: 't_missing' } })).status, 404);
    assert.equal((await call('POST', '/api/attempts', { body: { route: 'learn', text: 'x', topicId: 'demo-nope' } })).status, 400);

    const r = await call('POST', '/api/attempts', { body: { route: 'plan', taskId: t.id, text: 'idk mayb rivers flood' } });
    assert.equal(r.status, 201);
    const a = r.body.attempt;
    assert.match(a.id, /^att_/);
    assert.deepEqual(a.text, { value: 'idk mayb rivers flood', author: 'learner' }, 'kept exactly as written');
    assert.equal(a.escape, false);
    const month = a.createdAt.slice(0, 7);
    assert.ok(existsSync(path.join(store.dir, `attempts/${month}/${a.id}.json`)));

    const esc = await call('POST', '/api/attempts', { body: { route: 'research', escape: true } });
    assert.equal(esc.status, 201);
    assert.equal(esc.body.attempt.text, null);
    const learn = await call('POST', '/api/attempts', { body: { route: 'learn', topicId: 'demo-geo-2b', text: 'Nothing yet' } });
    assert.equal(learn.status, 201);

    const evs = store.events.filter((e) => e.type === 'attempt.recorded');
    assert.equal(evs.length, 3);
    assert.deepEqual(evs[0].links, { attemptId: a.id, taskId: t.id });
    assert.deepEqual(evs[1].payload, { route: 'research', escape: true });
    assert.equal(JSON.stringify(store.events).includes('rivers'), false);
  });
});

test('rate limit per pass: 429 with Retry-After; other passes unaffected; item route counted too', async () => {
  let t = 1_000_000;
  const rateLimiter = createRateLimiter({ limit: 3, now: () => t });
  const store = await fakeStore();
  await withApi({ store, rateLimiter }, async ({ call, parent }) => {
    for (let i = 0; i < 2; i += 1) assert.equal((await call('GET', '/api/tasks')).status, 200);
    assert.equal((await call('GET', '/api/item?type=task&id=t_none')).status, 404);
    const limited = await call('GET', '/api/tasks');
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '60');
    assert.match(limited.body.error, /Too many requests/);
    assert.equal((await call('GET', '/api/tasks', { pass: parent })).status, 403, 'a different pass has its own count');
    t += 60_000;
    assert.equal((await call('GET', '/api/tasks')).status, 200);
  });
});
