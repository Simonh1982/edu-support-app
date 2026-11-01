// Field checks shared by the work records (build spec Appendix A.3, A.6). Error messages name the
// field, never its value, so learner text is never echoed into replies or logs.
import { ITEM_ID_PATTERN } from '../storage/items.js';

export class DomainError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const bad = (message) => new DomainError(400, message);
export const notFound = (what) => new DomainError(404, `${what} not found.`);

export const TEXT_AUTHORS = Object.freeze(['learner', 'ai', 'source']);
// Used only when the curriculum isn't loaded; real IDs are checked against the outlines.
export const TOPIC_ID_FALLBACK = /^[a-z0-9][a-z0-9-]{0,79}$/;
export const QUAL_ID_FALLBACK = /^[a-z0-9][a-z0-9-]{0,39}$/;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9]{0,39}$/;

const isBlank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

export function plainObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw bad(`${name} must be a JSON object`);
  return value;
}

export function onlyKeys(body, allowed, name) {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw bad(`${name}: unknown field${FIELD_NAME.test(key) ? ` ${key}` : ''}`);
  }
}

/** A short label (title, subject): whitespace tidied, or null when empty and optional. */
export function shortString(value, name, { max, required = false }) {
  if (isBlank(value)) {
    if (required) throw bad(`${name} is required`);
    return null;
  }
  if (typeof value !== 'string') throw bad(`${name} must be text`);
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length > max) throw bad(`${name} is longer than ${max} characters`);
  return text;
}

/** A text field with its author: accepts "text" or { value, author }. Kept as written, ends trimmed. */
export function textField(value, name, { max, authors = TEXT_AUTHORS, defaultAuthor, required = false }) {
  const isObj = value && typeof value === 'object' && !Array.isArray(value);
  const raw = isObj ? value.value : value;
  const author = (isObj ? value.author : undefined) ?? defaultAuthor;
  if (isBlank(raw)) {
    if (required) throw bad(`${name} is required`);
    return null;
  }
  if (typeof raw !== 'string') throw bad(`${name} must be text`);
  if (raw.length > max) throw bad(`${name} is longer than ${max} characters`);
  if (!authors.includes(author)) throw bad(`${name}.author must be one of ${authors.join(', ')}`);
  return { value: raw.trim(), author };
}

export function oneOf(value, name, allowed, { required = false } = {}) {
  if (isBlank(value)) {
    if (required) throw bad(`${name} is required`);
    return null;
  }
  if (!allowed.includes(value)) throw bad(`${name} must be one of ${allowed.join(', ')}`);
  return value;
}

/** A UK calendar date, YYYY-MM-DD, that really exists. */
export function ukDate(value, name) {
  if (isBlank(value)) return null;
  const m = typeof value === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  const d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
  if (!d || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) throw bad(`${name} must be a date (YYYY-MM-DD)`);
  return value;
}

export function wholeNumber(value, name, { min = 0, max }) {
  if (value === undefined || value === null || value === '') return null;
  if (!Number.isInteger(value) || value < min || value > max) throw bad(`${name} must be a whole number from ${min} to ${max}`);
  return value;
}

export function flag(value, name, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw bad(`${name} must be true or false`);
  return value;
}

export function recordId(value, name, { required = false } = {}) {
  if (isBlank(value)) {
    if (required) throw bad(`${name} is required`);
    return null;
  }
  if (typeof value !== 'string' || !ITEM_ID_PATTERN.test(value)) throw bad(`${name} is not a valid id`);
  return value;
}

/** One topic ID: must exist in the loaded curriculum; the pattern is used only if none is loaded. */
export function topicId(value, name, curriculum) {
  if (isBlank(value)) return null;
  if (typeof value !== 'string') throw bad(`${name} is not a valid topic`);
  const known = curriculum?.topics instanceof Map ? curriculum.topics.has(value) : TOPIC_ID_FALLBACK.test(value);
  if (!known) throw bad(`${name} is not a known topic`);
  return value;
}

export function topicIds(value, name, curriculum, { max }) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw bad(`${name} must be a list`);
  if (value.length > max) throw bad(`${name} has more than ${max} topics`);
  return [...new Set(value.map((id) => topicId(id, name, curriculum)).filter(Boolean))];
}

export function qualificationId(value, name, curriculum) {
  if (isBlank(value)) return null;
  if (typeof value !== 'string') throw bad(`${name} is not a valid qualification`);
  const quals = curriculum?.qualifications;
  const known = quals instanceof Map ? quals.has(value) : QUAL_ID_FALLBACK.test(value);
  if (!known) throw bad(`${name} is not a known qualification`);
  return value;
}

/** The time encoded in an id from newId() ("t_<base36 ms>_<hex>"), used to find month folders. */
export function idDate(id) {
  const ms = parseInt(String(id).split('_')[1] ?? '', 36);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms) : null;
}
