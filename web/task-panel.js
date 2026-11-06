// Learner page: the task panel at the top of a conversation about a task (WP-114e; build spec §9,
// §10, §26, §28; A-010). The task's title, subject, due date and stage are always shown; the question,
// the sources saved for the task and (WP-115) his notes each sit in a collapsed section, so the
// conversation isn't pushed down on a phone. He can add a source he found himself and get an AI
// summary of text he pastes from it. WP-114f: he can change the task's stage here, and attach a copy
// of a source (a PDF, a Word file or photos of the pages), which goes to the Worker inbox like every
// other capture. The rules and wording are in shared/task-panel.js. Nothing here is kept in browser
// storage, and all text is shown with textContent, never as HTML.
import { UPCOMING_MESSAGES, ukToday, updateBody } from "./shared/upcoming.js";
import {
  FINAL_SUMMARY_OUTCOMES,
  PASTE_OUTCOMES,
  SOURCE_MESSAGES,
  checkPasted,
  sourceErrorMessage,
  summaryFromEntry,
  summaryFromResult,
} from "./shared/conversation.js";
import {
  MAX_ATTACHMENTS,
  PANEL_MESSAGES,
  attachInfo,
  attachNote,
  ownSourceBody,
  panelFacts,
  panelSources,
  panelStage,
} from "./shared/task-panel.js";
import { CAPTURE_MESSAGES, FILE_ACCEPT, newClientId, prepareCapture, sendCapture } from "./shared/capture.js";
import { make, pasteBox, sourceLink, summaryCard } from "./source-parts.js";

const READY_STATES = new Set(["ready", "readyNoAi"]);
const NO_COPIES = Object.freeze({ count: 0, state: "none" });
// While a copy is being read, the list is checked again every 10 seconds, for up to 5 minutes.
export const ATTACH_POLL = Object.freeze({ stepMs: 10_000, limit: 30 });

function setText(element, text) {
  if (element.textContent !== text) element.textContent = text;
}

// "Attach a copy": a collapsed box with a file picker and a button (WP-114f).
function attachBox(doc, { key, left, open = false, disabled = false, onToggle = () => {}, onSubmit = () => {} }) {
  const id = `attach-${key}`;
  const box = make(doc, "details", { className: "more attach-source" });
  if (open) box.setAttribute("open", "");
  box.addEventListener("toggle", () => onToggle(box.open === true));
  box.append(make(doc, "summary", { text: PANEL_MESSAGES.attachHeading }));
  box.append(make(doc, "label", { text: PANEL_MESSAGES.attachLabel, attrs: { for: id } }));
  box.append(make(doc, "p", { className: "hint", text: PANEL_MESSAGES.attachHint(left), attrs: { id: `${id}-hint` } }));
  const input = make(doc, "input", { attrs: { id, type: "file", accept: FILE_ACCEPT, multiple: "", "aria-describedby": `${id}-hint` } });
  box.append(input);
  const send = make(doc, "button", { className: "primary", text: PANEL_MESSAGES.attachSend, attrs: { type: "button" } });
  send.dataset.action = "attach";
  send.disabled = disabled;
  send.addEventListener("click", () => onSubmit(Array.from(input.files ?? [])));
  const actions = make(doc, "div", { className: "actions" });
  actions.append(send);
  box.append(actions);
  return box;
}

/**
 * The saved sources as list items. stateOf(id) → { summary?, summaryOpen?, working?, asked?, note?,
 * canPaste?, pasteText?, pasteOpen?, sending?, retry?, attachOpen? }. attachOf(id) → attachInfo().
 * The attach box appears only when canAttach is true. Exported for tests.
 */
export function sourceItems(doc, sources, {
  stateOf = () => ({}), ready = true, onSummarise = () => {}, onPaste = () => {}, onChange = () => {}, onOpenSummary = () => {},
  attachOf = () => NO_COPIES, canAttach = false, onAttach = () => {}, onRetry = () => {},
} = {}) {
  return sources.map((source) => {
    const state = stateOf(source.id) ?? {};
    const copies = attachOf(source.id) ?? NO_COPIES;
    const key = `panel-${source.id}`;
    const item = make(doc, "li", { className: "source-card", attrs: { id: `source-${key}`, tabindex: "-1" } });
    item.append(make(doc, "p", { className: "source-kind", text: source.kind }));
    const title = make(doc, "p", { className: "source-title" });
    if (source.url) title.append(sourceLink(doc, source.title, source.url));
    else title.textContent = source.title;
    item.append(title);
    if (source.byline) item.append(make(doc, "p", { className: "source-site", text: source.byline }));
    const working = Boolean(state.working || state.sending);
    const summarised = Boolean(source.summaryId || state.summary);
    if (summarised) {
      // an earlier AI summary, opened on request so the list stays short
      const box = make(doc, "details", { className: "more" });
      if (state.summaryOpen) box.setAttribute("open", "");
      box.addEventListener("toggle", () => onOpenSummary(source, box.open === true));
      box.append(make(doc, "summary", { text: PANEL_MESSAGES.openSummary }));
      if (state.summary) box.append(summaryCard(doc, state.summary, key));
      else if (state.summaryOpen) box.append(make(doc, "p", { className: "hint", text: PANEL_MESSAGES.loading }));
      item.append(box);
    } else if (source.canSummarise) {
      // a ready copy is read instead of the page (WP-114f), so it can be summarised with or without a link
      if ((source.url || copies.state === "ready") && !state.asked) {
        const b = make(doc, "button", { className: "secondary", text: state.working ? SOURCE_MESSAGES.summarising : SOURCE_MESSAGES.summarise, attrs: { type: "button" } });
        b.dataset.action = "summarise";
        b.disabled = !ready || working || copies.state === "waiting";
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
    const copiesNote = attachNote(copies);
    if (copiesNote) item.append(make(doc, "p", { className: "source-attach-note", text: copiesNote }));
    if (state.note) item.append(make(doc, "p", { className: "source-note", text: state.note }));
    if (state.retry > 0) {
      const again = make(doc, "button", { className: "secondary", text: PANEL_MESSAGES.attachTryAgain, attrs: { type: "button" } });
      again.dataset.action = "retry";
      again.disabled = !ready || working;
      again.addEventListener("click", () => onRetry(source));
      const actions = make(doc, "div", { className: "actions" });
      actions.append(again);
      item.append(actions);
    }
    const left = MAX_ATTACHMENTS - copies.count;
    if (canAttach && source.canSummarise && !summarised && left > 0 && !state.sending && !(state.retry > 0)) {
      item.append(attachBox(doc, {
        key,
        left,
        open: state.attachOpen === true,
        disabled: !ready || working,
        onToggle: (open) => onChange(source, { attachOpen: open }),
        onSubmit: (files) => onAttach(source, files),
      }));
    }
    return item;
  });
}

/**
 * Wires up the panel. Returns { show(item | null), setTutor(state), refresh(), clear() }, or null if
 * the page doesn't have it. item: the "Coming up" entry for the task ({ taskId, title, subject,
 * deadline, stage }); null hides the panel (a conversation with no task).
 * attach (WP-114f): { workerUrl, getToken, resizeImage, prepare?, send? } for sending attached copies
 * to the Worker inbox; without it, nothing can be attached. onTaskChanged() runs after a stage change.
 */
export function createTaskPanel({
  api, doc = document, now = () => new Date(), onSignedOut, onUnreachable, attach = null, onTaskChanged,
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (id) => clearTimeout(id),
}) {
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
  // WP-114f parts: the panel still works on a page without them
  const stageEls = {
    box: byId("task-panel-stage"),
    select: byId("task-panel-stage-select"),
    save: byId("task-panel-stage-save"),
    status: byId("task-panel-stage-status"),
  };
  const hasStage = Object.values(stageEls).every(Boolean);
  const ownFiles = byId("own-source-files");
  const canAttach = Boolean(attach?.workerUrl && typeof attach.getToken === "function");
  const prepare = attach?.prepare ?? prepareCapture;
  const send = attach?.send ?? sendCapture;

  let ready = false;
  let busy = false;
  let stageBusy = false;
  let stageChosen = null;
  let pollTimer = null;
  let polls = 0;
  // { item, task, sources, failed }; null when no task is shown
  let current = null;
  const states = new Map(); // source id → its state (memory only)
  const unsent = new Map(); // source id → copies not sent yet: [{ clientId, prepared }] (memory only)
  const stateOf = (id) => states.get(id) ?? {};
  const setState = (id, changes) => states.set(id, { ...stateOf(id), ...changes });
  const copiesOf = (id) => attachInfo((current?.sources ?? []).find((s) => s?.id === id));

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

  function stopPolling() {
    if (pollTimer !== null) clearTimer(pollTimer);
    pollTimer = null;
  }

  // Checks again while a copy is still being read, so Summarise appears without a reload.
  function schedulePoll() {
    stopPolling();
    if (!current || !ready || polls >= ATTACH_POLL.limit) return;
    if (!(current.sources ?? []).some((s) => attachInfo(s).state === "waiting")) return;
    polls += 1;
    pollTimer = setTimer(() => {
      pollTimer = null;
      refresh();
    }, ATTACH_POLL.stepMs);
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
      stateOf,
      ready,
      onSummarise: summarise,
      onPaste: paste,
      onChange: (s, changes) => setState(s.id, changes),
      onOpenSummary: openSummary,
      attachOf: copiesOf,
      canAttach,
      onAttach: attachTo,
      onRetry: (s) => sendCopies(s.id),
    }));
    els.ownAdd.disabled = !ready || busy;
  }

  function renderStage() {
    if (!hasStage || !current) return;
    stageEls.select.value = stageChosen ?? panelStage({ task: current.task, item: current.item });
    stageEls.select.disabled = !ready || stageBusy;
    stageEls.save.disabled = !ready || stageBusy;
    if (!ready && !stageBusy) setText(stageEls.status, PANEL_MESSAGES.stageWait);
    else if (stageEls.status.textContent === PANEL_MESSAGES.stageWait) setText(stageEls.status, "");
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
    renderStage();
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
    schedulePoll();
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

  // ---------- attached copies (WP-114f) ----------

  /** Prepares chosen files (photos are made smaller on the device), each with a new capture ID. */
  async function prepareCopies(files, left) {
    const list = Array.from(files ?? []);
    if (list.length === 0) return { error: PANEL_MESSAGES.attachNone };
    if (list.length > left) return { error: PANEL_MESSAGES.attachTooMany(left) };
    const out = [];
    for (const file of list) {
      let prepared;
      try {
        prepared = await prepare({ file, resizeImage: attach.resizeImage });
      } catch {
        prepared = { error: "unreadable" };
      }
      if (prepared?.error) return { error: CAPTURE_MESSAGES[prepared.error] ?? CAPTURE_MESSAGES.unreadable };
      out.push({ clientId: newClientId({ source: "attachment" }), prepared });
    }
    return { copies: out };
  }

  /** Sends a source's unsent copies to the Worker inbox, one at a time. A retry reuses each capture ID. */
  async function sendCopies(sourceId) {
    const mine = current;
    const list = unsent.get(sourceId) ?? [];
    if (!mine || !canAttach || list.length === 0 || stateOf(sourceId).sending) return;
    setState(sourceId, { sending: true, retry: 0, note: PANEL_MESSAGES.attachSending(list.length) });
    renderSources();
    const again = [];
    let refused = null;
    for (const copy of list) {
      let result;
      try {
        result = await send({
          workerUrl: attach.workerUrl,
          token: attach.getToken(),
          clientId: copy.clientId,
          mimeType: copy.prepared.mimeType,
          source: copy.prepared.image ? "gallery" : "file",
          contentKind: "source",
          capturedAt: new Date(now()).toISOString(),
          base64: copy.prepared.base64,
        });
      } catch {
        result = { kind: "retry" };
      }
      if (result.kind === "auth") return signedOut(result.reason);
      if (result.kind === "retry") again.push(copy);
      else if (result.kind !== "ok") refused = CAPTURE_MESSAGES[result.kind] ?? CAPTURE_MESSAGES.rejected;
    }
    if (current !== mine) return;
    if (again.length) unsent.set(sourceId, again);
    else unsent.delete(sourceId);
    let note = PANEL_MESSAGES.attachSent;
    if (again.length) note = PANEL_MESSAGES.attachRetry(again.length);
    else if (refused) note = refused;
    setState(sourceId, { sending: false, retry: again.length, note, asked: false, attachOpen: false });
    polls = 0;
    await refresh();
  }

  async function attachTo(source, files) {
    if (!ready || !canAttach || !current || stateOf(source.id).sending) return;
    const mine = current;
    const chosen = await prepareCopies(files, MAX_ATTACHMENTS - copiesOf(source.id).count);
    if (current !== mine) return;
    if (chosen.error) {
      setState(source.id, { note: chosen.error });
      renderSources();
      return;
    }
    setState(source.id, { sending: true, note: PANEL_MESSAGES.attachSending(chosen.copies.length) });
    renderSources();
    const result = await api.attachToSource(source.id, chosen.copies.map((c) => c.clientId));
    setState(source.id, { sending: false });
    if (current !== mine) return;
    if (result.kind !== "ok") {
      const message = failedCall(result);
      if (message) setState(source.id, { note: message });
      renderSources();
      return;
    }
    unsent.set(source.id, chosen.copies);
    await sendCopies(source.id);
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
    // WP-114f: a copy chosen with the form is prepared first, so a problem shows before anything is saved
    const files = canAttach && ownFiles ? Array.from(ownFiles.files ?? []) : [];
    let copies = [];
    if (files.length) {
      const prepared = await prepareCopies(files, MAX_ATTACHMENTS);
      if (current !== mine) return;
      if (prepared.error) {
        busy = false;
        setText(els.ownStatus, prepared.error);
        renderSources();
        ownFiles.focus();
        return;
      }
      copies = prepared.copies;
    }
    const body = { ...checked.body, taskId: mine.item.taskId };
    if (copies.length) body.attachments = copies.map((c) => c.clientId);
    const result = await api.addOwnSource(body);
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
    const sourceId = result.body?.source?.id;
    if (copies.length && typeof sourceId === "string") unsent.set(sourceId, copies);
    await refresh();
    if (copies.length && typeof sourceId === "string") await sendCopies(sourceId);
  });

  // ---------- the stage (WP-114f) ----------
  async function saveStage() {
    if (!current || !ready || stageBusy) return;
    const mine = current;
    const from = { stage: panelStage({ task: mine.task, item: mine.item }), deadline: (mine.task ?? mine.item).deadline ?? null };
    const change = updateBody(from, { stage: stageEls.select.value });
    if (change.unchanged) {
      setText(stageEls.status, UPCOMING_MESSAGES.nothingChanged);
      return;
    }
    if (change.error) {
      setText(stageEls.status, change.error);
      return;
    }
    stageBusy = true;
    setText(stageEls.status, UPCOMING_MESSAGES.saving);
    renderStage();
    const result = await api.updateTask(mine.item.taskId, change.body);
    stageBusy = false;
    if (current !== mine) return;
    if (result.kind !== "ok") {
      const message = failedCall(result);
      if (message) setText(stageEls.status, message);
      renderStage();
      return;
    }
    if (result.body?.task) mine.task = result.body.task;
    mine.item = { ...mine.item, stage: change.body.stage };
    stageChosen = null;
    setText(stageEls.status, change.leaves ? PANEL_MESSAGES.stageLeaves : UPCOMING_MESSAGES.updated);
    render();
    onTaskChanged?.();
  }

  if (hasStage) {
    stageEls.select.addEventListener("change", () => {
      stageChosen = stageEls.select.value;
    });
    stageEls.save.addEventListener("click", () => saveStage());
  }

  // ---------- public ----------
  function show(item) {
    states.clear();
    unsent.clear();
    stopPolling();
    polls = 0;
    busy = false;
    stageBusy = false;
    stageChosen = null;
    setText(els.ownStatus, "");
    if (hasStage) setText(stageEls.status, "");
    els.ownForm.reset();
    if (!item || typeof item.taskId !== "string") {
      current = null;
      els.panel.hidden = true;
      return undefined;
    }
    current = { item, task: null, sources: null, failed: false };
    // each part starts closed, so the conversation stays near the top on a phone
    for (const box of [els.question, els.sources, els.own, hasStage ? stageEls.box : null]) if (box) box.open = false;
    els.panel.hidden = false;
    render();
    return load();
  }

  /** Loads the saved sources again (after a card is saved or summarised, or while a copy is read). */
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
    schedulePoll();
  }

  function setTutor(state) {
    const wasReady = ready;
    ready = READY_STATES.has(state);
    if (!ready) stopPolling();
    render();
    if (ready && !wasReady && current && (!current.task || !current.sources)) return load();
    if (ready && !wasReady) schedulePoll();
    return undefined;
  }

  function clear() {
    current = null;
    busy = false;
    stageBusy = false;
    stageChosen = null;
    stopPolling();
    states.clear();
    unsent.clear();
    els.panel.hidden = true;
    els.list.replaceChildren();
    els.ownForm.reset();
    setText(els.ownStatus, "");
    if (hasStage) setText(stageEls.status, "");
  }

  return { show, setTutor, refresh, clear };
}
