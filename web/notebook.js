// WP-115b: "Your notebook" (build spec §29): history and search of his notes, quotes and AI summaries,
// by words, kind and task, and writing a note with quotes inserted with their citation. While the
// tutor rests, the titles come from the Worker's snapshot and an entry opens through the Worker's
// /item, so the notebook is view-only but still there (build spec §6.1). Nothing is kept on the device.
import { workerRequest } from "./shared/auth.js";
import {
  KIND_FILTERS, NOTEBOOK_TEXT, checkNote, entriesFromSnapshot, filterTitles, insertQuote, notebookQuery, quotesStillIn,
} from "./shared/notebook.js";
import { entryItem, make, noteForm } from "./notebook-parts.js";

// the tutor answers (with or without AI): the same states as the conversation
const READY_STATES = new Set(["ready", "readyNoAi"]);

function setText(element, text) {
  if (element.textContent !== text) element.textContent = text;
}

/**
 * Returns { setTutor(state), start(token), show(), stop() }, or null if the page lacks the view.
 * getTasks() → the "Coming up" list entries ({ taskId, title }).
 */
export function createNotebook({ api, workerUrl, getTasks = () => [], onSignedOut = () => {}, onUnreachable, doc = document }) {
  const byId = (id) => doc.getElementById(id);
  const els = {
    form: byId("notebook-search"),
    q: byId("notebook-q"),
    kind: byId("notebook-kind"),
    task: byId("notebook-task"),
    write: byId("notebook-write"),
    editor: byId("notebook-editor"),
    status: byId("notebook-status"),
    list: byId("notebook-list"),
  };
  if (Object.values(els).some((el) => !el)) return null;

  let ready = false;
  let token = null;
  let generation = 0;
  let entries = null;
  let viewOnly = false;
  const opened = new Map(); // entry id → { open, full, loading, note }
  // the note being written: { form: { title, text, taskId }, editingId, busy, status, quotes, inserted: [{ id, text }] }
  let editor = null;

  const tasks = () => (getTasks?.() ?? []).filter((t) => typeof t?.taskId === "string").map((t) => ({ taskId: t.taskId, title: t.title }));
  const taskTitle = (id) => tasks().find((t) => t.taskId === id)?.title ?? null;

  function signedOut(result) {
    onSignedOut(result.reason);
  }

  function fillFilters() {
    if (!els.kind.children.length) {
      for (const f of KIND_FILTERS) els.kind.append(make(doc, "option", { text: f.label, attrs: { value: f.value } }));
    }
    const chosen = els.task.value;
    els.task.replaceChildren(...[{ taskId: "", title: NOTEBOOK_TEXT.allTasks }, ...tasks()].map((t) => make(doc, "option", { text: t.title, attrs: { value: t.taskId } })));
    els.task.value = chosen;
  }

  const filters = () => ({ q: els.q.value, kind: els.kind.value, taskId: els.task.value });

  function render() {
    els.write.hidden = !ready || Boolean(editor);
    els.editor.hidden = !editor;
    if (editor) {
      els.editor.replaceChildren(noteForm(doc, {
        key: "notebook",
        form: editor.form,
        tasks: tasks(),
        quotes: editor.quotes,
        busy: editor.busy,
        status: editor.status,
        onChange: (changes) => { editor.form = { ...editor.form, ...changes }; if ("taskId" in changes) loadQuotes(); },
        onInsert: (q) => insert(q),
        onSave: (values) => saveNote(values),
        onCancel: () => { editor = null; render(); els.write.focus(); },
      }));
    } else {
      els.editor.replaceChildren();
    }
    if (entries === null) return;
    els.list.replaceChildren(...entries.map((entry) => {
      const state = opened.get(entry.id) ?? {};
      const actions = [];
      if (ready && entry.type === "note" && state.open && state.full) {
        actions.push({ label: NOTEBOOK_TEXT.edit, action: "edit", disabled: Boolean(editor), onClick: () => edit(state.full) });
      }
      return entryItem(doc, entry, { key: entry.id, taskTitle: taskTitle(entry.taskId), state, onToggle: toggle, actions });
    }));
  }

  async function load() {
    const mine = ++generation;
    fillFilters();
    setText(els.status, NOTEBOOK_TEXT.loading);
    const wanted = filters();
    let list = null;
    if (ready) {
      const result = await api.listNotebook(notebookQuery(wanted));
      if (mine !== generation) return;
      if (result.kind === "auth") return signedOut(result);
      if (result.kind === "ok" && Array.isArray(result.body?.entries)) {
        list = result.body.entries;
        viewOnly = false;
      } else if (result.kind === "network") {
        onUnreachable?.();
      }
    }
    if (!list && token) {
      // the tutor is resting: the snapshot's titles, filtered here
      const result = await workerRequest({ workerUrl, path: "snapshot", token });
      if (mine !== generation) return;
      if (result.kind === "auth") return signedOut(result);
      if (result.kind === "ok") {
        list = filterTitles(entriesFromSnapshot(result.body), wanted);
        viewOnly = true;
      }
    }
    if (!list) {
      setText(els.status, NOTEBOOK_TEXT.failed);
      return;
    }
    entries = list;
    const searching = Boolean(wanted.q.trim() || wanted.kind || wanted.taskId);
    let message = list.length ? NOTEBOOK_TEXT.found(list.length) : searching ? NOTEBOOK_TEXT.noMatch : NOTEBOOK_TEXT.none;
    if (viewOnly) message = `${NOTEBOOK_TEXT.viewOnly} ${message}`;
    setText(els.status, message);
    render();
  }

  async function openFull(id) {
    if (ready) {
      const result = await api.openItem("notebook", id);
      if (result.kind === "ok" && result.body?.item) return { item: result.body.item };
      return { result };
    }
    const result = await workerRequest({ workerUrl, path: `item?type=notebook&id=${encodeURIComponent(id)}`, token });
    if (result.kind === "ok" && result.body?.item) return { item: result.body.item };
    return { result };
  }

  async function toggle(entry) {
    const state = opened.get(entry.id) ?? {};
    if (state.open) {
      opened.set(entry.id, { ...state, open: false });
      render();
      return;
    }
    opened.set(entry.id, { ...state, open: true, loading: !state.full, note: "" });
    render();
    if (state.full) return;
    const { item, result } = await openFull(entry.id);
    if (result?.kind === "auth") return signedOut(result);
    opened.set(entry.id, { open: true, full: item ?? null, loading: false, note: item ? "" : NOTEBOOK_TEXT.failed });
    render();
  }

  // ---------- writing a note ----------

  async function loadQuotes() {
    if (!editor) return;
    const mine = editor;
    const taskId = editor.form.taskId;
    const result = await api.listNotebook(notebookQuery({ kind: "quote", taskId: taskId ?? "" }));
    if (editor !== mine) return;
    editor.quotes = result.kind === "ok" && Array.isArray(result.body?.entries) ? result.body.entries : [];
    render();
  }

  function startEditor(form, editingId = null, inserted = []) {
    editor = { form, editingId, busy: false, status: "", quotes: [], inserted };
    render();
    byId("note-notebook-text")?.focus();
    loadQuotes();
  }

  els.write.addEventListener("click", () => {
    if (!ready || editor) return;
    startEditor({ title: "", text: "", taskId: els.task.value || "" });
  });

  function edit(item) {
    startEditor({ title: item.title ?? "", text: item.text?.value ?? "", taskId: item.taskId ?? "" }, item.id,
      (item.quoteIds ?? []).map((id) => ({ id, text: null })));
  }

  async function insert(quote) {
    if (!editor || editor.busy) return;
    const mine = editor;
    // the list carries an excerpt only, so the full passage is read first
    const { item } = await openFull(quote.id);
    if (editor !== mine) return;
    if (!item) {
      editor.status = NOTEBOOK_TEXT.failed;
      render();
      return;
    }
    editor.form = { ...editor.form, text: insertQuote(editor.form.text, item) };
    editor.inserted = [...editor.inserted.filter((q) => q.id !== item.id), { id: item.id, text: item.text?.value ?? "" }];
    render();
    byId("note-notebook-text")?.focus();
  }

  async function saveNote(values) {
    if (!editor || editor.busy || !ready) return;
    const checked = checkNote(values);
    if (checked.error) {
      editor.status = checked.error;
      render();
      return;
    }
    const mine = editor;
    // quotes already in an edited note keep their place unless he removed the passage
    const known = editor.inserted.filter((q) => q.text !== null);
    const kept = editor.inserted.filter((q) => q.text === null).map((q) => q.id);
    const quoteIds = [...new Set([...kept, ...quotesStillIn(checked.text, known)])];
    const body = { title: checked.title, text: checked.text, taskId: editor.form.taskId || null, quoteIds };
    editor.busy = true;
    editor.status = "";
    render();
    const result = editor.editingId ? await api.updateNote(editor.editingId, body) : await api.createNote(body);
    if (editor !== mine) return;
    if (result.kind === "auth") return signedOut(result);
    if (result.kind !== "ok") {
      editor.busy = false;
      editor.status = typeof result.body?.error === "string" ? result.body.error : NOTEBOOK_TEXT.failed;
      render();
      return;
    }
    if (editor.editingId) opened.set(editor.editingId, { open: true, full: result.body.entry, loading: false });
    editor = null;
    setText(els.status, NOTEBOOK_TEXT.saved);
    await load();
    els.write.focus();
  }

  els.form.addEventListener("submit", (event) => {
    event.preventDefault();
    return load();
  });

  // ---------- public ----------
  function setTutor(state) {
    const was = ready;
    ready = READY_STATES.has(state);
    if (ready !== was && entries !== null) return load();
    render();
    return undefined;
  }

  function start(passToken) {
    token = passToken;
  }

  function show() {
    return load();
  }

  function stop() {
    generation += 1;
    token = null;
    entries = null;
    editor = null;
    opened.clear();
    els.list.replaceChildren();
    els.editor.replaceChildren();
    els.form.reset?.();
    setText(els.status, "");
  }

  return { setTutor, start, show, stop };
}
