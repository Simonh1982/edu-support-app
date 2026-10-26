// Builds index/snapshot.json: a small contents page the Worker serves while the Codespace sleeps
// (blueprint §4.3). It is built from a fixed list of fields, so note, feedback, draft, plan and
// question text can never reach it. Titles come only from a record's own title field (or the
// task's title), never from its text; anything without one gets a plain label.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { ukIso } from './records.js';
import { canReadItem } from '../auth.js';
import { ITEM_ID_PATTERN } from './items.js';

export const UPCOMING_LIMIT = 20;
export const RECENT_LIMIT = 10;
export const SHARED_LIMIT = 20;
const TITLE_MAX = 80;
const APP_NAME_MAX = 60;
const SETTING_MAX = 40;
const DONE_STAGES = new Set(['submitted', 'done']);
const LABELS = Object.freeze({ notebook: 'Note', plan: 'Plan', draft: 'Draft', feedback: 'Feedback' });
const UPLOAD_STATUSES = new Set(['inbox', 'processing', 'done', 'failed']);
const RECORD_FIELDS = new Set(['id', 'createdAt', 'updatedAt', 'createdBy', 'schemaVersion']);

function cleanText(value, max) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  return text === '' ? null : text.slice(0, max);
}

// Dates and times are kept only if they look like ISO dates, so no free text slips through.
function cleanDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}([T ][0-9:.+\-Z]{0,20})?$/.test(value) ? value : null;
}

// Settings are set choices (build spec Appendix A.1): short strings, numbers and true/false only.
function plainSettings(value) {
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [key, setting] of Object.entries(value)) {
    if (RECORD_FIELDS.has(key) || !/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(key)) continue;
    if (typeof setting === 'number' && Number.isFinite(setting)) out[key] = setting;
    else if (typeof setting === 'boolean') out[key] = setting;
    else if (typeof setting === 'string' && setting.length <= SETTING_MAX) out[key] = setting;
  }
  return out;
}

async function readJson(dir, relPath) {
  try {
    return JSON.parse(await readFile(path.join(dir, relPath), 'utf8'));
  } catch {
    return null; // missing or unreadable files are left out, never fatal
  }
}

async function names(dir, relPath, { folders = false } = {}) {
  try {
    const entries = await readdir(path.join(dir, relPath), { withFileTypes: true });
    return entries.filter((e) => (folders ? e.isDirectory() : e.isFile())).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

async function jsonIds(dir, relPath) {
  return (await names(dir, relPath))
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .filter((id) => ITEM_ID_PATTERN.test(id));
}

function itemTitle(type, record, taskTitle) {
  const own = cleanText(record?.title, TITLE_MAX);
  if (own) return own;
  return taskTitle ? `${LABELS[type]}: ${taskTitle}`.slice(0, TITLE_MAX) : LABELS[type];
}

function byNewest(field) {
  return (a, b) => String(b[field] ?? '').localeCompare(String(a[field] ?? ''));
}

/** Every item the snapshot may list: notebook entries, and each task's plan, drafts and feedback. */
async function collect(dir) {
  const tasks = [];
  const items = [];
  for (const id of await jsonIds(dir, 'notebook')) {
    const record = await readJson(dir, `notebook/${id}.json`);
    if (record) items.push({ type: 'notebook', id, record, title: itemTitle('notebook', record, null) });
  }
  // Uploads get a plain label only: their extracted text never reaches the snapshot.
  for (const id of await jsonIds(dir, 'uploads')) {
    const record = await readJson(dir, `uploads/${id}.json`);
    if (record) items.push({ type: 'upload', id, record, title: record.origin === 'photo' ? 'Photo' : 'File' });
  }
  const taskIds = (await names(dir, 'tasks', { folders: true })).filter((id) => ITEM_ID_PATTERN.test(id));
  for (const taskId of taskIds) {
    const task = await readJson(dir, `tasks/${taskId}/task.json`);
    const taskTitle = cleanText(task?.title, TITLE_MAX);
    if (task) tasks.push({ taskId, task, title: taskTitle ?? 'Task' });
    const plan = await readJson(dir, `tasks/${taskId}/plan.json`);
    if (plan) items.push({ type: 'plan', id: 'plan', task: taskId, record: plan, title: itemTitle('plan', plan, taskTitle) });
    for (const id of await jsonIds(dir, `tasks/${taskId}/drafts`)) {
      const record = await readJson(dir, `tasks/${taskId}/drafts/${id}.json`);
      if (record) items.push({ type: 'draft', id, task: taskId, record, title: itemTitle('draft', record, taskTitle) });
    }
    for (const id of await jsonIds(dir, `tasks/${taskId}/feedback`)) {
      const record = await readJson(dir, `tasks/${taskId}/feedback/${id}.json`);
      if (record) items.push({ type: 'feedback', id, task: taskId, record, title: itemTitle('feedback', record, taskTitle) });
    }
  }
  return { tasks, items };
}

function itemRef(item, extra) {
  return { type: item.type, id: item.id, ...(item.task ? { task: item.task } : {}), title: item.title, ...extra };
}

/**
 * Build the snapshot from the local clone. Never throws for missing folders or bad files.
 * Plan status and the next session are calculated in later phases, so they are null for now.
 */
export async function buildSnapshot({ dir, now = new Date() }) {
  const { tasks, items } = await collect(dir);
  const app = await readJson(dir, 'profile/app.json');
  const appName = cleanText(app?.displayName ?? app?.name, APP_NAME_MAX);
  const accessibility = plainSettings(await readJson(dir, 'profile/accessibility.json'));
  const presentation = plainSettings((await readJson(dir, 'profile/learner.json'))?.presentation);
  const inboxPending = (await names(dir, 'inbox')).filter((name) => name.endsWith('.json')).length;

  const upcoming = tasks
    .filter(({ task }) => !DONE_STAGES.has(task.stage))
    .map(({ taskId, task, title }) => ({
      taskId,
      title,
      subject: cleanText(task.subject, SETTING_MAX),
      deadline: cleanDate(task.deadline),
      stage: cleanText(task.stage, 20),
      kind: cleanText(task.kind, 20),
    }))
    .sort((a, b) => (a.deadline ?? '9999').localeCompare(b.deadline ?? '9999'))
    .slice(0, UPCOMING_LIMIT);

  const recent = items
    .filter((item) => ['notebook', 'feedback', 'upload'].includes(item.type))
    .map((item) => itemRef(item, {
      updatedAt: cleanDate(item.record.updatedAt),
      ...(item.type === 'upload' ? { status: UPLOAD_STATUSES.has(item.record.status) ? item.record.status : null } : {}),
    }))
    .sort(byNewest('updatedAt'))
    .slice(0, RECENT_LIMIT);

  // The same rule the Worker and the server use to open items, so the list never offers more.
  const shared = items
    .filter((item) => canReadItem('parent', item.type, item.record))
    .map((item) => itemRef(item, { sharedAt: cleanDate(item.record.sharedWithParent) }))
    .sort(byNewest('sharedAt'))
    .slice(0, SHARED_LIMIT);

  return {
    generatedAt: ukIso(now),
    learner: {
      appName,
      upcoming,
      planStatus: null,
      nextSession: null,
      settings: { accessibility, presentation },
      recent,
      inboxPending,
    },
    parent: {
      appName,
      upcoming: upcoming.map(({ title, subject, deadline }) => ({ title, subject, deadline })),
      planStatus: null,
      shared,
    },
  };
}
