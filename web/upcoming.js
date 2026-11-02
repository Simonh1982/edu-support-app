// Learner page: "Coming up" (WP-109; build spec §15–17, §6.1). The groups are worked out on the device
// each time the list is shown (shared/upcoming.js). Until the tutor answers, the list comes from the
// Worker's snapshot and can't be changed; once it answers, the list comes from the tutor, and each
// task's stage and deadline can be changed. Titles are only ever shown with textContent. Nothing is
// kept in browser storage.
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

/**
 * Wires up the "Coming up" section. Returns { start(token), setTutor(state), refresh(), stop() },
 * or null if the page doesn't have it.
 */
export function createUpcoming({ workerUrl, api, onSignedOut, doc = document, now = () => new Date() }) {
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
  let items = null; // list entries, or null before anything has loaded
  let source = null; // "snapshot" | "live"
  let ready = false;
  let generation = 0; // bumped by start() and stop(); older replies are ignored
  let busy = false;
  let lastMoved = null; // { taskId, from } for Undo

  function signedOut(reason) {
    stop();
    onSignedOut?.(reason);
  }

  function hideUndo() {
    lastMoved = null;
    els.undo.hidden = true;
  }

  // ---------- loading ----------
  async function loadSnapshot() {
    const mine = generation;
    if (!token) return;
    const result = await workerRequest({ workerUrl, path: "snapshot", token });
    // the tutor's own list is newer, so a late snapshot never replaces it
    if (mine !== generation || source === "live") return;
    if (result.kind === "auth") return signedOut(result.reason);
    if (result.kind === "ok") {
      items = fromSnapshot(result.body);
      source = "snapshot";
      render();
      return;
    }
    if (items === null) {
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
    items = result.body.tasks.map(fromTask).filter(Boolean);
    source = "live";
    render();
  }

  // ---------- drawing ----------
  function applyReady() {
    for (const el of els.groups.querySelectorAll(".task-edit select, .task-edit input, .task-edit button")) el.disabled = !ready;
    for (const el of els.groups.querySelectorAll(".task-edit .wait")) el.hidden = ready;
    els.undo.disabled = !ready;
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
    const meta = make(doc, "p", { className: "task-meta" });
    // "Overdue" is written out, not shown by colour alone
    if (entry.overdue) meta.append(make(doc, "strong", { text: UPCOMING_MESSAGES.overdue }), doc.createTextNode(" · "));
    const parts = [entry.subject, entry.kind === "assessment" ? UPCOMING_MESSAGES.assessment : null, entry.due];
    meta.append(doc.createTextNode(parts.filter(Boolean).join(" · ")));
    item.append(
      make(doc, "p", { className: "task-title", text: entry.title }),
      meta,
      make(doc, "p", { className: "task-stage", text: `Stage: ${entry.stageLabel}` }),
      editor(entry),
    );
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
    if (items === null) return;
    const open = keepOpen
      ? [...els.groups.querySelectorAll("li.task details[open]")].map((d) => d.closest("li")?.dataset.taskId)
      : [];
    if (els.status.textContent === UPCOMING_MESSAGES.loading) setText(els.status, "");
    els.source.hidden = source !== "snapshot";
    setText(els.source, source === "snapshot" ? UPCOMING_MESSAGES.saved : "");
    const groups = groupUpcoming(items, { today: ukToday(now()) });
    if (groups.count === 0) {
      els.groups.replaceChildren(make(doc, "p", { className: "hint", text: UPCOMING_MESSAGES.empty }));
    } else {
      els.groups.replaceChildren(...GROUPS.map((name) => groupSection(name, groups[name])));
    }
    for (const taskId of open) {
      const details = els.groups.querySelector(`li.task[data-task-id="${taskId}"] details`);
      if (details) details.open = true;
    }
    applyReady();
    if (focusTaskId) els.groups.querySelector(`li.task[data-task-id="${focusTaskId}"] summary`)?.focus();
  }

  // ---------- changes ----------
  function replaceItem(task) {
    const entry = fromTask(task);
    if (!entry) return null;
    items = [...(items ?? []).filter((i) => i.taskId !== entry.taskId), entry];
    return entry;
  }

  async function saveChange(entry, form) {
    if (busy || !ready) return;
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
    const result = await api.updateTask(entry.taskId, built.body);
    busy = false;
    if (mine !== generation) return;
    if (result.kind === "auth") return signedOut(result.reason);
    if (result.kind !== "ok" || !replaceItem(result.body?.task)) {
      setText(els.status, "");
      setText(form.error, apiErrorMessage(result));
      return;
    }
    hideUndo();
    if (built.leaves) {
      render({ keepOpen: false });
      lastMoved = { taskId: entry.taskId, from: entry.stage };
      els.undo.hidden = false;
      setText(els.status, movedOffMessage(entry.title, built.body.stage));
      els.heading.focus();
    } else {
      render({ focusTaskId: entry.taskId, keepOpen: false });
      setText(els.status, UPCOMING_MESSAGES.updated);
    }
  }

  els.undo.addEventListener("click", async () => {
    if (!lastMoved || busy || !ready) return;
    const { taskId, from } = lastMoved;
    const mine = generation;
    busy = true;
    setText(els.status, UPCOMING_MESSAGES.saving);
    const result = await api.updateTask(taskId, { stage: from });
    busy = false;
    if (mine !== generation) return;
    if (result.kind === "auth") return signedOut(result.reason);
    if (result.kind !== "ok" || !replaceItem(result.body?.task)) {
      setText(els.status, apiErrorMessage(result));
      return;
    }
    hideUndo();
    render({ focusTaskId: taskId });
    setText(els.status, UPCOMING_MESSAGES.undone);
  });

  // A page left open overnight works out "Today" again when it is looked at.
  doc.addEventListener("visibilitychange", () => {
    if (doc.visibilityState === "visible" && items !== null) render();
  });

  // ---------- public ----------
  function start(newToken) {
    generation += 1;
    token = newToken ?? null;
    items = null;
    source = null;
    busy = false;
    hideUndo();
    els.groups.replaceChildren();
    els.source.hidden = true;
    setText(els.status, UPCOMING_MESSAGES.loading);
    return ready ? loadLive() : loadSnapshot();
  }

  function setTutor(state) {
    const wasReady = ready;
    ready = READY_STATES.has(state);
    applyReady();
    if (ready && !wasReady && token) return loadLive();
    return undefined;
  }

  /** Called after a task is added: the tutor's list if it's ready, otherwise the snapshot. */
  function refresh() {
    if (!token) return undefined;
    return ready ? loadLive() : loadSnapshot();
  }

  function stop() {
    generation += 1;
    token = null;
    items = null;
    source = null;
    ready = false;
    busy = false;
    hideUndo();
    els.groups.replaceChildren();
    els.source.hidden = true;
    setText(els.source, "");
    setText(els.status, "");
  }

  return { start, setTutor, refresh, stop };
}
