// Small pieces shared by the source cards (the chat page's replies) and the task panel (web/task-panel.js):
// a source link, the AI summary card and the "Paste the text instead" box (WP-114e; build spec §28;
// A-010). All text is set with textContent, never as HTML. Nothing here is stored.
import { PASTED_SOURCE_MAX_CHARS, SOURCE_MESSAGES, canSummarise, sourceLabel } from "./shared/conversation.js";

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

function button(doc, text, { className = "secondary", label } = {}) {
  const el = make(doc, "button", { className, text, attrs: { type: "button" } });
  if (label) el.setAttribute("aria-label", label);
  return el;
}

// WP-134a: moved here from the classic conversation screen (web/conversation.js, retired).
/**
 * The source cards under a tutor reply (build spec §9.1, §26): the kind of source, a link to the
 * original, the site, a line on what it covers, then Save and Summarise. Exported for tests.
 * stateOf(index) → { sourceId?, saving?, summarising?, summary?, asked?, note?, canPaste?, pasteText?, pasteOpen? }.
 * WP-114e: once the tutor couldn't open a page, "Paste the text instead" appears (onPaste(card, text));
 * onPasteChange(card, changes) keeps what he has typed across redraws.
 * WP-114i: with onAttach (a task panel that can attach), "Attach a copy instead" appears beside the
 * paste box and takes him to that source's attach box in the task panel.
 */
export function sourceList(doc, turn, {
  stateOf = () => ({}), onSave = () => {}, onSummarise = () => {}, onPaste = () => {}, onPasteChange = () => {}, ready = true,
  onAttach = null,
} = {}) {
  const list = Array.isArray(turn?.sources) ? turn.sources : [];
  if (list.length === 0 || !turn.reply) return null;
  const headingId = `sources-${turn.id}`;
  const section = make(doc, "section", { className: "sources", attrs: { "aria-labelledby": headingId } });
  section.append(make(doc, "h3", { className: "sources-heading", text: SOURCE_MESSAGES.heading, attrs: { id: headingId } }));
  const cards = make(doc, "ul", { className: "source-cards" });
  for (const card of list) {
    const state = stateOf(card.index) ?? {};
    const key = `${turn.id}-${card.index}`;
    const item = make(doc, "li", { className: "source-card", attrs: { id: `source-${key}`, tabindex: "-1" } });
    item.append(make(doc, "p", { className: "source-kind", text: sourceLabel(card.category, card.minutes) }));
    const title = make(doc, "p", { className: "source-title" });
    title.append(sourceLink(doc, card.title, card.url));
    item.append(title);
    item.append(make(doc, "p", { className: "source-site", text: card.publisher ? `${card.publisher} · ${card.site}` : card.site }));
    if (card.why) item.append(make(doc, "p", { className: "source-why", text: `${SOURCE_MESSAGES.why} ${card.why}` }));
    if (card.accessNote) item.append(make(doc, "p", { className: "source-access", text: card.accessNote }));
    const working = Boolean(state.saving || state.summarising);
    const buttons = [];
    if (!state.sourceId) {
      const save = button(doc, state.saving ? SOURCE_MESSAGES.saving : SOURCE_MESSAGES.save);
      save.dataset.action = "save";
      save.disabled = !ready || working;
      save.addEventListener("click", () => onSave(card));
      buttons.push(save);
    }
    if (!state.summary && !state.asked && canSummarise(card)) {
      const summarise = button(doc, state.summarising ? SOURCE_MESSAGES.summarising : state.again ? SOURCE_MESSAGES.summariseAgain : SOURCE_MESSAGES.summarise);
      summarise.dataset.action = "summarise";
      summarise.disabled = !ready || working;
      summarise.addEventListener("click", () => onSummarise(card));
      buttons.push(summarise);
    }
    if (buttons.length) {
      const actions = make(doc, "div", { className: "actions source-actions" });
      actions.append(...buttons);
      item.append(actions);
    }
    if (state.note) item.append(make(doc, "p", { className: "source-note", text: state.note }));
    if (state.canPaste && !state.summary && canSummarise(card)) {
      item.append(pasteBox(doc, {
        key,
        text: state.pasteText ?? "",
        open: state.pasteOpen === true,
        disabled: !ready || working,
        onChange: (changes) => onPasteChange(card, changes),
        onSubmit: (text) => onPaste(card, text),
      }));
    }
    // WP-114j: on any saved card on a task, including after a summary of only its landing page
    if (onAttach && state.sourceId && canSummarise(card)) {
      const attach = button(doc, state.canPaste && !state.summary ? SOURCE_MESSAGES.attachInstead : SOURCE_MESSAGES.attachCopy);
      attach.dataset.action = "attach";
      attach.disabled = !ready || working;
      attach.addEventListener("click", () => onAttach(card, state.sourceId));
      const row = make(doc, "div", { className: "actions source-actions" });
      row.append(attach);
      item.append(row);
    }
    if (state.summary) item.append(summaryCard(doc, state.summary, key));
    cards.append(item);
  }
  section.append(cards);
  return section;
}
