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
// Copies of server/ai/sources.js values (checked by test/sources-screen.test.js, WP-114b).
export const SOURCE_CATEGORIES = Object.freeze([
  "introduction", "video", "official", "educational", "primary", "data", "academic", "specialist", "other",
]);
export const SOURCE_CARDS = 5;
// Copy of PASTED_SOURCE_MAX_CHARS in server/ai/sources.js (A-010; checked by test/task-panel.test.js).
export const PASTED_SOURCE_MAX_CHARS = 12_000;
// A summary opens the page and, on a task, passes the live check, which may write it a second time.
export const SUMMARY_TIMEOUT_MS = 210_000;

// A research reply may run several searches (A-009 tiers: up to 110 s), then a retry and the live
// check, so the browser waits longer than for other calls.
export const CONVERSATION_TIMEOUT_MS = 210_000;
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

// What kind of source each card is, in plain words (build spec §26).
export const SOURCE_LABELS = Object.freeze({
  introduction: "Quick introduction",
  video: "Video",
  official: "Official information",
  educational: "Educational resource",
  primary: "Primary source",
  data: "Data and statistics",
  academic: "More challenging reading",
  specialist: "Specialist source",
  other: "Source",
});

// Source cards and AI summaries (build spec §9.1, §26, §28; WP-114b).
export const SOURCE_MESSAGES = Object.freeze({
  heading: "Sources the tutor found",
  why: "What it covers:",
  newTab: "(opens in a new tab)",
  save: "Save to my sources",
  saving: "Saving…",
  saved: "Saved to your sources.",
  summarise: "Summarise this",
  summarising: "Summarising… This can take a minute or two.",
  summaryLabel: "AI summary",
  summaryNote: "Written by the AI from this source. Read the original to check it, and quote from the original, not this summary.",
  section: "Most useful part:",
  readOriginal: "Read the original",
  failed: "That didn't work just now. Please try again.",
  // A-010: paste to summarise
  pasteHeading: "Paste the text instead",
  pasteLabel: "Copy the part you need from the source, then paste it here",
  pasteHint: "Only the AI summary is kept, not the text you paste.",
  pasteSend: "Summarise what I pasted",
  pasteEmpty: "Paste some text from the source first.",
  pasteTooLong: `That's more than ${PASTED_SOURCE_MAX_CHARS.toLocaleString("en-GB")} characters. Paste the part you need most.`,
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
    sources: cardsFrom(turn.sources),
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
      sources: cardsFrom(t.sources),
    }));
}

/** An http(s) address that is safe to put in a link (no user name or password), or null. */
export function safeLink(url) {
  if (typeof url !== "string" || !url.trim()) return null;
  try {
    const u = new URL(url.trim());
    if ((u.protocol !== "https:" && u.protocol !== "http:") || u.username || u.password) return null;
    return u.href;
  } catch {
    return null;
  }
}

/** The site an address is on, without "www.", for the card. */
export function siteOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

export const cardKey = (turnId, index) => `${turnId}:${index}`;

/**
 * The source cards on a turn (WP-114a), cleaned for the screen. Each keeps its position in the
 * server's list (index), because saving a card names the turn and that position.
 */
export function cardsFrom(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  list.slice(0, SOURCE_CARDS).forEach((raw, index) => {
    if (!raw || typeof raw !== "object") return;
    const url = safeLink(raw.url);
    const title = typeof raw.title === "string" ? raw.title.trim() : "";
    if (!url || !title) return;
    const why = typeof raw.why === "string" ? raw.why : typeof raw.why?.value === "string" ? raw.why.value : "";
    const publisher = typeof raw.publisher === "string" && raw.publisher.trim() ? raw.publisher.trim() : null;
    const category = SOURCE_CATEGORIES.includes(raw.category) ? raw.category : "other";
    const card = { index, title, url, site: siteOf(url), publisher, category, why: why.trim() };
    // A-009: a video's length, and the access line the server worked out (school login or subscription)
    if (category === "video" && Number.isInteger(raw.minutes) && raw.minutes >= 1 && raw.minutes <= 180) card.minutes = raw.minutes;
    if (typeof raw.accessNote === "string" && raw.accessNote.trim() && raw.accessNote.length <= 200) card.accessNote = raw.accessNote.trim();
    out.push(card);
  });
  return out;
}

export function sourceLabel(category, minutes = null) {
  const label = SOURCE_LABELS[category] ?? SOURCE_LABELS.other;
  return category === "video" && Number.isInteger(minutes) && minutes > 0 ? `${label} (${minutes} min)` : label;
}

/** Summaries need page text, so videos can't be summarised (A-009). */
export function canSummarise(card) {
  return card?.category !== "video";
}

/** Summary outcomes that won't change if asked again, so Summarise goes. "Couldn't open" can be retried. */
export const FINAL_SUMMARY_OUTCOMES = Object.freeze(["read-original", "too-close", "subscription"]);
/** After these, "Paste the text instead" is offered (A-010): the tutor couldn't read the page itself. */
export const PASTE_OUTCOMES = Object.freeze(["unavailable", "subscription", "unclear"]);

/** Checks text he pasted from a source before it is sent. Never stored. */
export function checkPasted(text) {
  const value = typeof text === "string" ? text.trim() : "";
  if (!value) return { error: SOURCE_MESSAGES.pasteEmpty };
  if (value.length > PASTED_SOURCE_MAX_CHARS) return { error: SOURCE_MESSAGES.pasteTooLong };
  return { text: value };
}

/** A saved AI summary (a notebook entry, WP-114a) as a card, or a message if it has no text. */
export function summaryFromEntry(entry, card = null) {
  const textOf = (v) => (typeof v === "string" ? v.trim() : typeof v?.value === "string" ? v.value.trim() : "");
  const text = textOf(entry?.text);
  if (!text) return { kind: "message", text: SOURCE_MESSAGES.failed };
  return {
    kind: "summary",
    id: typeof entry.id === "string" ? entry.id : null,
    text,
    section: textOf(entry.section) || null,
    url: safeLink(entry.source?.url) ?? card?.url ?? null,
  };
}

/**
 * What POST /api/sources/:id/summary gave (build spec §28): a summary card when it was saved, or the
 * server's message (read the original; couldn't open it; too close to the task) to show instead.
 */
export function summaryFromResult(body, card = null) {
  if (body?.outcome === "saved" && body.entry) return summaryFromEntry(body.entry, card);
  if (typeof body?.message === "string" && body.message.trim() && body.message.length <= 400) {
    return { kind: "message", text: body.message.trim(), outcome: typeof body.outcome === "string" ? body.outcome : null };
  }
  return { kind: "message", text: SOURCE_MESSAGES.failed };
}

/** A plain message for a failed save or summary. unreachable: the tutor may be resting. */
export function sourceErrorMessage(result) {
  if (!result || ["network", "no-address", "not-json"].includes(result.kind)) return { message: TALK_MESSAGES.unreachable, unreachable: true };
  if (result.kind !== "http") return { message: SOURCE_MESSAGES.failed };
  const said = typeof result.body?.error === "string" && result.body.error.length <= 300 ? result.body.error : null;
  if ([400, 404, 409, 429].includes(result.status) && said) return { message: said };
  if (result.status === 503) return { message: "The tutor isn't quite ready. Please try again in a minute." };
  return { message: SOURCE_MESSAGES.failed };
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
