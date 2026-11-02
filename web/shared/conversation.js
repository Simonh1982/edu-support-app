// The conversation screen's rules and wording (WP-111b; build spec §9, §10, §20–§23.1, §31, A-007).
// The server enforces attempt before help and the order of the support pairs (WP-111a); this file only
// decides what to show. No imports and no DOM-only or Node-only APIs, so Node tests can check it.

// Copies of server values, checked against the server by test/conversation-screen.test.js.
export const WORK_ROUTES = Object.freeze(["research", "plan", "review"]);
export const ROUTE_BY_STAGE = Object.freeze({
  "not-started": "research",
  researching: "research",
  planning: "plan",
  drafting: "review",
  reviewing: "review",
});
export const SUPPORT_TYPES = Object.freeze(["hint", "breakdown", "pointer", "explanation"]);
export const FIRST_PAIR = Object.freeze(["hint", "breakdown"]);
export const VOTES = Object.freeze(["up", "down", "removed"]);
export const MESSAGE_MAX_CHARS = 4000;
// Copy of HELPLINES in server/wellbeing.js (checked by test/wellbeing.test.js). Shown beside level-3 replies.
export const HELPLINES = Object.freeze([
  Object.freeze({ name: "Childline", how: "call 0800 1111", href: "tel:08001111" }),
  Object.freeze({ name: "Shout", how: "text 85258", href: "sms:85258" }),
  Object.freeze({ name: "Samaritans", how: "call 116 123", href: "tel:116123" }),
  Object.freeze({ name: "In immediate danger", how: "call 999", href: "tel:999" }),
]);

// Each send can take up to two tutor calls of 60 s, so the browser waits longer than for other calls.
export const CONVERSATION_TIMEOUT_MS = 150_000;
// The quickest few tasks are shown as buttons; the rest sit behind "Show all".
export const TASK_BUTTONS = 5;

export const ROUTE_LABELS = Object.freeze({
  research: "Understand and research it",
  plan: "Plan my answer",
  review: "Review my work",
});

// The attempt each route asks for first (build spec §21.1).
export const ATTEMPT_PROMPTS = Object.freeze({
  research: "What do you think the question is asking?",
  plan: "What's your main point, in one sentence?",
  review: "Paste or type the part of your work you'd like help with.",
});

// The four support types, with the wording adjusted to the activity (build spec §21, §22, §23.1).
export const SUPPORT_LABELS = Object.freeze({
  default: Object.freeze({
    hint: "Give me a hint",
    breakdown: "Help me break it down",
    pointer: "Point me to something useful",
    explanation: "Explain the difficult bit",
  }),
  research: Object.freeze({
    hint: "Give me a search hint",
    breakdown: "Break down my question",
    pointer: "Show me a useful source",
    explanation: "Explain this concept",
  }),
  review: Object.freeze({
    hint: "Give me a writing hint",
    breakdown: "Break down this section",
    pointer: "Show me my relevant research",
    explanation: "Explain the feedback",
  }),
});

export const TALK_MESSAGES = Object.freeze({
  anythingCounts: "Anything counts, however rough. Spelling doesn't matter.",
  tryAgain: "Have another go. What would you try now?",
  tryAgainHint: "A fresh try opens the next kind of help.",
  reply: "Anything to say back to the tutor?",
  replyHint: "Or choose some help below.",
  waitForTutor: "You can write now. It sends once the tutor's ready.",
  thinking: "The tutor's thinking. This can take up to a minute or two.",
  needText: "Write something first, however rough.",
  tooLong: `That's too long. Please keep it under ${MESSAGE_MAX_CHARS.toLocaleString("en-GB")} characters.`,
  escapeNote: "No problem. Let's break it down into smaller steps.",
  noReply: "This reply wasn't kept.",
  failed: "The tutor couldn't answer just now. Your words are still here, so try again.",
  unreachable: "Can't reach the tutor. It may be resting. Your words are still here.",
  resumed: "Picked up where you left off.",
  voteFailed: "That didn't save. Please try again.",
  careHeading: "If you need to talk to someone now:",
  noTasks: "No tasks yet. Add one below, or choose Something else.",
  whatHelp: "What do you need help with?",
  noTask: "Not linked to a task.",
  workingOn: (title) => `Working on “${title}”.`,
  showAll: (count) => `Show all ${count} tasks`,
});

export const VOTE_LABELS = Object.freeze({
  up: Object.freeze({ text: "👍 Helpful", label: "Thumbs up: this helped" }),
  down: Object.freeze({ text: "👎 Not helpful", label: "Thumbs down: this didn't help" }),
});

export const isWorkRoute = (route) => WORK_ROUTES.includes(route);

/** The route a task's stage suggests (build spec §10), as the server's derived/route.js does. */
export function routeForStage(stage) {
  return ROUTE_BY_STAGE[stage] ?? "research";
}

/** The suggested route first, then the others in their usual order. */
export function routeChoices(route) {
  return isWorkRoute(route) ? [route, ...WORK_ROUTES.filter((r) => r !== route)] : [...WORK_ROUTES];
}

/**
 * Tasks the learner can get help with, soonest deadline first (no deadline last). Typed tasks still
 * waiting in the edit queue aren't on the tutor yet, so they are left out, as are finished tasks.
 * dueOf(deadline) gives the "due" wording.
 */
export function taskChoices(items, { dueOf = () => "" } = {}) {
  if (!Array.isArray(items)) return [];
  return items
    .filter((i) => i && typeof i.taskId === "string" && typeof i.title === "string" && !i.queued)
    .filter((i) => i.stage !== "submitted" && i.stage !== "done")
    .map((i, index) => ({ i, index }))
    .sort((a, b) => {
      const da = typeof a.i.deadline === "string" ? a.i.deadline : "9999-99-99";
      const db = typeof b.i.deadline === "string" ? b.i.deadline : "9999-99-99";
      return da === db ? a.index - b.index : da < db ? -1 : 1;
    })
    .map(({ i }) => ({ taskId: i.taskId, title: i.title, route: routeForStage(i.stage), due: dueOf(i.deadline ?? null) || "" }));
}

export function supportLabel(route, type) {
  const set = SUPPORT_LABELS[route] ?? SUPPORT_LABELS.default;
  return set[type] ?? SUPPORT_LABELS.default[type] ?? type;
}

/** "Need some help?" over the first pair, "Still stuck?" over the second (build spec §21, §22). */
export function supportHeading(offered) {
  if (!Array.isArray(offered) || offered.length === 0) return "";
  if (offered.length === 1 && offered[0] === "breakdown") return "Let's break it down";
  return offered.some((t) => FIRST_PAIR.includes(t)) ? "Need some help?" : "Still stuck?";
}

/**
 * The label and hint over the writing box. view is the server's conversation view (or null before
 * the conversation starts); asked tells whether any help has been given yet.
 */
export function promptFor(view, route, { asked = false } = {}) {
  if (!view || (view.needsAttempt && !asked)) {
    return { label: ATTEMPT_PROMPTS[route] ?? ATTEMPT_PROMPTS.research, hint: TALK_MESSAGES.anythingCounts };
  }
  if (view.needsAttempt) return { label: TALK_MESSAGES.tryAgain, hint: TALK_MESSAGES.tryAgainHint };
  return { label: TALK_MESSAGES.reply, hint: TALK_MESSAGES.replyHint };
}

/** The escape is offered only before the first attempt. */
export function canEscape(view) {
  return !view || view.canEscape === true;
}

/** Checks what he typed. Quality is never judged: anything entered counts (build spec §21.1). */
export function checkMessage(text) {
  const value = typeof text === "string" ? text.trim() : "";
  if (!value) return { error: TALK_MESSAGES.needText };
  if (value.length > MESSAGE_MAX_CHARS) return { error: TALK_MESSAGES.tooLong };
  return { text: value };
}

/** Tapping the vote already chosen takes it away; tapping the other one changes it (A-007). */
export function nextVote(current, tapped) {
  if (tapped !== "up" && tapped !== "down") return current ?? null;
  return current === tapped ? "removed" : tapped;
}

/** The vote as shown: "removed" shows as no vote. */
export function shownVote(vote) {
  return vote === "up" || vote === "down" ? vote : null;
}

/** A turn for the screen, from a send or support reply. learnerText is what he typed, if anything. */
export function turnFromReply(turn, { learnerText = null } = {}) {
  if (!turn || typeof turn.id !== "string") return null;
  return {
    id: turn.id,
    action: turn.action ?? "message",
    type: turn.type ?? null,
    learnerText: turn.action === "support" ? null : learnerText,
    reply: typeof turn.reply === "string" ? turn.reply : null,
    wellbeingLevel: Number.isInteger(turn.wellbeingLevel) ? turn.wellbeingLevel : null,
  };
}

/** The turns of a reopened conversation (GET /api/conversations/:id), oldest first. */
export function turnsFromServer(conversation) {
  const list = Array.isArray(conversation?.turns) ? conversation.turns : [];
  return list
    .filter((t) => t && typeof t.id === "string")
    .map((t) => ({
      id: t.id,
      action: t.action ?? "message",
      type: t.type ?? null,
      learnerText: typeof t.learnerText === "string" ? t.learnerText : null,
      reply: typeof t.reply === "string" ? t.reply : null,
      wellbeingLevel: Number.isInteger(t.wellbeingLevel) ? t.wellbeingLevel : null,
    }));
}

/** Level 3: the helplines are shown beside the reply, whatever it says (build spec §32.1). */
export function showsCare(turn) {
  return turn?.wellbeingLevel === 3;
}

/** What the learner side of a turn says: his words, or the help he asked for. */
export function learnerLine(turn, route) {
  if (turn.action === "support" && turn.type) return `You asked: ${supportLabel(route, turn.type)}`;
  return turn.learnerText;
}

/**
 * A plain message for a failed conversation call. The server's 409 and 400 messages are written for
 * the learner; anything else gets fixed wording. unreachable: the tutor may be resting.
 */
export function talkErrorMessage(result) {
  if (!result || ["network", "no-address", "not-json"].includes(result.kind)) return { message: TALK_MESSAGES.unreachable, unreachable: true };
  if (result.kind !== "http") return { message: TALK_MESSAGES.failed };
  const said = typeof result.body?.error === "string" && result.body.error.length <= 300 ? result.body.error : null;
  if ((result.status === 400 || result.status === 409 || result.status === 429) && said) return { message: said };
  if (result.status === 503) return { message: "The tutor isn't quite ready. Please try again in a minute." };
  if (result.status === 429) return { message: "That's a lot in a short time. Please wait a minute, then try again." };
  if (result.status === 404) return { message: "That conversation couldn't be found. Please start again." };
  return { message: TALK_MESSAGES.failed };
}
