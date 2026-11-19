// WP-115b: the notebook's screen parts, shared by the notebook view and the task panel's notes: one
// entry (labelled with its author, §29), the note form with "Insert a quote", and the quote form.
// Plain DOM, built with textContent only; usable by keyboard; every control has a label.
import { KIND_LABELS, NOTEBOOK_TEXT, NOTE_MAX_CHARS, NOTE_TITLE_MAX, PAGE_MAX, entryLine } from "./shared/notebook.js";

export function make(doc, tag, { className, text, attrs } = {}) {
  const el = doc.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  for (const [k, v] of Object.entries(attrs ?? {})) el.setAttribute(k, v);
  return el;
}

function button(doc, text, { className = "secondary", action } = {}) {
  const b = make(doc, "button", { className, text, attrs: { type: "button" } });
  if (action) b.dataset.action = action;
  return b;
}

/** The full text of an opened entry: his note, a quote with its citation, or an AI summary. */
function fullText(doc, item) {
  const box = make(doc, "div", { className: item.type === "summary" ? "ai-summary notebook-full" : "notebook-full" });
  if (item.type === "summary") box.append(make(doc, "p", { className: "hint", text: NOTEBOOK_TEXT.aiNote }));
  box.append(make(doc, "p", { className: "read-text", text: item.text?.value ?? "" }));
  if (item.type === "quote" && item.citation) box.append(make(doc, "p", { className: "hint", text: item.citation }));
  if (item.source?.url) {
    const p = make(doc, "p");
    const a = make(doc, "a", { text: item.source.title ?? item.source.url, attrs: { href: item.source.url, target: "_blank", rel: "noopener noreferrer" } });
    p.append(a);
    box.append(p);
  }
  return box;
}

/**
 * One notebook entry as a list item. state: { full?, loading?, open? }. actions: extra buttons
 * ({ label, action, onClick, disabled }). onToggle(entry) opens or closes the full text.
 */
export function entryItem(doc, entry, { key, taskTitle = null, state = {}, canOpen = true, onToggle = () => {}, actions = [] } = {}) {
  const item = make(doc, "li", { className: `source-card notebook-entry notebook-${entry.type}`, attrs: { id: `entry-${key}`, tabindex: "-1" } });
  item.append(make(doc, "p", { className: "source-kind", text: KIND_LABELS[entry.type] ?? KIND_LABELS.note }));
  item.append(make(doc, "p", { className: "source-title", text: entry.title || KIND_LABELS[entry.type] }));
  item.append(make(doc, "p", { className: "hint", text: entryLine(entry, taskTitle) }));
  if (entry.excerpt && !state.open) item.append(make(doc, "p", { className: "notebook-excerpt", text: entry.excerpt }));
  if (state.open && state.full) item.append(fullText(doc, state.full));
  if (state.open && state.loading) item.append(make(doc, "p", { className: "hint", text: NOTEBOOK_TEXT.loading }));
  const row = make(doc, "div", { className: "actions" });
  if (canOpen) {
    const open = button(doc, state.open ? NOTEBOOK_TEXT.close : NOTEBOOK_TEXT.open, { action: "open" });
    open.setAttribute("aria-expanded", state.open ? "true" : "false");
    open.addEventListener("click", () => onToggle(entry));
    row.append(open);
  }
  for (const a of actions) {
    const b = button(doc, a.label, { action: a.action });
    b.disabled = Boolean(a.disabled);
    b.addEventListener("click", a.onClick);
    row.append(b);
  }
  if (row.children.length) item.append(row);
  if (state.note) item.append(make(doc, "p", { className: "source-note", text: state.note }));
  return item;
}

/**
 * The note form. form: { title, text, taskId }. tasks: [{ taskId, title }] for the task choice, or
 * null to keep the given task. quotes: the quotes he can insert ({ id, title, excerpt }).
 * onChange(changes) keeps what he has typed across redraws.
 */
export function noteForm(doc, {
  key, form = {}, tasks = null, quotes = [], busy = false, status = "", onChange = () => {}, onInsert = () => {}, onSave = () => {}, onCancel = null,
} = {}) {
  const id = `note-${key}`;
  const box = make(doc, "form", { className: "note-form", attrs: { novalidate: "" } });
  box.append(make(doc, "label", { text: NOTEBOOK_TEXT.noteTitleLabel, attrs: { for: `${id}-title` } }));
  const title = make(doc, "input", { attrs: { id: `${id}-title`, type: "text", maxlength: String(NOTE_TITLE_MAX), autocomplete: "off" } });
  title.value = form.title ?? "";
  title.addEventListener("input", () => onChange({ title: title.value }));
  box.append(title);
  box.append(make(doc, "label", { text: NOTEBOOK_TEXT.noteLabel, attrs: { for: `${id}-text` } }));
  box.append(make(doc, "p", { className: "hint", text: NOTEBOOK_TEXT.noteHint, attrs: { id: `${id}-hint` } }));
  const area = make(doc, "textarea", { attrs: { id: `${id}-text`, rows: "8", maxlength: String(NOTE_MAX_CHARS), "aria-describedby": `${id}-hint` } });
  area.value = form.text ?? "";
  area.addEventListener("input", () => onChange({ text: area.value }));
  box.append(area);
  if (tasks) {
    box.append(make(doc, "label", { text: NOTEBOOK_TEXT.noteTask, attrs: { for: `${id}-task` } }));
    const select = make(doc, "select", { attrs: { id: `${id}-task` } });
    for (const t of [{ taskId: "", title: NOTEBOOK_TEXT.noTask }, ...tasks]) {
      const o = make(doc, "option", { text: t.title, attrs: { value: t.taskId } });
      if ((form.taskId ?? "") === t.taskId) o.setAttribute("selected", "");
      select.append(o);
    }
    select.value = form.taskId ?? "";
    select.addEventListener("change", () => onChange({ taskId: select.value }));
    box.append(select);
  }
  // quotes go in with their citation (§29); AI text is never offered here
  // WP-115d: shown open, not folded away: a folded section looked like a plain heading (live check)
  const insert = make(doc, "div", { className: "insert-quote", attrs: { role: "group", "aria-labelledby": `${id}-insert` } });
  insert.append(make(doc, "p", { className: "insert-heading", text: NOTEBOOK_TEXT.insertHeading, attrs: { id: `${id}-insert` } }));
  insert.append(make(doc, "p", { className: "hint", text: quotes.length ? NOTEBOOK_TEXT.insertHint : NOTEBOOK_TEXT.noQuotes }));
  if (quotes.length) {
    const list = make(doc, "ul", { className: "quote-picks" });
    for (const q of quotes) {
      const li = make(doc, "li");
      li.append(make(doc, "p", { text: q.excerpt || q.title }));
      const b = button(doc, NOTEBOOK_TEXT.insert, { action: "insert" });
      b.setAttribute("aria-label", `${NOTEBOOK_TEXT.insert}: ${q.title}`);
      b.disabled = busy;
      b.addEventListener("click", () => onInsert(q));
      li.append(b);
      list.append(li);
    }
    insert.append(list);
  }
  box.append(insert);
  const row = make(doc, "div", { className: "actions" });
  const save = make(doc, "button", { className: "primary", text: busy ? NOTEBOOK_TEXT.saving : NOTEBOOK_TEXT.save, attrs: { type: "submit" } });
  save.dataset.action = "save-note";
  save.disabled = busy;
  row.append(save);
  if (onCancel) {
    const cancel = button(doc, NOTEBOOK_TEXT.cancel, { action: "cancel" });
    cancel.addEventListener("click", onCancel);
    row.append(cancel);
  }
  box.append(row);
  box.append(make(doc, "p", { className: "status", text: status, attrs: { role: "status", "aria-live": "polite" } }));
  box.addEventListener("submit", (event) => {
    event?.preventDefault?.();
    if (!busy) onSave({ title: title.value, text: area.value, taskId: form.taskId ?? null });
  });
  return box;
}

/** "Add a quote" under a saved source: the passage he copied and its page. */
export function quoteForm(doc, { key, form = {}, open = false, busy = false, status = "", onChange = () => {}, onSave = () => {} } = {}) {
  const id = `quote-${key}`;
  const box = make(doc, "details", { className: "more add-quote" });
  if (open) box.setAttribute("open", "");
  box.addEventListener("toggle", () => onChange({ quoteOpen: box.open === true }));
  box.append(make(doc, "summary", { text: NOTEBOOK_TEXT.addQuote }));
  box.append(make(doc, "label", { text: NOTEBOOK_TEXT.quoteLabel, attrs: { for: id } }));
  box.append(make(doc, "p", { className: "hint", text: NOTEBOOK_TEXT.quoteHint, attrs: { id: `${id}-hint` } }));
  const area = make(doc, "textarea", { attrs: { id, rows: "4", "aria-describedby": `${id}-hint` } });
  area.value = form.quoteText ?? "";
  area.addEventListener("input", () => onChange({ quoteText: area.value }));
  box.append(area);
  box.append(make(doc, "label", { text: NOTEBOOK_TEXT.pageLabel, attrs: { for: `${id}-page` } }));
  const page = make(doc, "input", { attrs: { id: `${id}-page`, type: "text", maxlength: String(PAGE_MAX), autocomplete: "off", inputmode: "numeric" } });
  page.value = form.quotePage ?? "";
  page.addEventListener("input", () => onChange({ quotePage: page.value }));
  box.append(page);
  const row = make(doc, "div", { className: "actions" });
  const save = button(doc, busy ? NOTEBOOK_TEXT.saving : NOTEBOOK_TEXT.saveQuote, { className: "primary", action: "save-quote" });
  save.disabled = busy;
  save.addEventListener("click", () => onSave({ text: area.value, page: page.value }));
  row.append(save);
  box.append(row);
  if (status) box.append(make(doc, "p", { className: "status", text: status, attrs: { role: "status" } }));
  return box;
}

