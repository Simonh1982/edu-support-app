// Pass- and role-checked work routes (WP-105, WP-108a, WP-111a). server/index.js matches the route,
// checks the pass and the rate limit, reads the body, then calls handleApi. Every route here is
// learner only: the parent role never sees conversations, attempts or votes.
import { DomainError } from './domain/fields.js';
import { listTasks, readTask, createTask, updateTask, addAnchor, updateAnchor, removeAnchor } from './domain/tasks.js';
import { recordAttempt } from './domain/work.js';
import { openUpload, uploadView, confirmUpload, addPastedBrief, UPLOAD_MESSAGES } from './domain/uploads.js';
import {
  startConversation, openConversation, conversationView, sendMessage, requestSupport, voteOnTurn, suggestRoute,
  STATE_MESSAGES,
} from './domain/conversations.js';
import { listSources, saveSource, summariseSource, addOwnSource, attachToSource } from './domain/sources.js';
import { withAttachments } from './domain/attachments.js';

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
  // WP-108a: what was read from an upload, its confirmation, and pasted briefs
  route('POST', '/api/uploads/paste', 'pasteBrief'),
  route('GET', `/api/uploads/${ID}`, 'getUpload'),
  route('POST', `/api/uploads/${ID}/confirm`, 'confirmUpload'),
  // WP-111a: route choice, conversations with the support pairs, and votes on replies
  route('POST', '/api/route', 'suggestRoute'),
  route('POST', '/api/conversations', 'startConversation'),
  route('GET', `/api/conversations/${ID}`, 'getConversation'),
  route('POST', `/api/conversations/${ID}/messages`, 'sendMessage'),
  route('POST', `/api/conversations/${ID}/support`, 'requestSupport'),
  route('POST', `/api/turns/${ID}/vote`, 'voteOnTurn'),
  // WP-114a: saving source cards and AI summaries of saved sources
  route('GET', '/api/sources', 'listSources'),
  route('POST', '/api/sources', 'saveSource'),
  route('POST', `/api/sources/${ID}/summary`, 'summariseSource'),
  // WP-114e (A-010): a source he found himself; the summary route also takes pasted text
  route('POST', '/api/sources/own', 'addOwnSource'),
  // WP-114f (A-010): copies of a source attached as files or photos (the page sends them to the Worker inbox)
  route('POST', `/api/sources/${ID}/attachments`, 'attachSource'),
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
  async pasteBrief({ store, body }) {
    const { upload, duplicate } = await addPastedBrief(store, object(body));
    return { status: duplicate ? 200 : 201, body: { upload: uploadView(upload), duplicate } };
  },
  async getUpload({ store, params: [id] }) {
    const upload = await openUpload(store, id);
    return upload
      ? { status: 200, body: { upload: uploadView(upload) } }
      : { status: 404, body: { error: UPLOAD_MESSAGES.notFound } };
  },
  async confirmUpload({ store, params: [id], body, curriculum }) {
    const result = await confirmUpload(store, id, object(body), { curriculum });
    if (result.alreadyTaskId) return { status: 409, body: { error: UPLOAD_MESSAGES.alreadyTask, taskId: result.alreadyTaskId } };
    return { status: 201, body: { task: result.task, upload: uploadView(result.upload) } };
  },
  async suggestRoute({ store, body, ctx }) {
    return { status: 200, body: await suggestRoute(store, object(body), ctx) };
  },
  async startConversation({ store, body, curriculum, ctx }) {
    const conv = await startConversation(store, object(body), { curriculum });
    return { status: 201, body: { conversation: { ...conversationView(conv, ctx), turns: [] } } };
  },
  async getConversation({ store, params: [id], ctx }) {
    const conversation = await openConversation(store, id, ctx);
    return conversation
      ? { status: 200, body: { conversation } }
      : { status: 404, body: { error: STATE_MESSAGES.notFound } };
  },
  async sendMessage({ store, params: [id], body, ctx }) {
    return { status: 201, body: await sendMessage(store, id, object(body), ctx) };
  },
  async requestSupport({ store, params: [id], body, ctx }) {
    return { status: 201, body: await requestSupport(store, id, object(body), ctx) };
  },
  async voteOnTurn({ store, params: [id], body }) {
    return { status: 200, body: await voteOnTurn(store, id, object(body)) };
  },
  async listSources({ store, query }) {
    const sources = await listSources(store, { taskId: query.get('taskId') || null });
    // WP-114f: a source with copies shows their status (code words only), so the panel knows when to offer Summarise
    return { status: 200, body: { sources: await withAttachments(store, sources) } };
  },
  async saveSource({ store, body, ctx }) {
    const { source, duplicate } = await saveSource(store, object(body), ctx);
    return { status: duplicate ? 200 : 201, body: { source, duplicate } };
  },
  async addOwnSource({ store, body, ctx }) {
    const { source, duplicate } = await addOwnSource(store, object(body), ctx);
    return { status: duplicate ? 200 : 201, body: { source, duplicate } };
  },
  async attachSource({ store, params: [id], body, ctx }) {
    return { status: 200, body: await attachToSource(store, id, object(body), ctx) };
  },
  async summariseSource({ store, params: [id], body, ctx }) {
    const result = await summariseSource(store, id, ctx, body ?? {});
    return { status: result.outcome === 'saved' ? 201 : 200, body: result };
  },
};

/**
 * Run a matched route for a verified pass. Returns { status, body }. Validation, "not found",
 * out-of-order support (409), the AI ceiling (429) and AI problems (502/503) become answers;
 * anything else is thrown for the server's 500 handler.
 * getAi: () => { ai, models } once the AI has started, else null. aiCeiling: the daily AI limit.
 * settings: { disengageAfter, tally: { replies, chars } }. wellbeing: createWellbeing() (server/wellbeing.js), which alerts the
 * owner at levels 2–3; null records the event but sends no alert (tests never send real alerts).
 */
export async function handleApi({
  match, pass, store, body = null, query = new URLSearchParams(), getCurriculum = () => null,
  getAi = () => null, aiCeiling = null, settings = {}, wellbeing = null, log = console,
}) {
  const { route: r, params } = match;
  if (!r.roles.includes(pass?.role)) return { status: 403, body: { error: API_MESSAGES.notAllowed } };
  if (!store || !store.status().ready) return { status: 503, body: { error: API_MESSAGES.notReady } };
  const curriculum = getCurriculum() ?? null;
  const ctx = { getAi, aiCeiling, curriculum, disengageAfter: settings.disengageAfter, tally: settings.tally, wellbeing, log };
  try {
    return await HANDLERS[r.name]({ store, params, body, query, curriculum, ctx });
  } catch (err) {
    if (err instanceof DomainError) return { status: err.status, body: { error: err.message } };
    throw err;
  }
}
