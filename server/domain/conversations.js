// Conversations: attempt before help and the two support pairs, enforced in code (build spec §21.1,
// §22, §57), the disengagement trigger (§34), route choice (§10) and reply votes (A-007, §31).
// A Conversation record (conversations/<UK month>/<id>.json) holds state and turn IDs only, never
// text: the words live in the AI turn and Attempt records, which have their own retention rules.
// Events hold ids, types and counts only.
import { newRecord, updateRecord, ukIso, ukMonth } from '../storage/records.js';
import { ITEM_ID_PATTERN } from '../storage/items.js';
import { ROUTES, buildRequest, loadProfileSettings } from '../ai/prompt.js';
import { createReadTools } from '../ai/read-tools.js';
import { topicExtract } from '../curriculum.js';
import {
  ACTION_INSTRUCTIONS, DISENGAGED_INSTRUCTION, CONVERSATION_MESSAGES, askTutor, askRoute,
} from '../ai/conversation.js';
import { isIdkStyle, idkCount, DEFAULT_DISENGAGE_AFTER } from '../derived/engagement.js';
import { routeFromTask, routeOptions } from '../derived/route.js';
import { isDisclosure, noteDisclosure } from '../wellbeing.js';
import {
  DomainError, bad, notFound, plainObject, onlyKeys, oneOf, recordId, topicId, flag, textField, idDate,
} from './fields.js';
import { readTask, withTaskLock } from './tasks.js';
import {
  recordAttempt, readAttempt, logSupport, logSupportOutcome, saveAiTurn, aiTurnPath, SUPPORT_TYPES, WORK_LIMITS,
} from './work.js';

export const FIRST_PAIR = Object.freeze(['hint', 'breakdown']);
export const SECOND_PAIR = Object.freeze(['pointer', 'explanation']);
export const VOTES = Object.freeze(['up', 'down', 'removed']);
export const CONVERSATION_LIMITS = Object.freeze({ turns: 200, historyTurns: 5, topics: 2 });
export const ROUTE_FEATURE = 'route-choice';

export const STATE_MESSAGES = Object.freeze({
  needAttempt: 'Have a go first: write anything, however rough.',
  notOffered: "That help isn't available yet. Have another go first.",
  escapeOnce: '"I don\'t know where to start" is only for the start.',
  full: 'This conversation is full. Please start a new one.',
  notFound: 'Conversation not found.',
  turnNotFound: 'Reply not found.',
});

export function conversationPath(id) {
  const date = typeof id === 'string' && ITEM_ID_PATTERN.test(id) ? idDate(id) : null;
  return date ? `conversations/${ukMonth(date)}/${id}.json` : null;
}

/**
 * The support buttons on offer (build spec §21–§22). pair 0: none until an attempt. pair 1: the
 * first pair (Break it down only after the escape). pair 2: the second pair. While waiting for a
 * fresh attempt after help, nothing is offered.
 */
export function offeredSupport(state) {
  if (!state || state.waiting || !state.pair) return [];
  if (state.pair === 1) return state.escape ? ['breakdown'] : [...FIRST_PAIR];
  return [...SECOND_PAIR];
}

/** The next state after an attempt or a support request; throws 409 if the step is out of order. */
export function advance(state, step) {
  const s = { pair: state.pair ?? 0, waiting: state.waiting !== false, escape: state.escape === true };
  if (step.action === 'attempt') {
    if (!s.waiting) return s;
    if (step.escape) {
      if (s.pair !== 0) throw new DomainError(409, STATE_MESSAGES.escapeOnce);
      return { pair: 1, waiting: false, escape: true };
    }
    // the first attempt opens the first pair; a fresh attempt after help opens the second
    return { pair: s.pair === 0 ? 1 : 2, waiting: false, escape: false };
  }
  if (step.action === 'support') {
    if (s.waiting) throw new DomainError(409, s.pair === 0 ? STATE_MESSAGES.needAttempt : STATE_MESSAGES.notOffered);
    if (!offeredSupport(s).includes(step.type)) throw new DomainError(409, STATE_MESSAGES.notOffered);
    return { ...s, waiting: true };
  }
  throw new Error(`unknown step: ${step.action}`);
}

export function newConversation(body, { curriculum = null, now = new Date() } = {}) {
  plainObject(body, 'conversation');
  onlyKeys(body, ['route', 'taskId', 'topicId'], 'conversation');
  return newRecord('conv', {
    route: oneOf(body.route, 'route', ROUTES, { required: true }),
    taskId: recordId(body.taskId, 'taskId'),
    topicId: topicId(body.topicId, 'topicId', curriculum),
    pair: 0,
    waiting: true,
    escape: false,
    lastAttemptId: null,
    lastSupportEventId: null,
    // { turnId, action: attempt|message|support, type?, idk } for each AI turn, oldest first
    turns: [],
    disengagedAt: null,
  }, { createdBy: 'learner', now });
}

/** What the screen needs: state and counts, no text (turns are added by openConversation). */
export function conversationView(conv, { disengageAfter = DEFAULT_DISENGAGE_AFTER } = {}) {
  return {
    id: conv.id,
    route: conv.route,
    taskId: conv.taskId,
    topicId: conv.topicId,
    needsAttempt: conv.waiting === true,
    canEscape: conv.waiting === true && conv.pair === 0,
    offered: offeredSupport(conv),
    idkCount: idkCount(conv.turns),
    disengaged: idkCount(conv.turns) >= disengageAfter,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
  };
}

export async function readConversation(store, id) {
  const p = conversationPath(id);
  return p ? store.read(p) : null;
}

async function saveConversation(store, conv, changes, now) {
  const next = updateRecord(conv, changes, { now });
  await store.put(conversationPath(next.id), next);
  return next;
}

const links = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== null && v !== undefined));
const lockKey = (id) => `conversation:${id}`;

export async function startConversation(store, body, { curriculum = null, now = new Date() } = {}) {
  const conv = newConversation(body, { curriculum, now });
  let task = null;
  if (conv.taskId) {
    task = await readTask(store, conv.taskId);
    if (!task) throw notFound('Task');
  }
  // the task's first topic gives the curriculum extract when none was chosen
  if (!conv.topicId && Array.isArray(task?.topicIds) && task.topicIds[0]) conv.topicId = task.topicIds[0];
  await store.put(conversationPath(conv.id), conv);
  await store.logEvent('conversation.started', {
    createdBy: 'learner',
    links: links({ conversationId: conv.id, taskId: conv.taskId, topicId: conv.topicId }),
    payload: { route: conv.route },
  });
  return conv;
}

/** The conversation with its turns' text, for resuming after the tutor wakes (blueprint §9.2). */
export async function openConversation(store, id, { disengageAfter } = {}) {
  const conv = await readConversation(store, id);
  if (!conv) return null;
  const turns = [];
  for (const t of conv.turns) {
    const turn = await store.read(aiTurnPath(t.turnId));
    turns.push({
      id: t.turnId,
      action: t.action,
      type: t.type ?? null,
      learnerText: turn?.learnerText?.value ?? null,
      reply: turn?.text?.value ?? null,
      textRemoved: turn ? turn.textRemoved === true : true,
      // a number only, so the screen can show the helplines again beside a level-3 reply
      wellbeingLevel: Number.isInteger(turn?.wellbeingLevel) ? turn.wellbeingLevel : null,
      createdAt: turn?.createdAt ?? null,
    });
  }
  return { ...conversationView(conv, { disengageAfter }), turns };
}

function taskForPrompt(task) {
  if (!task) return undefined;
  return {
    question: task.questionText?.value ?? '',
    anchors: (Array.isArray(task.anchors) ? task.anchors : []).map((a) => ({ kind: a.type, text: a.text?.value ?? '' })),
  };
}

// The last few exchanges, oldest first. Turns whose text was removed simply drop out.
async function recentTurns(store, conv) {
  const out = [];
  for (const t of conv.turns.slice(-CONVERSATION_LIMITS.historyTurns)) {
    const turn = await store.read(aiTurnPath(t.turnId));
    if (turn?.learnerText?.value) out.push({ role: 'learner', text: turn.learnerText.value });
    if (turn?.text?.value) out.push({ role: 'tutor', text: turn.text.value });
  }
  return out;
}

function requireAi(getAi) {
  const handle = getAi?.() ?? null;
  if (!handle?.ai || !handle.models?.conversation) throw new DomainError(503, CONVERSATION_MESSAGES.notReady);
  return handle;
}

// Everything a tutor call needs. Only the parts build spec §32.3 allows reach the model.
async function tutorCall(store, conv, { ctx, message, attempt, instruction, needLevel }) {
  const handle = requireAi(ctx.getAi);
  const task = conv.taskId ? await readTask(store, conv.taskId) : null;
  const curriculum = ctx.curriculum ?? null;
  const topics = [...new Set([conv.topicId, ...(Array.isArray(task?.topicIds) ? task.topicIds : [])].filter(Boolean))]
    .slice(0, CONVERSATION_LIMITS.topics);
  const extracts = curriculum ? topics.map((t) => topicExtract(curriculum, t)).filter(Boolean) : [];
  const settings = await loadProfileSettings({ storageDir: store.dir });
  const { system, prompt } = await buildRequest({
    route: conv.route,
    settings,
    task: taskForPrompt(task),
    curriculum: extracts,
    conversation: await recentTurns(store, conv),
    attempt,
    message,
    instruction,
  });
  const customTools = createReadTools({
    getCurriculum: () => curriculum,
    getStorageDir: () => store.dir,
    scope: { taskId: conv.taskId, topicIds: topics },
  });
  return askTutor({
    ai: handle.ai, model: handle.models.conversation, system, prompt, customTools, needLevel,
    ceiling: ctx.aiCeiling, log: ctx.log ?? console,
  });
}

const instructionFor = (action, disengaged) => [ACTION_INSTRUCTIONS[action], disengaged ? DISENGAGED_INSTRUCTION : '']
  .filter(Boolean).join('\n');

function turnView(turn, { action, type = null, reply, wellbeingLevel }) {
  return { id: turn.id, action, type, replyType: type ?? 'other', reply, wellbeingLevel, textRemoved: turn.textRemoved };
}

/**
 * A typed message, or the escape. While the conversation waits for an attempt, the message is that
 * attempt (anything entered counts; quality is never judged). The AI is asked first and nothing is
 * saved unless it answers, so a failed call can simply be tried again.
 */
export async function sendMessage(store, id, body, ctx = {}) {
  plainObject(body, 'message');
  onlyKeys(body, ['text', 'escape'], 'message');
  const escape = flag(body.escape, 'escape', false);
  const now = ctx.now ?? new Date();
  const after = ctx.disengageAfter ?? DEFAULT_DISENGAGE_AFTER;
  return withTaskLock(lockKey(id), async () => {
    const conv = await readConversation(store, id);
    if (!conv) throw new DomainError(404, STATE_MESSAGES.notFound);
    const base = { route: conv.route, taskId: conv.taskId, topicId: conv.topicId };

    if (escape) {
      // "I don't know where to start": an attempt with no text, which offers Break it down only (§21.1)
      if (typeof body.text === 'string' && body.text.trim()) throw bad('escape takes no text');
      const state = advance(conv, { action: 'attempt', escape: true });
      const attempt = await recordAttempt(store, { ...base, escape: true }, { curriculum: ctx.curriculum, now });
      const saved = await saveConversation(store, conv, { ...state, lastAttemptId: attempt.id }, now);
      return { conversation: conversationView(saved, { disengageAfter: after }), turn: null, attemptId: attempt.id };
    }

    const text = textField(body.text, 'text', {
      max: WORK_LIMITS.attemptText, authors: ['learner'], defaultAuthor: 'learner', required: true,
    });
    if (conv.turns.length >= CONVERSATION_LIMITS.turns) throw new DomainError(409, STATE_MESSAGES.full);
    const isAttempt = conv.waiting === true;
    const idk = isIdkStyle(text.value);
    const count = idkCount(conv.turns) + (idk ? 1 : 0);
    const disengaged = count >= after;
    const answer = await tutorCall(store, conv, {
      ctx, message: text.value, instruction: instructionFor(isAttempt ? 'attempt' : 'message', disengaged), needLevel: true,
    });

    // Levels 2–3 (build spec §32.1): his words, the reply and anything made from them are dropped
    // before anything is saved. A disclosure isn't a go at the work, so it makes no Attempt record and
    // opens no help; he still sees the reply.
    const disclosure = isDisclosure(answer.wellbeingLevel);
    const counts = isAttempt && !disclosure;
    const action = counts ? 'attempt' : 'message';
    let state = { pair: conv.pair, waiting: conv.waiting, escape: conv.escape };
    let attemptId = null;
    if (counts) {
      state = advance(conv, { action: 'attempt' });
      if (conv.lastSupportEventId) await logSupportOutcome(store, { supportEventId: conv.lastSupportEventId, outcome: 'tried-again' });
      attemptId = (await recordAttempt(store, { ...base, text: text.value }, { curriculum: ctx.curriculum, now })).id;
    }
    const turn = await saveAiTurn(store, {
      feature: conv.route, role: 'conversation', model: answer.model, taskId: conv.taskId, topicId: conv.topicId, attemptId,
      learnerText: disclosure ? null : text.value, text: disclosure ? null : answer.reply, latencyMs: answer.ms, success: true,
      taskSpecific: answer.taskSpecific, wellbeingLevel: answer.wellbeingLevel,
    }, { now });
    const changes = {
      ...state,
      lastAttemptId: attemptId ?? conv.lastAttemptId,
      lastSupportEventId: counts ? null : conv.lastSupportEventId,
      turns: [...conv.turns, { turnId: turn.id, action, idk: idk && !disclosure }],
    };
    if (disengaged && !disclosure && !conv.disengagedAt) {
      changes.disengagedAt = ukIso(now);
      await store.logEvent('conversation.disengaged', {
        createdBy: 'system',
        links: links({ conversationId: conv.id, taskId: conv.taskId }),
        payload: { route: conv.route, count },
      });
    }
    const saved = await saveConversation(store, conv, changes, now);
    // then the event (date and level only) and the owner's alert; neither ever sees his words
    await noteDisclosure(store, answer.wellbeingLevel, { wellbeing: ctx.wellbeing ?? null, log: ctx.log ?? console });
    return {
      conversation: conversationView(saved, { disengageAfter: after }),
      turn: turnView(turn, { action, reply: answer.reply, wellbeingLevel: answer.wellbeingLevel }),
      attemptId,
    };
  });
}

/** A support button. Only the buttons on offer are accepted, so help is never out of order (§57). */
export async function requestSupport(store, id, body, ctx = {}) {
  plainObject(body, 'support');
  onlyKeys(body, ['type'], 'support');
  const type = oneOf(body.type, 'type', SUPPORT_TYPES, { required: true });
  const now = ctx.now ?? new Date();
  const after = ctx.disengageAfter ?? DEFAULT_DISENGAGE_AFTER;
  return withTaskLock(lockKey(id), async () => {
    const conv = await readConversation(store, id);
    if (!conv) throw new DomainError(404, STATE_MESSAGES.notFound);
    const state = advance(conv, { action: 'support', type });
    if (conv.turns.length >= CONVERSATION_LIMITS.turns) throw new DomainError(409, STATE_MESSAGES.full);
    const attempt = conv.lastAttemptId ? await readAttempt(store, conv.lastAttemptId) : null;
    const answer = await tutorCall(store, conv, {
      ctx,
      attempt: attempt?.text?.value ?? '',
      instruction: instructionFor(type, idkCount(conv.turns) >= after),
      // a button press isn't something he typed, so there's nothing to rate (§32.1)
      needLevel: false,
    });
    const base = { taskId: conv.taskId, topicId: conv.topicId };
    const event = await logSupport(store, { type, route: conv.route, attemptId: conv.lastAttemptId, ...base });
    const turn = await saveAiTurn(store, {
      feature: conv.route, role: 'conversation', model: answer.model, ...base, attemptId: conv.lastAttemptId,
      text: answer.reply, latencyMs: answer.ms, success: true, taskSpecific: answer.taskSpecific,
    }, { now });
    const saved = await saveConversation(store, conv, {
      ...state,
      lastSupportEventId: event.id,
      turns: [...conv.turns, { turnId: turn.id, action: 'support', type, idk: false }],
    }, now);
    return {
      conversation: conversationView(saved, { disengageAfter: after }),
      turn: turnView(turn, { action: 'support', type, reply: answer.reply, wellbeingLevel: null }),
    };
  });
}

/**
 * Thumbs up or down on a tutor reply (A-007): an event with the turn ID, route and vote, no text.
 * Each tap is a new event and the latest one counts, so a vote can be changed or removed. Votes are
 * never read back into a prompt.
 */
export async function voteOnTurn(store, turnId, body) {
  plainObject(body, 'vote');
  onlyKeys(body, ['vote'], 'vote');
  const vote = oneOf(body.vote, 'vote', VOTES, { required: true });
  const p = aiTurnPath(turnId);
  const turn = p ? await store.read(p) : null;
  if (!turn || !ROUTES.includes(turn.feature)) throw new DomainError(404, STATE_MESSAGES.turnNotFound);
  await store.logEvent('reply.feedback', {
    createdBy: 'learner',
    links: { turnId },
    payload: { route: turn.feature, vote },
  });
  return { turnId, route: turn.feature, vote };
}

/**
 * Suggest a route (build spec §10). From a task: its stage decides, with no AI call. From a typed
 * message: the light model suggests one. Never fails for want of the AI: it just suggests nothing.
 * The message is never saved; the AI turn keeps the level only.
 */
export async function suggestRoute(store, body, ctx = {}) {
  plainObject(body, 'route request');
  onlyKeys(body, ['taskId', 'message'], 'route request');
  const taskId = recordId(body.taskId, 'taskId');
  if (taskId) {
    const task = await readTask(store, taskId);
    if (!task) throw notFound('Task');
    return { ...routeFromTask(task), by: 'task' };
  }
  const message = textField(body.message, 'message', { max: WORK_LIMITS.attemptText, authors: ['learner'], defaultAuthor: 'learner' });
  const handle = ctx.getAi?.() ?? null;
  if (!message || !handle?.ai || !handle.models?.light) return { route: null, options: [...ROUTES], by: 'none' };
  const answer = await askRoute({
    ai: handle.ai, model: handle.models.light, message: message.value, ceiling: ctx.aiCeiling, log: ctx.log ?? console,
  });
  if (answer.ok) {
    await saveAiTurn(store, {
      feature: ROUTE_FEATURE, role: 'light', model: answer.model, latencyMs: answer.ms,
      success: answer.route !== null, wellbeingLevel: answer.wellbeingLevel,
    }, { now: ctx.now ?? new Date() });
  }
  const out = { route: answer.route, options: routeOptions(answer.route, ROUTES), by: answer.route ? 'light' : 'none' };
  // Above level 1 the conversation model writes the reply (blueprint §7.10): the screen sends his
  // message straight on, and that reply is the one rated, so the owner is alerted once.
  return isDisclosure(answer.wellbeingLevel) ? { ...out, sendNow: true } : out;
}
