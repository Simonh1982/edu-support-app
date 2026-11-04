// Learner page: "Get help with a task" and the conversation screen (WP-111b; build spec §6.1, §9, §10,
// §20–§23.1, §31). The rules and wording are in shared/conversation.js; the server enforces attempt
// before help and the order of the pairs. He can write his attempt while the tutor wakes (§6.1); it
// sends once the tutor's ready. Nothing here is kept in browser storage, and all text from him or the
// tutor is shown with textContent, never as HTML.
// WP-114b: source cards under research replies, with Save and Summarise; summaries show as AI cards.
import { apiErrorMessage } from "./shared/api.js";
import { dueText, ukToday } from "./shared/upcoming.js";
import {
  HELPLINES,
  ROUTE_LABELS,
  SOURCE_MESSAGES,
  TALK_MESSAGES,
  TASK_BUTTONS,
  VOTE_LABELS,
  canEscape,
  cardKey,
  checkMessage,
  isWorkRoute,
  learnerLine,
  nextVote,
  promptFor,
  routeChoices,
  shownVote,
  showsCare,
  sourceErrorMessage,
  sourceLabel,
  summaryFromEntry,
  summaryFromResult,
  supportHeading,
  supportLabel,
  talkErrorMessage,
  taskChoices,
  turnFromReply,
  turnsFromServer,
} from "./shared/conversation.js";

const READY_STATES = new Set(["ready", "readyNoAi"]);

function setText(element, text) {
  if (element.textContent !== text) element.textContent = text;
}

function make(doc, tag, { className, text, attrs } = {}) {
  const el = doc.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  for (const [key, value] of Object.entries(attrs ?? {})) el.setAttribute(key, value);
  return el;
}

function button(doc, text, { className = "secondary", label } = {}) {
  const el = make(doc, "button", { className, text, attrs: { type: "button" } });
  if (label) el.setAttribute("aria-label", label);
  return el;
}

// A link to a source, opened in a new tab so the conversation stays put.
function sourceLink(doc, text, url) {
  const link = make(doc, "a", { text, attrs: { href: url, target: "_blank", rel: "noopener noreferrer" } });
  link.append(make(doc, "span", { className: "visually-hidden", text: ` ${SOURCE_MESSAGES.newTab}` }));
  return link;
}

// An AI summary (build spec §28): a tinted card whose label "AI summary" is text, not colour alone.
function summaryCard(doc, summary, key) {
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
 * The source cards under a tutor reply (build spec §9.1, §26): the kind of source, a link to the
 * original, the site, a line on what it covers, then Save and Summarise. Exported for tests.
 * stateOf(index) → { sourceId?, saving?, summarising?, summary?, asked?, note? }.
 */
export function sourceList(doc, turn, { stateOf = () => ({}), onSave = () => {}, onSummarise = () => {}, ready = true } = {}) {
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
    item.append(make(doc, "p", { className: "source-kind", text: sourceLabel(card.category) }));
    const title = make(doc, "p", { className: "source-title" });
    title.append(sourceLink(doc, card.title, card.url));
    item.append(title);
    item.append(make(doc, "p", { className: "source-site", text: card.publisher ? `${card.publisher} · ${card.site}` : card.site }));
    if (card.why) item.append(make(doc, "p", { className: "source-why", text: `${SOURCE_MESSAGES.why} ${card.why}` }));
    const working = Boolean(state.saving || state.summarising);
    const buttons = [];
    if (!state.sourceId) {
      const save = button(doc, state.saving ? SOURCE_MESSAGES.saving : SOURCE_MESSAGES.save);
      save.dataset.action = "save";
      save.disabled = !ready || working;
      save.addEventListener("click", () => onSave(card));
      buttons.push(save);
    }
    if (!state.summary && !state.asked) {
      const summarise = button(doc, state.summarising ? SOURCE_MESSAGES.summarising : SOURCE_MESSAGES.summarise);
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
    if (state.summary) item.append(summaryCard(doc, state.summary, key));
    cards.append(item);
  }
  section.append(cards);
  return section;
}

/**
 * Wires up "Get help with a task" (in the work view) and the conversation view. getTasks() gives the
 * entries "Coming up" last showed. onUnreachable() is called when the tutor stops answering, so the
 * page can wake it again. Returns { setTutor(state), start(), stop(), refreshTasks() }, or null if the
 * page doesn't have the sections.
 */
export function createConversation({ api, home, getTasks = () => [], onSignedOut, onUnreachable, doc = document, now = () => new Date() }) {
  const byId = (id) => doc.getElementById(id);
  const els = {
    helpTasks: byId("help-tasks"),
    helpAll: byId("help-all"),
    helpOther: byId("help-other"),
    helpForm: byId("help-other-form"),
    helpText: byId("help-other-text"),
    helpStatus: byId("help-status"),
    back: byId("talk-back"),
    heading: byId("talk-heading"),
    task: byId("talk-task"),
    routes: byId("talk-routes"),
    routeButtons: byId("talk-route-buttons"),
    turns: byId("talk-turns"),
    form: byId("talk-form"),
    label: byId("talk-prompt-label"),
    hint: byId("talk-prompt-hint"),
    text: byId("talk-text"),
    send: byId("talk-send"),
    escape: byId("talk-escape"),
    support: byId("talk-support"),
    supportHeading: byId("support-heading"),
    supportButtons: byId("talk-support-buttons"),
    status: byId("talk-status"),
    error: byId("talk-error"),
  };
  if (Object.values(els).some((el) => !el) || !home) return null;

  let ready = false;
  let active = false;
  let busy = false;
  let showAll = false;
  // { route, taskId, title, conversationId, view, turns, asked }; null when no conversation is open
  let session = null;
  const votes = new Map(); // turn id → up | down | removed (kept in memory only)
  const cards = new Map(); // cardKey → { sourceId, summaryId, saving, summarising, summary, asked, note } (memory only)

  function signedOut(reason) {
    stop();
    onSignedOut?.(reason);
  }

  // ---------- "Get help with a task" ----------
  function dueOf(deadline) {
    try {
      return deadline ? dueText(deadline, ukToday(now())) : "";
    } catch {
      return "";
    }
  }

  function refreshTasks() {
    if (!active) return;
    const choices = taskChoices(getTasks?.() ?? [], { dueOf });
    const shown = showAll ? choices : choices.slice(0, TASK_BUTTONS);
    if (choices.length === 0) {
      els.helpTasks.replaceChildren(make(doc, "li", { className: "hint", text: TALK_MESSAGES.noTasks }));
    } else {
      els.helpTasks.replaceChildren(...shown.map((choice) => {
        const item = make(doc, "li");
        const open = button(doc, "", { className: "secondary task-choice" });
        open.append(make(doc, "span", { className: "task-choice-title", text: choice.title }));
        if (choice.due) open.append(make(doc, "span", { className: "task-choice-due", text: choice.due }));
        open.addEventListener("click", () => openTalk({ taskId: choice.taskId, title: choice.title, route: choice.route }));
        item.append(open);
        return item;
      }));
    }
    els.helpAll.hidden = showAll || choices.length <= TASK_BUTTONS;
    setText(els.helpAll, TALK_MESSAGES.showAll(choices.length));
  }

  els.helpAll.addEventListener("click", () => {
    showAll = true;
    refreshTasks();
    els.helpTasks.querySelectorAll("button")[TASK_BUTTONS]?.focus();
  });

  els.helpOther.addEventListener("click", () => {
    const opening = els.helpForm.hidden;
    els.helpForm.hidden = !opening;
    els.helpOther.setAttribute("aria-expanded", String(opening));
    if (opening) els.helpText.focus();
  });

  // Something else: the light model suggests a route when the tutor is ready; otherwise he starts in
  // "Understand and research it" and can switch. His words go into the writing box for him to send.
  els.helpForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    const checked = checkMessage(els.helpText.value);
    if (checked.error) {
      setText(els.helpStatus, checked.error);
      els.helpText.focus();
      return;
    }
    let route = "research";
    let sendNow = false;
    if (ready) {
      busy = true;
      setText(els.helpStatus, "Finding the best place to start…");
      const result = await api.suggestRoute({ message: checked.text });
      busy = false;
      if (!active) return;
      if (result.kind === "auth") return signedOut(result.reason);
      if (result.kind === "ok" && isWorkRoute(result.body?.route)) route = result.body.route;
      sendNow = result.kind === "ok" && result.body?.sendNow === true;
    }
    setText(els.helpStatus, "");
    els.helpText.value = "";
    els.helpForm.hidden = true;
    els.helpOther.setAttribute("aria-expanded", "false");
    openTalk({ taskId: null, title: null, route, draft: checked.text });
    // a personal message goes straight to the tutor, which replies with care (blueprint §7.10)
    if (sendNow) await sendText(checked.text);
  });

  // ---------- the conversation view ----------
  function openTalk({ taskId, title, route, draft = "" }) {
    const same = session && session.taskId === taskId && session.route === route && session.conversationId;
    if (!same) {
      session = { route, taskId, title, conversationId: null, view: null, turns: [], asked: false };
      els.text.value = draft;
      setText(els.status, "");
    } else if (draft && !els.text.value) {
      els.text.value = draft;
    }
    setText(els.error, "");
    render();
    home.show("talk");
  }

  /** Switching route before the conversation starts keeps whatever he has written. */
  function switchRoute(route) {
    if (!session || session.conversationId || busy) return;
    session = { ...session, route };
    render();
    els.heading.focus();
  }

  function voteButtons(turn) {
    const group = make(doc, "div", { className: "votes", attrs: { role: "group", "aria-label": "Was this reply helpful?" } });
    const current = shownVote(votes.get(turn.id));
    for (const choice of ["up", "down"]) {
      const b = button(doc, VOTE_LABELS[choice].text, { className: "vote", label: VOTE_LABELS[choice].label });
      b.setAttribute("aria-pressed", String(current === choice));
      b.dataset.vote = choice;
      b.addEventListener("click", () => castVote(turn.id, choice));
      group.append(b);
    }
    return group;
  }

  // Level 3: the UK helplines, always shown beside the reply (build spec §32.1). Real links, so a tap
  // rings or texts straight away.
  function careBox() {
    const box = make(doc, "div", { className: "care" });
    box.append(make(doc, "p", { className: "care-heading", text: TALK_MESSAGES.careHeading }));
    const list = make(doc, "ul");
    for (const line of HELPLINES) {
      const item = make(doc, "li");
      item.append(make(doc, "strong", { text: `${line.name}: ` }), make(doc, "a", { text: line.how, attrs: { href: line.href } }));
      list.append(item);
    }
    box.append(list);
    return box;
  }

  function turnItem(turn) {
    const item = make(doc, "li", { className: "turn" });
    const said = learnerLine(turn, session.route);
    if (said) {
      const you = make(doc, "div", { className: "turn-you" });
      you.append(make(doc, "p", { className: "turn-who", text: "You" }), make(doc, "p", { className: "turn-text", text: said }));
      item.append(you);
    }
    const tutor = make(doc, "div", { className: "turn-tutor", attrs: { id: `turn-${turn.id}`, tabindex: "-1" } });
    tutor.append(make(doc, "p", { className: "turn-who", text: "Tutor" }));
    if (turn.reply) tutor.append(make(doc, "p", { className: "turn-text", text: turn.reply }));
    else tutor.append(make(doc, "p", { className: "hint", text: TALK_MESSAGES.noReply }));
    if (showsCare(turn)) tutor.append(careBox());
    const sources = sourceList(doc, turn, {
      stateOf: (index) => cards.get(cardKey(turn.id, index)),
      onSave: (card) => saveCard(turn.id, card),
      onSummarise: (card) => summariseCard(turn.id, card),
      ready,
    });
    if (sources) tutor.append(sources);
    if (turn.reply) tutor.append(voteButtons(turn));
    item.append(tutor);
    return item;
  }

  function render() {
    if (!session) return;
    const { route, view } = session;
    setText(els.heading, ROUTE_LABELS[route] ?? ROUTE_LABELS.research);
    setText(els.task, session.title ? TALK_MESSAGES.workingOn(session.title) : TALK_MESSAGES.noTask);

    // other routes are offered only until the first send
    const others = routeChoices(route).filter((r) => r !== route);
    els.routes.hidden = Boolean(session.conversationId);
    els.routeButtons.replaceChildren(...others.map((r) => {
      const b = button(doc, ROUTE_LABELS[r]);
      b.disabled = busy;
      b.addEventListener("click", () => switchRoute(r));
      return b;
    }));

    els.turns.replaceChildren(...session.turns.map(turnItem));
    els.turns.hidden = session.turns.length === 0;

    const prompt = promptFor(view, route, { asked: session.asked });
    setText(els.label, prompt.label);
    setText(els.hint, ready ? prompt.hint : `${prompt.hint} ${TALK_MESSAGES.waitForTutor}`);
    els.text.readOnly = busy;
    els.send.disabled = busy || !ready;
    els.escape.hidden = !canEscape(view);
    els.escape.disabled = busy || !ready;

    const offered = Array.isArray(view?.offered) ? view.offered : [];
    els.support.hidden = offered.length === 0;
    setText(els.supportHeading, supportHeading(offered));
    els.supportButtons.replaceChildren(...offered.map((type) => {
      const b = button(doc, supportLabel(route, type), { className: "primary" });
      b.dataset.type = type;
      b.disabled = busy || !ready;
      b.addEventListener("click", () => askForSupport(type));
      return b;
    }));
  }

  function setBusy(on) {
    busy = on;
    setText(els.status, on ? TALK_MESSAGES.thinking : "");
    render();
  }

  function failed(result) {
    if (result.kind === "auth") {
      signedOut(result.reason);
      return;
    }
    const { message, unreachable } = talkErrorMessage(result);
    setText(els.error, message);
    if (unreachable) onUnreachable?.();
  }

  function focusTurn(turnId) {
    byId(`turn-${turnId}`)?.focus();
  }

  /** Starts the conversation on the first send; true once it exists. */
  async function ensureConversation(mine) {
    if (session.conversationId) return true;
    const body = { route: session.route };
    if (session.taskId) body.taskId = session.taskId;
    const result = await api.startConversation(body);
    if (session !== mine) return false;
    if (result.kind !== "ok" || typeof result.body?.conversation?.id !== "string") {
      failed(result);
      return false;
    }
    session.conversationId = result.body.conversation.id;
    session.view = result.body.conversation;
    return true;
  }

  els.form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!session || busy || !ready) return undefined;
    const checked = checkMessage(els.text.value);
    if (checked.error) {
      setText(els.error, checked.error);
      els.text.focus();
      return undefined;
    }
    return sendText(checked.text);
  });

  /** Sends what he wrote. The writing box clears only once the tutor has answered. */
  async function sendText(text) {
    if (!session || busy || !ready) return;
    const mine = session;
    setText(els.error, "");
    setBusy(true);
    if (!(await ensureConversation(mine))) {
      if (session === mine) setBusy(false);
      return;
    }
    const result = await api.sendMessage(mine.conversationId, { text });
    if (session !== mine) return;
    setBusy(false);
    if (result.kind !== "ok") return failed(result);
    mine.view = result.body?.conversation ?? mine.view;
    const turn = turnFromReply(result.body?.turn, { learnerText: text });
    if (turn) mine.turns.push(turn);
    els.text.value = "";
    render();
    if (turn) focusTurn(turn.id);
  }

  // "I don't know where to start": Break it down only (build spec §21.1). No tutor call.
  els.escape.addEventListener("click", async () => {
    if (!session || busy || !ready) return;
    const mine = session;
    setText(els.error, "");
    setBusy(true);
    if (!(await ensureConversation(mine))) {
      if (session === mine) setBusy(false);
      return;
    }
    const result = await api.sendMessage(mine.conversationId, { escape: true });
    if (session !== mine) return;
    setBusy(false);
    if (result.kind !== "ok") return failed(result);
    mine.view = result.body?.conversation ?? mine.view;
    render();
    setText(els.status, TALK_MESSAGES.escapeNote);
    els.supportButtons.querySelector("button")?.focus();
  });

  async function askForSupport(type) {
    if (!session?.conversationId || busy || !ready) return;
    const mine = session;
    setText(els.error, "");
    setBusy(true);
    const result = await api.requestSupport(mine.conversationId, type);
    if (session !== mine) return;
    setBusy(false);
    if (result.kind !== "ok") return failed(result);
    mine.view = result.body?.conversation ?? mine.view;
    mine.asked = true;
    const turn = turnFromReply(result.body?.turn);
    if (turn) mine.turns.push(turn);
    render();
    if (turn) focusTurn(turn.id);
  }

  // Thumbs up or down (A-007): shown at once, put back if it didn't save. Never sent to the model.
  async function castVote(turnId, tapped) {
    if (!ready) {
      setText(els.error, TALK_MESSAGES.voteFailed);
      return;
    }
    const before = votes.get(turnId) ?? null;
    const vote = nextVote(before, tapped);
    votes.set(turnId, vote);
    render();
    doc.querySelector(`#turn-${turnId} button[data-vote="${tapped}"]`)?.focus();
    const result = await api.vote(turnId, vote);
    if (result.kind === "auth") return signedOut(result.reason);
    if (result.kind !== "ok") {
      if (before === null) votes.delete(turnId);
      else votes.set(turnId, before);
      render();
      setText(els.error, result.kind === "http" ? apiErrorMessage(result) : TALK_MESSAGES.voteFailed);
    }
  }

  // ---------- source cards (WP-114b) ----------
  const cardOf = (turnId, index) => cards.get(cardKey(turnId, index)) ?? {};
  function setCard(turnId, index, changes) {
    cards.set(cardKey(turnId, index), { ...cardOf(turnId, index), ...changes });
  }

  function focusCard(turnId, index, { summary = false } = {}) {
    const key = `${turnId}-${index}`;
    const target = (summary && byId(`summary-${key}`)) || byId(`source-${key}`);
    target?.focus();
  }

  function cardFailed(turnId, index, result) {
    if (result.kind === "auth") {
      signedOut(result.reason);
      return;
    }
    const { message, unreachable } = sourceErrorMessage(result);
    setCard(turnId, index, { saving: false, summarising: false, note: message });
    if (unreachable) onUnreachable?.();
  }

  /** Makes the Source record if it isn't there yet; the card's state afterwards, or null. */
  async function ensureSaved(turnId, card) {
    const known = cardOf(turnId, card.index);
    if (known.sourceId) return known;
    const result = await api.saveSource({ turnId, index: card.index });
    if (!active) return null;
    if (result.kind !== "ok" || typeof result.body?.source?.id !== "string") {
      cardFailed(turnId, card.index, result);
      return null;
    }
    const source = result.body.source;
    setCard(turnId, card.index, { sourceId: source.id, summaryId: typeof source.summaryId === "string" ? source.summaryId : null });
    return cardOf(turnId, card.index);
  }

  async function saveCard(turnId, card) {
    if (!ready || !active) return;
    const state = cardOf(turnId, card.index);
    if (state.saving || state.summarising || state.sourceId) return;
    setCard(turnId, card.index, { saving: true, note: "" });
    render();
    const saved = await ensureSaved(turnId, card);
    if (!active) return;
    if (saved) setCard(turnId, card.index, { saving: false, note: SOURCE_MESSAGES.saved });
    render();
    focusCard(turnId, card.index);
  }

  // Summarise: saves the card first (a summary keeps its source, build spec §28). A card saved and
  // summarised before shows that summary again rather than making a second one.
  async function summariseCard(turnId, card) {
    if (!ready || !active) return;
    const state = cardOf(turnId, card.index);
    if (state.saving || state.summarising || state.summary) return;
    setCard(turnId, card.index, { summarising: true, note: "" });
    render();
    const saved = await ensureSaved(turnId, card);
    if (!active) return;
    if (!saved) {
      render();
      focusCard(turnId, card.index);
      return;
    }
    let summary = null;
    if (saved.summaryId) {
      const opened = await api.openItem("notebook", saved.summaryId);
      if (!active) return;
      if (opened.kind === "ok" && opened.body?.item) summary = summaryFromEntry(opened.body.item, card);
    }
    if (summary?.kind !== "summary") {
      const result = await api.summariseSource(saved.sourceId);
      if (!active) return;
      if (result.kind !== "ok") {
        cardFailed(turnId, card.index, result);
        render();
        focusCard(turnId, card.index);
        return;
      }
      summary = summaryFromResult(result.body, card);
    }
    if (summary.kind === "summary") {
      setCard(turnId, card.index, { summarising: false, summary, summaryId: summary.id, note: "" });
    } else {
      // nothing saved: "read the original" and "too close" are final; "couldn't open it" can be tried again
      setCard(turnId, card.index, { summarising: false, asked: summary.outcome === "read-original" || summary.outcome === "too-close", note: summary.text });
    }
    render();
    focusCard(turnId, card.index, { summary: summary.kind === "summary" });
  }

  els.back.addEventListener("click", () => home.show("work"));

  /** After the tutor wakes again, carry on from the saved turns (blueprint §9.2). */
  async function resume() {
    const mine = session;
    if (!mine?.conversationId) return;
    const result = await api.openConversation(mine.conversationId);
    if (session !== mine || result.kind !== "ok" || !result.body?.conversation) return;
    const conversation = result.body.conversation;
    const before = mine.turns.length;
    mine.view = conversation;
    mine.turns = turnsFromServer(conversation);
    mine.asked = mine.turns.some((t) => t.action === "support");
    render();
    if (mine.turns.length !== before) setText(els.status, TALK_MESSAGES.resumed);
  }

  // ---------- public ----------
  function setTutor(state) {
    const wasReady = ready;
    ready = READY_STATES.has(state);
    render();
    if (ready && !wasReady && active) return resume();
    return undefined;
  }

  function start() {
    active = true;
    showAll = false;
    refreshTasks();
  }

  function stop() {
    active = false;
    busy = false;
    showAll = false;
    session = null;
    votes.clear();
    cards.clear();
    els.helpTasks.replaceChildren();
    els.helpAll.hidden = true;
    els.helpForm.hidden = true;
    els.helpForm.reset();
    els.helpOther.setAttribute("aria-expanded", "false");
    setText(els.helpStatus, "");
    els.turns.replaceChildren();
    els.supportButtons.replaceChildren();
    els.routeButtons.replaceChildren();
    els.support.hidden = true;
    els.text.value = "";
    els.text.readOnly = false;
    setText(els.status, "");
    setText(els.error, "");
  }

  return { setTutor, start, stop, refreshTasks };
}
