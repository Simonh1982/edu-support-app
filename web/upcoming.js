// Learner page: "Coming up" (WP-109, WP-110; build spec §15–17, §6.1). The groups are worked out on the
// device each time the list is shown (shared/upcoming.js). The list comes from, freshest last: the copy
// saved on this device (own devices only), the Worker's snapshot, then the tutor itself. While the
// tutor wakes, a stage or deadline change goes into the edit queue (shared/offline.js), shows at once
// marked "Will save when the tutor's ready", and is sent in order once the tutor answers. Titles are
// only ever shown with textContent. This file never touches browser storage itself.
import { workerRequest } from "./shared/auth.js";
import { apiErrorMessage } from "./shared/api.js";
import {
  GROUPS,
  GROUP_LABELS,
  STAGES,
  STAGE_LABELS,
  UPCOMING_MESSAGES,
  fromSnapshot,
  fromTask,
  groupUpcoming,
  longDateText,
  movedOffMessage,
  ukToday,
  updateBody,
} from "./shared/upcoming.js";
import { OFFLINE_MESSAGES, droppedMessage, overlayEdits } from "./shared/offline.js";

function setText(element, text) {
  if (element.textContent !== text) element.textContent = text;
}

function make(doc, tag, { className, text, attrs } = {}) {
  const el = doc.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  for (const [key, value] of Object.entries(attrs ?? {})) el.setAttribute(key, value);
  return el;
}

const READY_STATES = new Set(["ready", "readyNoAi"]);
// A later source never gives way to an older one.
const RANK = Object.freeze({ cache: 1, snapshot: 2, live: 3 });

/**
 * Wires up the "Coming up" section. offline is the page's createOffline() (or null: no queue).
 * onList({ items, appName }) is called after each redraw with the entries as shown (queued changes
 * included) and the app's display name (undefined until known).
 * Returns { start(token), setTutor(state), refresh(), focusTask(taskId), stop() }, or null if the page
 * doesn't have the section.
 */
export function createUpcoming({ workerUrl, api, offline = null, onSignedOut, onList, doc = document, now = () => new Date() }) {
  const byId = (id) => doc.getElementById(id);
  const els = {
    heading: byId("upcoming-heading"),
    source: byId("upcoming-source"),
    status: byId("upcoming-status"),
    undo: byId("upcoming-undo"),
    groups: byId("upcoming-groups"),
  };
  if (Object.values(els).some((el) => !el)) return null;

  let token = null;
  let base = null; // entries from the latest source, before queued changes; null before anything loads
  let source = null; // "cache" | "snapshot" | "live"
  let appName; // undefined until the saved copy or the snapshot gives one
  let ready = false;
  let generation = 0; // bumped by start() and stop(); older replies are ignored
  let busy = false;
  let lastMoved = null; // { taskId, from } for Undo

  const canQueue = () => offline !== null && offline.active();
  const canEdit = () => ready || canQueue();
  const queued = () => (offline ? offline.edits() : []);
  const shown = () => overlayEdits(base ?? [], queued());

  function signedOut(reason) {
    stop();
    onSignedOut?.(reason);
  }

  function hideUndo() {
    lastMoved = null;
    els.undo.hidden = true;
  }

  /** Takes a new list unless a fresher one is already showing. */
  function accept(kind, list, name) {
    if (source && RANK[source] > RANK[kind]) return false;
    base = list;
    source = kind;
    if (name !== undefined) appName = name;
    return true;
  }

  // ---------- loading ----------
  async function loadCache() {
    const mine = generation;
    const saved = await offline?.loadView();
    if (mine !== generation || !saved || source) return;
    accept("cache", saved.items, saved.appName);
    render();
  }

  async function loadSnapshot() {
    const mine = generation;
    if (!token) return;
    const result = await workerRequest({ workerUrl, path: "snapshot", token });
    if (mine !== generation) return;
    if (result.kind === "auth") return signedOut(result.reason);
    if (result.kind === "ok") {
      const name = typeof result.body?.appName === "string" ? result.body.appName : null;
      if (!accept("snapshot", fromSnapshot(result.body), name)) return;
      render();
      offline?.saveView({ items: base, appName: name });
      return;
    }
    if (base === null) {
      setText(els.status, result.kind === "http" && result.status === 404 ? UPCOMING_MESSAGES.noSnapshot : UPCOMING_MESSAGES.failed);
    }
  }

  async function loadLive() {
    const mine = generation;
    const result = await api.openTasks();
    if (mine !== generation) return;
    if (result.kind === "auth") return signedOut(result.reason);
    if (result.kind !== "ok" || !Array.isArray(result.body?.tasks)) {
      setText(els.status, apiErrorMessage(result));
      return;
    }
    accept("live", result.body.tasks.map(fromTask).filter(Boolean));
    render();
    offline?.saveView({ items: base });
  }

  /** Once the tutor answers: send anything queued, in order, then show the tutor's own list. */
  async function sync() {
    const mine = generation;
    if (offline && offline.count() > 0) {
      setText(els.status, OFFLINE_MESSAGES.sending);
      const result = await offline.flush(api);
      if (mine !== generation) return;
      if (result.stop === "auth") return signedOut(result.reason);
      const notes = [];
      if (result.dropped > 0) notes.push(droppedMessage(result.dropped));
      if (result.stop === "later") notes.push(OFFLINE_MESSAGES.waiting);
      else if (result.sent > 0 && result.dropped === 0) notes.push(OFFLINE_MESSAGES.sent);
      setText(els.status, notes.join(" "));
    }
    await loadLive();
  }

  // ---------- drawing ----------
  function applyEditable() {
    const editable = canEdit();
    for (const el of els.groups.querySelectorAll(".task-edit select, .task-edit input, .task-edit button")) el.disabled = !editable;
    for (const el of els.groups.querySelectorAll(".task-edit .wait")) {
      el.hidden = ready;
      setText(el, editable ? OFFLINE_MESSAGES.changesWait : UPCOMING_MESSAGES.waitForTutor);
    }
    els.undo.disabled = !editable;
  }

  function editor(entry) {
    const details = make(doc, "details", { className: "more task-edit" });
    const summary = make(doc, "summary");
    summary.append(
      doc.createTextNode(entry.noDeadline ? "Add a deadline" : "Update"),
      make(doc, "span", { className: "visually-hidden", text: `: ${entry.title}` }),
    );
    const ids = { stage: `up-stage-${entry.taskId}`, deadline: `up-deadline-${entry.taskId}`, uk: `up-deadline-uk-${entry.taskId}` };
    const stage = make(doc, "select", { attrs: { id: ids.stage } });
    for (const value of STAGES) stage.append(make(doc, "option", { text: STAGE_LABELS[value], attrs: { value } }));
    stage.value = entry.stage;
    const deadline = make(doc, "input", { attrs: { id: ids.deadline, type: "date", "aria-describedby": ids.uk } });
    deadline.value = entry.deadline ?? "";
    const uk = make(doc, "p", { className: "hint", text: longDateText(entry.deadline), attrs: { id: ids.uk } });
    deadline.addEventListener("input", () => setText(uk, longDateText(deadline.value)));
    const wait = make(doc, "p", { className: "hint wait", text: UPCOMING_MESSAGES.waitForTutor });
    const error = make(doc, "p", { className: "error", attrs: { role: "alert" } });
    const save = make(doc, "button", { className: "primary", text: "Save", attrs: { type: "button" } });
    save.addEventListener("click", () => saveChange(entry, { stage, deadline, error }));
    const actions = make(doc, "div", { className: "actions" });
    actions.append(save);
    details.append(
      summary,
      make(doc, "label", { text: "Stage", attrs: { for: ids.stage } }),
      stage,
      make(doc, "label", { text: "Deadline", attrs: { for: ids.deadline } }),
      deadline,
      uk,
      wait,
      error,
      actions,
    );
    return details;
  }

  function taskItem(entry) {
    const item = make(doc, "li", { className: "task", attrs: { "data-task-id": entry.taskId } });
    if (entry.overdue) item.dataset.overdue = "true";
    if (entry.pending) item.dataset.pending = "true";
    const meta = make(doc, "p", { className: "task-meta" });
    // "Overdue" is written out, not shown by colour alone
    if (entry.overdue) meta.append(make(doc, "strong", { text: UPCOMING_MESSAGES.overdue }), doc.createTextNode(" · "));
    const parts = [entry.subject, entry.kind === "assessment" ? UPCOMING_MESSAGES.assessment : null, entry.due];
    meta.append(doc.createTextNode(parts.filter(Boolean).join(" · ")));
    item.append(make(doc, "p", { className: "task-title", text: entry.title, attrs: { tabindex: "-1" } }), meta);
    if (entry.queued) {
      // a typed task that isn't on the tutor yet: nothing to change until it is
      item.append(make(doc, "p", { className: "task-pending", text: OFFLINE_MESSAGES.pendingTask }));
      return item;
    }
    item.append(make(doc, "p", { className: "task-stage", text: `Stage: ${entry.stageLabel}` }));
    if (entry.pending) item.append(make(doc, "p", { className: "task-pending", text: OFFLINE_MESSAGES.pending }));
    item.append(editor(entry));
    return item;
  }

  function groupSection(name, list) {
    const id = `upcoming-group-${name}`;
    const section = make(doc, "section", { className: "upcoming-group", attrs: { "aria-labelledby": id } });
    section.append(make(doc, "h3", { text: list.length ? `${GROUP_LABELS[name]} (${list.length})` : GROUP_LABELS[name], attrs: { id } }));
    if (list.length === 0) {
      section.append(make(doc, "p", { className: "hint", text: UPCOMING_MESSAGES.emptyGroup[name] }));
    } else {
      const list_ = make(doc, "ul", { className: "tasks" });
      list_.append(...list.map(taskItem));
      section.append(list_);
    }
    return section;
  }

  /** Redraws from the current entries. keepOpen: reopen any task panels that were open. */
  function render({ focusTaskId = null, keepOpen = true } = {}) {
    if (base === null && queued().length === 0) return;
    const entries = shown();
    const open = keepOpen
      ? [...els.groups.querySelectorAll("li.task details[open]")].map((d) => d.closest("li")?.dataset.taskId)
      : [];
    if (els.status.textContent === UPCOMING_MESSAGES.loading) setText(els.status, "");
    const saved = source !== null && source !== "live";
    els.source.hidden = !saved;
    setText(els.source, saved ? (canQueue() ? OFFLINE_MESSAGES.savedList : UPCOMING_MESSAGES.saved) : "");
    const groups = groupUpcoming(entries, { today: ukToday(now()) });
    if (groups.count === 0) {
      els.groups.replaceChildren(make(doc, "p", { className: "hint", text: UPCOMING_MESSAGES.empty }));
    } else {
      els.groups.replaceChildren(...GROUPS.map((name) => groupSection(name, groups[name])));
    }
    for (const taskId of open) {
      const details = els.groups.querySelector(`li.task[data-task-id="${taskId}"] details`);
      if (details) details.open = true;
    }
    applyEditable();
    if (focusTaskId) focusTask(focusTaskId);
    onList?.({ items: entries, appName });
  }

  /** Moves focus to a task in the list (its Update button, else its title), or the heading. */
  function focusTask(taskId) {
    const item = els.groups.querySelector(`li.task[data-task-id="${taskId}"]`);
    (item?.querySelector("summary") ?? item?.querySelector(".task-title") ?? els.heading).focus();
  }

  // ---------- changes ----------
  function replaceItem(task) {
    const entry = fromTask(task);
    if (!entry) return null;
    base = [...(base ?? []).filter((i) => i.taskId !== entry.taskId), entry];
    return entry;
  }

  /** Sends a change now if the tutor is ready, otherwise queues it. */
  async function applyChange(taskId, body) {
    if (ready) {
      const result = await api.updateTask(taskId, body);
      if (result.kind === "auth") return { auth: result.reason };
      if (result.kind !== "ok" || !replaceItem(result.body?.task)) return { error: apiErrorMessage(result) };
      return { ok: true, queued: false };
    }
    const added = await offline.add({ type: "update", taskId, changes: body });
    return added.ok ? { ok: true, queued: true } : { error: added.error };
  }

  async function saveChange(entry, form) {
    if (busy || !canEdit()) return;
    const built = updateBody(entry, { stage: form.stage.value, deadline: form.deadline.value });
    if (built.error) {
      setText(form.error, built.error);
      form[built.field]?.focus();
      return;
    }
    setText(form.error, "");
    if (built.unchanged) {
      setText(els.status, UPCOMING_MESSAGES.nothingChanged);
      return;
    }
    const mine = generation;
    busy = true;
    setText(els.status, UPCOMING_MESSAGES.saving);
    const result = await applyChange(entry.taskId, built.body);
    busy = false;
    if (mine !== generation) return;
    if (result.auth !== undefined) return signedOut(result.auth);
    if (!result.ok) {
      setText(els.status, "");
      setText(form.error, result.error);
      return;
    }
    const after = result.queued ? ` ${OFFLINE_MESSAGES.changeQueued}` : "";
    hideUndo();
    if (built.leaves) {
      render({ keepOpen: false });
      lastMoved = { taskId: entry.taskId, from: entry.stage };
      els.undo.hidden = false;
      setText(els.status, `${movedOffMessage(entry.title, built.body.stage)}${after}`);
      els.heading.focus();
    } else {
      render({ focusTaskId: entry.taskId, keepOpen: false });
      setText(els.status, result.queued ? OFFLINE_MESSAGES.changeQueued : UPCOMING_MESSAGES.updated);
    }
  }

  els.undo.addEventListener("click", async () => {
    if (!lastMoved || busy || !canEdit()) return;
    const { taskId, from } = lastMoved;
    const mine = generation;
    busy = true;
    setText(els.status, UPCOMING_MESSAGES.saving);
    const result = await applyChange(taskId, { stage: from });
    busy = false;
    if (mine !== generation) return;
    if (result.auth !== undefined) return signedOut(result.auth);
    if (!result.ok) {
      setText(els.status, result.error);
      return;
    }
    hideUndo();
    render({ focusTaskId: taskId });
    setText(els.status, result.queued ? `${UPCOMING_MESSAGES.undone} ${OFFLINE_MESSAGES.changeQueued}` : UPCOMING_MESSAGES.undone);
  });

  // A page left open overnight works out "Today" again when it is looked at.
  doc.addEventListener("visibilitychange", () => {
    if (doc.visibilityState === "visible" && token) render();
  });

  // Queued changes show at once, and disappear from "waiting" as they are sent.
  offline?.onChange(() => {
    if (token) render();
  });

  // ---------- public ----------
  function start(newToken) {
    generation += 1;
    token = newToken ?? null;
    base = null;
    source = null;
    appName = undefined;
    busy = false;
    hideUndo();
    els.groups.replaceChildren();
    els.source.hidden = true;
    setText(els.status, UPCOMING_MESSAGES.loading);
    return Promise.all([loadCache(), ready ? sync() : loadSnapshot()]);
  }

  function setTutor(state) {
    const wasReady = ready;
    ready = READY_STATES.has(state);
    applyEditable();
    if (ready && !wasReady && token) return sync();
    if (token) render();
    return undefined;
  }

  /** Called after a task is added: the tutor's list if it's ready, otherwise the snapshot. */
  function refresh() {
    if (!token) return undefined;
    render();
    return ready ? loadLive() : loadSnapshot();
  }

  function stop() {
    generation += 1;
    token = null;
    base = null;
    source = null;
    appName = undefined;
    ready = false;
    busy = false;
    hideUndo();
    els.groups.replaceChildren();
    els.source.hidden = true;
    setText(els.source, "");
    setText(els.status, "");
  }

  return { start, setTutor, refresh, focusTask, stop };
}
