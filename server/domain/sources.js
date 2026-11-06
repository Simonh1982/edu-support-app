// Source records and AI summary cards (build spec §9.1, §26–§29; Appendix A.3).
// A Source record (sources/<id>.json) is made when the learner saves a card the tutor showed: the
// card is copied from the saved AI turn, so only cards the tutor really found can be saved. An AI
// summary is a notebook entry (notebook/<id>.json, the WP-103 record shape) written by 'ai', with
// the source attached. On a task, a summary passes the live check first (build spec §23.5); one
// that can't pass is never saved. Events hold ids, counts and code words only, never text.
// WP-114f (A-010): a source can carry copies he attached (uploadIds; server/domain/attachments.js).
// A summary then reads the copy instead of the page, with no web tools.
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { newRecord, updateRecord } from '../storage/records.js';
import { ITEM_ID_PATTERN } from '../storage/items.js';
import { buildRequest, loadProfileSettings } from '../ai/prompt.js';
import {
  SUMMARY_CONTRACT, summaryInstruction, askSummary, summaryText, SOURCE_LIMITS,
  pastedSummaryInstruction, fileSummaryInstruction, PASTED_SOURCE_MAX_CHARS, cleanUrl,
} from '../ai/sources.js';
import { liveCheck, askChecker, STRICT_INSTRUCTION, CHECK_FEATURE } from '../ai/check.js';
import { CONVERSATION_MESSAGES } from '../ai/conversation.js';
import { DomainError, bad, notFound, plainObject, onlyKeys, recordId, wholeNumber, shortString } from './fields.js';
import { readTask, withTaskLock } from './tasks.js';
import { aiTurnPath, saveAiTurn } from './work.js';
import { taskForPrompt } from './conversations.js';
import { ATTACH_MESSAGES, ATTACHED_SOURCE_MAX_CHARS, attachmentIds, attachmentText, mergeUploadIds } from './attachments.js';

export const SUMMARY_FEATURE = 'source-summary';
export const MAX_SOURCE_FILES = 1000;
// A-010: sources he found himself (a book, a PDF, a page the tutor couldn't open).
export const OWN_SOURCE_LIMITS = Object.freeze({ title: 200, author: 120 });

export const SOURCE_MESSAGES = Object.freeze({
  notFound: 'Source not found.',
  cardNotFound: "That source isn't available to save any more.",
  readOriginal: "This one's short and readable, so it's worth reading the original. Open the link and take a look.",
  unavailable: "I couldn't open that page just now. Some sites don't let the tutor read them. Open the link and read it yourself, or copy the part you need and paste it below.",
  subscription: "This one needs a subscription, so I can't read it. Ask {parents} if they can get you a copy, then paste the part you need below.",
  video: "Videos can't be summarised. Watch it, and jot down the key points as you go.",
  tooClose: "I couldn't summarise this one without getting too close to your task. Have a look at the original: "
    + "it's yours to read and judge.",
  // A-010: paste to summarise, and sources he adds himself
  noLink: "This source has no link, so paste the part you'd like summarised, or attach a copy.",
  pasteEmpty: 'Paste some text from the source first.',
  pasteTooLong: `That's more than ${PASTED_SOURCE_MAX_CHARS.toLocaleString('en-GB')} characters. Paste the part you need most.`,
  pasteUnclear: "I couldn't make sense of that text. Check you copied the right part, then paste it again.",
  badLink: 'The link must be a web address, such as https://example.org/page.',
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

/** Adds upload IDs to a source (WP-114f). Call inside withTaskLock('sources'). Event: counts only. */
async function addUploads(store, source, added, ctx = {}) {
  const before = Array.isArray(source.uploadIds) ? source.uploadIds : [];
  const uploadIds = mergeUploadIds(before, added);
  if (uploadIds.length === before.length) return source;
  const updated = updateRecord(source, { uploadIds }, { now: ctx.now ?? new Date() });
  await store.put(sourcePath(source.id), updated);
  await store.logEvent('source.attached', {
    createdBy: 'learner',
    links: links({ sourceId: source.id, taskId: source.taskId ?? null }),
    payload: { files: uploadIds.length - before.length },
  });
  return updated;
}

/**
 * A source he found himself (A-010): a title, and an author and a link if he has them. Body:
 * { title, author?, url?, taskId?, attachments? }. The same link on the same task returns the saved
 * record. attachments (WP-114f): the capture IDs of copies the page sends to the Worker inbox.
 */
export async function addOwnSource(store, body, ctx = {}) {
  plainObject(body, 'source');
  onlyKeys(body, ['title', 'author', 'url', 'taskId', 'attachments'], 'source');
  const title = shortString(body.title, 'title', { max: OWN_SOURCE_LIMITS.title, required: true });
  const author = shortString(body.author, 'author', { max: OWN_SOURCE_LIMITS.author });
  const given = typeof body.url === 'string' ? body.url.trim() : body.url;
  let url = null;
  if (given !== undefined && given !== null && given !== '') {
    url = cleanUrl(given);
    if (!url) throw bad(SOURCE_MESSAGES.badLink);
  }
  const taskId = recordId(body.taskId, 'taskId');
  const uploadIds = attachmentIds(body.attachments);
  const task = taskId ? await readTask(store, taskId) : null;
  if (taskId && !task) throw notFound('Task');
  return withTaskLock('sources', async () => {
    if (url) {
      const existing = (await listSources(store)).find((s) => s.url === url && (s.taskId ?? null) === taskId);
      if (existing) return { source: uploadIds.length ? await addUploads(store, existing, uploadIds, ctx) : existing, duplicate: true };
    }
    const source = newRecord('src', {
      url,
      title,
      publisher: author,
      publishedDate: null,
      category: 'other',
      why: null,
      selected: true,
      evaluation: null,
      taskId,
      topicIds: Array.isArray(task?.topicIds) ? task.topicIds : [],
      fromTurnId: null,
      summaryId: null,
      uploadIds,
      origin: 'learner',
    }, { createdBy: 'learner', now: ctx.now ?? new Date() });
    await store.put(sourcePath(source.id), source);
    await store.logEvent('source.added', {
      createdBy: 'learner',
      links: links({ sourceId: source.id, taskId }),
      payload: { origin: 'learner', link: Boolean(url), ...(uploadIds.length ? { files: uploadIds.length } : {}) },
    });
    return { source, duplicate: false };
  });
}

/**
 * Attach copies to a saved source (A-010 choice 3B; WP-114f). Body: { attachments: [clientId] }: the
 * capture IDs the page sends to the Worker inbox with kind 'source'. At most five copies per source.
 */
export async function attachToSource(store, id, body, ctx = {}) {
  plainObject(body, 'attachments');
  onlyKeys(body, ['attachments'], 'attachments');
  const added = attachmentIds(body.attachments);
  if (!added.length) throw bad(ATTACH_MESSAGES.badList);
  return withTaskLock('sources', async () => {
    const source = await readSource(store, id);
    if (!source || source.deletedAt) throw new DomainError(404, SOURCE_MESSAGES.notFound);
    if (source.category === 'video') throw new DomainError(409, SOURCE_MESSAGES.video);
    return { source: await addUploads(store, source, added, ctx) };
  });
}

/** Pasted text for a summary (A-010): trimmed, and within the limit. Never stored or logged. */
function pastedText(body) {
  const b = body ?? {};
  plainObject(b, 'summary');
  onlyKeys(b, ['text'], 'summary');
  if (b.text === undefined) return null;
  const text = typeof b.text === 'string' ? b.text.trim() : '';
  if (!text) throw bad(SOURCE_MESSAGES.pasteEmpty);
  if (text.length > PASTED_SOURCE_MAX_CHARS) throw bad(SOURCE_MESSAGES.pasteTooLong);
  return text;
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
 *  - 'unclear' (A-010): pasted text or an attached copy the model couldn't read as a source; nothing saved
 * One AI turn per model call (no text: the summary lives in the notebook entry). Not rated for
 * wellbeing and not counted in the per-task tally: it teaches the source, it isn't a tutor reply.
 * body: {} to fetch the page, or { text } with text he pasted from the source (A-010). Pasted text
 * goes to the model once and is never stored or logged; only the summary is kept.
 * WP-114f: with body {}, a source with attached copies is summarised from their text (409 while a copy
 * is still being read, or when none could be read), with no web tools.
 */
export async function summariseSource(store, id, ctx = {}, body = {}) {
  const source = await readSource(store, id);
  if (!source || source.deletedAt) throw new DomainError(404, SOURCE_MESSAGES.notFound);
  if (source.category === 'video') throw new DomainError(409, SOURCE_MESSAGES.video);
  const pasted = pastedText(body);
  // a copy he attached is read instead of the page, which may refuse the tutor
  const files = pasted ? { state: 'none' } : await attachmentText(store, source);
  if (files.state === 'waiting') throw new DomainError(409, ATTACH_MESSAGES.waiting);
  if (files.state === 'failed') throw new DomainError(409, ATTACH_MESSAGES.failed);
  const fileText = files.state === 'ready' ? files.text : null;
  if (!pasted && !fileText && !source.url) throw new DomainError(409, SOURCE_MESSAGES.noLink);
  const handle = requireAi(ctx.getAi);
  const log = ctx.log ?? console;
  const now = ctx.now ?? new Date();
  const task = source.taskId ? await readTask(store, source.taskId) : null;
  const settings = await loadProfileSettings({ storageDir: store.dir });
  const topicId = Array.isArray(source.topicIds) ? source.topicIds[0] ?? null : null;
  const instructionFor = () => {
    if (pasted) return pastedSummaryInstruction(source);
    if (fileText) return fileSummaryInstruction(source, { shortened: files.shortened === true });
    return summaryInstruction(source);
  };
  const ask = async (extra = '') => {
    const { system, prompt } = await buildRequest({
      route: 'research',
      settings,
      task: taskForPrompt(task),
      sourceText: pasted ?? fileText ?? undefined,
      sourceLimit: fileText ? ATTACHED_SOURCE_MAX_CHARS : undefined,
      instruction: [instructionFor(), extra].filter(Boolean).join('\n'),
      contract: SUMMARY_CONTRACT,
    });
    return askSummary({
      ai: handle.ai, model: handle.models.conversation, system, prompt, ceiling: ctx.aiCeiling, log,
      failedMessage: CONVERSATION_MESSAGES.failed, pasted: Boolean(pasted || fileText), method: fileText ? 'file' : 'paste',
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

  // pasted text or a copy can't be "unavailable" or behind a paywall: the model couldn't read it as a source
  const given = Boolean(pasted || fileText);
  const kind = given && ['unavailable', 'subscription'].includes(chosen.result.kind) ? 'unclear' : chosen.result.kind;
  const outcome = checkResult === 'fallback' ? 'too-close' : (kind === 'summary' ? 'saved' : kind);
  const event = (extra = {}) => store.logEvent('source.summary', {
    createdBy: 'learner',
    links: links({ sourceId: source.id, taskId: source.taskId ?? null, ...extra }),
    payload: links({ outcome, checkResult, method: pasted ? 'paste' : fileText ? 'file' : null }),
  });
  if (outcome !== 'saved') {
    await event();
    const message = {
      'read-original': SOURCE_MESSAGES.readOriginal,
      unavailable: SOURCE_MESSAGES.unavailable,
      subscription: SOURCE_MESSAGES.subscription.replaceAll('{parents}', settings.labels.parents),
      'too-close': SOURCE_MESSAGES.tooClose,
      unclear: fileText ? ATTACH_MESSAGES.unclear : SOURCE_MESSAGES.pasteUnclear,
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
