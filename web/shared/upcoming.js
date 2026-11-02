// "Coming up" (WP-109; build spec §15–17, Appendix A.7): Today / Coming soon / Later. The groups are
// worked out on the device each time the list is shown, so "Today" is right even when the saved
// snapshot is days old. Nothing here is stored. server/derived/upcoming.js re-exports this file, so the
// server uses exactly the same rules. No DOM-only or Node-only APIs.
//
// Owner decision (2 Nov 2026):
// - Today: due today, or overdue (labelled "Overdue");
// - Coming soon: due in the 7 days from tomorrow, and every task with no deadline yet;
// - Later: due after that;
// - handed in (submitted) and done tasks leave the list.

export const UK_TIME_ZONE = "Europe/London";
// Copies of server/domain/tasks.js; test/upcoming.test.js checks they match.
export const STAGES = Object.freeze(["not-started", "researching", "planning", "drafting", "reviewing", "submitted", "done"]);
export const FINISHED_STAGES = Object.freeze(["submitted", "done"]);
export const TASK_KINDS = Object.freeze(["assignment", "homework", "assessment"]);

export const STAGE_LABELS = Object.freeze({
  "not-started": "Not started",
  researching: "Researching",
  planning: "Planning",
  drafting: "Drafting",
  reviewing: "Reviewing",
  submitted: "Handed in",
  done: "Done",
});
export const GROUPS = Object.freeze(["today", "soon", "later"]);
export const GROUP_LABELS = Object.freeze({ today: "Today", soon: "Coming soon", later: "Later" });
export const SOON_DAYS = 7;

export const UPCOMING_MESSAGES = Object.freeze({
  loading: "Loading your list…",
  empty: "Nothing coming up. Add a task when you get one.",
  emptyGroup: Object.freeze({
    today: "Nothing due today.",
    soon: "Nothing in the next week.",
    later: "Nothing further ahead.",
  }),
  saved: "This is your saved list. You can change things once the tutor's ready.",
  noSnapshot: "Your list will appear once the tutor has started for the first time.",
  failed: "Couldn't load your list. It'll try again when the tutor's ready.",
  waitForTutor: "You can change this once the tutor's ready.",
  saving: "Saving…",
  updated: "Saved.",
  nothingChanged: "Nothing to change.",
  badDeadline: "Please choose a real date, or leave it blank.",
  badStage: "Please choose a stage.",
  noDeadline: "No deadline yet",
  overdue: "Overdue",
  assessment: "Assessment",
  undone: "Put back on your list.",
});

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T ])/;
const DAY_MS = 86_400_000;
const TITLE_MAX = 120;
const SUBJECT_MAX = 40;

const ukDayParts = new Intl.DateTimeFormat("en-GB", {
  timeZone: UK_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
});
// Plain dates are formatted at UTC midnight, so the device's own time zone never shifts them.
const dateParts = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC", weekday: "long", day: "numeric", month: "long", year: "numeric",
});
const shortParts = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC", weekday: "short", day: "numeric", month: "short",
});

const partsOf = (format, date) => Object.fromEntries(format.formatToParts(date).map((p) => [p.type, p.value]));

/** Today's date in the UK, as YYYY-MM-DD. */
export function ukToday(now = new Date()) {
  const p = partsOf(ukDayParts, now);
  return `${p.year}-${p.month}-${p.day}`;
}

function utcMs(date) {
  const [, y, m, d] = DATE_PATTERN.exec(date);
  return Date.UTC(Number(y), Number(m) - 1, Number(d));
}

/** A real calendar date as YYYY-MM-DD (a date-time keeps only its date part), or null. */
export function validDate(value) {
  if (typeof value !== "string") return null;
  const match = DATE_PATTERN.exec(value.trim());
  if (!match) return null;
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (date.getUTCFullYear() !== Number(y) || date.getUTCMonth() !== Number(m) - 1 || date.getUTCDate() !== Number(d)) return null;
  return `${y}-${m}-${d}`;
}

export function addDays(date, days) {
  return new Date(utcMs(date) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from one date to another (negative if "to" is earlier). */
export function daysBetween(from, to) {
  return Math.round((utcMs(to) - utcMs(from)) / DAY_MS);
}

/** "Friday 20 November 2026", or "" for no date. */
export function longDateText(date) {
  const value = validDate(date);
  if (!value) return "";
  const p = partsOf(dateParts, new Date(utcMs(value)));
  return `${p.weekday} ${p.day} ${p.month} ${p.year}`;
}

function shortDateText(date) {
  const p = partsOf(shortParts, new Date(utcMs(date)));
  return `${p.weekday} ${p.day} ${p.month}`;
}

/** "Due today", "Due Friday", "Was due yesterday", "No deadline yet", … */
export function dueText(deadline, today) {
  const date = validDate(deadline);
  if (!date) return UPCOMING_MESSAGES.noDeadline;
  const days = daysBetween(today, date);
  const weekday = () => partsOf(dateParts, new Date(utcMs(date))).weekday;
  if (days === 0) return "Due today";
  if (days === 1) return "Due tomorrow";
  if (days === -1) return "Was due yesterday";
  if (days > 1 && days < 7) return `Due ${weekday()}`;
  if (days < -1 && days > -7) return `Was due ${weekday()}`;
  return `${days > 0 ? "Due" : "Was due"} ${shortDateText(date)}`;
}

export function stageLabel(stage) {
  return Object.hasOwn(STAGE_LABELS, stage ?? "") ? STAGE_LABELS[stage] : STAGE_LABELS["not-started"];
}

function cleanText(value, max) {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  return text === "" ? null : text.slice(0, max);
}

/**
 * One list entry from a snapshot entry ({ taskId, title, subject, deadline, stage, kind }), with
 * every field checked. Anything else (question text, anchors) is never copied. Null without an id.
 */
export function upcomingItem(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.taskId !== "string" || !ID_PATTERN.test(raw.taskId)) return null;
  return {
    taskId: raw.taskId,
    title: cleanText(raw.title, TITLE_MAX) ?? "Task",
    subject: cleanText(raw.subject, SUBJECT_MAX),
    deadline: validDate(raw.deadline),
    stage: STAGES.includes(raw.stage) ? raw.stage : "not-started",
    kind: TASK_KINDS.includes(raw.kind) ? raw.kind : null,
  };
}

/** A list entry from a Task record (GET /api/tasks). */
export function fromTask(task) {
  if (!task || typeof task !== "object") return null;
  const { id: taskId, title, subject, deadline, stage, kind } = task;
  return upcomingItem({ taskId, title, subject, deadline, stage, kind });
}

/** The list entries in a /snapshot reply: the learner section, or a whole snapshot. */
export function fromSnapshot(body) {
  const section = Array.isArray(body?.upcoming) ? body : body?.learner;
  const list = Array.isArray(section?.upcoming) ? section.upcoming : [];
  return list.map(upcomingItem).filter(Boolean);
}

/**
 * Today / Coming soon / Later for a list of entries (from fromTask or fromSnapshot), on a UK date.
 * Finished tasks are left out. Each group is soonest first; tasks with no deadline come last in
 * Coming soon, in the order given.
 * @returns {{ today: object[], soon: object[], later: object[], count: number, date: string }}
 */
export function groupUpcoming(items, { today = ukToday() } = {}) {
  const out = { today: [], soon: [], later: [] };
  (Array.isArray(items) ? items : []).forEach((item, index) => {
    if (!item || FINISHED_STAGES.includes(item.stage)) return;
    const deadline = validDate(item.deadline);
    const days = deadline ? daysBetween(today, deadline) : null;
    const group = days === null ? "soon" : days <= 0 ? "today" : days <= SOON_DAYS ? "soon" : "later";
    out[group].push({
      ...item,
      deadline,
      group,
      days,
      overdue: days !== null && days < 0,
      noDeadline: days === null,
      due: dueText(deadline, today),
      stageLabel: stageLabel(item.stage),
      index,
    });
  });
  const order = (a, b) => (a.days ?? Infinity) - (b.days ?? Infinity) || a.index - b.index;
  for (const name of GROUPS) out[name] = out[name].sort(order).map(({ index, ...entry }) => entry);
  return { ...out, count: out.today.length + out.soon.length + out.later.length, date: today };
}

/** The same groups straight from Task records (for server code). */
export function groupTasks(tasks, options) {
  return groupUpcoming((Array.isArray(tasks) ? tasks : []).map(fromTask).filter(Boolean), options);
}

/**
 * The PATCH body for a change of stage and/or deadline, holding only what changed.
 * deadline "" clears it.
 * @returns {{ body, leaves: boolean } | { unchanged: true } | { error, field }}
 */
export function updateBody(item, { stage, deadline } = {}) {
  const changes = {};
  if (stage !== undefined && stage !== item.stage) {
    if (!STAGES.includes(stage)) return { error: UPCOMING_MESSAGES.badStage, field: "stage" };
    changes.stage = stage;
  }
  if (deadline !== undefined) {
    const text = typeof deadline === "string" ? deadline.trim() : "";
    const value = text === "" ? null : validDate(text);
    if (text !== "" && value !== text) return { error: UPCOMING_MESSAGES.badDeadline, field: "deadline" };
    if (value !== (item.deadline ?? null)) changes.deadline = value;
  }
  if (Object.keys(changes).length === 0) return { unchanged: true };
  return { body: changes, leaves: FINISHED_STAGES.includes(changes.stage) };
}

/** What the page says when a task leaves the list. */
export function movedOffMessage(title, stage) {
  return `“${title}” is ${stage === "done" ? "done" : "handed in"}, so it's off this list.`;
}
