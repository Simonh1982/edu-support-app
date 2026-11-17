// WP-115b: the notebook's rules and wording for the page (build spec §29). No imports, no DOM.
// The limits and quoteForNote are copies of server/domain/notebook.js; test/notebook-screen.test.js
// checks they match.

export const NOTE_MAX_CHARS = 10_000;
export const QUOTE_MAX_CHARS = 2_000;
export const NOTE_TITLE_MAX = 120;
export const PAGE_MAX = 20;
export const SEARCH_MAX = 100;
export const NOTEBOOK_KINDS = Object.freeze(["note", "quote", "summary"]);

// Every entry says who wrote it (§29); the label is text, not colour alone.
export const KIND_LABELS = Object.freeze({ note: "Your note", quote: "Quote", summary: "AI summary" });
export const AUTHOR_LABELS = Object.freeze({ learner: "Written by you", source: "The source's words", ai: "Written by AI" });
export const KIND_FILTERS = Object.freeze([
  { value: "", label: "Everything" },
  { value: "note", label: "Your notes" },
  { value: "quote", label: "Quotes" },
  { value: "summary", label: "AI summaries" },
]);

export const NOTEBOOK_TEXT = Object.freeze({
  heading: "Your notebook",
  searchLabel: "Search your notebook",
  searchHint: "Words from a title, a note or a source.",
  kindLabel: "Show",
  taskLabel: "Task",
  allTasks: "All tasks",
  search: "Search",
  loading: "Loading…",
  none: "Nothing here yet. Notes, quotes and summaries you save while working appear here.",
  noMatch: "Nothing matches. Try fewer or different words.",
  found: (n) => (n === 1 ? "1 entry" : `${n} entries`),
  viewOnly: "The tutor is resting, so you can see titles only. Search and full notes come back once it's awake.",
  open: "Open",
  close: "Close",
  edit: "Edit",
  noTask: "Not linked to a task",
  failed: "That didn't work. Please try again.",
  // writing a note
  write: "Write a note",
  noteTitleLabel: "Title (optional)",
  noteLabel: "Your note",
  noteHint: "Your own words. You can insert a quote below, and its citation comes with it.",
  noteTask: "Task for this note",
  save: "Save the note",
  saving: "Saving…",
  saved: "Note saved.",
  cancel: "Cancel",
  needText: "Write something first.",
  tooLong: (max) => `That's too long. Please keep it under ${max.toLocaleString("en-GB")} characters.`,
  titleTooLong: `Please keep the title under ${NOTE_TITLE_MAX} characters.`,
  insertHeading: "Insert a quote",
  insertHint: "The quote goes in with quotation marks and its citation.",
  insert: "Insert",
  noQuotes: "No quotes for this task yet. Add one from a source in Your sources.",
  // quotes
  addQuote: "Add a quote",
  quoteLabel: "Copy the passage exactly as it is in the source",
  quoteHint: "Keep it short: the part you might quote. The app adds the citation.",
  pageLabel: "Page, if it has one",
  saveQuote: "Save the quote",
  quoteSaved: "Quote saved to your notebook.",
  // AI text is pin-only (§29)
  aiNote: "Written by AI. You can pin it to a task, but not copy it into your own notes.",
  // the task panel's part
  taskNotes: "Your notes for this task",
  taskNotesCount: (n) => (n === 1 ? "Your notes for this task (1)" : `Your notes for this task (${n})`),
  pinned: "Pinned from another task",
  unpin: "Remove from this task",
  // surfacing earlier research (§29)
  earlier: (n, when) => `You researched this topic before${when ? ` (from ${when})` : ""}: ${n === 1 ? "1 entry" : `${n} entries`}. Would you like to use those notes?`,
  useThis: "Use this",
  used: "Added to this task.",
  notNow: "Not now",
});

/** The notebook titles in a /snapshot reply (the learner section, or a whole snapshot). */
export function entriesFromSnapshot(body) {
  const list = Array.isArray(body?.notebook) ? body.notebook : Array.isArray(body?.learner?.notebook) ? body.learner.notebook : [];
  return list
    .filter((e) => e && typeof e.id === "string" && NOTEBOOK_KINDS.includes(e.kind))
    .map((e) => ({
      id: e.id,
      type: e.kind,
      title: typeof e.title === "string" ? e.title : KIND_LABELS[e.kind],
      taskId: typeof e.taskId === "string" ? e.taskId : null,
      updatedAt: typeof e.updatedAt === "string" ? e.updatedAt : null,
      author: e.kind === "note" ? "learner" : e.kind === "quote" ? "source" : "ai",
      excerpt: "",
    }));
}

const fold = (s) => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");

/** While the tutor rests: the same filters as the server, on titles only. */
export function filterTitles(entries, { q = "", kind = "", taskId = "" } = {}) {
  const words = fold(q).split(/\s+/).filter(Boolean);
  return entries.filter((e) => (!kind || e.type === kind) && (!taskId || e.taskId === taskId)
    && words.every((w) => fold(e.title).includes(w)));
}

/** The query string for GET /api/notebook, with empty filters left out. */
export function notebookQuery({ q = "", kind = "", taskId = "" } = {}) {
  const params = new URLSearchParams();
  if (q.trim()) params.set("q", q.trim().slice(0, SEARCH_MAX));
  if (kind) params.set("type", kind);
  if (taskId) params.set("taskId", taskId);
  const s = params.toString();
  return s ? `?${s}` : "";
}

/** "17 Nov" in UK time; "" when unknown. */
export function shortDay(iso) {
  const at = new Date(iso ?? "");
  if (Number.isNaN(at.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", day: "numeric", month: "short" }).format(at);
}

/** One line under an entry's title: who wrote it, its task and when. */
export function entryLine(entry, taskTitle = null) {
  return [AUTHOR_LABELS[entry.author] ?? KIND_LABELS[entry.type], taskTitle ?? NOTEBOOK_TEXT.noTask, shortDay(entry.updatedAt)]
    .filter(Boolean).join(" · ");
}

/** The passage in quotation marks, then its citation (server/domain/notebook.js quoteForNote). */
export const quoteForNote = (entry) => `“${entry?.text?.value ?? entry?.excerpt ?? ""}” ${entry?.citation ?? ""}`.trimEnd();

/** His note with a quote added at the end, on its own paragraph. */
export function insertQuote(text, entry) {
  const quote = quoteForNote(entry);
  const before = String(text ?? "").trimEnd();
  return before ? `${before}\n\n${quote}` : quote;
}

/** The quotes still in the note as inserted (he may have deleted some). quotes: [{ id, text }]. */
export function quotesStillIn(text, quotes) {
  return quotes.filter((q) => String(text ?? "").includes(q.text)).map((q) => q.id);
}

/** A note ready to send, or { error }. */
export function checkNote({ title = "", text = "" } = {}) {
  const body = String(text ?? "").trim();
  if (!body) return { error: NOTEBOOK_TEXT.needText };
  if (body.length > NOTE_MAX_CHARS) return { error: NOTEBOOK_TEXT.tooLong(NOTE_MAX_CHARS) };
  const name = String(title ?? "").replace(/\s+/g, " ").trim();
  if (name.length > NOTE_TITLE_MAX) return { error: NOTEBOOK_TEXT.titleTooLong };
  return { title: name || null, text: body };
}

/** A quote ready to send, or { error }. */
export function checkQuote({ text = "", page = "" } = {}) {
  const body = String(text ?? "").trim();
  if (!body) return { error: NOTEBOOK_TEXT.needText };
  if (body.length > QUOTE_MAX_CHARS) return { error: NOTEBOOK_TEXT.tooLong(QUOTE_MAX_CHARS) };
  const p = String(page ?? "").trim().slice(0, PAGE_MAX);
  return { text: body, page: p || null };
}
