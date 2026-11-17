// WP-115b: the task panel's "Your notes for this task" part (build spec §29): his notes, quotes and
// AI summaries for the task, and entries pinned to it from elsewhere; writing a note with quotes
// inserted with their citation; and, when he has researched the task's topics before, "Would you
// like to use those notes?", which pins the ones he picks. Needs the tutor; nothing is kept on the device.
import { NOTEBOOK_TEXT, checkNote, insertQuote, notebookQuery, quotesStillIn, shortDay } from "./shared/notebook.js";
import { entryItem, make, noteForm } from "./notebook-parts.js";

function setText(element, text) {
  if (element.textContent !== text) element.textContent = text;
}

/**
 * Returns { show(taskId), setTutor(ready), refresh(), clear() }, or null when the page lacks the part.
 * The task panel calls these; failed(result) shows its error wording, or signs out on "auth".
 */
export function createTaskNotes({ api, doc = document, failed = () => "" }) {
  const byId = (id) => doc.getElementById(id);
  const els = {
    box: byId("task-panel-notes"),
    label: byId("task-panel-notes-label"),
    status: byId("task-panel-notes-status"),
    earlier: byId("task-panel-earlier"),
    list: byId("task-panel-notes-list"),
    editor: byId("task-panel-note-editor"),
  };
  if (Object.values(els).some((el) => !el)) return null;

  let ready = false;
  let taskId = null;
  let generation = 0;
  let entries = null;
  let earlier = null; // { entries, count, since } or null
  let earlierHidden = false;
  const opened = new Map();
  const notes = new Map(); // entry id → a short note under it
  let editor = { form: { title: "", text: "" }, busy: false, status: "", inserted: [] };

  const quotes = () => (entries ?? []).filter((e) => e.type === "quote");

  function render() {
    els.box.hidden = !taskId;
    if (!taskId) return;
    setText(els.label, entries ? NOTEBOOK_TEXT.taskNotesCount(entries.length) : NOTEBOOK_TEXT.taskNotes);
    // earlier research on the same topics (§29)
    if (earlier && earlier.count > 0 && !earlierHidden && ready) {
      const box = make(doc, "div", { className: "earlier-research", attrs: { role: "group", "aria-labelledby": "earlier-text" } });
      box.append(make(doc, "p", { text: NOTEBOOK_TEXT.earlier(earlier.count, shortDay(earlier.since)), attrs: { id: "earlier-text" } }));
      const list = make(doc, "ul", { className: "source-cards" });
      for (const e of earlier.entries) {
        list.append(entryItem(doc, e, {
          key: `earlier-${e.id}`, state: opened.get(e.id) ?? {}, onToggle: toggle,
          actions: [{ label: NOTEBOOK_TEXT.useThis, action: "use", onClick: () => pin(e, true) }],
        }));
      }
      box.append(list);
      const row = make(doc, "div", { className: "actions" });
      const later = make(doc, "button", { className: "secondary", text: NOTEBOOK_TEXT.notNow, attrs: { type: "button" } });
      later.dataset.action = "not-now";
      later.addEventListener("click", () => { earlierHidden = true; render(); });
      row.append(later);
      box.append(row);
      els.earlier.replaceChildren(box);
      els.earlier.hidden = false;
    } else {
      els.earlier.replaceChildren();
      els.earlier.hidden = true;
    }
    els.list.replaceChildren(...(entries ?? []).map((e) => {
      const fromElsewhere = e.taskId !== taskId;
      return entryItem(doc, e, {
        key: `task-${e.id}`,
        taskTitle: fromElsewhere ? NOTEBOOK_TEXT.pinned : null,
        state: { ...(opened.get(e.id) ?? {}), note: notes.get(e.id) ?? "" },
        onToggle: toggle,
        actions: fromElsewhere && ready ? [{ label: NOTEBOOK_TEXT.unpin, action: "unpin", onClick: () => pin(e, false) }] : [],
      });
    }));
    els.editor.replaceChildren(ready ? noteForm(doc, {
      key: "task",
      form: editor.form,
      quotes: quotes(),
      busy: editor.busy,
      status: editor.status,
      onChange: (changes) => { editor.form = { ...editor.form, ...changes }; },
      onInsert: (q) => insert(q),
      onSave: (values) => save(values),
    }) : make(doc, "p", { className: "hint", text: NOTEBOOK_TEXT.viewOnly }));
  }

  async function load() {
    const mine = ++generation;
    if (!taskId || !ready) {
      render();
      return;
    }
    setText(els.status, NOTEBOOK_TEXT.loading);
    const [list, before] = await Promise.all([
      api.listNotebook(notebookQuery({ taskId })),
      api.earlierResearch(taskId),
    ]);
    if (mine !== generation) return;
    if (list.kind === "ok" && Array.isArray(list.body?.entries)) {
      entries = list.body.entries;
      setText(els.status, entries.length ? "" : NOTEBOOK_TEXT.none);
    } else {
      setText(els.status, failed(list) || NOTEBOOK_TEXT.failed);
    }
    earlier = before.kind === "ok" && Array.isArray(before.body?.entries) ? before.body : null;
    render();
  }

  async function openFull(id) {
    const result = await api.openItem("notebook", id);
    return result.kind === "ok" && result.body?.item ? { item: result.body.item } : { result };
  }

  async function toggle(entry) {
    const state = opened.get(entry.id) ?? {};
    if (state.open) {
      opened.set(entry.id, { ...state, open: false });
      render();
      return;
    }
    opened.set(entry.id, { ...state, open: true, loading: !state.full });
    render();
    if (state.full || !ready) return;
    const { item, result } = await openFull(entry.id);
    opened.set(entry.id, { open: true, full: item ?? null, loading: false });
    if (!item) notes.set(entry.id, failed(result) || NOTEBOOK_TEXT.failed);
    render();
  }

  async function pin(entry, pinned) {
    if (!ready || !taskId) return;
    const result = await api.pinEntry(entry.id, { taskId, pinned });
    if (result.kind !== "ok") {
      notes.set(entry.id, failed(result) || NOTEBOOK_TEXT.failed);
      render();
      return;
    }
    if (pinned) notes.set(entry.id, NOTEBOOK_TEXT.used);
    await load();
    byId(`entry-task-${entry.id}`)?.focus();
  }

  async function insert(quote) {
    if (editor.busy || !ready) return;
    const { item } = await openFull(quote.id);
    if (!item) {
      editor.status = NOTEBOOK_TEXT.failed;
      render();
      return;
    }
    editor.form = { ...editor.form, text: insertQuote(editor.form.text, item) };
    editor.inserted = [...editor.inserted.filter((q) => q.id !== item.id), { id: item.id, text: item.text?.value ?? "" }];
    render();
    byId("note-task-text")?.focus();
  }

  async function save(values) {
    if (editor.busy || !ready || !taskId) return;
    const checked = checkNote(values);
    if (checked.error) {
      editor.status = checked.error;
      render();
      return;
    }
    editor.busy = true;
    editor.status = "";
    render();
    const result = await api.createNote({
      title: checked.title, text: checked.text, taskId, quoteIds: quotesStillIn(checked.text, editor.inserted),
    });
    editor.busy = false;
    if (result.kind !== "ok") {
      editor.status = failed(result) || (typeof result.body?.error === "string" ? result.body.error : NOTEBOOK_TEXT.failed);
      render();
      return;
    }
    editor = { form: { title: "", text: "" }, busy: false, status: NOTEBOOK_TEXT.saved, inserted: [] };
    await load();
  }

  // ---------- public ----------
  function show(id) {
    taskId = typeof id === "string" ? id : null;
    entries = null;
    earlier = null;
    earlierHidden = false;
    opened.clear();
    notes.clear();
    editor = { form: { title: "", text: "" }, busy: false, status: "", inserted: [] };
    els.box.open = false;
    setText(els.status, "");
    return load();
  }

  function setTutor(isReady) {
    const was = ready;
    ready = isReady;
    if (ready && !was) return load();
    render();
    return undefined;
  }

  function clear() {
    generation += 1;
    taskId = null;
    entries = null;
    earlier = null;
    opened.clear();
    notes.clear();
    els.list.replaceChildren();
    els.earlier.replaceChildren();
    els.editor.replaceChildren();
    els.box.hidden = true;
  }

  return { show, setTutor, refresh: load, clear };
}
