// Pass- and role-checked work routes (WP-105). server/index.js matches the route, checks the pass
// and the rate limit, reads the body, then calls handleApi. Every route here is learner only.
import { DomainError } from './domain/fields.js';
import { listTasks, readTask, createTask, updateTask, addAnchor, updateAnchor, removeAnchor } from './domain/tasks.js';
import { recordAttempt } from './domain/work.js';

const ID = '([A-Za-z0-9][A-Za-z0-9_-]{0,99})';
const LEARNER = Object.freeze(['learner']);
const route = (method, pattern, name) => Object.freeze({ method, path: new RegExp(`^${pattern}$`), name, roles: LEARNER });

export const API_ROUTES = Object.freeze([
  route('GET', '/api/tasks', 'listTasks'),
  route('POST', '/api/tasks', 'createTask'),
  route('GET', `/api/tasks/${ID}`, 'getTask'),
  route('PATCH', `/api/tasks/${ID}`, 'updateTask'),
  route('POST', `/api/tasks/${ID}/anchors`, 'addAnchor'),
  route('PATCH', `/api/tasks/${ID}/anchors/${ID}`, 'updateAnchor'),
  route('DELETE', `/api/tasks/${ID}/anchors/${ID}`, 'removeAnchor'),
  route('POST', '/api/attempts', 'recordAttempt'),
]);

export const API_MESSAGES = Object.freeze({
  notAllowed: "You don't have access to this.",
  notReady: "Saved work isn't available yet.",
  needBody: 'Request body must be a JSON object.',
});

/** { route, params } for a known route, { status: 405, allow } for a known path with another method, or null. */
export function matchApiRoute(method, pathname) {
  const hits = API_ROUTES.map((r) => ({ r, m: r.path.exec(pathname) })).filter((h) => h.m);
  if (hits.length === 0) return null;
  const hit = hits.find((h) => h.r.method === method);
  if (!hit) return { status: 405, allow: [...new Set(hits.map((h) => h.r.method))] };
  return { route: hit.r, params: hit.m.slice(1) };
}

const object = (body) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new DomainError(400, API_MESSAGES.needBody);
  return body;
};

const HANDLERS = {
  async listTasks({ store, query }) {
    return { status: 200, body: { tasks: await listTasks(store, { open: query.get('open') === '1' }) } };
  },
  async createTask({ store, body, curriculum }) {
    // a task the learner types is his own, so it starts confirmed unless he says otherwise
    const task = await createTask(store, { confirmed: true, ...object(body) }, { curriculum });
    return { status: 201, body: { task } };
  },
  async getTask({ store, params: [id] }) {
    const task = await readTask(store, id);
    return task ? { status: 200, body: { task } } : { status: 404, body: { error: 'Task not found.' } };
  },
  async updateTask({ store, params: [id], body, curriculum }) {
    return { status: 200, body: { task: await updateTask(store, id, object(body), { curriculum }) } };
  },
  async addAnchor({ store, params: [id], body }) {
    return { status: 201, body: await addAnchor(store, id, object(body)) };
  },
  async updateAnchor({ store, params: [id, anchorId], body }) {
    return { status: 200, body: await updateAnchor(store, id, anchorId, object(body)) };
  },
  async removeAnchor({ store, params: [id, anchorId] }) {
    const { task } = await removeAnchor(store, id, anchorId);
    return { status: 200, body: { task } };
  },
  async recordAttempt({ store, body, curriculum }) {
    return { status: 201, body: { attempt: await recordAttempt(store, object(body), { curriculum }) } };
  },
};

/**
 * Run a matched route for a verified pass. Returns { status, body }. Validation and "not found"
 * become 4xx answers; anything else is thrown for the server's 500 handler.
 */
export async function handleApi({ match, pass, store, body = null, query = new URLSearchParams(), getCurriculum = () => null }) {
  const { route: r, params } = match;
  if (!r.roles.includes(pass?.role)) return { status: 403, body: { error: API_MESSAGES.notAllowed } };
  if (!store || !store.status().ready) return { status: 503, body: { error: API_MESSAGES.notReady } };
  try {
    return await HANDLERS[r.name]({ store, params, body, query, curriculum: getCurriculum() ?? null });
  } catch (err) {
    if (err instanceof DomainError) return { status: err.status, body: { error: err.message } };
    throw err;
  }
}
