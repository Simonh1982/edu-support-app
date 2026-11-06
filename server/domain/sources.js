// Source records and AI summary cards (build spec §9.1, §26–§29; Appendix A.3).
// A Source record (sources/<id>.json) is made when the learner saves a card the tutor showed: the
// card is copied from the saved AI turn, so only cards the tutor really found can be saved. An AI
// summary is a notebook entry (notebook/<id>.json, the WP-103 record shape) written by 'ai', with
// the source attached. On a task, a summary passes the live check first (build spec §23.5); one
// that can't pass is never saved. Events hold ids, counts and code words only, never text.
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { newRecord, updateRecord } from '../storage/records.js';
import { ITEM_ID_PATTERN } from '../storage/items.js';
import { buildRequest, loadProfileSettings } from '../ai/prompt.js';
import {
  SUMMARY_CONTRACT, summaryInstruction, askSummary, summaryText, SOURCE_LIMITS,
} from '../ai/sources.js';
import { liveCheck, askChecker, STRICT_INSTRUCTION, CHECK_FEATURE } from '../ai/check.js';
import { CONVERSATION_MESSAGES } from '../ai/conversation.js';
import { DomainError, bad, plainObject, onlyKeys, recordId, wholeNumber } from './fields.js';
import { readTask, withTaskLock } from './tasks.js';
import { aiTurnPath, saveAiTurn } from './work.js';
import { taskForPrompt } from './conversations.js';

export const SUMMARY_FEATURE = 'source-summary';
export const MAX_SOURCE_FILES = 1000;

export const SOURCE_MESSAGES = Object.freeze({
  notFound: 'Source not found.',
  cardNotFound: "That source isn't available to save any more.",
  readOriginal: "This one's short and readable, so it's worth reading the original. Open the link and take a look.",
  unavailable: "I couldn't open that page just now. Some sites don't let the tutor read them, so open the link and read it yourself, or try again later.",
  subscription: "This one needs a subscription, so I can't read it. Ask {parents} if they can get you a copy.",
  video: "Videos can't be summarised. Watch it, and jot down the key points as you go.",
  tooClose: "I couldn't summarise this one without getting too close to your task. Have a look at the original: "
    + "it's yours to read and judge.",
});

const validId = (id) => typeof id === 'string' && ITEM_ID_PATTERN.test(id);
export const sourcePath = (id) => (validId(id) ? `sources/${id}.json` : null);
export const notebookPath = (id) => (validId(id) ? `notebook/${id}.json` : null);
const links = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== null && v !== undefined));

export async function readSource(store, id) {
  const p = sourcePath(id);
  return p ? store.read(p) : null;
}

/** Saved sources, newest first; only those for one task when taskId is given. */
export async function listSources(store, { taskId = null } = {}) {
  const wanted = recordId(taskId, 'taskId');
  let names = [];
  try {
    names = (await readdir(path.join(store.dir, 'sources'))).filter((n) => n.endsWith('.json'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const out = [];
  for (const name of names.sort().reverse().slice(0, MAX_SOURCE_FILES)) {
    const id = name.slice(0, -5);
    if (!validId(id)) continue;
    const source = await store.read(`sources/${name}`);
    if (!source || source.deletedAt) continue;
    if (wanted && source.taskId !== wanted) continue;
    out.push(source);
  }
  return out.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
}

/**
 * Save one card from a tutor reply as a Source record (Appendix A.3). Body: { turnId, index }.
 * Saving the same address again for the same task returns the saved record ({ duplicate: true }).
 */
export async function saveSource(store, body, ctx = {}) {
  plainObject(body, 'source');
  onlyKeys(body, ['turnId', 'index'], 'source');
  const turnId = recordId(body.turnId, 'turnId', { required: true });
  const index = wholeNumber(body.index, 'index', { max: SOURCE_LIMITS.cards - 1 });
  if (index === null) throw bad('index is required');
  const p = aiTurnPath(turnId);
  const turn = p ? await store.read(p) : null;
  const card = Array.isArray(turn?.sources) ? turn.sources[index] : null;
  if (!turn || !card?.url) throw new DomainError(404, SOURCE_MESSAGES.cardNotFound);
  const taskId = turn.taskId ?? null;
  return withTaskLock('sources', async () => {
    const existing = (await listSources(store)).find((s) => s.url === card.url && (s.taskId ?? null) === taskId);
    if (existing) return { source: existing, duplicate: true };
    const source = newRecord('src', {
      url: card.url,
      title: card.title,
      publisher: card.publisher ?? null,
      publishedDate: null,
      category: card.category,
      why: card.why,
      selected: true,
      evaluation: null,
      taskId,
      topicIds: turn.topicId ? [turn.topicId] : [],
      fromTurnId: turn.id,
      summaryId: null,
    }, { createdBy: 'learner', now: ctx.now ?? new Date() });
    await store.put(sourcePath(source.id), source);
    await store.logEvent('source.saved', {
      createdBy: 'learner',
      links: links({ sourceId: source.id, taskId, turnId: turn.id }),
      payload: { category: source.category },
    });
    return { source, duplicate: false };
  });
}

function requireAi(getAi) {
  const handle = getAi?.() ?? null;
  if (!handle?.ai || !handle.models?.conversation) throw new DomainError(503, CONVERSATION_MESSAGES.notReady);
  return handle;
}

/**
 * An AI summary of a saved source (build spec §28). Outcomes:
 *  - 'saved': a notebook entry (type 'summary', text by 'ai', source attached) → 201
 *  - 'read-original': short and readable, so he reads it himself; nothing saved
 *  - 'unavailable': the page couldn't be opened; nothing saved
 *  - 'subscription': the page is behind a paywall or login (A-009); nothing saved
 * Videos are never summarised (A-009): there is no page text to read (409).
 *  - 'too-close': on a task, the summary failed the live check twice; nothing saved
 * One AI turn per model call (no text: the summary lives in the notebook entry). Not rated for
 * wellbeing and not counted in the per-task tally: it teaches the source, it isn't a tutor reply.
 */
export async function summariseSource(store, id, ctx = {}) {
  const source = await readSource(store, id);
  if (!source || source.deletedAt) throw new DomainError(404, SOURCE_MESSAGES.notFound);
  if (source.category === 'video') throw new DomainError(409, SOURCE_MESSAGES.video);
  const handle = requireAi(ctx.getAi);
  const log = ctx.log ?? console;
  const now = ctx.now ?? new Date();
  const task = source.taskId ? await readTask(store, source.taskId) : null;
  const settings = await loadProfileSettings({ storageDir: store.dir });
  const topicId = Array.isArray(source.topicIds) ? source.topicIds[0] ?? null : null;
  const ask = async (extra = '') => {
    const { system, prompt } = await buildRequest({
      route: 'research',
      settings,
      task: taskForPrompt(task),
      instruction: [summaryInstruction(source), extra].filter(Boolean).join('\n'),
      contract: SUMMARY_CONTRACT,
    });
    return askSummary({
      ai: handle.ai, model: handle.models.conversation, system, prompt, ceiling: ctx.aiCeiling, log,
      failedMessage: CONVERSATION_MESSAGES.failed,
    });
  };
  const turnFor = (call, checkResult = null) => saveAiTurn(store, {
    feature: SUMMARY_FEATURE, role: 'conversation', model: call.model, taskId: source.taskId ?? null, topicId,
    latencyMs: call.ms, success: call.success !== false, checkResult,
  }, { now });

  const first = await ask();
  let chosen = first;
  let checkResult = null;
  const calls = [first];
  const checks = [];
  if (first.result.kind === 'summary' && task) {
    let second = null;
    const checked = await liveCheck({
      answer: { reply: summaryText(first.result), taskSpecific: false, model: first.model, ms: first.ms },
      route: 'research',
      check: (reply) => askChecker({
        ai: handle.ai, model: handle.models?.checker, task: taskForPrompt(task), reply, ceiling: ctx.aiCeiling, log,
      }),
      regenerate: async () => {
        second = await ask(STRICT_INSTRUCTION);
        calls.push(second);
        if (second.result.kind !== 'summary') throw Object.assign(new Error('no summary'), { status: 502 });
        return { reply: summaryText(second.result), taskSpecific: false, model: second.model, ms: second.ms };
      },
      log,
    });
    checkResult = checked.checkResult;
    checks.push(...checked.checks);
    if (checkResult === 'regenerated') chosen = second;
  }

  // one AI turn for the summary, as for a checked tutor reply: a failed draft is never kept
  // success false when the page couldn't be opened, so the owner can count those turns (WP-114d)
  await turnFor({
    model: chosen.model, ms: calls.reduce((n, c) => n + (c.ms ?? 0), 0), success: chosen.result.kind !== 'unavailable',
  }, checkResult);
  for (const c of checks) {
    if (!c.model) continue;
    await saveAiTurn(store, {
      feature: CHECK_FEATURE, role: 'checker', model: c.model, taskId: source.taskId ?? null, topicId,
      latencyMs: c.ms, success: c.leak !== null,
    }, { now });
  }

  const kind = chosen.result.kind;
  const outcome = checkResult === 'fallback' ? 'too-close' : (kind === 'summary' ? 'saved' : kind);
  const event = (extra = {}) => store.logEvent('source.summary', {
    createdBy: 'learner',
    links: links({ sourceId: source.id, taskId: source.taskId ?? null, ...extra }),
    payload: links({ outcome, checkResult }),
  });
  if (outcome !== 'saved') {
    await event();
    const message = {
      'read-original': SOURCE_MESSAGES.readOriginal,
      unavailable: SOURCE_MESSAGES.unavailable,
      subscription: SOURCE_MESSAGES.subscription.replaceAll('{parents}', settings.labels.parents),
      'too-close': SOURCE_MESSAGES.tooClose,
    }[outcome];
    return { outcome, message, entry: null, checkResult };
  }

  const r = chosen.result;
  const entry = newRecord('note', {
    type: 'summary',
    title: source.title,
    text: { value: r.summary, author: 'ai' },
    section: r.section ? { value: r.section, author: 'ai' } : null,
    taskId: source.taskId ?? null,
    topicIds: Array.isArray(source.topicIds) ? source.topicIds : [],
    source: { title: source.title, author: source.publisher ?? null, url: source.url },
    sourceId: source.id,
    sharedWithParent: null,
  }, { createdBy: 'ai', now });
  await store.put(notebookPath(entry.id), entry);
  await store.put(sourcePath(source.id), updateRecord(source, { summaryId: entry.id }, { now }));
  await event({ notebookId: entry.id });
  return { outcome: 'saved', message: null, entry, checkResult };
}
