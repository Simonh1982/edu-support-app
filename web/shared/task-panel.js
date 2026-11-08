// The task panel's rules and wording (WP-114e; build spec §9, §10, §26; A-010). At the top of a
// conversation about a task: its title, subject, due date and stage, then collapsed parts: changing
// the stage, the question, the sources saved for the task, and (WP-115) his notes. WP-114f: copies of
// a source he attaches (a file or photos of pages). No DOM-only or Node-only APIs.
import { STAGES, daysBetween, dueText, longDateText, stageLabel, validDate } from "./upcoming.js";
import { canSummarise, safeLink, siteOf, sourceLabel } from "./conversation.js";

// Copies of server/domain/sources.js OWN_SOURCE_LIMITS and the address limit in server/ai/sources.js
// (checked by test/task-panel.test.js).
export const OWN_SOURCE_LIMITS = Object.freeze({ title: 200, author: 120, url: 500 });
// Copy of server/domain/attachments.js MAX_ATTACHMENTS (checked by test/source-attachments.test.js).
export const MAX_ATTACHMENTS = 5;

export const PANEL_MESSAGES = Object.freeze({
  showQuestion: "Show the question",
  noQuestion: "No question saved for this task yet.",
  waitQuestion: "The question shows once the tutor's ready.",
  sources: "Your sources for this task",
  sourcesCount: (n) => `Your sources for this task (${n})`,
  noSources: "No sources saved yet. Save one from the tutor's cards, or add one you found yourself.",
  waitSources: "Your sources show once the tutor's ready.",
  loading: "Loading…",
  failed: "Couldn't load the task details. They'll try again when the tutor's ready.",
  noDeadline: "No deadline yet",
  due: (date) => `Due ${date}`,
  wasDue: (when, date) => `${when} (${date})`,
  ownKind: "Your source",
  aiSummary: "AI summary",
  openSummary: "Show the AI summary",
  added: "Added to your sources.",
  needTitle: "Give the source a title.",
  titleTooLong: `Please keep the title under ${OWN_SOURCE_LIMITS.title} characters.`,
  authorTooLong: `Please keep the author under ${OWN_SOURCE_LIMITS.author} characters.`,
  badLink: "That link doesn't look right. Check it, or leave it blank.",
  // WP-114f: the stage, and copies he attaches
  stageWait: "You can change the stage once the tutor's ready.",
  stageLeaves: "Saved. It's off your Coming up list now. Change it back here if that was a mistake.",
  attachHeading: "Attach a copy (a file or photos of the pages)",
  attachLabel: "Choose a PDF, a Word file or photos",
  attachHint: (left) => `Up to ${left} more. The tutor reads the copy when the page won't open.`,
  attachSend: "Attach",
  attachNone: "Choose a file or photos first.",
  attachTooMany: (left) => (left > 0
    ? `You can attach ${left} more to this source. Choose fewer, then try again.`
    : `This source already has ${MAX_ATTACHMENTS} files or photos.`),
  attachSending: (n) => (n === 1 ? "Sending your copy…" : `Sending ${n} files…`),
  attachSent: "Sent. Your copy is being read.",
  attachRetry: (n) => `${n === 1 ? "One file" : `${n} files`} couldn't be sent. Check your connection, then tap Try again.`,
  attachTryAgain: "Try again",
  attachWaiting: "Your copy is being read. Summarise will be ready in a minute or two.",
  attachReady: (n) => (n === 1 ? "Your copy is ready to summarise." : `Your ${n} files are ready to summarise.`),
  attachFailed: "Your copy couldn't be read. Try photos of the pages, or paste the text instead.",
});

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const UPLOAD_ID = /^up_[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;
const ATTACH_STATUSES = new Set(["waiting", "reading", "done", "failed"]);

const textOf = (v) => (typeof v === "string" ? v.trim() : typeof v?.value === "string" ? v.value.trim() : "");
const clean = (v, max) => {
  const t = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
  return t ? t.slice(0, max) : null;
};

/**
 * What the panel shows. task: the Task record once the tutor gives it (GET /api/tasks/:id); item: the
 * "Coming up" entry until then (no question). today: a UK date (YYYY-MM-DD).
 * → { title, meta, due, question, loaded }
 */
export function panelFacts({ task = null, item = null, today }) {
  const from = task ?? item ?? {};
  const title = clean(from.title, 120) ?? "Task";
  const subject = clean(from.subject, 40);
  const deadline = validDate(from.deadline);
  let due = PANEL_MESSAGES.noDeadline;
  if (deadline) {
    const days = daysBetween(today, deadline);
    // overdue and today read best as words, with the date beside them; otherwise the full date
    due = days <= 1 ? PANEL_MESSAGES.wasDue(dueText(deadline, today), longDateText(deadline)) : PANEL_MESSAGES.due(longDateText(deadline));
  }
  return {
    title,
    meta: [subject, stageLabel(from.stage)].filter(Boolean).join(" · "),
    due,
    question: task ? textOf(task.questionText) || null : null,
    loaded: Boolean(task),
  };
}

/** The task's stage (WP-114f): the Task record's, or the list entry's until the task loads. */
export function panelStage({ task = null, item = null } = {}) {
  const stage = (task ?? item ?? {}).stage;
  return STAGES.includes(stage) ? stage : "not-started";
}

/** Saved sources for the panel, newest first as the server sends them. Anything malformed is left out. */
export function panelSources(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list) {
    if (!raw || typeof raw.id !== "string" || !ID_PATTERN.test(raw.id)) continue;
    const title = clean(raw.title, OWN_SOURCE_LIMITS.title);
    if (!title) continue;
    const url = safeLink(raw.url);
    const own = raw.origin === "learner";
    const publisher = clean(raw.publisher, OWN_SOURCE_LIMITS.author);
    const site = url ? siteOf(url) : "";
    out.push({
      id: raw.id,
      title,
      url,
      own,
      kind: own ? PANEL_MESSAGES.ownKind : sourceLabel(raw.category),
      byline: [publisher, site].filter(Boolean).join(" · "),
      summaryId: typeof raw.summaryId === "string" && raw.summaryId ? raw.summaryId : null,
      canSummarise: canSummarise({ category: raw.category }),
    });
  }
  return out;
}

/**
 * A saved source's attached copies (GET /api/sources adds "attachments": [{ uploadId, status }]).
 * → { count, state: none | waiting | ready | failed }. ready: at least one copy was read and none is
 * still waiting or being read.
 */
export function attachInfo(raw) {
  const list = (Array.isArray(raw?.attachments) ? raw.attachments : [])
    .filter((a) => a && typeof a.uploadId === "string" && UPLOAD_ID.test(a.uploadId) && ATTACH_STATUSES.has(a.status))
    .slice(0, MAX_ATTACHMENTS);
  if (!list.length) return { count: 0, state: "none" };
  const waiting = list.some((a) => a.status === "waiting" || a.status === "reading");
  const done = list.filter((a) => a.status === "done").length;
  return { count: list.length, done, state: waiting ? "waiting" : done ? "ready" : "failed" };
}

/** The line under a source about its attached copies, or "" when there are none. */
export function attachNote(info) {
  if (info?.state === "waiting") return PANEL_MESSAGES.attachWaiting;
  if (info?.state === "ready") return PANEL_MESSAGES.attachReady(info.done ?? info.count);
  if (info?.state === "failed") return PANEL_MESSAGES.attachFailed;
  return "";
}

/**
 * The body for POST /api/sources/own from the form, or an error naming the field. A link typed
 * without https:// gets it added, so "example.org/page" works.
 */
export function ownSourceBody({ title, author, url } = {}) {
  const t = typeof title === "string" ? title.replace(/\s+/g, " ").trim() : "";
  if (!t) return { error: PANEL_MESSAGES.needTitle, field: "title" };
  if (t.length > OWN_SOURCE_LIMITS.title) return { error: PANEL_MESSAGES.titleTooLong, field: "title" };
  const a = typeof author === "string" ? author.replace(/\s+/g, " ").trim() : "";
  if (a.length > OWN_SOURCE_LIMITS.author) return { error: PANEL_MESSAGES.authorTooLong, field: "author" };
  const body = { title: t };
  if (a) body.author = a;
  const typed = typeof url === "string" ? url.trim() : "";
  if (typed) {
    const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(typed) ? typed : `https://${typed}`;
    const link = safeLink(withScheme);
    if (!link || link.length > OWN_SOURCE_LIMITS.url || !new URL(link).hostname.includes(".")) return { error: PANEL_MESSAGES.badLink, field: "url" };
    body.url = link;
  }
  return { body };
}
