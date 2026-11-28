// WP-132b (A-013 §6): the source cards under a research reply on the chat page, with Save and
// Summarise, and "Paste the text instead" when the tutor can't open the page (A-010). The cards are
// drawn by sourceList (web/conversation.js), the same builder as the classic page, so the rules
// (a summary keeps its source, read-the-original and too-close are final, videos aren't summarised)
// stay in one place. WP-133: Attach a copy opens the task panel at that source. State is kept in memory.
import { sourceList } from "./source-parts.js";
import {
  FINAL_SUMMARY_OUTCOMES, PASTE_OUTCOMES, SOURCE_MESSAGES, cardKey, checkPasted, sourceErrorMessage, summaryFromEntry, summaryFromResult,
} from "./shared/conversation.js";

/**
 * api: the tutor's calls; isReady(); onChange() redraws; onSignedOut(); onUnreachable(); onSaved()
 * after a source is saved (the menu and task page refresh). WP-133: canAttach() and onAttach(card, sourceId)
 * show "Attach a copy" on a saved card in a chat about a task. Returns { render(turn), clear() }.
 */
export function createSourceCards({
  doc = document, api, isReady = () => true, onChange = () => {}, onSignedOut = () => {}, onUnreachable = () => {}, onSaved = () => {},
  canAttach = () => false, onAttach = () => {},
}) {
  const cards = new Map(); // cardKey → { sourceId, summaryId, saving, summarising, summary, asked, again, canPaste, pasteText, pasteOpen, note }
  let generation = 0;
  const cardOf = (turnId, index) => cards.get(cardKey(turnId, index)) ?? {};
  const setCard = (turnId, index, changes) => cards.set(cardKey(turnId, index), { ...cardOf(turnId, index), ...changes });
  const focusCard = (turnId, index, { summary = false } = {}) => {
    const key = `${turnId}-${index}`;
    ((summary && doc.getElementById(`summary-${key}`)) || doc.getElementById(`source-${key}`))?.focus?.();
  };

  function failed(turnId, index, result) {
    if (result.kind === "auth") { onSignedOut(); return; }
    const { message, unreachable } = sourceErrorMessage(result);
    setCard(turnId, index, { saving: false, summarising: false, note: message });
    if (unreachable) onUnreachable();
  }

  async function ensureSaved(turnId, card) {
    const known = cardOf(turnId, card.index);
    if (known.sourceId) return known;
    const mine = generation;
    const result = await api.saveSource({ turnId, index: card.index });
    if (mine !== generation) return null;
    if (result.kind !== "ok" || typeof result.body?.source?.id !== "string") { failed(turnId, card.index, result); return null; }
    const source = result.body.source;
    setCard(turnId, card.index, { sourceId: source.id, summaryId: typeof source.summaryId === "string" ? source.summaryId : null });
    onSaved();
    return cardOf(turnId, card.index);
  }

  async function save(turnId, card) {
    const state = cardOf(turnId, card.index);
    if (!isReady() || state.saving || state.summarising || state.sourceId) return;
    setCard(turnId, card.index, { saving: true, note: "" });
    onChange();
    const saved = await ensureSaved(turnId, card);
    if (saved) setCard(turnId, card.index, { saving: false, note: SOURCE_MESSAGES.saved });
    onChange();
    focusCard(turnId, card.index);
  }

  function show(turnId, card, summary) {
    if (summary.kind === "summary") {
      setCard(turnId, card.index, { summarising: false, summary, summaryId: summary.id, note: "", canPaste: false, pasteText: "" });
      onSaved();
    } else {
      setCard(turnId, card.index, {
        summarising: false,
        asked: FINAL_SUMMARY_OUTCOMES.includes(summary.outcome),
        again: summary.outcome === "too-close",
        canPaste: PASTE_OUTCOMES.includes(summary.outcome) || cardOf(turnId, card.index).canPaste === true,
        note: summary.text,
      });
    }
    onChange();
    focusCard(turnId, card.index, { summary: summary.kind === "summary" });
  }

  // A summary keeps its source (§28): save first; a source summarised before shows that summary again.
  async function summarise(turnId, card) {
    const state = cardOf(turnId, card.index);
    if (!isReady() || state.saving || state.summarising || state.summary) return;
    setCard(turnId, card.index, { summarising: true, note: "" });
    onChange();
    const mine = generation;
    const saved = await ensureSaved(turnId, card);
    if (!saved) { onChange(); return; }
    let summary = null;
    if (saved.summaryId) {
      const opened = await api.openItem("notebook", saved.summaryId);
      if (mine !== generation) return;
      if (opened.kind === "ok" && opened.body?.item) summary = summaryFromEntry(opened.body.item, card);
    }
    if (summary?.kind !== "summary") {
      const result = await api.summariseSource(saved.sourceId);
      if (mine !== generation) return;
      if (result.kind !== "ok") { failed(turnId, card.index, result); onChange(); return; }
      summary = summaryFromResult(result.body, card);
    }
    show(turnId, card, summary);
  }

  // A-010: text he pasted from the source goes to the tutor once; only the summary is kept.
  async function paste(turnId, card, text) {
    const state = cardOf(turnId, card.index);
    if (!isReady() || state.saving || state.summarising || !state.sourceId) return;
    const checked = checkPasted(text);
    if (checked.error) { setCard(turnId, card.index, { note: checked.error }); onChange(); return; }
    setCard(turnId, card.index, { summarising: true, note: "" });
    onChange();
    const mine = generation;
    const result = await api.summariseSource(state.sourceId, { text: checked.text });
    if (mine !== generation) return;
    if (result.kind !== "ok") { failed(turnId, card.index, result); onChange(); return; }
    show(turnId, card, summaryFromResult(result.body, card));
  }

  return {
    /** The cards under one tutor turn, or null when it has none. */
    render(turn) {
      return sourceList(doc, turn, {
        stateOf: (index) => cardOf(turn.id, index),
        onSave: (card) => save(turn.id, card),
        onSummarise: (card) => summarise(turn.id, card),
        onPaste: (card, text) => paste(turn.id, card, text),
        onPasteChange: (card, changes) => setCard(turn.id, card.index, changes),
        ready: isReady(),
        onAttach: canAttach() ? (card, sourceId) => onAttach(card, sourceId) : null,
      });
    },
    clear() { generation += 1; cards.clear(); },
  };
}
