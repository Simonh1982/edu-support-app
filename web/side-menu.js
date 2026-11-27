// WP-131b (A-013 §3): the side menu. Top level: New chat, Search, subject buttons (opens on All),
// Chats (3 newest), Tasks (3 due soonest, Done closed at the bottom) and Topics (closed). Choosing a
// chat, task or topic opens it and shows its focus level, with a way back. Built with textContent
// only (never parsed markup); every control is a labelled button; the sections use aria-expanded.
import { MENU_SHOW, MENU_TEXT, menuLists, focusLists, whenLabel, dueLabel } from "./shared/menu.js";

// Icons are plain characters, hidden from screen readers (the buttons carry words).
const ICONS = Object.freeze({ chev: "›", back: "‹", newc: "+" });

export function make(doc, tag, { className, text, attrs } = {}) {
  const el = doc.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  for (const [k, v] of Object.entries(attrs ?? {})) if (v !== null && v !== undefined) el.setAttribute(k, v);
  return el;
}

function icon(doc, name) {
  return make(doc, "span", { className: `icon icon-${name}`, text: ICONS[name], attrs: { "aria-hidden": "true" } });
}

/**
 * root: the menu's <nav>. onOpen(kind, id) opens a chat, task or topic; onNewChat(); onFoot(kind)
 * for notebook | files | settings | sign-out. Returns { setMenu, setCurrent, setFocus, showTasks, render }.
 */
export function createSideMenu({ doc = document, root, onOpen = () => {}, onNewChat = () => {}, onFoot = () => {}, now = () => new Date() }) {
  if (!root) return null;
  let menu = { subjects: [], chats: [], tasks: [], topics: [] };
  let subject = null; // A-013: always opens on All
  let search = "";
  let focus = null; // { kind, id } at the focus level
  let current = null; // { kind, id } open in the main window
  const open = { chats: false, tasks: false, topics: false, done: false };

  const isCurrent = (kind, id) => (current?.kind === kind && current?.id === id ? "page" : null);

  function item(kind, id, title, sub, { soon = false } = {}) {
    const b = make(doc, "button", { className: "menu-item", attrs: { type: "button", "aria-current": isCurrent(kind, id) } });
    b.dataset.kind = kind;
    b.dataset.id = id;
    b.append(make(doc, "span", { className: "menu-item-title", text: title }), make(doc, "span", { className: `menu-item-sub${soon ? " due-soon" : ""}`, text: sub }));
    b.addEventListener("click", () => onOpen(kind, id));
    return b;
  }
  const chatItem = (c) => item("chat", c.id, c.name, `${whenLabel(c.updatedAt, now())}${c.taskId ? "" : ` · ${MENU_TEXT.noTask}`}`);
  const taskItem = (t) => { const due = dueLabel(t.deadline, now()); return item("task", t.id, t.title, `${t.subject ? `${t.subject} · ` : ""}${due.text}`, { soon: due.soon && !["submitted", "done"].includes(t.stage) }); };
  const subjectLabel = (qualId) => menu.subjects.find((s) => s.id === qualId)?.label ?? "";
  const topicItem = (t) => item("topic", t.id, t.title, [subjectLabel(t.qualId), whenLabel(t.lastWorked, now())].filter(Boolean).join(" · "));

  function sectionHead(key, label) {
    const b = make(doc, "button", { className: "menu-section-head", attrs: { type: "button", "aria-expanded": String(open[key]) } });
    b.dataset.section = key;
    b.append(icon(doc, "chev"), make(doc, "span", { text: label }));
    b.addEventListener("click", () => { open[key] = !open[key]; render(); doc.querySelector?.(`[data-section="${key}"]`)?.focus(); });
    return b;
  }

  function section(key, label, items, shown, { extra = null } = {}) {
    const box = make(doc, "div", { className: "menu-section" });
    box.append(sectionHead(key, label));
    const showing = search || open[key] ? items : items.slice(0, shown);
    if (showing.length) {
      const ul = make(doc, "ul", { className: "menu-list" });
      for (const el of showing) { const li = make(doc, "li"); li.append(el); ul.append(li); }
      box.append(ul);
    }
    if (!open[key] && !search && items.length > shown && shown > 0) {
      const more = make(doc, "button", { className: "menu-more", text: MENU_TEXT.showAll(items.length), attrs: { type: "button" } });
      more.addEventListener("click", () => { open[key] = true; render(); });
      box.append(more);
    }
    if (extra) box.append(extra);
    return box;
  }

  function back(label, key) {
    const b = make(doc, "button", { className: "menu-back", attrs: { type: "button" } });
    b.append(icon(doc, "back"), make(doc, "span", { text: label }));
    b.addEventListener("click", () => { focus = null; if (key) open[key] = true; render(); root.querySelector(".menu-new")?.focus(); });
    return b;
  }

  function group(label, els, empty) {
    const box = make(doc, "div", { className: "menu-section" });
    box.append(make(doc, "p", { className: "menu-label", text: label }));
    if (els.length) {
      const ul = make(doc, "ul", { className: "menu-list" });
      for (const el of els) { const li = make(doc, "li"); li.append(el); ul.append(li); }
      box.append(ul);
    } else if (empty) {
      box.append(make(doc, "p", { className: "menu-empty", text: empty }));
    }
    return box;
  }

  function topLevel() {
    const lists = menuLists(menu, { subject, search });
    const parts = [];
    if (menu.subjects.length > 1) {
      const row = make(doc, "div", { className: "menu-subjects", attrs: { role: "group", "aria-label": MENU_TEXT.subjectsLabel } });
      for (const s of [{ id: null, label: MENU_TEXT.allSubjects }, ...menu.subjects]) {
        const b = make(doc, "button", { className: "menu-subject", text: s.label, attrs: { type: "button", "aria-pressed": String(subject === s.id) } });
        b.addEventListener("click", () => { subject = s.id; render(); });
        row.append(b);
      }
      parts.push(row);
    }
    let done = null;
    if ((open.tasks || search) && lists.done.length) {
      done = section("done", MENU_TEXT.done(lists.done.length), lists.done.map(taskItem), 0);
      done.classList?.add("menu-done");
    }
    parts.push(
      section("chats", MENU_TEXT.chats(lists.chats.length), lists.chats.map(chatItem), MENU_SHOW),
      section("tasks", MENU_TEXT.tasks(lists.open.length), lists.open.map(taskItem), MENU_SHOW, { extra: done }),
      section("topics", MENU_TEXT.topics(lists.topics.length), lists.topics.map(topicItem), 0),
    );
    if (!menu.chats.length && !menu.tasks.length) parts.push(make(doc, "p", { className: "menu-empty", text: MENU_TEXT.menuEmpty }));
    return parts;
  }

  function focusLevel() {
    const f = focusLists(menu, focus);
    if (focus.kind === "chat") {
      return [back(MENU_TEXT.allChats, "chats"), make(doc, "p", { className: "menu-focus-title", text: f.chat?.name ?? "" }),
        group(MENU_TEXT.task, f.task ? [taskItem(f.task)] : [], MENU_TEXT.notLinked),
        group(MENU_TEXT.topicsLabel, f.topics.map(topicItem), MENU_TEXT.noTopics)];
    }
    if (focus.kind === "task") {
      const due = f.task ? dueLabel(f.task.deadline, now()).text : "";
      return [back(MENU_TEXT.allTasks, "tasks"), make(doc, "p", { className: "menu-focus-title", text: f.task?.title ?? "" }), make(doc, "p", { className: "menu-focus-meta", text: due }),
        group(MENU_TEXT.chatsLabel(f.chats.length), f.chats.map(chatItem), MENU_TEXT.noChats),
        group(MENU_TEXT.topicsLabel, f.topics.map(topicItem), MENU_TEXT.noTopics)];
    }
    return [back(MENU_TEXT.allTopics, "topics"), make(doc, "p", { className: "menu-focus-title", text: f.topic?.title ?? "" }),
      group(MENU_TEXT.chatsLabel(f.chats.length), f.chats.map(chatItem), MENU_TEXT.noChats),
      group(MENU_TEXT.tasksLabel(f.tasks.length), f.tasks.map(taskItem), null)];
  }

  function render() {
    const active = doc.activeElement;
    const hadSearch = active?.classList?.contains?.("menu-search");
    const head = [];
    const brand = make(doc, "p", { className: "menu-brand" });
    brand.append(make(doc, "span", { className: "menu-brand-mark", attrs: { "aria-hidden": "true" } }), make(doc, "span", { text: MENU_TEXT.appName }));
    const newChat = make(doc, "button", { className: "menu-new", attrs: { type: "button" } });
    newChat.append(icon(doc, "newc"), make(doc, "span", { text: MENU_TEXT.newChat }));
    newChat.addEventListener("click", () => onNewChat());
    const find = make(doc, "input", { className: "menu-search", attrs: { type: "search", "aria-label": MENU_TEXT.search, placeholder: MENU_TEXT.search, autocomplete: "off" } });
    find.value = search;
    find.addEventListener("input", () => { search = find.value; focus = null; render(); });
    head.push(brand, newChat, find);
    const body = make(doc, "div", { className: "menu-body" });
    body.append(...(focus && !search ? focusLevel() : topLevel()));
    const foot = make(doc, "div", { className: "menu-foot" });
    for (const [kind, label] of [["notebook", MENU_TEXT.notebook], ["files", MENU_TEXT.files], ["settings", MENU_TEXT.settings], ["sign-out", MENU_TEXT.signOut]]) {
      const b = make(doc, "button", { className: "menu-foot-item", text: label, attrs: { type: "button" } });
      b.dataset.foot = kind;
      b.addEventListener("click", () => onFoot(kind));
      foot.append(b);
    }
    root.replaceChildren(...head, body, foot);
    if (hadSearch) { const s = root.querySelector?.(".menu-search"); s?.focus(); s?.setSelectionRange?.(s.value.length, s.value.length); }
  }

  return {
    setMenu(next) { menu = next; render(); },
    /** What is open in the main window, marked in the menu. */
    setCurrent(view) { current = view; render(); },
    /** The focus level (A-013 §3); null for the top level. */
    setFocus(next) { focus = next; search = ""; render(); },
    /** "What's due?": the full task list. */
    showTasks() { focus = null; open.tasks = true; render(); root.querySelector?.('[data-section="tasks"]')?.focus(); },
    render,
    state: () => ({ subject, search, focus, open: { ...open } }),
  };
}
