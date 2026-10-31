// The app's own read-only tools for the model (blueprint §7.5; build spec §25, §29, §32.3):
// read_curriculum(topicId) and read_notebook(taskId?, topicId?). Each is a plain definition for
// ai.ask({ customTools }), which checks it with checkCustomTools and wraps the handler.
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { topicExtract, TOPIC_ID_PATTERN, stringList } from '../curriculum.js';

export const READ_CURRICULUM = 'read_curriculum';
export const READ_NOTEBOOK = 'read_notebook';
export const NOTEBOOK_DIR = 'notebook';
export const MAX_NOTEBOOK_ENTRIES = 20;
export const MAX_NOTEBOOK_FILES = 500;
export const MAX_ENTRY_TEXT = 2000;
export const TEXT_AUTHORS = Object.freeze(['learner', 'ai', 'source']);
// same shape as item IDs (server/storage/items.js ITEM_ID_PATTERN)
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

export function readCurriculumTool({ getCurriculum }) {
  return {
    name: READ_CURRICULUM,
    description: 'Look up one curriculum topic by its topic ID: the specification outline, its unit, the related assessment objectives and command words. Read-only.',
    parameters: {
      type: 'object',
      properties: { topicId: { type: 'string', description: 'The topic ID, for example from the task details.' } },
      required: ['topicId'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const topicId = typeof args?.topicId === 'string' ? args.topicId.trim() : '';
      if (!TOPIC_ID_PATTERN.test(topicId)) return { error: 'Not a valid topic ID.' };
      const curriculum = getCurriculum();
      if (!curriculum) return { error: "The curriculum isn't loaded yet." };
      return topicExtract(curriculum, topicId) ?? { error: 'No topic with that ID.' };
    },
  };
}

/**
 * One notebook record as the model sees it. Expected record shape (WP-115 follows it):
 * { id, type, title, text: { value, author } | text + author, taskId?, topicIds?, source?, updatedAt }.
 * Returns null for records that can't be used or are deleted.
 */
export function notebookEntryForModel(raw) {
  if (!isObject(raw) || !ID_PATTERN.test(String(raw.id ?? '')) || raw.deletedAt) return null;
  const textField = isObject(raw.text) ? raw.text : { value: raw.text, author: raw.author };
  let value = typeof textField.value === 'string' ? textField.value : (typeof textField.text === 'string' ? textField.text : '');
  if (value.length > MAX_ENTRY_TEXT) value = `${value.slice(0, MAX_ENTRY_TEXT - 1)}…`;
  const source = isObject(raw.source)
    ? { title: str(raw.source.title), author: str(raw.source.author ?? raw.source.publisher), url: str(raw.source.url) }
    : null;
  return {
    id: raw.id,
    type: str(raw.type) ?? 'note',
    title: str(raw.title),
    text: { value, author: TEXT_AUTHORS.includes(textField.author) ? textField.author : 'unknown' },
    source,
    taskId: str(raw.taskId),
    topicIds: [...new Set([...stringList(raw.topicIds), ...stringList(raw.topicId)])],
    updatedAt: str(raw.updatedAt) ?? str(raw.createdAt),
  };
}

/** Read and convert every notebook record in the storage clone (newest file names first). */
export async function readNotebookEntries(storageDir) {
  const dir = path.join(storageDir, NOTEBOOK_DIR);
  let names;
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const entries = [];
  for (const name of names.sort().reverse().slice(0, MAX_NOTEBOOK_FILES)) {
    try {
      const entry = notebookEntryForModel(JSON.parse(await readFile(path.join(dir, name), 'utf8')));
      if (entry) entries.push(entry);
    } catch {
      // an unreadable record is skipped; its text is never logged
    }
  }
  return entries;
}

/**
 * Pick the entries a request may see. The scope is set by the server for this request, never by
 * the model: { taskId?, topicIds? }. Entries linked to another task are never returned (§32.3).
 * Entries with no task are returned when they share a topic in scope (earlier research, §29).
 * The model's taskId / topicId can only narrow the scope.
 */
export function selectNotebookEntries(entries, scope = {}, args = {}) {
  const scopeTask = str(scope.taskId);
  const scopeTopics = new Set(stringList(scope.topicIds));
  const wantTask = str(args.taskId);
  const wantTopic = str(args.topicId);
  if (wantTask && wantTask !== scopeTask) return { entries: [], note: 'Only notes for the current task can be read.' };
  if (wantTopic && !scopeTopics.has(wantTopic)) return { entries: [], note: 'Only notes on the current topics can be read.' };
  const topics = wantTopic ? new Set([wantTopic]) : scopeTopics;
  const picked = entries.filter((e) => {
    if (e.taskId && e.taskId !== scopeTask) return false;
    if (wantTask) return e.taskId === scopeTask && (!wantTopic || e.topicIds.includes(wantTopic));
    if (scopeTask && e.taskId === scopeTask && !wantTopic) return true;
    return e.topicIds.some((t) => topics.has(t));
  });
  picked.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
  return { entries: picked.slice(0, MAX_NOTEBOOK_ENTRIES), more: Math.max(0, picked.length - MAX_NOTEBOOK_ENTRIES) };
}

export function readNotebookTool({ getStorageDir, scope = {}, readEntries = readNotebookEntries }) {
  return {
    name: READ_NOTEBOOK,
    description: "Read the learner's saved notebook entries for the current task or its topics. Each entry says who wrote it (learner, ai or source). Read-only.",
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Optional: only entries for the current task.' },
        topicId: { type: 'string', description: 'Optional: only entries on this topic.' },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const dir = getStorageDir();
      if (!dir) return { error: "The notebook isn't available yet." };
      return selectNotebookEntries(await readEntries(dir), scope, args || {});
    },
  };
}

/** Both read tools for one request. scope: { taskId?, topicIds? }, set by the route. */
export function createReadTools({ getCurriculum, getStorageDir, scope = {} }) {
  return [readCurriculumTool({ getCurriculum }), readNotebookTool({ getStorageDir, scope })];
}
