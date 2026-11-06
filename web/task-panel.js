// Learner page: the task panel at the top of a conversation about a task (WP-114e; build spec §9,
// §10, §26, §28; A-010). The task's title, subject, due date and stage are always shown; the question,
// the sources saved for the task and (WP-115) his notes each sit in a collapsed section, so the
// conversation isn't pushed down on a phone. He can add a source he found himself and get an AI
// summary of text he pastes from it. The rules and wording are in shared/task-panel.js. Nothing here
// is kept in browser storage, and all text is shown with textContent, never as HTML.
import { ukToday } from "./shared/upcoming.js";
import {
  FINAL_SUMMARY_OUTCOMES,
  PASTE_OUTCOMES,
  SOURCE_MESSAGES,
  checkPasted,
  sourceErrorMessage,
  summaryFromEntry,
  summaryFromResult,
} from "./shared/conversation.js";
import { PANEL_MESSAGES, ownSourceBody, panelFacts, panelSources } from "./shared/task-panel.js";
import { make, pasteBox, sourceLink, summaryCard } from "./source-parts.js";

const READY_STATES = new Set(["ready", "readyNoAi"]);

function setText(element, text) {
  if (element.textContent !== text) element.textContent = text;
}

/**
 * The saved sources as list items. stateOf(id) → { summary?, summaryOpen?, working?, asked?, note?,
 * canPaste?, pasteText?, pasteOpen? }. Exported for tests.
 */
export function sourceItems(doc, sources, {
  stateOf = () => ({}), ready = true, onSummarise = () => {}, onPaste = () => {}, onChange = () => {}, onOpenSummary = () => {},
} = {}) {
  return sources.map((source) => {
    const state = stateOf(source.id) ?? {};
    const key = `panel-${source.id}`;
    const item = make(doc, "li", { className: "source-card", attrs: { id: `source-${key}`, tabindex: "-1" } });
    item.append(make(doc, "p", { className: "source-kind", text: source.kind }));
    const title = make(doc, "p", { className: "source-title" });
    if (source.url) title.append(sourceLink(doc, source.title, source.url));
    else title.textContent = source.title;
    item.append(title);
    if (source.byline) item.append(make(doc, "p", { className: "source-site", text: source.byline }));
    const working = Boolean(state.working);
    if (source.summaryId || state.summary) {
      // an earlier AI summary, opened on request so the list stays short
      const box = make(doc, "details", { className: "more" });
      if (state.summaryOpen) box.setAttribute("open", "");
      box.addEventListener("toggle", () => onOpenSummary(source, box.open === true));
      box.append(make(doc, "summary", { text: PANEL_MESSAGES.openSummary }));
      if (state.summary) box.append(summaryCard(doc, state.summary, key));
      else if (state.summaryOpen) box.append(make(doc, "p", { className: "hint", text: PANEL_MESSAGES.loading }));
      item.append(box);
    } else if (source.canSummarise) {
      if (source.url && !state.asked) {
        const b = make(doc, "button", { className: "secondary", text: working ? SOURCE_MESSAGES.summarising : SOURCE_MESSAGES.summarise, attrs: { type: "button" } });
        b.dataset.action = "summarise";
        b.disabled = !ready || working;
        b.addEventListener("click", () => onSummarise(source));
        const actions = make(doc, "div", { className: "actions source-actions" });
        actions.append(b);
        item.append(actions);
      }
      // a source with no link can only be summarised from pasted text, so the box is always there
      if (!source.url || state.canPaste) {
        item.append(pasteBox(doc, {
          key,
          text: state.pasteText ?? "",
          open: state.pasteOpen === true,
          disabled: !ready || working,
          onChange: (changes) => onChange(source, changes),
          onSubmit: (text) => onPaste(source, text),
        }));
      }
    }
    if (state.note) item.append(make(doc, "p", { className: "source-note", text: state.note }));
    return item;
  });
}

/**
 * Wires up the panel. Returns { show(item | null), setTutor(state), refresh(), clear() }, or null if
 * the page doesn't have it. item: the "Coming up" entry for the task ({ taskId, title, subject,
 * deadline, stage }); null hides the panel (a conversation with no task).
 */
export function createTaskPanel({ api, doc = document, now = () => new Date(), onSignedOut, onUnreachable }) {
  const byId = (id) => doc.getElementById(id);
  const els = {
    panel: byId("task-panel"),
    title: byId("task-panel-title"),
    meta: byId("task-panel-meta"),
    due: byId("task-panel-due"),
    question: byId("task-panel-question"),
    questionText: byId("task-panel-question-text"),
    sources: byId("task-panel-sources"),
    sourcesLabel: byId("task-panel-sources-label"),
    sourcesStatus: byId("task-panel-sources-status"),
    list: byId("task-panel-sources-list"),
    own: byId("own-source"),
    ownForm: byId("own-source-form"),
    ownTitle: byId("own-source-title"),
    ownAuthor: byId("own-source-author"),
    ownUrl: byId("own-source-url"),
    ownAdd: byId("own-source-add"),
    ownStatus: byId("own-source-status"),
  };
  if (Object.values(els).some((el) => !el)) return null;

  let ready = false;
  let busy = false;
  // { item, task, sources, failed }; null when no task is shown
  let current = null;
  const states = new Map(); // source id → its state (memory only)
  const stateOf = (id) => states.get(id) ?? {};
  const setState = (id, changes) => states.set(id, { ...stateOf(id), ...changes });

  function signedOut(reason) {
    clear();
    onSignedOut?.(reason);
  }

  function failedCall(result) {
    if (result.kind === "auth") {
      signedOut(result.reason);
      return null;
    }
    const { message, unreachable } = sourceErrorMessage(result);
    if (unreachable) onUnreachable?.();
    return message;
  }

  function renderSources() {
    if (!current) return;
    const list = current.sources ? panelSources(current.sources) : null;
    setText(els.sourcesLabel, list ? PANEL_MESSAGES.sourcesCount(list.length) : PANEL_MESSAGES.sources);
    let status = "";
    if (!ready && !list) status = PANEL_MESSAGES.waitSources;
    else if (current.failed) status = PANEL_MESSAGES.failed;
    else if (!list) status = PANEL_MESSAGES.loading;
    else if (list.length === 0) status = PANEL_MESSAGES.noSources;
    setText(els.sourcesStatus, status);
    els.list.replaceChildren(...sourceItems(doc, list ?? [], {
      stateOf, ready, onSummarise: summarise, onPaste: paste, onChange: (s, changes) => setState(s.id, changes), onOpenSummary: openSummary,
    }));
    els.ownAdd.disabled = !ready || busy;
  }

  function render() {
    if (!current) return;
    const facts = panelFacts({ task: current.task, item: current.item, today: ukToday(now()) });
    setText(els.title, facts.title);
    setText(els.meta, facts.meta);
    setText(els.due, facts.due);
    let question = facts.question ?? PANEL_MESSAGES.noQuestion;
    if (!facts.loaded) question = current.failed ? PANEL_MESSAGES.failed : ready ? PANEL_MESSAGES.loading : PANEL_MESSAGES.waitQuestion;
    setText(els.questionText, question);
    renderSources();
  }

  async function load() {
    const mine = current;
    if (!mine || !ready) return;
    const [task, sources] = await Promise.all([api.getTask(mine.item.taskId), api.listSources(mine.item.taskId)]);
    if (current !== mine) return;
    for (const result of [task, sources]) {
      if (result.kind === "auth") return signedOut(result.reason);
    }
    mine.failed = task.kind !== "ok" || sources.kind !== "ok";
    if (task.kind === "ok" && task.body?.task) mine.task = task.body.task;
    if (sources.kind === "ok" && Array.isArray(sources.body?.sources)) mine.sources = sources.body.sources;
    if (mine.failed && [task, sources].some((r) => ["network", "no-address", "not-json"].includes(r.kind))) onUnreachable?.();
    render();
  }

  async function openSummary(source, open) {
    setState(source.id, { summaryOpen: open });
    const state = stateOf(source.id);
    if (!open || state.summary || state.loadingSummary || !source.summaryId || !ready) return;
    setState(source.id, { loadingSummary: true });
    renderSources();
    const result = await api.openItem("notebook", source.summaryId);
    setState(source.id, { loadingSummary: false });
    if (result.kind === "ok" && result.body?.item) {
      const summary = summaryFromEntry(result.body.item, source);
      if (summary.kind === "summary") setState(source.id, { summary });
      else setState(source.id, { note: summary.text });
    } else {
      const message = failedCall(result);
      if (message) setState(source.id, { note: message });
    }
    renderSources();
  }

  async function ask(source, body) {
    if (!ready || stateOf(source.id).working) return;
    setState(source.id, { working: true, note: "" });
    renderSources();
    const result = await api.summariseSource(source.id, body);
    setState(source.id, { working: false });
    if (result.kind !== "ok") {
      const message = failedCall(result);
      if (message) setState(source.id, { note: message });
      renderSources();
      return;
    }
    const summary = summaryFromResult(result.body, source);
    if (summary.kind === "summary") {
      setState(source.id, { summary, summaryOpen: true, canPaste: false, pasteText: "", note: "" });
    } else {
      setState(source.id, {
        asked: FINAL_SUMMARY_OUTCOMES.includes(summary.outcome),
        canPaste: PASTE_OUTCOMES.includes(summary.outcome) || stateOf(source.id).canPaste === true,
        note: summary.text,
      });
    }
    renderSources();
    byId(`source-panel-${source.id}`)?.focus();
  }

  function summarise(source) {
    return ask(source, {});
  }

  function paste(source, text) {
    const checked = checkPasted(text);
    if (checked.error) {
      setState(source.id, { note: checked.error });
      renderSources();
      return undefined;
    }
    return ask(source, { text: checked.text });
  }

  els.ownForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!current || !ready || busy) return;
    const checked = ownSourceBody({ title: els.ownTitle.value, author: els.ownAuthor.value, url: els.ownUrl.value });
    if (checked.error) {
      setText(els.ownStatus, checked.error);
      ({ title: els.ownTitle, author: els.ownAuthor, url: els.ownUrl })[checked.field]?.focus();
      return;
    }
    const mine = current;
    busy = true;
    renderSources();
    const result = await api.addOwnSource({ ...checked.body, taskId: mine.item.taskId });
    busy = false;
    if (current !== mine) return;
    if (result.kind !== "ok") {
      const message = failedCall(result);
      if (message) setText(els.ownStatus, message);
      renderSources();
      return;
    }
    els.ownForm.reset();
    setText(els.ownStatus, PANEL_MESSAGES.added);
    await refresh();
  });

  // ---------- public ----------
  function show(item) {
    states.clear();
    busy = false;
    setText(els.ownStatus, "");
    els.ownForm.reset();
    if (!item || typeof item.taskId !== "string") {
      current = null;
      els.panel.hidden = true;
      return undefined;
    }
    current = { item, task: null, sources: null, failed: false };
    // each part starts closed, so the conversation stays near the top on a phone
    for (const box of [els.question, els.sources, els.own]) box.open = false;
    els.panel.hidden = false;
    render();
    return load();
  }

  /** Loads the saved sources again (after a card is saved or summarised in the conversation). */
  async function refresh() {
    const mine = current;
    if (!mine || !ready) return;
    const result = await api.listSources(mine.item.taskId);
    if (current !== mine) return;
    if (result.kind === "auth") return signedOut(result.reason);
    if (result.kind === "ok" && Array.isArray(result.body?.sources)) {
      mine.sources = result.body.sources;
      mine.failed = false;
    }
    renderSources();
  }

  function setTutor(state) {
    const wasReady = ready;
    ready = READY_STATES.has(state);
    render();
    if (ready && !wasReady && current && (!current.task || !current.sources)) return load();
    return undefined;
  }

  function clear() {
    current = null;
    busy = false;
    states.clear();
    els.panel.hidden = true;
    els.list.replaceChildren();
    els.ownForm.reset();
    setText(els.ownStatus, "");
  }

  return { show, setTutor, refresh, clear };
}
