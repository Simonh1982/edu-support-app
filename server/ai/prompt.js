// Prompt assembly (blueprint §7.3; build spec §30, §32.3, §34). The system prompt is the core skill
// file plus the route's skill file plus fixed presentation wordings; the prompt holds only the
// parts a request is allowed to carry, each wrapped in a tag the learner's text can't escape.
// Nothing here calls a model or writes anything. Private settings (presentation choices, parent
// labels, tone examples) are read from the storage clone at run time and never logged.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SKILLS_DIR = fileURLToPath(new URL('../../skills/', import.meta.url));
export const CORE_SKILL = 'core';
// Phase 1 conversation routes (build spec §9, §12): research, plan, review, learn.
export const ROUTES = Object.freeze(['research', 'plan', 'review', 'learn']);
export const PROFILE_FILES = Object.freeze({
  learner: 'profile/learner.json',
  toneExamples: 'profile/tone-examples.md',
});
export const MAX_PROFILE_BYTES = 64 * 1024;
export const MAX_TONE_EXAMPLES_CHARS = 8000;
export const TONE_START = '<!-- tone-examples:start -->';
export const TONE_END = '<!-- tone-examples:end -->';
// Used only when profile/learner.json has no labels; plural, so the skill wording agrees.
export const DEFAULT_LABELS = Object.freeze({ parent: 'a parent', parents: 'your parents' });
const LABEL_PATTERN = /^[\p{L}][\p{L} '’-]{0,39}$/u;

export const LIMITS = Object.freeze({
  questionChars: 1500,
  anchors: 12,
  anchorChars: 300,
  curriculumChars: 6000,
  notebookEntries: 20,
  notebookChars: 2000,
  turns: 10,
  turnChars: 2000,
  attemptChars: 4000,
  draftChars: 20000,
  sourceChars: 12000,
  messageChars: 4000,
});

// The fixed, tested wordings for the four presentation choices (build spec §30). The learner picks
// a value; only these sentences ever reach the model, never anything he types.
export const PRESENTATION_WORDINGS = Object.freeze({
  paragraphLength: Object.freeze({
    short: 'Keep paragraphs short: two or three sentences at most.',
    medium: 'Use paragraphs of medium length: about three to five sentences.',
  }),
  numberedSteps: Object.freeze({
    on: 'Use numbered steps when you explain a process or a method; use ordinary sentences for everything else.',
    off: "Don't use numbered steps; explain processes in short paragraphs instead.",
  }),
  bullets: Object.freeze({
    fewer: 'Use bullet points sparingly; prefer short paragraphs.',
    more: 'Use bullet points where they make a list or comparison easier to scan, but not in every reply.',
  }),
  explanations: Object.freeze({
    brief: 'Keep explanations brief: the key idea first, then check the student is following.',
    fuller: 'Give fuller explanations: the key idea, why it works, and one short example from a different context.',
  }),
});

export const REPLY_CONTRACT = 'Reply with a single JSON object and nothing else: '
  + '{"reply": "…", "replyType": "hint|breakdown|pointer|explanation|clarification|summary|feedback|other", '
  + '"taskSpecific": true or false, "wellbeingLevel": 0 to 3, "sources": []}';

const NOTE_AUTHORS = new Set(['learner', 'ai', 'source']);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));

// Learner text can't open or close our tags (blueprint §7.3: learner text is data).
export function tagSafe(text) {
  return str(text).replace(/</g, '‹').replace(/>/g, '›');
}

export function clip(text, max) {
  const s = str(text).trim();
  return s.length > max ? `${s.slice(0, max)}… (shortened)` : s;
}

/** Only the known choices with known values; anything else is dropped. */
export function normalisePresentation(raw) {
  const out = {};
  if (!isObject(raw)) return out;
  for (const [key, values] of Object.entries(PRESENTATION_WORDINGS)) {
    if (typeof raw[key] === 'string' && Object.hasOwn(values, raw[key])) out[key] = raw[key];
  }
  return out;
}

/** The fixed wordings for a set of choices, always in the same order. */
export function presentationLines(choices = {}) {
  const valid = normalisePresentation(choices);
  return Object.keys(PRESENTATION_WORDINGS).filter((k) => valid[k]).map((k) => PRESENTATION_WORDINGS[k][valid[k]]);
}

/** {parent} and {parents} display labels; anything that isn't a short plain name falls back. */
export function normaliseLabels(raw) {
  const pick = (key) => {
    const v = isObject(raw) && typeof raw[key] === 'string' ? raw[key].trim() : '';
    return LABEL_PATTERN.test(v) ? v : DEFAULT_LABELS[key];
  };
  return { parent: pick('parent'), parents: pick('parents') };
}

/** Private tone examples: non-empty text within the size limit, else null (use the generic ones). */
export function cleanToneExamples(text) {
  if (typeof text !== 'string') return null;
  const t = text.replace(/^\uFEFF/, '').trim();
  if (!t || t.length > MAX_TONE_EXAMPLES_CHARS) return null;
  // the markers must not be smuggled in, or a later replacement could misplace text
  return t.includes(TONE_START) || t.includes(TONE_END) ? null : t;
}

/**
 * The system prompt from skill-file text (pure; no file access).
 * Private tone examples replace the generic block in the core file (build spec §34: one set of
 * examples for every model). Labels are substituted last, so they apply everywhere.
 */
export function assembleSystem({ coreText, routeText = '', presentation = {}, labels = {}, toneExamples = null }) {
  let core = str(coreText);
  const start = core.indexOf(TONE_START);
  const end = core.indexOf(TONE_END);
  const own = cleanToneExamples(toneExamples);
  if (start !== -1 && end > start) {
    const generic = core.slice(start + TONE_START.length, end).trim();
    core = `${core.slice(0, start)}${own ?? generic}${core.slice(end + TONE_END.length)}`;
  } else if (own) {
    core = `${core.trim()}\n\n### Tone examples\n${own}`;
  }
  const parts = [core.trim()];
  if (str(routeText).trim()) parts.push(str(routeText).trim());
  const lines = presentationLines(presentation);
  if (lines.length) parts.push(`Presentation:\n${lines.map((l) => `- ${l}`).join('\n')}`);
  const names = normaliseLabels(labels);
  return `${parts.join('\n\n')}\n`.replaceAll('{parents}', names.parents).replaceAll('{parent}', names.parent);
}

/** Read one skill file. Re-read on every request (blueprint §2.1), so edits apply at once. */
export async function loadSkill(name, { dir = SKILLS_DIR, read = readFile } = {}) {
  if (name !== CORE_SKILL && !ROUTES.includes(name)) throw new Error(`unknown skill: ${name}`);
  return read(path.join(dir, name, 'SKILL.md'), 'utf8');
}

/** The full system prompt for a route (or core only when route is null). */
export async function buildSystem({ route = null, settings = {}, dir = SKILLS_DIR, read = readFile } = {}) {
  const coreText = await loadSkill(CORE_SKILL, { dir, read });
  const routeText = route ? await loadSkill(route, { dir, read }) : '';
  return assembleSystem({
    coreText,
    routeText,
    presentation: settings.presentation,
    labels: settings.labels,
    toneExamples: settings.toneExamples,
  });
}

async function readSmall(file, read) {
  const buf = await read(file);
  if (buf.length > MAX_PROFILE_BYTES) throw Object.assign(new Error('too large'), { code: 'TOO_LARGE' });
  return buf.toString('utf8');
}

const why = (err) => (err?.code === 'ENOENT' ? 'missing' : err?.code === 'TOO_LARGE' ? 'too large' : err instanceof SyntaxError ? 'not valid JSON' : 'unreadable');

/**
 * Private prompt settings from the storage clone. Reads only presentation choices, parent labels
 * and tone examples (build spec §32.3: nothing else about the learner reaches a model).
 * Never throws; problems name files only. Missing files are normal until they're written.
 */
export async function loadProfileSettings({ storageDir, read = readFile } = {}) {
  const out = { presentation: {}, labels: normaliseLabels(null), toneExamples: null, problems: [] };
  if (!storageDir) {
    out.problems.push('storage not ready');
    return out;
  }
  try {
    const profile = JSON.parse(await readSmall(path.join(storageDir, PROFILE_FILES.learner), read));
    out.presentation = normalisePresentation(profile?.presentation);
    out.labels = normaliseLabels(profile?.labels);
  } catch (err) {
    out.problems.push(`${PROFILE_FILES.learner}: ${why(err)}`);
  }
  try {
    const text = await readSmall(path.join(storageDir, PROFILE_FILES.toneExamples), read);
    out.toneExamples = cleanToneExamples(text);
    if (!out.toneExamples) out.problems.push(`${PROFILE_FILES.toneExamples}: empty, too long or not usable`);
  } catch (err) {
    out.problems.push(`${PROFILE_FILES.toneExamples}: ${why(err)}`);
  }
  return out;
}

function anchorLine(anchor) {
  if (typeof anchor === 'string') return clip(anchor, LIMITS.anchorChars);
  if (!isObject(anchor)) return '';
  const kind = str(anchor.kind ?? anchor.type).trim();
  const value = clip(anchor.text ?? anchor.value, LIMITS.anchorChars);
  if (!value) return '';
  return kind ? `${clip(kind, 40)}: ${value}` : value;
}

function taskBlock(task) {
  if (!isObject(task)) return '';
  const lines = [];
  const question = clip(task.question, LIMITS.questionChars);
  if (question) lines.push(`Question: ${question}`);
  const anchors = (Array.isArray(task.anchors) ? task.anchors : []).map(anchorLine).filter(Boolean).slice(0, LIMITS.anchors);
  if (anchors.length) lines.push(`Anchors:\n${anchors.map((a) => `- ${a}`).join('\n')}`);
  return lines.length ? `<task>\n${tagSafe(lines.join('\n'))}\n</task>` : '';
}

function curriculumBlock(extracts) {
  const list = (Array.isArray(extracts) ? extracts : [extracts]).filter(isObject);
  if (!list.length) return '';
  return `<curriculum>\n${tagSafe(clip(JSON.stringify(list), LIMITS.curriculumChars))}\n</curriculum>`;
}

function noteText(entry) {
  if (isObject(entry.text)) return { value: entry.text.value, author: entry.text.author };
  return { value: entry.text, author: entry.author };
}

function notebookBlock(entries) {
  const list = (Array.isArray(entries) ? entries : []).filter(isObject).slice(0, LIMITS.notebookEntries);
  const shown = [];
  for (const entry of list) {
    const { value, author } = noteText(entry);
    const body = clip(value, LIMITS.notebookChars);
    if (!body) continue;
    const who = NOTE_AUTHORS.has(author) ? author : 'unknown';
    const lines = [];
    if (str(entry.title).trim()) lines.push(`Title: ${clip(entry.title, 200)}`);
    lines.push(body);
    if (isObject(entry.source) && str(entry.source.title).trim()) {
      lines.push(`Source: ${[entry.source.title, entry.source.author].filter((s) => str(s).trim()).map((s) => clip(s, 200)).join(', ')}`);
    }
    shown.push(`<entry author="${who}">\n${tagSafe(lines.join('\n'))}\n</entry>`);
  }
  return shown.length ? `<notebook>\n${shown.join('\n')}\n</notebook>` : '';
}

function conversationBlock(turns) {
  const list = (Array.isArray(turns) ? turns : []).filter(isObject).slice(-LIMITS.turns);
  const shown = [];
  for (const turn of list) {
    const text = clip(turn.text, LIMITS.turnChars);
    if (!text) continue;
    if (turn.role === 'learner') shown.push(`<learner_message>${tagSafe(text)}</learner_message>`);
    else if (turn.role === 'tutor' || turn.role === 'ai') shown.push(`<tutor_reply>${tagSafe(text)}</tutor_reply>`);
  }
  return shown.length ? `<conversation>\n${shown.join('\n')}\n</conversation>` : '';
}

const wrap = (tag, text, max) => {
  const body = clip(text, max);
  return body ? `<${tag}>${tagSafe(body)}</${tag}>` : '';
};

/**
 * The prompt for one request (blueprint §7.3 items 3–4). Takes only these named parts; anything
 * else passed in (health, interests, other tasks, parent-side data) is ignored by design.
 * @param {object} parts
 * @param {{question?: string, anchors?: Array<string|{kind?: string, text: string}>}} [parts.task]
 * @param {object|object[]} [parts.curriculum] topicExtract() results
 * @param {object[]} [parts.notebook] notebook entries ({ title, text: { value, author }, source? })
 * @param {{role: 'learner'|'tutor', text: string}[]} [parts.conversation] recent turns, oldest first
 * @param {string} [parts.attempt] his attempt   @param {string} [parts.draft] his draft
 * @param {string} [parts.sourceText] text from a source   @param {string} [parts.message] his new message
 * @param {string} [parts.instruction] a fixed server instruction (never learner text)
 */
export function buildPrompt({ task, curriculum, notebook, conversation, attempt, draft, sourceText, message, instruction, contract = REPLY_CONTRACT } = {}) {
  return [
    taskBlock(task),
    curriculumBlock(curriculum),
    notebookBlock(notebook),
    conversationBlock(conversation),
    wrap('learner_attempt', attempt, LIMITS.attemptChars),
    wrap('learner_draft', draft, LIMITS.draftChars),
    wrap('source_text', sourceText, LIMITS.sourceChars),
    wrap('learner_message', message, LIMITS.messageChars),
    str(instruction).trim(),
    str(contract).trim(),
  ].filter(Boolean).join('\n\n');
}

/** System prompt and prompt together, for the routes (WP-111 onwards). */
export async function buildRequest({ route = null, settings = {}, dir = SKILLS_DIR, read = readFile, ...parts } = {}) {
  return { system: await buildSystem({ route, settings, dir, read }), prompt: buildPrompt(parts) };
}
