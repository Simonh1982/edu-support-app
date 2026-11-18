// WP-115a: the research notebook (build spec §29). Entries are notes (his words), quotes (a source's
// words with their citation) and summaries (AI, made by server/domain/sources.js). Every entry's text
// says who wrote it. AI text can be pinned to a task but never inserted into his notes; a quote can
// be inserted with its citation, and the note records which quotes it holds. Records follow the
// WP-103 contract: { id, type, title, text: { value, author }, taskId?, topicIds?, source?, … }.
// Events hold counts and IDs only, never text.
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { newRecord, updateRecord } from '../storage/records.js';
import { ITEM_ID_PATTERN } from '../storage/items.js';
import {
  DomainError, bad, notFound, plainObject, onlyKeys, shortString, textField, recordId, topicIds, flag,
} from './fields.js';
import { readTask, listTasks, withTaskLock } from './tasks.js';
import { readSource } from './sources.js';

export const NOTEBOOK_TYPES = Object.freeze(['note', 'quote', 'summary']);
export const NOTEBOOK_LIMITS = Object.freeze({
  title: 120, note: 10_000, quote: 2_000, page: 20, quotesPerNote: 50, topics: 5, pins: 20,
  search: 100, list: 200, files: 2_000, excerpt: 240, earlier: 5,
});
export const NOTEBOOK_MESSAGES = Object.freeze({
  notFound: 'Notebook entry not found.',
  notYours: 'Only your own notes can be changed.',
  noSource: 'Save the source first, then add a quote from it.',
  quoteMissing: 'That quote is no longer in your notebook.',
  quoteNotInNote: 'Put each quote you insert into the note, with its citation.',
});

const lock = 'notebook';
export const notebookEntryPath = (id) => (typeof id === 'string' && ITEM_ID_PATTERN.test(id) ? `notebook/${id}.json` : null);

export async function readEntry(store, id) {
  const p = notebookEntryPath(id);
  const entry = p ? await store.read(p) : null;
  return entry && !entry.deletedAt ? entry : null;
}

/** "(A. Author, “Title”, p. 12)": how a quote is cited when it goes into his note. */
export function citation(source = {}, page = null) {
  const parts = [];
  if (source.author) parts.push(source.author);
  if (source.title) parts.push(`“${source.title}”`);
  if (page) parts.push(`p. ${page}`);
  return parts.length ? `(${parts.join(', ')})` : '(source not named)';
}

/** The text that goes into a note when a quote is inserted: the passage in quotation marks, then its citation. */
export const quoteForNote = (entry) => `“${entry?.text?.value ?? ''}” ${entry?.citation ?? citation(entry?.source, entry?.page)}`;

/** The list view of an entry: no full text, just a short excerpt for the search results. */
export function entryView(entry) {
  const text = typeof entry?.text?.value === 'string' ? entry.text.value : '';
  return {
    id: entry.id,
    type: entry.type,
    title: entry.title ?? null,
    author: entry.text?.author ?? null,
    excerpt: text.length > NOTEBOOK_LIMITS.excerpt ? `${text.slice(0, NOTEBOOK_LIMITS.excerpt).trimEnd()}…` : text,
    taskId: entry.taskId ?? null,
    topicIds: Array.isArray(entry.topicIds) ? entry.topicIds : [],
    source: entry.source ?? null,
    sourceId: entry.sourceId ?? null,
    citation: entry.citation ?? null,
    quoteIds: Array.isArray(entry.quoteIds) ? entry.quoteIds : [],
    pinnedTo: Array.isArray(entry.pinnedTo) ? entry.pinnedTo : [],
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

async function allEntries(store) {
  let names = [];
  try {
    names = (await readdir(path.join(store.dir, 'notebook'))).filter((n) => n.endsWith('.json'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const out = [];
  for (const name of names.sort().reverse().slice(0, NOTEBOOK_LIMITS.files)) {
    const entry = await readEntry(store, name.slice(0, -5));
    if (entry && NOTEBOOK_TYPES.includes(entry.type)) out.push(entry);
  }
  return out;
}

/**
 * WP-115c: an entry's topics are its own and its task's current ones, so research saved before its
 * task had topics (or before they were matched) is still found by topic.
 */
async function topicsLookup(store) {
  const byTask = new Map((await listTasks(store)).map((t) => [t.id, Array.isArray(t.topicIds) ? t.topicIds : []]));
  return (entry) => new Set([...(entry.topicIds ?? []), ...(byTask.get(entry.taskId) ?? [])]);
}

const newest = (a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? ''));
const fold = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');

/**
 * The notebook, newest first, as list views. query: taskId (entries for that task or pinned to it),
 * topicId, subject (the subject of the entry's task), type, q (words searched in titles, text and
 * source titles; every word must match).
 */
export async function listNotebook(store, query = {}) {
  const taskId = recordId(query.taskId, 'taskId');
  const topic = shortString(query.topicId, 'topicId', { max: 80 });
  const subject = shortString(query.subject, 'subject', { max: 80 });
  const type = shortString(query.type, 'type', { max: 20 });
  if (type && !NOTEBOOK_TYPES.includes(type)) throw bad(`type must be one of ${NOTEBOOK_TYPES.join(', ')}`);
  const q = shortString(query.q, 'q', { max: NOTEBOOK_LIMITS.search });
  const words = q ? fold(q).split(' ').filter(Boolean) : [];
  const subjects = subject ? new Map((await listTasks(store)).map((t) => [t.id, fold(t.subject)])) : null;
  const topicsOf = topic ? await topicsLookup(store) : null;
  const out = [];
  for (const entry of await allEntries(store)) {
    if (taskId && entry.taskId !== taskId && !(entry.pinnedTo ?? []).includes(taskId)) continue;
    if (topic && !topicsOf(entry).has(topic)) continue;
    if (type && entry.type !== type) continue;
    if (subjects && subjects.get(entry.taskId) !== fold(subject)) continue;
    if (words.length) {
      const hay = fold([entry.title, entry.text?.value, entry.source?.title, entry.source?.author].filter(Boolean).join(' '));
      if (!words.every((w) => hay.includes(w))) continue;
    }
    out.push(entryView(entry));
  }
  return out.sort(newest).slice(0, NOTEBOOK_LIMITS.list);
}

/** The task's topics, or the ones given; the task gives the topics when none are given. */
async function topicsFor(store, body, task, curriculum) {
  const given = topicIds(body.topicIds, 'topicIds', curriculum, { max: NOTEBOOK_LIMITS.topics });
  if (given.length) return given;
  return Array.isArray(task?.topicIds) ? task.topicIds.slice(0, NOTEBOOK_LIMITS.topics) : [];
}

/** Every inserted quote must exist, be a quote, and appear in the note with its citation. */
async function checkQuotes(store, ids, text) {
  if (ids === undefined || ids === null) return [];
  if (!Array.isArray(ids) || ids.length > NOTEBOOK_LIMITS.quotesPerNote) throw bad('quoteIds must be a short list');
  const out = [];
  for (const id of [...new Set(ids)]) {
    recordId(id, 'quoteIds', { required: true });
    const quote = await readEntry(store, id);
    if (!quote || quote.type !== 'quote') throw bad(NOTEBOOK_MESSAGES.quoteMissing);
    if (!(text ?? '').includes(quote.text.value)) throw bad(NOTEBOOK_MESSAGES.quoteNotInNote);
    out.push(id);
  }
  return out;
}

async function taskFor(store, taskId) {
  if (!taskId) return null;
  const task = await readTask(store, taskId);
  if (!task) throw notFound('Task');
  return task;
}

/** A note in his own words. body: { title?, text, taskId?, topicIds?, quoteIds? }. */
export async function createNote(store, body, { curriculum = null, now = new Date() } = {}) {
  plainObject(body, 'note');
  onlyKeys(body, ['title', 'text', 'taskId', 'topicIds', 'quoteIds'], 'note');
  const text = textField(body.text, 'text', { max: NOTEBOOK_LIMITS.note, authors: ['learner'], defaultAuthor: 'learner', required: true });
  const title = shortString(body.title, 'title', { max: NOTEBOOK_LIMITS.title });
  const taskId = recordId(body.taskId, 'taskId');
  const task = await taskFor(store, taskId);
  const entry = newRecord('note', {
    type: 'note',
    title,
    text,
    taskId,
    topicIds: await topicsFor(store, body, task, curriculum),
    quoteIds: await checkQuotes(store, body.quoteIds, text.value),
    pinnedTo: [],
    sharedWithParent: null,
  }, { createdBy: 'learner', now });
  await store.put(notebookEntryPath(entry.id), entry);
  await store.logEvent('notebook.created', {
    createdBy: 'learner',
    links: links({ notebookId: entry.id, taskId }),
    payload: { type: 'note', quotes: entry.quoteIds.length },
  });
  return entry;
}

/** Changes one of his notes. body: any of { title, text, taskId, topicIds, quoteIds }. */
export async function updateNote(store, id, body, { curriculum = null, now = new Date() } = {}) {
  plainObject(body, 'note');
  onlyKeys(body, ['title', 'text', 'taskId', 'topicIds', 'quoteIds'], 'note');
  return withTaskLock(lock, async () => {
    const entry = await readEntry(store, id);
    if (!entry) throw new DomainError(404, NOTEBOOK_MESSAGES.notFound);
    if (entry.type !== 'note' || entry.text?.author !== 'learner') throw new DomainError(409, NOTEBOOK_MESSAGES.notYours);
    const changes = {};
    if ('title' in body) changes.title = shortString(body.title, 'title', { max: NOTEBOOK_LIMITS.title });
    if ('text' in body) changes.text = textField(body.text, 'text', { max: NOTEBOOK_LIMITS.note, authors: ['learner'], defaultAuthor: 'learner', required: true });
    if ('taskId' in body) changes.taskId = recordId(body.taskId, 'taskId');
    const task = await taskFor(store, changes.taskId ?? entry.taskId);
    if ('topicIds' in body || 'taskId' in body) changes.topicIds = await topicsFor(store, body, task, curriculum);
    const text = (changes.text ?? entry.text).value;
    changes.quoteIds = await checkQuotes(store, 'quoteIds' in body ? body.quoteIds : entry.quoteIds, text);
    const next = updateRecord(entry, changes, { now });
    await store.put(notebookEntryPath(next.id), next);
    await store.logEvent('notebook.updated', {
      createdBy: 'learner', links: links({ notebookId: next.id, taskId: next.taskId }), payload: { type: 'note' },
    });
    return next;
  });
}

/**
 * A quote from one of his saved sources: the passage he copied (the source's words) and its citation.
 * body: { sourceId, text, page? }. The task and topics come from the source.
 */
export async function createQuote(store, body, { now = new Date() } = {}) {
  plainObject(body, 'quote');
  onlyKeys(body, ['sourceId', 'text', 'page'], 'quote');
  const sourceId = recordId(body.sourceId, 'sourceId', { required: true });
  const source = await readSource(store, sourceId);
  if (!source || source.deletedAt) throw new DomainError(404, NOTEBOOK_MESSAGES.noSource);
  const text = textField(body.text, 'text', { max: NOTEBOOK_LIMITS.quote, authors: ['source'], defaultAuthor: 'source', required: true });
  const page = shortString(body.page, 'page', { max: NOTEBOOK_LIMITS.page });
  const cited = { title: source.title ?? null, author: source.publisher ?? null, url: source.url ?? null };
  const entry = newRecord('note', {
    type: 'quote',
    title: source.title ? `Quote: ${source.title}`.slice(0, NOTEBOOK_LIMITS.title) : 'Quote',
    text,
    page,
    citation: citation(cited, page),
    taskId: source.taskId ?? null,
    topicIds: Array.isArray(source.topicIds) ? source.topicIds.slice(0, NOTEBOOK_LIMITS.topics) : [],
    source: cited,
    sourceId,
    pinnedTo: [],
    sharedWithParent: null,
  }, { createdBy: 'learner', now });
  await store.put(notebookEntryPath(entry.id), entry);
  await store.logEvent('notebook.created', {
    createdBy: 'learner', links: links({ notebookId: entry.id, taskId: entry.taskId, sourceId }), payload: { type: 'quote' },
  });
  return entry;
}

/**
 * Pins any entry to a task, or unpins it (AI text is pin-only, §29). body: { taskId, pinned }.
 * Pinning an entry to its own task is allowed, and changes nothing about where it belongs.
 */
export async function pinEntry(store, id, body, { now = new Date() } = {}) {
  plainObject(body, 'pin');
  onlyKeys(body, ['taskId', 'pinned'], 'pin');
  const taskId = recordId(body.taskId, 'taskId', { required: true });
  const pinned = flag(body.pinned, 'pinned', true);
  await taskFor(store, taskId);
  return withTaskLock(lock, async () => {
    const entry = await readEntry(store, id);
    if (!entry) throw new DomainError(404, NOTEBOOK_MESSAGES.notFound);
    const was = Array.isArray(entry.pinnedTo) ? entry.pinnedTo : [];
    const pinnedTo = pinned ? [...new Set([...was, taskId])].slice(-NOTEBOOK_LIMITS.pins) : was.filter((t) => t !== taskId);
    if (pinnedTo.length === was.length && pinnedTo.every((t, i) => t === was[i])) return entry;
    const next = updateRecord(entry, { pinnedTo }, { now });
    await store.put(notebookEntryPath(next.id), next);
    await store.logEvent(pinned ? 'notebook.pinned' : 'notebook.unpinned', {
      createdBy: 'learner', links: links({ notebookId: next.id, taskId }), payload: { type: next.type },
    });
    return next;
  });
}

/**
 * Surfacing earlier research (§29): entries on this task's topics that belong to another task (or to
 * none) and aren't pinned here yet, newest first. The screen asks "Would you like to use those notes?"
 * and pins the ones he picks.
 */
export async function earlierResearch(store, taskId, { limit = NOTEBOOK_LIMITS.earlier } = {}) {
  const id = recordId(taskId, 'taskId', { required: true });
  const task = await taskFor(store, id);
  const topics = new Set(Array.isArray(task.topicIds) ? task.topicIds : []);
  if (!topics.size) return { entries: [], count: 0, since: null };
  const topicsOf = await topicsLookup(store);
  const found = (await allEntries(store))
    .filter((e) => e.taskId !== id && !(e.pinnedTo ?? []).includes(id))
    .filter((e) => [...topicsOf(e)].some((t) => topics.has(t)))
    .sort(newest);
  return {
    entries: found.slice(0, limit).map(entryView),
    count: found.length,
    since: found.length ? found[found.length - 1].createdAt ?? null : null,
  };
}

const links = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== null && v !== undefined));
