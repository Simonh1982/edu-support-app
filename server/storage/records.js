// Record and event helpers shared by all domain code (blueprint §2.2, build spec Appendix A).
// Every record carries id, createdAt, updatedAt, createdBy and schemaVersion; times are UK time.
import { randomBytes } from 'node:crypto';

export const SCHEMA_VERSION = 1;
export const CREATED_BY = Object.freeze(['learner', 'parent', 'system', 'ai']);
export const MAX_EVENT_PAYLOAD_BYTES = 1024;
export const MAX_EVENT_STRING = 200;

const UK = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

function ukParts(date) {
  const p = Object.fromEntries(UK.formatToParts(date).map(({ type, value }) => [type, value]));
  return { y: p.year, mo: p.month, d: p.day, h: p.hour, mi: p.minute, s: p.second };
}

/** ISO 8601 in UK time with its offset, e.g. 2026-10-21T17:04:11+01:00 (BST) or …+00:00 (GMT). */
export function ukIso(date = new Date()) {
  const { y, mo, d, h, mi, s } = ukParts(date);
  const asUtc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  const offsetMin = Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
  const sign = offsetMin < 0 ? '-' : '+';
  const abs = Math.abs(offsetMin);
  const off = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}${off}`;
}

/** The UK calendar month, e.g. "2026-10". Events are filed by UK month, not UTC month. */
export function ukMonth(date = new Date()) {
  const { y, mo } = ukParts(date);
  return `${y}-${mo}`;
}

/** A short, sortable, unguessable id such as "ev_mgz3k1a2_9f1c2b3a". */
export function newId(prefix, date = new Date()) {
  if (!/^[a-z]{1,8}$/.test(prefix)) throw new Error(`bad id prefix: ${prefix}`);
  return `${prefix}_${date.getTime().toString(36)}_${randomBytes(4).toString('hex')}`;
}

function checkCreatedBy(createdBy) {
  if (!CREATED_BY.includes(createdBy)) throw new Error(`createdBy must be one of ${CREATED_BY.join(', ')}`);
}

/** A new record: the caller's fields plus the standard ones. */
export function newRecord(prefix, fields, { createdBy, now = new Date() } = {}) {
  checkCreatedBy(createdBy);
  const at = ukIso(now);
  return { id: newId(prefix, now), ...fields, createdAt: at, updatedAt: at, createdBy, schemaVersion: SCHEMA_VERSION };
}

/** A copy of the record with changes applied and updatedAt moved on. id and createdAt never change. */
export function updateRecord(record, changes = {}, { now = new Date() } = {}) {
  const { id, createdAt, createdBy, schemaVersion } = record;
  return { ...record, ...changes, id, createdAt, createdBy, schemaVersion, updatedAt: ukIso(now) };
}

// Events hold facts, never content: short strings only, and a small payload overall.
function checkSmall(value, where) {
  if (typeof value === 'string' && value.length > MAX_EVENT_STRING) {
    throw new Error(`event ${where} is too long for an event (events never hold text content)`);
  }
  if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) checkSmall(inner, `${where}.${key}`);
  }
}

/** One line for the append-only event log (build spec Appendix A.6: type, time, links, small payload). */
export function makeEvent(type, { links = {}, payload = {}, createdBy = 'system', now = new Date() } = {}) {
  if (!/^[a-z][a-z0-9_.-]{1,63}$/.test(type)) throw new Error(`bad event type: ${type}`);
  checkCreatedBy(createdBy);
  checkSmall(links, 'links');
  checkSmall(payload, 'payload');
  if (Buffer.byteLength(JSON.stringify(payload)) > MAX_EVENT_PAYLOAD_BYTES) {
    throw new Error(`event payload is over ${MAX_EVENT_PAYLOAD_BYTES} bytes`);
  }
  const at = ukIso(now);
  return {
    id: newId('ev', now), type, time: at, links, payload,
    createdAt: at, updatedAt: at, createdBy, schemaVersion: SCHEMA_VERSION,
  };
}

/** Where an event is filed: events/<UK month>.jsonl. */
export function eventsPath(date = new Date()) {
  return `events/${ukMonth(date)}.jsonl`;
}
