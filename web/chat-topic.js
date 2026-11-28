// WP-133 (A-013 §5): his notes, quotes and AI summaries on a topic, for the chat page's topic page.
// Uses the notebook's own entry cards (labels for kind and author; an AI summary opens labelled and
// pin-only), loaded with GET /api/notebook?topicId=. State is kept in memory.
import { entryItem, make } from "./notebook-parts.js";
import { notebookQuery } from "./shared/notebook.js";

export const TOPIC_TEXT = Object.freeze({
  notes: (n) => `Your notes and summaries (${n})`,
  noNotes: "Nothing saved on this topic yet. Notes, quotes and summaries from its tasks and chats appear here.",
  loading: "Loading your notes…",
  waiting: "Your notes on this topic show once the tutor is ready.",
  failed: "Your notes couldn't load just now. Try again in a moment.",
  fromOutline: "From your course outline",
});

/**
 * api: listNotebook and openItem; isReady(); onChange() redraws; onSignedOut(); onUnreachable();
 * taskTitle(taskId) names the task an entry belongs to.
 * Returns { load(topicId), render(topicId) → element, clear() }.
 */
export function createTopicNotes({
  doc = document, api, isReady = () => true, onChange = () => {}, onSignedOut = () => {}, onUnreachable = () => {}, taskTitle = () => null,
}) {
  let topicId = null;
  let entries = null; // null: not loaded
  let failed = false;
  let generation = 0;
  const opened = new Map(); // entry id → { open, loading, full, note }

  async function load(id) {
    if (id !== topicId) { topicId = id; entries = null; failed = false; opened.clear(); generation += 1; }
    if (!isReady() || !id) { onChange(); return; }
    const mine = generation;
    const r = await api.listNotebook(notebookQuery({ topicId: id }));
    if (mine !== generation) return;
    if (r.kind === "auth") { onSignedOut(); return; }
    if (r.kind === "ok" && Array.isArray(r.body?.entries)) { entries = r.body.entries; failed = false; } else {
      failed = true;
      if (["network", "no-address", "not-json"].includes(r.kind)) onUnreachable();
    }
    onChange();
  }

  async function toggle(entry) {
    const state = opened.get(entry.id) ?? {};
    if (state.open) { opened.set(entry.id, { ...state, open: false }); onChange(); return; }
    opened.set(entry.id, { ...state, open: true, loading: !state.full, note: "" });
    onChange();
    if (state.full) return;
    const mine = generation;
    const r = await api.openItem("notebook", entry.id);
    if (mine !== generation) return;
    if (r.kind === "auth") { onSignedOut(); return; }
    const item = r.kind === "ok" ? r.body?.item ?? null : null;
    opened.set(entry.id, { open: true, loading: false, full: item, note: item ? "" : TOPIC_TEXT.failed });
    onChange();
  }

  function render(id) {
    const box = make(doc, "section", { className: "topic-notes", attrs: { "aria-labelledby": "topic-notes-heading" } });
    const list = entries ?? [];
    box.append(make(doc, "h2", { text: TOPIC_TEXT.notes(list.length), attrs: { id: "topic-notes-heading" } }));
    if (id !== topicId || entries === null) {
      box.append(make(doc, "p", { className: "hint", text: failed ? TOPIC_TEXT.failed : isReady() ? TOPIC_TEXT.loading : TOPIC_TEXT.waiting }));
      return box;
    }
    if (!list.length) { box.append(make(doc, "p", { className: "hint", text: TOPIC_TEXT.noNotes })); return box; }
    const ul = make(doc, "ul", { className: "source-cards" });
    for (const entry of list) {
      ul.append(entryItem(doc, entry, { key: `topic-${entry.id}`, taskTitle: entry.taskId ? taskTitle(entry.taskId) : null, state: opened.get(entry.id) ?? {}, canOpen: isReady(), onToggle: (e) => toggle(e) }));
    }
    box.append(ul);
    return box;
  }

  return { load, render, clear() { topicId = null; entries = null; failed = false; opened.clear(); generation += 1; } };
}
