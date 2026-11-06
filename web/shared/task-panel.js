// The task panel's rules and wording (WP-114e; build spec §9, §10, §26; A-010). At the top of a
// conversation about a task: its title, subject, due date and stage, then three collapsed parts:
// the question, the sources saved for the task, and (WP-115) his notes. No DOM-only or Node-only APIs.
import { daysBetween, dueText, longDateText, stageLabel, validDate } from "./upcoming.js";
import { canSummarise, safeLink, siteOf, sourceLabel } from "./conversation.js";

// Copies of server/domain/sources.js OWN_SOURCE_LIMITS and the address limit in server/ai/sources.js
// (checked by test/task-panel.test.js).
export const OWN_SOURCE_LIMITS = Object.freeze({ title: 200, author: 120, url: 500 });

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
});

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

/** Saved sources for the panel, newest first as the server sends them. Anything malformed is left out. */
export function panelSources(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list) {
    if (!raw || typeof raw.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(raw.id)) continue;
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
