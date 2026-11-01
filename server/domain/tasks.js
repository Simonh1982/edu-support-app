// Task and anchor records (build spec Appendix A.3; blueprint §2.2: tasks/<taskId>/task.json,
// anchors inside it). Events record facts only (ids, field names, stages), never text.
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { newRecord, updateRecord, ukIso } from '../storage/records.js';
import { ITEM_ID_PATTERN } from '../storage/items.js';
import {
  bad, notFound, plainObject, onlyKeys, shortString, textField, oneOf, ukDate, wholeNumber, flag,
  recordId, topicIds, qualificationId,
} from './fields.js';

export const TASK_KINDS = Object.freeze(['assignment', 'homework', 'assessment']);
export const WORK_TYPES = Object.freeze(['essay', 'worksheet', 'project', 'production', 'other']);
export const STAGES = Object.freeze(['not-started', 'researching', 'planning', 'drafting', 'reviewing', 'submitted', 'done']);
export const FINISHED_STAGES = Object.freeze(['submitted', 'done']);
export const ANCHOR_TYPES = Object.freeze(['question', 'location', 'text', 'track', 'thesis']);
export const ANCHOR_AUTHORS = Object.freeze(['learner', 'source']);
export const TASK_LIMITS = Object.freeze({
  title: 120, subject: 40, questionText: 4000, anchorText: 1000, anchors: 20, topics: 20, marks: 1000, wordCount: 100000,
});
export const TASK_FIELDS = Object.freeze([
  'title', 'subject', 'qualificationId', 'topicIds', 'kind', 'workType', 'questionText', 'deadline', 'stage',
  'marks', 'wordCount', 'confirmed',
]);

export const taskPath = (id) => `tasks/${id}/task.json`;

// The fields present in body, checked. For a new task, title is required.
function taskFields(body, { curriculum, partial }) {
  const has = (key) => !partial || Object.hasOwn(body, key);
  const L = TASK_LIMITS;
  const out = {};
  if (has('title')) out.title = shortString(body.title, 'title', { max: L.title, required: true });
  if (has('subject')) out.subject = shortString(body.subject, 'subject', { max: L.subject });
  if (has('qualificationId')) out.qualificationId = qualificationId(body.qualificationId, 'qualificationId', curriculum);
  if (has('topicIds')) out.topicIds = topicIds(body.topicIds, 'topicIds', curriculum, { max: L.topics });
  if (has('kind')) out.kind = oneOf(body.kind, 'kind', TASK_KINDS);
  if (has('workType')) out.workType = oneOf(body.workType, 'workType', WORK_TYPES);
  if (has('questionText')) {
    out.questionText = textField(body.questionText, 'questionText', {
      max: L.questionText, authors: ANCHOR_AUTHORS, defaultAuthor: 'learner',
    });
  }
  if (has('deadline')) out.deadline = ukDate(body.deadline, 'deadline');
  if (has('stage')) out.stage = oneOf(body.stage, 'stage', STAGES, { required: partial }) ?? 'not-started';
  if (has('marks')) out.marks = wholeNumber(body.marks, 'marks', { max: L.marks });
  if (has('wordCount')) out.wordCount = wholeNumber(body.wordCount, 'wordCount', { max: L.wordCount });
  if (has('confirmed')) out.confirmed = flag(body.confirmed, 'confirmed', false);
  return out;
}

/** A new anchor. Anchors the learner writes are his own words, so they count as confirmed. */
export function newAnchor(body, { createdBy = 'learner', now = new Date() } = {}) {
  plainObject(body, 'anchor');
  onlyKeys(body, ['type', 'text', 'confirmed'], 'anchor');
  const type = oneOf(body.type, 'anchor type', ANCHOR_TYPES, { required: true });
  const text = textField(body.text, 'anchor text', {
    max: TASK_LIMITS.anchorText, authors: ANCHOR_AUTHORS, defaultAuthor: 'learner', required: true,
  });
  const confirmed = flag(body.confirmed, 'confirmed', text.author === 'learner');
  return newRecord('anc', { type, text, confirmed }, { createdBy, now });
}

/** A new Task record. createdBy is 'learner' for typed tasks and 'ai' for tasks read from a brief. */
export function newTask(body, { curriculum = null, createdBy = 'learner', now = new Date() } = {}) {
  plainObject(body, 'task');
  onlyKeys(body, [...TASK_FIELDS, 'anchors'], 'task');
  const f = taskFields(body, { curriculum, partial: false });
  const anchorsIn = body.anchors ?? [];
  if (!Array.isArray(anchorsIn)) throw bad('anchors must be a list');
  if (anchorsIn.length > TASK_LIMITS.anchors) throw bad(`a task has at most ${TASK_LIMITS.anchors} anchors`);
  const anchors = anchorsIn.map((a) => newAnchor(a, { createdBy, now }));
  return newRecord('t', {
    ...f,
    anchors,
    sourceUploads: [],
    // the retention clock starts the first time the task is submitted or done (build spec §32.2)
    completedAt: FINISHED_STAGES.includes(f.stage) ? ukIso(now) : null,
  }, { createdBy, now });
}

/** Apply a partial update. Returns { task, changed: [field names], stage: { from, to } | null }. */
export function applyTaskChanges(task, body, { curriculum = null, now = new Date() } = {}) {
  plainObject(body, 'changes');
  onlyKeys(body, TASK_FIELDS, 'changes');
  const f = taskFields(body, { curriculum, partial: true });
  const changed = Object.keys(f).filter((key) => JSON.stringify(f[key]) !== JSON.stringify(task[key] ?? null));
  if (changed.length === 0) return { task, changed, stage: null };
  const changes = Object.fromEntries(changed.map((key) => [key, f[key]]));
  if (changed.includes('stage') && FINISHED_STAGES.includes(f.stage) && !task.completedAt) changes.completedAt = ukIso(now);
  const stage = changed.includes('stage') ? { from: task.stage ?? null, to: f.stage } : null;
  return { task: updateRecord(task, changes, { now }), changed, stage };
}

// One read-modify-write at a time per task, so two quick edits can't overwrite each other.
const taskLocks = new Map();
export function withTaskLock(id, fn) {
  const run = (taskLocks.get(id) ?? Promise.resolve()).then(() => fn());
  const tail = run.catch(() => {});
  taskLocks.set(id, tail);
  tail.then(() => { if (taskLocks.get(id) === tail) taskLocks.delete(id); });
  return run;
}

export async function readTask(store, id) {
  if (!recordId(id, 'task id')) return null;
  return store.read(taskPath(id));
}

/** All tasks, soonest deadline first (no deadline last). open: leave out submitted and done. */
export async function listTasks(store, { open = false } = {}) {
  let entries = [];
  try {
    entries = await readdir(path.join(store.dir, 'tasks'), { withFileTypes: true });
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const tasks = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !ITEM_ID_PATTERN.test(entry.name)) continue;
    const task = await store.read(taskPath(entry.name));
    if (task && !(open && FINISHED_STAGES.includes(task.stage))) tasks.push(task);
  }
  return tasks.sort((a, b) => (a.deadline ?? '9999').localeCompare(b.deadline ?? '9999')
    || String(a.createdAt).localeCompare(String(b.createdAt)));
}

export async function createTask(store, body, { curriculum = null, createdBy = 'learner', now = new Date() } = {}) {
  const task = newTask(body, { curriculum, createdBy, now });
  await store.put(taskPath(task.id), task);
  await store.logEvent('task.created', {
    createdBy,
    links: { taskId: task.id },
    payload: { kind: task.kind, stage: task.stage, anchors: task.anchors.length, topics: task.topicIds.length },
  });
  return task;
}

export async function updateTask(store, id, body, { curriculum = null, createdBy = 'learner', now = new Date() } = {}) {
  return withTaskLock(id, async () => {
    const current = await readTask(store, id);
    if (!current) throw notFound('Task');
    const { task, changed, stage } = applyTaskChanges(current, body, { curriculum, now });
    if (changed.length === 0) return task;
    await store.put(taskPath(id), task);
    await store.logEvent('task.updated', { createdBy, links: { taskId: id }, payload: { fields: changed } });
    if (stage) await store.logEvent('task.stage', { createdBy, links: { taskId: id }, payload: stage });
    return task;
  });
}

// Shared by the three anchor operations: read, change, save, log.
async function changeAnchors(store, taskId, eventType, change, { createdBy, now }) {
  return withTaskLock(taskId, async () => {
    const current = await readTask(store, taskId);
    if (!current) throw notFound('Task');
    const { anchors, anchor } = change(Array.isArray(current.anchors) ? current.anchors : []);
    const task = updateRecord(current, { anchors }, { now });
    await store.put(taskPath(taskId), task);
    await store.logEvent(eventType, {
      createdBy,
      links: { taskId, anchorId: anchor.id },
      payload: { type: anchor.type, confirmed: anchor.confirmed === true },
    });
    return { task, anchor };
  });
}

export function addAnchor(store, taskId, body, { createdBy = 'learner', now = new Date() } = {}) {
  return changeAnchors(store, taskId, 'anchor.added', (anchors) => {
    if (anchors.length >= TASK_LIMITS.anchors) throw bad(`a task has at most ${TASK_LIMITS.anchors} anchors`);
    const anchor = newAnchor(body, { createdBy, now });
    return { anchors: [...anchors, anchor], anchor };
  }, { createdBy, now });
}

export function updateAnchor(store, taskId, anchorId, body, { createdBy = 'learner', now = new Date() } = {}) {
  return changeAnchors(store, taskId, 'anchor.updated', (anchors) => {
    plainObject(body, 'anchor');
    onlyKeys(body, ['text', 'confirmed'], 'anchor');
    const index = anchors.findIndex((a) => a.id === anchorId);
    if (index < 0) throw notFound('Anchor');
    const old = anchors[index];
    const changes = {};
    if (Object.hasOwn(body, 'text')) {
      changes.text = textField(body.text, 'anchor text', {
        max: TASK_LIMITS.anchorText, authors: ANCHOR_AUTHORS, defaultAuthor: 'learner', required: true,
      });
    }
    if (Object.hasOwn(body, 'confirmed')) changes.confirmed = flag(body.confirmed, 'confirmed', old.confirmed);
    const anchor = updateRecord(old, changes, { now });
    return { anchors: anchors.map((a, i) => (i === index ? anchor : a)), anchor };
  }, { createdBy, now });
}

export function removeAnchor(store, taskId, anchorId, { createdBy = 'learner', now = new Date() } = {}) {
  return changeAnchors(store, taskId, 'anchor.removed', (anchors) => {
    const anchor = anchors.find((a) => a.id === anchorId);
    if (!anchor) throw notFound('Anchor');
    return { anchors: anchors.filter((a) => a.id !== anchorId), anchor };
  }, { createdBy, now });
}
