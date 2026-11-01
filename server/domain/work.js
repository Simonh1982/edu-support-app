// Attempts, support events and AI turns (build spec Appendix A.3, A.6; §21.1).
// Attempts: attempts/<UK month>/<id>.json. AI turns: ai-turns/<UK month>/<id>.json (blueprint §2.2).
// Support requests and outcomes are events only: facts and ids, never text.
import { newRecord, ukMonth } from '../storage/records.js';
import { ITEM_ID_PATTERN } from '../storage/items.js';
import { ROUTES } from '../ai/prompt.js';
import { ROLES } from '../ai/models.js';
import {
  bad, notFound, plainObject, onlyKeys, textField, oneOf, wholeNumber, flag, recordId, topicId, idDate,
} from './fields.js';
import { readTask } from './tasks.js';

export const SUPPORT_TYPES = Object.freeze(['hint', 'breakdown', 'pointer', 'explanation']);
export const SUPPORT_OUTCOMES = Object.freeze(['tried-again', 'solved', 'gave-up']);
export const CHECK_RESULTS = Object.freeze(['passed', 'regenerated', 'fallback']);
export const WORK_LIMITS = Object.freeze({ attemptText: 4000, learnerText: 8000, replyText: 20000 });
const FEATURE_PATTERN = /^[a-z][a-z0-9-]{1,30}$/;

// null for anything that isn't a well-formed id, so a path can never be built from bad input
function monthPath(folder, id) {
  const date = typeof id === 'string' && ITEM_ID_PATTERN.test(id) ? idDate(id) : null;
  return date ? `${folder}/${ukMonth(date)}/${id}.json` : null;
}
export const attemptPath = (id) => monthPath('attempts', id);
export const aiTurnPath = (id) => monthPath('ai-turns', id);

// Links with nothing in them are left out, so events stay small.
const links = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== null && v !== undefined));

/**
 * An Attempt record. The check is code only (build spec §21.1): something entered, or the escape.
 * Quality and spelling are never judged.
 */
export function newAttempt(body, { curriculum = null, now = new Date() } = {}) {
  plainObject(body, 'attempt');
  onlyKeys(body, ['route', 'taskId', 'topicId', 'text', 'escape'], 'attempt');
  const route = oneOf(body.route, 'route', ROUTES, { required: true });
  const taskId = recordId(body.taskId, 'taskId');
  const topic = topicId(body.topicId, 'topicId', curriculum);
  const escape = flag(body.escape, 'escape', false);
  const text = textField(body.text, 'text', { max: WORK_LIMITS.attemptText, authors: ['learner'], defaultAuthor: 'learner' });
  if (!text && !escape) throw bad('an attempt needs something written, or the escape');
  return newRecord('att', { route, taskId, topicId: topic, text, escape }, { createdBy: 'learner', now });
}

export async function recordAttempt(store, body, { curriculum = null, now = new Date() } = {}) {
  const attempt = newAttempt(body, { curriculum, now });
  if (attempt.taskId && !(await readTask(store, attempt.taskId))) throw notFound('Task');
  await store.put(attemptPath(attempt.id), attempt);
  await store.logEvent('attempt.recorded', {
    createdBy: 'learner',
    links: links({ attemptId: attempt.id, taskId: attempt.taskId, topicId: attempt.topicId }),
    payload: { route: attempt.route, escape: attempt.escape },
  });
  return attempt;
}

export async function readAttempt(store, id) {
  const p = attemptPath(id);
  return p ? store.read(p) : null;
}

/** A support button press. The event's id is the support event id used for its outcome. */
export async function logSupport(store, { type, route, attemptId, taskId = null, topicId: topic = null } = {}) {
  return store.logEvent('support.requested', {
    createdBy: 'learner',
    links: links({
      attemptId: recordId(attemptId, 'attemptId', { required: true }),
      taskId: recordId(taskId, 'taskId'),
      topicId: topicId(topic, 'topicId', null),
    }),
    payload: {
      type: oneOf(type, 'support type', SUPPORT_TYPES, { required: true }),
      route: oneOf(route, 'route', ROUTES, { required: true }),
    },
  });
}

export async function logSupportOutcome(store, { supportEventId, outcome } = {}) {
  return store.logEvent('support.outcome', {
    createdBy: 'learner',
    links: { supportEventId: recordId(supportEventId, 'supportEventId', { required: true }) },
    payload: { outcome: oneOf(outcome, 'outcome', SUPPORT_OUTCOMES, { required: true }) },
  });
}

/**
 * An AI turn record. For wellbeing levels 2 and 3 the text of the turn is never kept (build spec
 * §32.1, Appendix A.6): this is a backstop; server/wellbeing.js (WP-112) also removes it upstream.
 */
export function newAiTurn(fields, { now = new Date() } = {}) {
  plainObject(fields, 'AI turn');
  onlyKeys(fields, ['feature', 'role', 'model', 'taskId', 'topicId', 'attemptId', 'learnerText', 'text', 'tokens',
    'credits', 'latencyMs', 'success', 'taskSpecific', 'checkResult', 'wellbeingLevel'], 'AI turn');
  if (typeof fields.feature !== 'string' || !FEATURE_PATTERN.test(fields.feature)) throw bad('feature is not valid');
  const role = oneOf(fields.role, 'role', ROLES, { required: true });
  if (typeof fields.model !== 'string' || fields.model.length > 80) throw bad('model is not valid');
  const level = wholeNumber(fields.wellbeingLevel, 'wellbeingLevel', { max: 3 });
  const keepText = !(level >= 2);
  const tokens = fields.tokens == null ? null : {
    input: wholeNumber(fields.tokens.input, 'tokens.input', { max: 10_000_000 }),
    output: wholeNumber(fields.tokens.output, 'tokens.output', { max: 10_000_000 }),
  };
  if (fields.credits != null && !(typeof fields.credits === 'number' && fields.credits >= 0)) throw bad('credits is not valid');
  return newRecord('turn', {
    feature: fields.feature,
    role,
    model: fields.model,
    taskId: recordId(fields.taskId, 'taskId'),
    topicId: topicId(fields.topicId, 'topicId', null),
    attemptId: recordId(fields.attemptId, 'attemptId'),
    learnerText: keepText ? textField(fields.learnerText, 'learnerText', {
      max: WORK_LIMITS.learnerText, authors: ['learner'], defaultAuthor: 'learner',
    }) : null,
    text: keepText ? textField(fields.text, 'text', { max: WORK_LIMITS.replyText, authors: ['ai'], defaultAuthor: 'ai' }) : null,
    textRemoved: !keepText,
    tokens,
    credits: fields.credits ?? null,
    latencyMs: wholeNumber(fields.latencyMs, 'latencyMs', { max: 3_600_000 }),
    success: flag(fields.success, 'success', true),
    taskSpecific: flag(fields.taskSpecific, 'taskSpecific', false),
    checkResult: oneOf(fields.checkResult, 'checkResult', CHECK_RESULTS),
    wellbeingLevel: level,
  }, { createdBy: 'ai', now });
}

export async function saveAiTurn(store, fields, { now = new Date() } = {}) {
  const turn = newAiTurn(fields, { now });
  await store.put(aiTurnPath(turn.id), turn);
  return turn;
}
