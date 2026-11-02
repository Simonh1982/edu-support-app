// The saved view and the edit queue (WP-110; build spec §6.1; blueprint §10.2–10.3). On the
// learner's own devices both are kept in IndexedDB (web/device-store.js), so the home screen can show
// the last list at once and changes made while the tutor wakes survive a reload. On a shared computer
// the page passes a memory store instead and the saved view is never written, so nothing is left in
// the browser. The store is any { get, set, delete, clear } object with async methods.
// No DOM-only or Node-only APIs.
//
// The saved view holds the "Coming up" list fields only (title, subject, deadline, stage, kind) and
// the app's display name: never question text, notes, feedback or drafts.
import { STAGES, upcomingItem, validDate } from "./upcoming.js";

export const OFFLINE_DB = "edu-support.learner";
export const OFFLINE_KEYS = Object.freeze({ view: "view", queue: "queue" });
export const QUEUE_LIMIT = 50;
export const VIEW_LIMIT = 50;
export const ADD_MAX_CHARS = 16_000;

const EDIT_ID_PATTERN = /^e[a-z0-9]{6,40}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const TITLE_MAX = 120;
const APP_NAME_MAX = 60;
const ADD_KEYS = Object.freeze(["title", "deadline", "questionText", "anchors"]);
// Answers that can never succeed if sent again (a bad change, or a task that has gone).
const DROP_STATUSES = new Set([400, 403, 404, 409, 413]);

export const OFFLINE_MESSAGES = Object.freeze({
  pending: "Will save when the tutor's ready.",
  pendingTask: "Will be added when the tutor's ready.",
  changesWait: "Changes save when the tutor's ready.",
  savedList: "This is your saved list. Changes you make now will save when the tutor's ready.",
  changeQueued: "Saved on this device. It'll save when the tutor's ready.",
  taskQueued: "Saved on this device. It'll be added when the tutor's ready.",
  queueFull: "There are a lot of changes waiting. Please wait for the tutor, then try again.",
  notStarted: "Please wait a moment, then try again.",
  badEdit: "That change couldn't be saved. Please try again.",
  sending: "Saving your changes…",
  sent: "Your changes are saved.",
  waiting: "Some changes are still waiting. They'll save next time the tutor's ready.",
  sharedNote: "On a shared computer, they're lost if you close this tab first.",
});

/** The line shown while changes wait, or "" when none do. */
export function queueNote(count, { shared = false } = {}) {
  if (!Number.isInteger(count) || count < 1) return "";
  const main = count === 1 ? "1 change will save when the tutor's ready." : `${count} changes will save when the tutor's ready.`;
  return shared ? `${main} ${OFFLINE_MESSAGES.sharedNote}` : main;
}

export function droppedMessage(count) {
  return count === 1
    ? "1 change couldn't be saved, because the task had changed or been removed. Please check your list."
    : `${count} changes couldn't be saved, because the tasks had changed or been removed. Please check your list.`;
}

/** The sign-out dialog's text when changes are still waiting. */
export function signOutMessage(count) {
  return count === 1
    ? "1 change hasn't been saved yet. If you sign out now, it will be lost."
    : `${count} changes haven't been saved yet. If you sign out now, they will be lost.`;
}

/** A store that lives only as long as the page (shared computers, and tests). */
export function memoryKeyValue() {
  const map = new Map();
  return {
    get: async (key) => (map.has(key) ? structuredClone(map.get(key)) : undefined),
    set: async (key, value) => void map.set(key, structuredClone(value)),
    delete: async (key) => void map.delete(key),
    clear: async () => void map.clear(),
  };
}

/** A saved view, checked: list fields only, at most VIEW_LIMIT entries. Null if unusable. */
export function cleanView(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const items = Array.isArray(raw.items) ? raw.items.slice(0, VIEW_LIMIT).map(upcomingItem).filter(Boolean) : [];
  const name = typeof raw.appName === "string" ? raw.appName.replace(/\s+/g, " ").trim() : "";
  return {
    items,
    appName: name === "" ? null : name.slice(0, APP_NAME_MAX),
    savedAt: typeof raw.savedAt === "number" && Number.isFinite(raw.savedAt) ? raw.savedAt : null,
  };
}

/** A device-made id for a queued edit, e.g. "emh3k2a1b4c9". */
export function newEditId(nowMs = Date.now(), random = Math.random) {
  const tail = Math.floor(random() * 36 ** 6).toString(36).padStart(6, "0");
  return `e${Math.max(0, Math.floor(nowMs)).toString(36)}${tail}`;
}

function cleanChanges(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out = {};
  if (Object.hasOwn(raw, "stage")) {
    if (!STAGES.includes(raw.stage)) return null;
    out.stage = raw.stage;
  }
  if (Object.hasOwn(raw, "deadline")) {
    if (raw.deadline !== null && validDate(raw.deadline) !== raw.deadline) return null;
    out.deadline = raw.deadline;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function cleanAddBody(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (typeof raw.title !== "string" || raw.title.trim() === "" || raw.title.length > TITLE_MAX) return null;
  if (raw.deadline !== undefined && raw.deadline !== null && validDate(raw.deadline) !== raw.deadline) return null;
  const body = {};
  for (const key of ADD_KEYS) if (Object.hasOwn(raw, key)) body[key] = raw[key];
  let text;
  try {
    text = JSON.stringify(body);
  } catch {
    return null;
  }
  return text.length <= ADD_MAX_CHARS ? JSON.parse(text) : null;
}

/**
 * One queued edit, checked (also used for edits read back from the device):
 * { id, at, type: "update", taskId, changes: { stage?, deadline? } } or
 * { id, at, type: "add", body } (the typed-task body). Null if unusable.
 */
export function cleanEdit(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.id !== "string" || !EDIT_ID_PATTERN.test(raw.id)) return null;
  if (typeof raw.at !== "number" || !Number.isFinite(raw.at)) return null;
  if (raw.type === "update") {
    if (typeof raw.taskId !== "string" || !ID_PATTERN.test(raw.taskId)) return null;
    const changes = cleanChanges(raw.changes);
    return changes ? { id: raw.id, at: raw.at, type: "update", taskId: raw.taskId, changes } : null;
  }
  if (raw.type === "add") {
    const body = cleanAddBody(raw.body);
    return body ? { id: raw.id, at: raw.at, type: "add", body } : null;
  }
  return null;
}

/**
 * The queue with one more edit. A change to a task that already has a queued change is merged into
 * it (later values win), so the queue stays short; skipId is an edit being sent, never merged into.
 */
export function mergeEdit(edits, edit, { skipId = null } = {}) {
  const list = Array.isArray(edits) ? edits : [];
  if (edit.type === "update") {
    const index = list.findIndex((e) => e.type === "update" && e.taskId === edit.taskId && e.id !== skipId);
    if (index >= 0) {
      const merged = { ...list[index], at: edit.at, changes: { ...list[index].changes, ...edit.changes } };
      return list.map((e, i) => (i === index ? merged : e));
    }
  }
  return [...list, edit];
}

/**
 * The list with queued edits shown on top: changed tasks carry pending: true, and typed tasks not yet
 * added appear with queued: true (their taskId is the edit's id).
 */
export function overlayEdits(items, edits) {
  const list = (Array.isArray(items) ? items : []).map((item) => ({ ...item }));
  for (const edit of Array.isArray(edits) ? edits : []) {
    if (edit.type === "update") {
      const item = list.find((i) => i.taskId === edit.taskId);
      if (item) Object.assign(item, edit.changes, { pending: true });
    } else if (edit.type === "add") {
      const entry = upcomingItem({ taskId: edit.id, title: edit.body.title, deadline: edit.body.deadline ?? null, stage: "not-started" });
      if (entry) list.push({ ...entry, pending: true, queued: true });
    }
  }
  return list;
}

/** What to do with a queued edit after sending it: "sent", "dropped", "auth" or "later". */
export function editOutcome(result) {
  if (result?.kind === "ok") return "sent";
  if (result?.kind === "auth") return "auth";
  if (result?.kind === "http" && DROP_STATUSES.has(result.status)) return "dropped";
  return "later";
}

/**
 * The page's saved view and edit queue. start({ store, shared }) at sign-in; stop() drops what is
 * in memory (the store keeps its copy); clear() empties the store too (sign-out).
 */
export function createOffline({ now = () => Date.now(), random = Math.random, log = console } = {}) {
  let store = null;
  let shared = false;
  let edits = [];
  let view = null;
  let generation = 0;
  let loading = Promise.resolve();
  let flushing = null;
  let inFlight = null;
  const listeners = new Set();

  function notify() {
    for (const fn of listeners) {
      try {
        fn(edits.length);
      } catch (err) {
        log.error?.("[offline] listener failed:", err?.name ?? "Error");
      }
    }
  }

  // Device storage can fail (private browsing, a full disk). Log the error's name only, never data.
  async function safely(action, fallback) {
    try {
      return await action();
    } catch (err) {
      log.error?.("[offline] device storage failed:", err?.name ?? "Error");
      return fallback;
    }
  }

  async function persist(mine) {
    if (store && mine === generation) await safely(() => store.set(OFFLINE_KEYS.queue, edits), undefined);
  }

  function start({ store: newStore = null, shared: isShared = false } = {}) {
    generation += 1;
    const mine = generation;
    store = newStore;
    shared = isShared === true;
    edits = [];
    view = null;
    inFlight = null;
    notify();
    loading = (async () => {
      if (!store) return;
      const raw = await safely(() => store.get(OFFLINE_KEYS.queue), undefined);
      if (mine !== generation) return;
      edits = Array.isArray(raw) ? raw.map(cleanEdit).filter(Boolean).slice(0, QUEUE_LIMIT) : [];
      if (edits.length > 0) notify();
    })();
    return loading;
  }

  function stop() {
    generation += 1;
    store = null;
    edits = [];
    view = null;
    inFlight = null;
    notify();
  }

  async function clear() {
    const old = store;
    stop();
    if (old) await safely(() => old.clear(), undefined);
  }

  /** Queues { type: "update", taskId, changes } or { type: "add", body }. */
  async function add(input) {
    await loading;
    if (!store) return { error: OFFLINE_MESSAGES.notStarted };
    const at = now();
    const edit = cleanEdit({ ...input, id: newEditId(at, random), at });
    if (!edit) return { error: OFFLINE_MESSAGES.badEdit };
    const next = mergeEdit(edits, edit, { skipId: inFlight });
    if (next.length > QUEUE_LIMIT) return { error: OFFLINE_MESSAGES.queueFull };
    edits = next;
    notify();
    await persist(generation);
    return { ok: true, edit };
  }

  /**
   * Sends the queue in order through api.updateTask / api.addTask (shared/api.js). Stops at the
   * first edit that can't be sent yet, leaving it and the rest queued.
   * @returns {Promise<{ sent, dropped, stop: null | "auth" | "later", reason? }>}
   */
  function flush(api) {
    if (flushing) return flushing;
    const mine = generation;
    flushing = (async () => {
      await loading;
      const out = { sent: 0, dropped: 0, stop: null };
      while (edits.length > 0 && mine === generation) {
        const [edit] = edits;
        inFlight = edit.id;
        let result;
        try {
          result = edit.type === "add" ? await api.addTask(edit.body) : await api.updateTask(edit.taskId, edit.changes);
        } catch (err) {
          log.error?.("[offline] sending failed:", err?.name ?? "Error");
          result = { kind: "network" };
        }
        inFlight = null;
        if (mine !== generation) break;
        const outcome = editOutcome(result);
        if (outcome === "auth") {
          out.stop = "auth";
          out.reason = result.reason;
          break;
        }
        if (outcome === "later") {
          out.stop = "later";
          break;
        }
        out[outcome] += 1;
        edits = edits.filter((e) => e.id !== edit.id);
        notify();
        await persist(mine);
      }
      return out;
    })().finally(() => {
      flushing = null;
      inFlight = null;
    });
    return flushing;
  }

  /** The saved view, on own devices only. */
  async function loadView() {
    if (!store || shared) return null;
    const mine = generation;
    const raw = await safely(() => store.get(OFFLINE_KEYS.view), undefined);
    if (mine !== generation) return null;
    view = cleanView(raw);
    return view;
  }

  /** Saves the list as the server gave it (never with queued edits). appName undefined keeps the old one. */
  async function saveView({ items, appName } = {}) {
    if (!store || shared) return;
    const mine = generation;
    const next = cleanView({ items, appName: appName === undefined ? view?.appName ?? null : appName, savedAt: now() });
    view = next;
    if (mine === generation) await safely(() => store.set(OFFLINE_KEYS.view, next), undefined);
  }

  return {
    start,
    stop,
    clear,
    add,
    flush,
    loadView,
    saveView,
    edits: () => edits.slice(),
    count: () => edits.length,
    active: () => store !== null,
    isShared: () => shared,
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
