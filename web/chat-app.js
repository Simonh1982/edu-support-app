// WP-131b (A-013): the chat-first learner page. A clean new chat (greeting, small chips, the message
// box), the side menu of chats, tasks and topics, the tutor's status as a dot, and simple task and
// topic pages. Uses the same pass, wake-up, accessibility settings and server routes as the classic
// page (index.html), which stays until WP-134. The message box's "+" menu and help chip (WP-132) and
// the full task and topic pages (WP-133) come next.
import { config } from "./config.js";
import { clearPass, loadPass, usableStorage, workerRequest } from "./shared/auth.js";
import { createWaker, tutorPanel } from "./shared/wake.js";
import { createApi } from "./shared/api.js";
import { createAccessibility } from "./shared/accessibility.js";
import {
  HELPLINES, ROUTE_LABELS, TALK_MESSAGES, checkMessage, learnerLine, routeForStage, safeLink, showsCare, siteOf,
  talkErrorMessage, turnFromReply, turnsFromServer,
} from "./shared/conversation.js";
import { MENU_TEXT, cleanMenu, dueLabel, focusLists, statusOf, whenLabel } from "./shared/menu.js";
import { createSideMenu, make } from "./side-menu.js";
import { STAGE_LABELS } from "./shared/upcoming.js";
import { createChatCards, CARD_TEXT } from "./chat-cards.js";
import { resizeImage } from "./capture.js";

const ROLE = "learner";
const READY_STATES = new Set(["ready", "readyNoAi"]);
// Help types as the chip names them (A-013 §6); Learn something isn't one of the work routes.
export const HELP_LABELS = Object.freeze({ ...ROUTE_LABELS, learn: "Learn something" });
export const CHAT_TEXT = Object.freeze({
  helpAuto: "Help: automatic",
  placeholderNew: "Ask anything…",
  placeholderLearn: "What would you like to learn about?",
  placeholderReply: "Reply…",
  placeholderTask: "Start a chat about this task…",
  waiting: "The tutor is still waking up. Your words are still here: send again in a moment.",
  notReadyChat: "This chat opens once the tutor is ready.",
  rename: "Rename this chat",
  renamed: "Chat renamed.",
  taskPage: "Sources, notes and your plan move onto this page in the next update. For now they're on the classic page.",
  classic: "Open the classic page",
  newTaskSoon: "Adding a task here, by photo, file or pasting, comes in the next update. For now, add it on the classic page.",
  notebookSoon: "Your notebook moves here in a later update. For now it's on the classic page.",
  filesSoon: "Your photos and files move here in a later update. For now they're on the classic page.",
  settingsSoon: "Settings are on the classic page for now.",
  chatsAbout: (n) => `Chats about this task (${n})`,
  topicChats: (n) => `Chats (${n})`,
  topicTasks: (n) => `Tasks (${n})`,
  noChatsYet: "No chats yet. Write below to start one.",
  // WP-132a: the "+" menu
  pasteChip: "Adding a task",
  placeholderPaste: "Paste or type the task here: the whole thing, with any instructions…",
  sourceNeedsTask: "A source belongs to a task. Open the task (or add one with Paste a task) first.",
  sources: "Sources from this reply",
  you: "You",
  tutor: "Tutor",
});

function setText(el, text) {
  if (el && el.textContent !== text) el.textContent = text;
}

export function initChat({ doc = document, win = window } = {}) {
  const byId = (id) => doc.getElementById(id);
  const els = {
    shell: byId("shell"), side: byId("side"), scrim: byId("scrim"), menuOpen: byId("menu-open"), title: byId("top-title"),
    taskChip: byId("task-chip"), dot: byId("tutor-dot"), view: byId("view"), composer: byId("composer"), message: byId("message"),
    send: byId("send"), typeChip: byId("type-chip"), note: byId("composer-note"), signedOut: byId("signed-out"),
    dialog: byId("sign-out-dialog"), dialogCancel: byId("sign-out-cancel"), dialogConfirm: byId("sign-out-confirm"),
    plus: byId("plus"), plusMenu: byId("plus-menu"), cameraInput: byId("camera-input"), galleryInput: byId("gallery-input"),
    fileInput: byId("file-input"), pasteExtra: byId("paste-extra"), pasteDue: byId("paste-due"), pasteCancel: byId("paste-cancel"),
  };
  if (Object.values(els).some((el) => !el)) return null;

  const local = usableStorage(() => win.localStorage);
  const session = usableStorage(() => win.sessionStorage);
  let token = null;
  let backendUrl = null;
  let ready = false;
  let waker = null;
  let menuData = cleanMenu(null);
  let view = { kind: "new" };
  let conv = null; // { id, route, taskId, name, turns, loaded }
  let pendingRoute = null;
  let busy = false;
  let renaming = false;
  let pasteMode = false; // WP-132a: the message box takes a task to add

  const api = createApi({ getBackendUrl: () => backendUrl, getToken: () => token });
  const accessibility = createAccessibility({ workerUrl: config.workerUrl, root: doc.documentElement, local });
  const phone = () => win.matchMedia?.("(max-width: 719px)").matches === true;
  const cards = createChatCards({
    doc, api, workerUrl: config.workerUrl, getToken: () => token, isReady: () => ready, resizeImage,
    onChange: () => render(), onAdded: (task) => taskAdded(task),
  });

  const side = createSideMenu({
    doc,
    root: els.side,
    onOpen: (kind, id) => openItem(kind, id),
    onNewChat: () => newChat(),
    onFoot: (kind) => (kind === "sign-out" ? askSignOut() : show({ kind: "classic", what: kind })),
  });

  // ---------- drawer (phone) ----------
  function openDrawer() {
    els.side.classList.add("open");
    els.scrim.hidden = false;
    els.menuOpen.setAttribute("aria-expanded", "true");
    els.side.querySelector(".menu-new")?.focus();
  }
  function closeDrawer() {
    if (!els.side.classList.contains("open")) return;
    els.side.classList.remove("open");
    els.scrim.hidden = true;
    els.menuOpen.setAttribute("aria-expanded", "false");
  }
  els.menuOpen.addEventListener("click", openDrawer);
  els.scrim.addEventListener("click", () => { closeDrawer(); els.menuOpen.focus(); });
  doc.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && els.side.classList.contains("open")) { closeDrawer(); els.menuOpen.focus(); }
  });

  // ---------- more room on a phone (live check, 29 Nov) ----------
  // The top bar slides away while he scrolls down the chat and comes back as soon as he scrolls up;
  // while he fills in a card, the message box steps aside so the card has the screen.
  // Live check fix: showing or hiding the bar changes the chat's height, which makes the browser move
  // the scroll position, which looked like a scroll the other way: the bar flickered. So the app's own
  // jumps don't count, the knock-on scroll after a change is ignored, and the bar only hides when
  // there is plenty to scroll through.
  const mainEl = els.view.parentElement;
  const SETTLE_MS = 400;
  let lastY = 0;
  let settleUntil = 0;
  function setTopAway(away) {
    if (mainEl.classList.contains("top-away") === away) return;
    mainEl.classList.toggle("top-away", away);
    settleUntil = Date.now() + SETTLE_MS;
  }
  /** The app's own scrolling (to the newest message, or the top): never counts as his. */
  function jumpTo(y) {
    settleUntil = Date.now() + SETTLE_MS;
    els.view.scrollTop = y;
    lastY = els.view.scrollTop;
  }
  els.view.addEventListener("scroll", () => {
    const y = els.view.scrollTop;
    const dy = y - lastY;
    lastY = y;
    if (Date.now() < settleUntil) return;
    const room = els.view.scrollHeight - els.view.clientHeight;
    if (y < 24 || dy < -6) setTopAway(false);
    else if (dy > 6 && y > 64 && room > 240) setTopAway(true);
  }, { passive: true });
  // Nothing may move while he taps: the box stays aside while focus is anywhere in the card (its
  // buttons too), and comes back once he leaves it or the card is finished (found in testing).
  const isField = (el) => Boolean(el?.closest?.(".chat-card") && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  const inCard = (el) => Boolean(el?.closest?.(".chat-card"));
  els.view.addEventListener("focusin", (e) => {
    if (isField(e.target)) mainEl.classList.add("editing-card");
  });
  els.view.addEventListener("focusout", (e) => {
    if (!inCard(e.relatedTarget)) mainEl.classList.remove("editing-card");
  });
  win.addEventListener?.("resize", () => renderTop());

  // ---------- status ----------
  function setStatus(panel) {
    els.dot.dataset.tutor = panel;
    const s = statusOf(panel);
    setText(els.dot.querySelector(".dot-word"), s.word);
    els.dot.setAttribute("aria-label", `Tutor: ${s.word}`);
  }

  // ---------- the menu's data ----------
  async function loadMenu() {
    if (!token) return;
    if (ready) {
      const r = await api.getMenu();
      if (r.kind === "auth") return signedOut();
      if (r.kind === "ok") { menuData = cleanMenu(r.body); side.setMenu(menuData); render(); return; }
    }
    // the tutor is resting: the snapshot's copy, view-only (A-013 §2)
    const r = await workerRequest({ workerUrl: config.workerUrl, path: "snapshot", token });
    if (r.kind === "auth") return signedOut();
    if (r.kind === "ok") { menuData = cleanMenu(r.body); side.setMenu(menuData); render(); }
  }

  // ---------- navigation ----------
  function show(next) {
    if (next.kind !== view.kind || next.id !== view.id) { cards.clear(); pasteMode = false; }
    view = next;
    renaming = false;
    setText(els.note, "");
    side.setCurrent(next.kind === "chat" || next.kind === "task" || next.kind === "topic" ? next : null);
    closeDrawer();
    render();
    jumpTo(next.kind === "chat" ? els.view.scrollHeight : 0);
  }

  function newChat() {
    conv = null;
    pendingRoute = null;
    side.setFocus(null);
    show({ kind: "new" });
    els.message.focus();
  }

  function openItem(kind, id) {
    side.setFocus({ kind, id });
    if (kind === "chat") return openChat(id);
    conv = null;
    show({ kind, id });
    return undefined;
  }

  async function openChat(id) {
    const known = menuData.chats.find((c) => c.id === id);
    conv = { id, route: known?.route ?? null, taskId: known?.taskId ?? null, name: known?.name ?? null, turns: [], loaded: false };
    show({ kind: "chat", id });
    if (!ready) return;
    const r = await api.openConversation(id);
    if (conv?.id !== id) return;
    if (r.kind === "auth") return signedOut();
    if (r.kind !== "ok" || !r.body?.conversation) {
      setText(els.note, talkErrorMessage(r).message);
      return;
    }
    const c = r.body.conversation;
    conv = { id, route: c.route, taskId: c.taskId ?? null, name: c.name ?? known?.name ?? null, turns: turnsFromServer(c), loaded: true };
    render();
    jumpTo(els.view.scrollHeight);
  }

  // ---------- header ----------
  function chatTitle() {
    const known = menuData.chats.find((c) => c.id === conv?.id);
    if (known?.name) return known.name;
    // a task chat not yet in the menu (no reply yet) is named as the server will name it
    const task = conv?.taskId ? menuData.tasks.find((t) => t.id === conv.taskId) : null;
    if (task) return `${task.title} – ${conv.route ?? "chat"}`;
    return conv?.name ?? "Chat";
  }

  function renderTop() {
    els.taskChip.hidden = true;
    if (view.kind === "chat" && conv) {
      const known = menuData.chats.find((c) => c.id === conv.id);
      const renamable = known ? known.renamable : !conv.taskId;
      if (renaming) {
        const input = make(doc, "input", { attrs: { type: "text", maxlength: "60", "aria-label": CHAT_TEXT.rename } });
        input.value = chatTitle();
        let done = false;
        const finish = async (save) => {
          if (done) return;
          done = true;
          renaming = false;
          const name = input.value.replace(/\s+/g, " ").trim();
          if (save && name && name !== chatTitle() && ready) {
            const r = await api.renameChat(conv.id, name);
            if (r.kind === "ok") { conv.name = name; setText(els.note, ""); await loadMenu(); }
            else setText(els.note, talkErrorMessage(r).message);
          }
          render();
        };
        input.addEventListener("keydown", (e) => { if (e.key === "Enter") finish(true); if (e.key === "Escape") finish(false); });
        input.addEventListener("blur", () => finish(true));
        els.title.replaceChildren(input);
        win.setTimeout(() => input.focus(), 0);
      } else {
        const parts = [make(doc, "span", { text: chatTitle() })];
        if (renamable && ready) {
          const pen = make(doc, "button", { className: "icon-button", text: "✎", attrs: { type: "button", "aria-label": CHAT_TEXT.rename } });
          pen.addEventListener("click", () => { renaming = true; renderTop(); });
          parts.push(pen);
        }
        els.title.replaceChildren(...parts);
      }
      const task = conv.taskId ? menuData.tasks.find((t) => t.id === conv.taskId) : null;
      if (task) {
        els.taskChip.hidden = false;
        // on a phone the chat's name already says which task: the button just says "Task" (live check)
        setText(els.taskChip, phone() ? MENU_TEXT.task : task.title);
        els.taskChip.setAttribute("aria-label", `Open the task: ${task.title}`);
      }
    } else {
      const titles = { new: MENU_TEXT.newChat, task: MENU_TEXT.task, topic: "Topic", classic: "" };
      els.title.replaceChildren(make(doc, "span", { text: titles[view.kind] ?? "" }));
    }
  }
  els.taskChip.addEventListener("click", () => { if (conv?.taskId) openItem("task", conv.taskId); });

  // ---------- main views ----------
  /** Turns and cards in the order they happened; a stable sort keeps equal times in place. */
  function timeline(turns, cardList) {
    return [...turns.map((turn, i) => ({ turn, at: turn.at ?? 0, i })), ...cardList.map((card, i) => ({ card, at: card.at ?? 0, i: turns.length + i }))]
      .sort((a, b) => a.at - b.at || a.i - b.i);
  }

  function careBox() {
    const box = make(doc, "div", { className: "care" });
    box.append(make(doc, "p", { text: TALK_MESSAGES.careHeading }));
    const list = make(doc, "ul");
    for (const line of HELPLINES) {
      const li = make(doc, "li");
      li.append(make(doc, "strong", { text: `${line.name}: ` }), make(doc, "a", { text: line.how, attrs: { href: line.href } }));
      list.append(li);
    }
    box.append(list);
    return box;
  }

  function messageItem(turn) {
    const li = make(doc, "li", { className: "message" });
    // his own words (with the invisible ladder, a request for help is his words too)
    const said = turn.learnerText ?? learnerLine(turn, conv?.route);
    if (said) {
      const you = make(doc, "div", { className: "message-you" });
      you.append(make(doc, "p", { text: said, attrs: { "aria-label": `${CHAT_TEXT.you}: ${said}` } }));
      li.append(you);
    }
    if (turn.pending) {
      li.append(make(doc, "p", { className: "thinking", text: TALK_MESSAGES.thinking }));
      return li;
    }
    const tutor = make(doc, "div", { className: "message-tutor", attrs: { id: `turn-${turn.id}`, tabindex: "-1" } });
    tutor.append(make(doc, "p", { className: "who", text: CHAT_TEXT.tutor }));
    tutor.append(make(doc, "p", { className: "text", text: turn.reply ?? TALK_MESSAGES.noReply }));
    if (showsCare(turn)) tutor.append(careBox());
    const links = (turn.sources ?? []).map((s) => ({ s, url: safeLink(s.url) })).filter((x) => x.url);
    if (links.length) {
      tutor.append(make(doc, "p", { className: "who", text: CHAT_TEXT.sources }));
      const ul = make(doc, "ul", { className: "message-sources" });
      for (const { s, url } of links) {
        const item = make(doc, "li");
        item.append(make(doc, "a", { text: s.title ?? siteOf(url), attrs: { href: url, target: "_blank", rel: "noopener noreferrer" } }), make(doc, "span", { text: ` · ${siteOf(url)}` }));
        ul.append(item);
      }
      tutor.append(ul);
    }
    li.append(tutor);
    return li;
  }

  function listButton(label, sub, onClick) {
    const b = make(doc, "button", { attrs: { type: "button" } });
    b.append(make(doc, "span", { text: label }), make(doc, "span", { text: sub }));
    b.addEventListener("click", onClick);
    const li = make(doc, "li");
    li.append(b);
    return li;
  }

  function pageList(heading, items, empty = null) {
    const box = make(doc, "div", { className: "page-list" });
    box.append(make(doc, "h2", { text: heading }));
    if (items.length) { const ul = make(doc, "ul"); ul.append(...items); box.append(ul); }
    else if (empty) box.append(make(doc, "p", { className: "hint", text: empty }));
    return box;
  }

  function classicLink() {
    return make(doc, "a", { className: "button-link", text: CHAT_TEXT.classic, attrs: { href: "./" } });
  }

  function renderView() {
    if (view.kind === "new" && cards.list().length) {
      const col = make(doc, "div", { className: "column" });
      const ol = make(doc, "ol", { className: "messages", attrs: { "aria-label": "Your conversation" } });
      ol.append(...cards.list().map((c) => cards.render(c)));
      col.append(ol);
      return [col];
    }
    if (view.kind === "new") {
      const box = make(doc, "div", { className: "welcome" });
      box.append(make(doc, "h1", { text: MENU_TEXT.greeting, attrs: { tabindex: "-1" } }));
      const chips = make(doc, "div", { className: "chips" });
      const chip = (label, fn) => { const b = make(doc, "button", { className: "chip", text: label, attrs: { type: "button" } }); b.addEventListener("click", fn); chips.append(b); };
      chip(MENU_TEXT.chipTask, () => startPaste());
      chip(MENU_TEXT.chipLearn, () => { pendingRoute = "learn"; render(); els.message.focus(); });
      chip(MENU_TEXT.chipDue, () => { side.showTasks(); if (phone()) openDrawer(); });
      box.append(chips);
      return [box];
    }
    if (view.kind === "chat") {
      const col = make(doc, "div", { className: "column" });
      if (!ready && !conv?.loaded) col.append(make(doc, "p", { className: "hint", text: CHAT_TEXT.notReadyChat }));
      const ul = make(doc, "ol", { className: "messages", attrs: { "aria-label": "Your conversation" } });
      // one timeline in the order things happened: saved turns first (at 0), then this visit's
      // messages and cards, so new messages always go at the bottom (live check, 29 Nov)
      ul.append(...timeline(conv?.turns ?? [], cards.list()).map((x) => (x.card ? cards.render(x.card) : messageItem(x.turn))));
      col.append(ul);
      return [col];
    }
    if (view.kind === "task") {
      const f = focusLists(menuData, view);
      const t = f?.task;
      const col = make(doc, "div", { className: "column page" });
      if (!t) return [col];
      const due = dueLabel(t.deadline);
      col.append(make(doc, "h1", { text: t.title, attrs: { tabindex: "-1" } }), make(doc, "p", { className: "meta", text: [t.subject, due.text, STAGE_LABELS[t.stage] ?? t.stage].filter(Boolean).join(" · ") }));
      col.append(pageList(CHAT_TEXT.chatsAbout(f.chats.length), f.chats.map((c) => listButton(c.name, whenLabel(c.updatedAt), () => openItem("chat", c.id))), CHAT_TEXT.noChatsYet));
      if (f.topics.length) col.append(pageList(MENU_TEXT.topicsLabel, f.topics.map((p) => listButton(p.title, whenLabel(p.lastWorked), () => openItem("topic", p.id)))));
      col.append(make(doc, "p", { className: "hint", text: CHAT_TEXT.taskPage }), classicLink());
      return [col];
    }
    if (view.kind === "topic") {
      const f = focusLists(menuData, view);
      const col = make(doc, "div", { className: "column page" });
      if (!f?.topic) return [col];
      const subject = menuData.subjects.find((s) => s.id === f.topic.qualId)?.label ?? "";
      col.append(make(doc, "h1", { text: f.topic.title, attrs: { tabindex: "-1" } }), make(doc, "p", { className: "meta", text: subject }));
      col.append(pageList(CHAT_TEXT.topicChats(f.chats.length), f.chats.map((c) => listButton(c.name, whenLabel(c.updatedAt), () => openItem("chat", c.id))), MENU_TEXT.noChats));
      col.append(pageList(CHAT_TEXT.topicTasks(f.tasks.length), f.tasks.map((t) => listButton(t.title, dueLabel(t.deadline).text, () => openItem("task", t.id)))));
      return [col];
    }
    // the parts still on the classic page until WP-133 and WP-134
    const col = make(doc, "div", { className: "column page" });
    const text = { task: CHAT_TEXT.newTaskSoon, notebook: CHAT_TEXT.notebookSoon, files: CHAT_TEXT.filesSoon, settings: CHAT_TEXT.settingsSoon }[view.what] ?? "";
    col.append(make(doc, "p", { text }), classicLink());
    return [col];
  }

  function renderComposer() {
    const shown = view.kind === "new" || view.kind === "chat" || view.kind === "task";
    els.composer.hidden = !shown;
    const route = view.kind === "chat" ? conv?.route : pendingRoute;
    setText(els.typeChip, pasteMode ? CHAT_TEXT.pasteChip : route ? HELP_LABELS[route] ?? CHAT_TEXT.helpAuto : CHAT_TEXT.helpAuto);
    els.pasteExtra.hidden = !pasteMode;
    els.message.maxLength = pasteMode ? 20000 : 4000;
    els.message.placeholder = pasteMode ? CHAT_TEXT.placeholderPaste : view.kind === "chat" ? CHAT_TEXT.placeholderReply
      : view.kind === "task" ? CHAT_TEXT.placeholderTask
        : pendingRoute === "learn" ? CHAT_TEXT.placeholderLearn : CHAT_TEXT.placeholderNew;
    els.send.disabled = busy;
    els.message.readOnly = busy;
  }

  function render() {
    renderTop();
    els.view.replaceChildren(...renderView());
    // a finished card takes its focused button with it, so bring the message box back
    if (!inCard(doc.activeElement)) els.view.parentElement.classList.remove("editing-card");
    renderComposer();
  }

  // ---------- sending ----------
  async function routeFor(text) {
    if (view.kind === "task") {
      const task = menuData.tasks.find((t) => t.id === view.id);
      return routeForStage(task?.stage);
    }
    if (pendingRoute) return pendingRoute;
    const r = await api.suggestRoute({ message: text });
    return typeof r.body?.route === "string" ? r.body.route : "research";
  }

  function failed(r) {
    if (r.kind === "auth") return signedOut();
    const { message, unreachable } = talkErrorMessage(r);
    setText(els.note, message);
    if (unreachable) wakeAgain();
    return undefined;
  }

  els.composer.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    if (pasteMode) return sendPaste();
    const checked = checkMessage(els.message.value);
    if (checked.error) { setText(els.note, checked.error); els.message.focus(); return; }
    if (!ready) { setText(els.note, CHAT_TEXT.waiting); return; }
    busy = true;
    setText(els.note, "");
    const text = checked.text;
    let id = view.kind === "chat" ? conv?.id : null;
    if (!id) {
      const route = await routeFor(text);
      const body = { route };
      if (view.kind === "task") body.taskId = view.id;
      const started = await api.startConversation(body);
      if (started.kind !== "ok" || typeof started.body?.conversation?.id !== "string") { busy = false; renderComposer(); return failed(started); }
      id = started.body.conversation.id;
      conv = { id, route, taskId: body.taskId ?? null, name: null, turns: [], loaded: true };
      pendingRoute = null;
      side.setFocus({ kind: "chat", id });
      view = { kind: "chat", id };
      side.setCurrent(view);
    }
    const mine = conv;
    const sentAt = Date.now();
    mine.turns.push({ id: `pending-${sentAt}`, at: sentAt, learnerText: text, pending: true });
    render();
    jumpTo(els.view.scrollHeight);
    const r = await api.sendMessage(id, { text });
    busy = false;
    mine.turns = mine.turns.filter((t) => !t.pending);
    if (r.kind !== "ok") { render(); return failed(r); }
    const turn = turnFromReply(r.body?.turn, { learnerText: text });
    if (turn) mine.turns.push({ ...turn, at: sentAt });
    if (r.body?.conversation?.name) mine.name = r.body.conversation.name;
    els.message.value = "";
    autosize();
    render();
    jumpTo(els.view.scrollHeight);
    if (turn) doc.getElementById(`turn-${turn.id}`)?.focus({ preventScroll: true });
    loadMenu();
    return undefined;
  });

  // ---------- the "+" menu (WP-132a) ----------
  function taskContext() {
    if (view.kind === "task") return view.id;
    return view.kind === "chat" ? conv?.taskId ?? null : null;
  }

  function closePlus({ focus = false } = {}) {
    if (els.plusMenu.hidden) return;
    els.plusMenu.hidden = true;
    els.plus.setAttribute("aria-expanded", "false");
    if (focus) els.plus.focus();
  }
  function openPlus() {
    const source = els.plusMenu.querySelector('[data-add="source"]');
    source?.setAttribute("aria-disabled", String(!taskContext()));
    els.plusMenu.hidden = false;
    els.plus.setAttribute("aria-expanded", "true");
    els.plusMenu.querySelector("button")?.focus();
  }
  els.plus.addEventListener("click", () => (els.plusMenu.hidden ? openPlus() : closePlus({ focus: true })));
  els.plusMenu.addEventListener("keydown", (e) => {
    const items = [...els.plusMenu.querySelectorAll("button")];
    const at = items.indexOf(doc.activeElement);
    if (e.key === "Escape") { e.preventDefault(); closePlus({ focus: true }); }
    if (e.key === "ArrowDown") { e.preventDefault(); items[(at + 1) % items.length]?.focus(); }
    if (e.key === "ArrowUp") { e.preventDefault(); items[(at - 1 + items.length) % items.length]?.focus(); }
  });
  doc.addEventListener("click", (e) => {
    if (!els.plusMenu.hidden && !els.plusMenu.contains(e.target) && !els.plus.contains(e.target)) closePlus();
  });
  els.plusMenu.addEventListener("click", (e) => {
    const what = e.target?.closest?.("[data-add]")?.dataset.add;
    if (!what) return;
    closePlus();
    if (what === "camera") els.cameraInput.click();
    else if (what === "gallery") els.galleryInput.click();
    else if (what === "file") els.fileInput.click();
    else if (what === "paste") startPaste();
    else if (what === "source") {
      const taskId = taskContext();
      if (!taskId) { setText(els.note, CHAT_TEXT.sourceNeedsTask); els.plus.focus(); return; }
      const card = cards.addSource(taskId);
      win.setTimeout(() => doc.getElementById(`${card.key}-title`)?.focus(), 0);
    }
  });
  for (const [input, source] of [[els.cameraInput, "camera"], [els.galleryInput, "gallery"], [els.fileInput, "file"]]) {
    input.addEventListener("change", () => {
      const files = Array.from(input.files ?? []);
      input.value = "";
      if (!files.length) return;
      setText(els.note, "");
      cards.addFiles(files, source);
    });
  }

  function startPaste() {
    pasteMode = true;
    setText(els.note, "");
    renderComposer();
    els.message.focus();
  }
  els.pasteCancel.addEventListener("click", () => { pasteMode = false; els.pasteDue.value = ""; renderComposer(); els.message.focus(); });

  async function sendPaste() {
    if (!ready) { setText(els.note, CHAT_TEXT.waiting); return; }
    busy = true;
    renderComposer();
    const r = await cards.addPaste(els.message.value, els.pasteDue.value);
    busy = false;
    if (r.error) { setText(els.note, r.error); renderComposer(); (r.field === "deadline" ? els.pasteDue : els.message).focus(); return; }
    els.message.value = "";
    els.pasteDue.value = "";
    pasteMode = false;
    autosize();
    render();
    jumpTo(els.view.scrollHeight);
  }

  /** A task he confirmed in a card: link this chat to it, or start a chat on it (A-013 §6). */
  async function taskAdded(task) {
    if (view.kind === "chat" && conv && !conv.taskId) {
      const r = await api.linkChat(conv.id, task.id);
      if (r.kind === "ok") conv.taskId = task.id;
    } else if (view.kind !== "chat" || !conv) {
      const started = await api.startConversation({ route: routeForStage(task.stage), taskId: task.id });
      if (started.kind !== "ok" || typeof started.body?.conversation?.id !== "string") { loadMenu(); return; }
      const keep = cards.list().slice();
      conv = { id: started.body.conversation.id, route: started.body.conversation.route, taskId: task.id, name: null, turns: [], loaded: true };
      view = { kind: "chat", id: conv.id };
      side.setFocus({ kind: "chat", id: conv.id });
      side.setCurrent(view);
      cards.list().splice(0, cards.list().length, ...keep);
    }
    if (conv) conv.turns.push({ id: `local-${Date.now()}`, at: Date.now(), local: true, reply: CARD_TEXT.prompt, sources: [] });
    await loadMenu();
    render();
    jumpTo(els.view.scrollHeight);
    els.message.focus();
  }

  function autosize() {
    els.message.style.height = "auto";
    els.message.style.height = `${Math.min(192, els.message.scrollHeight)}px`;
  }
  els.message.addEventListener("input", autosize);
  els.message.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !phone()) { e.preventDefault(); els.composer.requestSubmit?.(); }
  });

  // ---------- signing out ----------
  function signedOut() {
    clearPass({ role: ROLE, local, session });
    waker?.stop?.();
    els.shell.hidden = true;
    els.signedOut.hidden = false;
    doc.getElementById("signed-out-heading")?.focus();
  }
  function askSignOut() {
    closeDrawer();
    if (typeof els.dialog.showModal === "function") { els.dialog.showModal(); els.dialogCancel.focus(); }
  }
  els.dialogCancel.addEventListener("click", () => els.dialog.close());
  els.dialogConfirm.addEventListener("click", () => { els.dialog.close(); clearPass({ role: ROLE, local, session }); win.location.assign("./"); });

  // ---------- waking the tutor ----------
  function startWaking() {
    waker?.stop?.();
    ready = false;
    setStatus("waking");
    const current = createWaker({ workerUrl: config.workerUrl, token, onUpdate: ({ state }) => setStatus(tutorPanel(state)) });
    waker = current;
    current.run().then((result) => {
      if (waker !== current) return;
      if (result.state === "signedOut") return signedOut();
      setStatus(tutorPanel(result.state));
      if (READY_STATES.has(result.state)) {
        backendUrl = result.backendUrl ?? null;
        ready = true;
        loadMenu();
        if (view.kind === "chat" && conv && !conv.loaded) openChat(conv.id);
        render();
      }
      return undefined;
    }).catch(() => setStatus("offline"));
  }
  function wakeAgain() {
    if (ready) startWaking();
  }

  // ---------- start ----------
  const pass = loadPass({ role: ROLE, local, session });
  if (!pass?.token) {
    els.signedOut.hidden = false;
    return { state: () => ({ view, ready }) };
  }
  token = pass.token;
  els.shell.hidden = false;
  accessibility.start({ token, shared: pass.payload?.shared === true }).catch(() => {});
  render();
  side.render();
  loadMenu();
  startWaking();
  return { state: () => ({ view, ready, conv, menu: menuData }) };
}

if (typeof document !== "undefined" && document.getElementById("shell")) initChat();
