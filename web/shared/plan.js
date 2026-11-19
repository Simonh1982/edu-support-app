// WP-116: Plan my answer, for the page (build spec §9.2). No imports, no DOM. PLAN_SECTIONS and the
// limits are copies of server/domain/plan.js; test/plan.test.js checks they match.

export const PLAN_SECTIONS = Object.freeze([
  Object.freeze({ key: "mainPoint", label: "What is your main point?" }),
  Object.freeze({ key: "evidence", label: "What evidence supports it?" }),
  Object.freeze({ key: "otherView", label: "Is there another view?" }),
  Object.freeze({ key: "answersQuestion", label: "How does this answer the question?" }),
  Object.freeze({ key: "judgement", label: "What judgement can you justify?" }),
]);
export const PLAN_SECTION_MAX = 3000;
export const GAP_MAX = 300;

export const PLAN_TEXT = Object.freeze({
  heading: "Your plan for this task",
  intro: "Your own words, in short notes. The tutor won't fill these in for you.",
  hints: Object.freeze({
    mainPoint: "One sentence: what you are arguing.",
    evidence: "Facts, examples, data or quotes you will use. Name where they come from.",
    otherView: "What might someone who disagrees say?",
    answersQuestion: "Link your point back to the exact words of the question.",
    judgement: "How far do you agree, and why?",
  }),
  save: "Save the plan",
  saving: "Saving…",
  saved: "Plan saved.",
  unsaved: "You have changes that aren't saved yet.",
  tooLong: (max) => `Please keep each part under ${max.toLocaleString("en-GB")} characters.`,
  failed: "That didn't work. Please try again.",
  viewOnly: "The tutor is resting, so your plan can't be changed just now.",
  // pinned references (§29: pinned, never inserted)
  pinnedHeading: "Pinned for reference",
  pinnedNone: "Nothing pinned yet. Pin notes, quotes or summaries below, to keep them beside your plan.",
  pinHeading: "Pin from your notes",
  pinNone: "No notes for this task yet.",
  pin: "Pin",
  unpin: "Unpin",
  // gaps (§9.2: identify gaps requiring further research)
  gapsHeading: "Gaps to look into",
  gapsNone: "No gaps listed.",
  gapLabel: "Add a gap",
  gapHint: "Something you still need to find out or decide.",
  addGap: "Add",
  done: "Done",
  remove: "Remove",
  fromTutor: "Question from the tutor",
  findGaps: "What's missing?",
  finding: "Looking at your plan… this can take a minute.",
  findHint: "The tutor reads your plan and asks what you still need to find out. It won't answer for you.",
  needText: "Type something first.",
});

/** The sections he has changed, ready to send, or { error }. values: { key: text }. */
export function planChanges(values, saved = {}) {
  const sections = {};
  for (const { key } of PLAN_SECTIONS) {
    const value = String(values?.[key] ?? "").trim();
    if (value.length > PLAN_SECTION_MAX) return { error: PLAN_TEXT.tooLong(PLAN_SECTION_MAX), field: key };
    if (value !== String(saved?.[key] ?? "").trim()) sections[key] = value;
  }
  return { sections };
}

/** A gap he typed, ready to send, or { error }. */
export function checkGap(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return { error: PLAN_TEXT.needText };
  if (text.length > GAP_MAX) return { error: PLAN_TEXT.tooLong(GAP_MAX) };
  return { text };
}
