// Small pieces shared by the source cards (web/conversation.js) and the task panel (web/task-panel.js):
// a source link, the AI summary card and the "Paste the text instead" box (WP-114e; build spec §28;
// A-010). All text is set with textContent, never as HTML. Nothing here is stored.
import { PASTED_SOURCE_MAX_CHARS, SOURCE_MESSAGES } from "./shared/conversation.js";

export function make(doc, tag, { className, text, attrs } = {}) {
  const el = doc.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  for (const [key, value] of Object.entries(attrs ?? {})) el.setAttribute(key, value);
  return el;
}

// A link to a source, opened in a new tab so the conversation stays put.
export function sourceLink(doc, text, url) {
  const link = make(doc, "a", { text, attrs: { href: url, target: "_blank", rel: "noopener noreferrer" } });
  link.append(make(doc, "span", { className: "visually-hidden", text: ` ${SOURCE_MESSAGES.newTab}` }));
  return link;
}

// An AI summary (build spec §28): a tinted card whose label "AI summary" is text, not colour alone.
export function summaryCard(doc, summary, key) {
  const box = make(doc, "div", {
    className: "ai-summary", attrs: { id: `summary-${key}`, tabindex: "-1", role: "group", "aria-labelledby": `summary-label-${key}` },
  });
  box.append(make(doc, "p", { className: "ai-summary-label", text: SOURCE_MESSAGES.summaryLabel, attrs: { id: `summary-label-${key}` } }));
  box.append(make(doc, "p", { className: "hint", text: SOURCE_MESSAGES.summaryNote }));
  box.append(make(doc, "p", { className: "ai-summary-text", text: summary.text }));
  if (summary.section) box.append(make(doc, "p", { text: `${SOURCE_MESSAGES.section} ${summary.section}` }));
  if (summary.url) {
    const p = make(doc, "p");
    p.append(sourceLink(doc, SOURCE_MESSAGES.readOriginal, summary.url));
    box.append(p);
  }
  return box;
}

/**
 * "Paste the text instead" (A-010): a collapsed box with a text area and a button. The pasted text
 * goes to the tutor once and is never kept. onChange gets { pasteText } as he types and { pasteOpen }
 * when the box opens or closes, so a redraw keeps both. No maxlength: a long paste is told it's too
 * long rather than cut short without a word.
 */
export function pasteBox(doc, { key, text = "", open = false, disabled = false, onChange = () => {}, onSubmit = () => {} }) {
  const id = `paste-${key}`;
  const box = make(doc, "details", { className: "more paste-source" });
  if (open) box.setAttribute("open", "");
  box.addEventListener("toggle", () => onChange({ pasteOpen: box.open === true }));
  box.append(make(doc, "summary", { text: SOURCE_MESSAGES.pasteHeading }));
  box.append(make(doc, "label", { text: SOURCE_MESSAGES.pasteLabel, attrs: { for: id } }));
  box.append(make(doc, "p", { className: "hint", text: SOURCE_MESSAGES.pasteHint, attrs: { id: `${id}-hint` } }));
  const area = make(doc, "textarea", { attrs: { id, rows: "6", "aria-describedby": `${id}-hint` } });
  area.value = text;
  area.addEventListener("input", () => onChange({ pasteText: area.value }));
  box.append(area);
  const send = make(doc, "button", { className: "primary", text: SOURCE_MESSAGES.pasteSend, attrs: { type: "button" } });
  send.dataset.action = "paste";
  send.disabled = disabled;
  send.addEventListener("click", () => onSubmit(area.value));
  const actions = make(doc, "div", { className: "actions" });
  actions.append(send);
  box.append(actions);
  return box;
}
