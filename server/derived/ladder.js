// WP-130 (A-013 §7): the invisible support ladder. With no support buttons, the server tells from
// what he writes whether he is asking for help, then keeps the same rules as the buttons did (build
// spec §20–§22): an attempt first, the first pair (hint or breakdown) before the second (pointer or
// explanation), the second only after a fresh try, and an explanation never first. Pure code, no AI:
// the tutor only chooses which of the allowed kinds fits.
import { normaliseAnswer, isIdkStyle } from './engagement.js';

// A whole message that is one of these is him saying he's stuck. A message of up to SHORT_WORDS words
// that asks for help counts too; a longer one has his own thinking in it as well.
export const SHORT_WORDS = 6;
export const STUCK_PHRASES = Object.freeze([
  'im stuck', 'i am stuck', 'stuck', 'still stuck', 'im still stuck', 'help', 'help me', 'help please', 'please help',
  'i need help', 'can you help', 'can you help me', 'i dont get it', 'i dont understand', 'dont get it',
  'i still dont get it', 'still dont get it', 'i dont understand this', 'im confused', 'i am confused', 'confused',
  'im lost', 'lost', 'i cant do this', 'i cant do it', 'what do i do', 'what do i do now', 'what now',
  'where do i start', 'how do i start', 'i dont know where to start', 'dont know where to start',
  // "just" is dropped as a filler word before matching, so the bare forms are listed too
  'tell me', 'just tell me', 'just tell me the answer', 'tell me the answer', 'give me the answer', 'what is the answer',
  'whats the answer', 'give me a hint', 'a hint', 'hint', 'hint please', 'can i have a hint', 'break it down',
  'can you break it down', 'explain', 'explain it', 'can you explain', 'can you explain it', 'explain please',
  'show me', 'show me how', 'i give up',
]);
// Anywhere in a longer message, these still ask for the next step.
export const ASK_PATTERNS = Object.freeze([
  /\b(im|i am|i m) (still )?stuck\b/, /\bjust tell me\b/, /\b(give|tell) me the answer\b/, /\bgive me a hint\b/,
  /\bcan (you|i) (have|get) a hint\b/, /\bbreak (it|this) down\b/, /\b(can|could) you explain\b/, /\bhelp me\b/,
  /\bi (still )?dont (get|understand) (it|this)\b/,
]);
const STUCK = new Set(STUCK_PHRASES);

/**
 * 'stuck': a short message asking for help (or an "idk"); 'ask': a longer message that also asks for
 * help; null: anything else, which is a go at the work or an ordinary message.
 */
export function helpKind(text) {
  const n = normaliseAnswer(text);
  if (!n) return null;
  const words = n.split(' ').length;
  const asks = ASK_PATTERNS.some((p) => p.test(n));
  // a few words that only ask for help; anything longer has his own thinking in it too
  if (STUCK.has(n) || isIdkStyle(text) || (asks && words <= SHORT_WORDS)) return 'stuck';
  return asks ? 'ask' : null;
}

/**
 * What a typed message does, from the conversation's state ({ pair, waiting, escape }) and the
 * message's help kind:
 *  - 'escape':  stuck before any attempt: like "I don't know where to start", it gets a breakdown only;
 *  - 'attempt': a go at the work while one is awaited (anything counts, quality is never judged);
 *  - 'support': help on offer and he asked for it: the tutor gives one of the allowed kinds;
 *  - 'retry':   stuck again after help: that counts as his next try, so it opens the next help at once
 *               (WP-130b, owner's choice: the nudge felt too stubborn);
 *  - 'message': anything else.
 * taskLinked false (WP-130b): a chat with no task is not set work, so nothing waits for an attempt and
 * the tutor just helps (as the core skill already says); every message is a 'message'.
 */
export function ladderStep(state, kind, { taskLinked = true } = {}) {
  if (!taskLinked) return 'message';
  const waiting = state?.waiting !== false;
  const pair = state?.pair ?? 0;
  if (waiting && pair === 0) return kind === 'stuck' ? 'escape' : 'attempt';
  if (waiting) return kind === 'stuck' ? 'retry' : 'attempt';
  return kind ? 'support' : 'message';
}
