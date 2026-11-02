// "idk"-style answers and the disengagement trigger (build spec §34, Appendix A.6–A.7).
// Pure: the count is calculated from a conversation's turns each time, never stored. The escape
// ("I don't know where to start") is a legitimate route and never counts (§21.1), and neither does
// "nothing yet", which Learn something accepts as an answer (§12).

export const DEFAULT_DISENGAGE_AFTER = 3;

// Whole answers only: a sentence that merely contains "not sure" is a real attempt.
export const IDK_PHRASES = Object.freeze([
  'idk', 'i dk', 'idek', 'dk', 'i dont know', 'i do not know', 'dont know', 'do not know', 'dunno', 'i dunno',
  'no idea', 'i have no idea', 'no clue', 'not sure', 'im not sure', 'idc', 'i dont care', 'whatever', 'meh', '?',
]);
const IDK = new Set(IDK_PHRASES);
// Little words that don't change the meaning when they surround an "idk".
const FILLERS = new Set(['um', 'umm', 'erm', 'hmm', 'tbh', 'lol', 'mate', 'really', 'honestly', 'sorry', 'ok', 'okay', 'just', 'like', 'so']);

/** Lower case, apostrophes dropped, punctuation to spaces, filler words trimmed from both ends. */
export function normaliseAnswer(text) {
  if (typeof text !== 'string') return '';
  const t = text.toLowerCase().replace(/['’`]/g, '');
  if (/^[\s?!.]*\?[\s?!.]*$/.test(t)) return '?';
  const words = t.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  while (words.length && FILLERS.has(words[0])) words.shift();
  while (words.length && FILLERS.has(words[words.length - 1])) words.pop();
  return words.join(' ');
}

export function isIdkStyle(text) {
  const n = normaliseAnswer(text);
  return n !== '' && IDK.has(n);
}

/** turns: the conversation's turn list ({ idk } on typed messages only). */
export function idkCount(turns = []) {
  return (Array.isArray(turns) ? turns : []).filter((t) => t && t.idk === true).length;
}

export function isDisengaged(turns, after = DEFAULT_DISENGAGE_AFTER) {
  return Number.isInteger(after) && after > 0 && idkCount(turns) >= after;
}
