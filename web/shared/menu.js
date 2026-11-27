// WP-131b (A-013 §2–§4): the side menu's rules and wording. No imports, no DOM. The menu's lists
// come from GET /api/menu, or from the snapshot's learner.menu while the tutor rests.

export const MENU_SHOW = 3; // chats and tasks show this many until opened
export const DUE_SOON_DAYS = 3;
export const DONE_STAGES = Object.freeze(["submitted", "done"]);

export const MENU_TEXT = Object.freeze({
  appName: "Study",
  newChat: "New chat",
  search: "Search chats, tasks and topics",
  allSubjects: "All",
  subjectsLabel: "Show one subject",
  chats: (n) => `Chats (${n})`,
  tasks: (n) => `Tasks (${n})`,
  topics: (n) => `Topics (${n})`,
  done: (n) => `Done (${n})`,
  showAll: (n) => `Show all ${n}`,
  noTask: "no task",
  noChats: "No chats yet",
  noTopics: "No topics yet",
  notLinked: "Not linked to a task",
  allChats: "All chats",
  allTasks: "All tasks",
  allTopics: "All topics",
  task: "Task",
  topicsLabel: "Topics",
  chatsLabel: (n) => `Chats (${n})`,
  tasksLabel: (n) => `Tasks (${n})`,
  notebook: "Notebook",
  files: "Photos & files",
  settings: "Settings",
  signOut: "Sign out",
  openMenu: "Open the menu",
  closeMenu: "Close the menu",
  greeting: "What do you need help with today?",
  chipTask: "Start a new task",
  chipLearn: "Learn something",
  chipDue: "What's due?",
  menuEmpty: "Your chats, tasks and topics appear here.",
});

// The tutor's state as a dot and a word (A-013 §2): green, amber or red, always with the word.
export const STATUS = Object.freeze({
  ready: { dot: "ready", word: "Ready" },
  waking: { dot: "waking", word: "Waking" },
  offline: { dot: "offline", word: "Resting" },
});

const fold = (s) => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v.filter(isObject) : []);

/** A checked copy of a menu from the server or the snapshot ({ menu } or a learner section). */
export function cleanMenu(raw) {
  const m = isObject(raw?.menu) ? raw.menu : raw;
  const str = (v) => (typeof v === "string" ? v : null);
  return {
    subjects: list(m?.subjects).filter((s) => str(s.id) && str(s.label)).map((s) => ({ id: s.id, label: s.label })),
    chats: list(m?.chats).filter((c) => str(c.id)).map((c) => ({
      id: c.id, name: str(c.name) ?? "Chat", route: str(c.route), taskId: str(c.taskId), qualId: str(c.qualId),
      topicIds: Array.isArray(c.topicIds) ? c.topicIds.filter((t) => typeof t === "string") : [], updatedAt: str(c.updatedAt), renamable: c.renamable === true,
    })),
    tasks: list(m?.tasks).filter((t) => str(t.id)).map((t) => ({
      id: t.id, title: str(t.title) ?? "Task", qualId: str(t.qualId), subject: str(t.subject), deadline: str(t.deadline), stage: str(t.stage),
      topicIds: Array.isArray(t.topicIds) ? t.topicIds.filter((x) => typeof x === "string") : [],
    })),
    topics: list(m?.topics).filter((t) => str(t.id)).map((t) => ({ id: t.id, title: str(t.title) ?? t.id, qualId: str(t.qualId), lastWorked: str(t.lastWorked) })),
  };
}

/**
 * The top level's lists for a subject (null: All) and search words: chats newest first, open tasks
 * by due date, done tasks, topics most recently worked on first.
 */
export function menuLists(menu, { subject = null, search = "" } = {}) {
  const words = fold(search).split(/\s+/).filter(Boolean);
  const hit = (text) => words.every((w) => fold(text).includes(w));
  const inSubject = (qualId) => !subject || qualId === subject;
  const chats = menu.chats.filter((c) => inSubject(c.qualId) && hit(c.name))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const tasks = menu.tasks.filter((t) => inSubject(t.qualId) && hit(t.title))
    .sort((a, b) => String(a.deadline ?? "9999").localeCompare(String(b.deadline ?? "9999")));
  const topics = menu.topics.filter((t) => inSubject(t.qualId) && hit(t.title))
    .sort((a, b) => String(b.lastWorked).localeCompare(String(a.lastWorked)));
  return {
    chats,
    open: tasks.filter((t) => !DONE_STAGES.includes(t.stage)),
    done: tasks.filter((t) => DONE_STAGES.includes(t.stage)),
    topics,
  };
}

/** The focus level for one chat, task or topic (A-013 §3): what is linked to it. */
export function focusLists(menu, focus) {
  const byNewest = (a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt));
  if (focus?.kind === "chat") {
    const chat = menu.chats.find((c) => c.id === focus.id) ?? null;
    return {
      chat,
      task: chat?.taskId ? menu.tasks.find((t) => t.id === chat.taskId) ?? null : null,
      topics: menu.topics.filter((t) => chat?.topicIds.includes(t.id)),
    };
  }
  if (focus?.kind === "task") {
    const task = menu.tasks.find((t) => t.id === focus.id) ?? null;
    return {
      task,
      chats: menu.chats.filter((c) => c.taskId === focus.id).sort(byNewest),
      topics: menu.topics.filter((t) => task?.topicIds.includes(t.id)),
    };
  }
  if (focus?.kind === "topic") {
    return {
      topic: menu.topics.find((t) => t.id === focus.id) ?? null,
      chats: menu.chats.filter((c) => c.topicIds.includes(focus.id)).sort(byNewest),
      tasks: menu.tasks.filter((t) => t.topicIds.includes(focus.id)),
    };
  }
  return null;
}

const DAY_MS = 86_400_000;
const ukDay = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const daysBetween = (a, b) => Math.round((Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / DAY_MS);

/** "Today", "Yesterday", "Mon" or "4 Nov", in UK time. */
export function whenLabel(iso, now = new Date()) {
  const at = new Date(iso ?? "");
  if (Number.isNaN(at.getTime())) return "";
  const d = daysBetween(ukDay(now), ukDay(at));
  if (d <= 0) return "Today";
  if (d === 1) return "Yesterday";
  if (d < 7) return new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "short" }).format(at);
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", day: "numeric", month: "short" }).format(at);
}

/** "due today", "due tomorrow", "due Friday", "due 4 Dec", or "no due date"; soon: within 3 days. */
export function dueLabel(deadline, now = new Date()) {
  if (typeof deadline !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(deadline)) return { text: "no due date", soon: false };
  const d = daysBetween(deadline, ukDay(now));
  const at = new Date(`${deadline}T12:00:00Z`);
  let text;
  if (d < 0) text = d === -1 ? "due yesterday" : `due ${-d} days ago`;
  else if (d === 0) text = "due today";
  else if (d === 1) text = "due tomorrow";
  else if (d < 7) text = `due ${new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "long" }).format(at)}`;
  else text = `due ${new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short" }).format(at)}`;
  return { text, soon: d <= DUE_SOON_DAYS };
}

/** The tutor's wake state as the dot's colour and word. */
export function statusOf(panel) {
  return STATUS[panel] ?? STATUS.waking;
}
