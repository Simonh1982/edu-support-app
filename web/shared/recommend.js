// "Recommended next" on the home screen (WP-110; build spec §4.1, §6, §6.1, Appendix A.7): one short
// suggestion chosen by fixed rules, with no AI. It is worked out on the device each time the list is
// shown, never stored. Owner decision (2 Nov 2026, option 1A): the first rule that matches wins.
//   1. overdue:    "“T” was due Thursday. Spend 15 minutes on it, or change the deadline."
//   2. dueSoon:    due today or tomorrow: "“T” is due tomorrow. Spend 20 minutes <stage step>."
//   3. makeStart:  due within 7 days and not started: small, early starts first (§4.1)
//   4. next:       the next dated task, with a step for its stage
//   5. noDeadline: "Add a deadline to “T”."
//   6. nothing open: no line at all.
// Ties: soonest deadline first, then assessments, then list order. No DOM-only or Node-only APIs.
import { groupUpcoming, ukToday, SOON_DAYS } from "./upcoming.js";

export const RECOMMEND_RULES = Object.freeze(["overdue", "dueSoon", "makeStart", "next", "noDeadline"]);

// A small step for each stage that is still in progress.
export const STAGE_STEPS = Object.freeze({
  "not-started": Object.freeze({ minutes: 15, doing: "working out what the question asks" }),
  researching: Object.freeze({ minutes: 15, doing: "on research" }),
  planning: Object.freeze({ minutes: 20, doing: "planning your answer" }),
  drafting: Object.freeze({ minutes: 20, doing: "writing" }),
  reviewing: Object.freeze({ minutes: 15, doing: "checking it over" }),
});

export function stageStep(stage) {
  return Object.hasOwn(STAGE_STEPS, stage ?? "") ? STAGE_STEPS[stage] : STAGE_STEPS["not-started"];
}

const quoted = (title) => `“${title}”`;
const lowerFirst = (text) => text.charAt(0).toLowerCase() + text.slice(1);

/**
 * The recommendation for a list of entries (from fromTask, fromSnapshot or overlayEdits).
 * @returns {{ rule, taskId, title, text } | null}
 */
export function recommendNext(items, { today = ukToday() } = {}) {
  const groups = groupUpcoming(items, { today });
  const isAssessment = (entry) => (entry.kind === "assessment" ? 0 : 1);
  const open = [...groups.today, ...groups.soon, ...groups.later]
    .map((entry, position) => ({ entry, position }))
    .sort((a, b) => (a.entry.days ?? Infinity) - (b.entry.days ?? Infinity)
      || isAssessment(a.entry) - isAssessment(b.entry)
      || a.position - b.position)
    .map(({ entry }) => entry);
  const pick = (rule, test, text) => {
    const entry = open.find(test);
    return entry ? { rule, taskId: entry.taskId, title: entry.title, text: text(entry) } : null;
  };
  return pick("overdue", (e) => e.overdue,
    (e) => `${quoted(e.title)} ${lowerFirst(e.due)}. Spend 15 minutes on it, or change the deadline.`)
    ?? pick("dueSoon", (e) => e.days === 0 || e.days === 1,
      (e) => `${quoted(e.title)} is ${lowerFirst(e.due)}. Spend 20 minutes ${stageStep(e.stage).doing}.`)
    ?? pick("makeStart", (e) => e.days !== null && e.days <= SOON_DAYS && e.stage === "not-started",
      (e) => `Make a start on ${quoted(e.title)}: 15 minutes ${STAGE_STEPS["not-started"].doing}.`)
    ?? pick("next", (e) => e.days !== null,
      (e) => `${quoted(e.title)} is ${lowerFirst(e.due)}. Spend ${stageStep(e.stage).minutes} minutes ${stageStep(e.stage).doing}.`)
    ?? pick("noDeadline", (e) => e.noDeadline, (e) => `Add a deadline to ${quoted(e.title)}.`);
}
