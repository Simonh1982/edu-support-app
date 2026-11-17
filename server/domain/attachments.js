// Files and photos attached to a source (A-010 choice 3B; WP-114f). When the tutor can't open a page,
// the learner can attach a copy: a PDF, a Word file or photos of its pages. Each one goes through the
// Worker inbox like every other capture (blueprint §4.4), becomes an Upload with contentKind 'source',
// and the reader turns it into text written by 'source'. The Source record lists its uploads in
// uploadIds, and a summary reads that text with no web tools. The text stays on the Upload record and
// follows the A-008 removal periods (WP-123). Nothing here logs text or puts it in an event.
import { bad } from './fields.js';
import { CLIENT_ID_PATTERN, uploadIdFor } from '../storage/inbox.js';

export const MAX_ATTACHMENTS = 5;
// A-011 (WP-114g), raised by A-012: an attached copy is read up to 120,000 characters, including spaces (about 12,000
// words, or roughly 25 to 30 pages of a journal article). A longer copy gets a note saying which part
// the summary covers.
export const ATTACHED_SOURCE_MAX_CHARS = 120_000;
export const ATTACHMENT_KIND = 'source';
const UPLOAD_ID = /^up_[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;

export const ATTACH_MESSAGES = Object.freeze({
  badList: 'attachments must be a list of capture IDs.',
  tooMany: `A source can have up to ${MAX_ATTACHMENTS} files or photos.`,
  waiting: 'Your copy is still being read. Try again in a minute.',
  failed: "I couldn't read the copy you attached. Try photos of the pages, or paste the text instead.",
  unclear: "I couldn't make sense of the copy you attached. Check it's the right one, or paste the part you need.",
  readOriginal: "This one's short and readable, so it's worth reading the original. Open your copy and take a look.",
  rest: 'To cover the rest, attach a copy of the later pages, or paste the part you need.',
});

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * The note added to a summary of a copy that wasn't read in full (A-011), in the app's own words, or
 * null when all of it was read. parts: [{ length, image, pageCount, pageEnds, truncated }] in the order
 * joined; cut: how many characters of the joined text were sent (Infinity when none were cut);
 * headers: the characters added before each part when several are joined.
 */
export function coverageNote(parts, { cut = Infinity, headers = [] } = {}) {
  if (!Array.isArray(parts) || !parts.length) return null;
  const sentAll = !Number.isFinite(cut);
  if (sentAll && !parts.some((p) => p.truncated)) return null;
  if (parts.length === 1) {
    const [part] = parts;
    const start = headers[0] ?? 0;
    const limit = sentAll ? Infinity : cut - start;
    if (Number.isInteger(part.pageCount) && part.pageCount > 0 && Array.isArray(part.pageEnds)) {
      const pages = part.pageEnds.filter((end) => end <= limit).length;
      if (pages >= 1 && pages < part.pageCount) return `This summary covers roughly the first ${pages} of ${plural(part.pageCount, 'page')}. ${ATTACH_MESSAGES.rest}`;
      if (pages >= 1) return null;
    }
    if (!part.truncated && part.length > 0 && Number.isFinite(limit)) {
      const share = Math.max(5, Math.min(95, Math.round((limit / part.length) * 20) * 5));
      return `This summary covers roughly the first ${share}% of the document. ${ATTACH_MESSAGES.rest}`;
    }
    return `This summary covers only the first part of the document. ${ATTACH_MESSAGES.rest}`;
  }
  let end = 0;
  let whole = 0;
  for (const [i, part] of parts.entries()) {
    end += (i ? 2 : 0) + (headers[i] ?? 0) + part.length;
    if (end <= cut && !part.truncated) whole += 1;
    else break;
  }
  const unit = parts.every((p) => p.image) ? 'photo' : 'part';
  if (!whole) {
    const [first] = parts;
    const limit = cut - (headers[0] ?? 0);
    const pages = Number.isInteger(first.pageCount) && Array.isArray(first.pageEnds) ? first.pageEnds.filter((e) => e <= limit).length : 0;
    if (pages >= 1 && pages < first.pageCount) {
      return `This summary covers roughly the first ${pages} of ${plural(first.pageCount, 'page')} of the first ${unit}, and none of the other ${parts.length - 1 === 1 ? unit : `${parts.length - 1} ${unit}s`}. ${ATTACH_MESSAGES.rest}`;
    }
  }
  return `This summary covers ${whole ? `the first ${whole} of ${plural(parts.length, unit)}` : `only the start of the first ${unit}`}. ${ATTACH_MESSAGES.rest}`;
}

/** Upload IDs for a list of capture (client) IDs, in order and without repeats. Throws 400. */
export function attachmentIds(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw bad(ATTACH_MESSAGES.badList);
  const out = [];
  for (const clientId of value) {
    if (typeof clientId !== 'string' || !CLIENT_ID_PATTERN.test(clientId)) throw bad(ATTACH_MESSAGES.badList);
    const id = uploadIdFor(clientId);
    if (!out.includes(id)) out.push(id);
  }
  if (out.length > MAX_ATTACHMENTS) throw bad(ATTACH_MESSAGES.tooMany);
  return out;
}

/** A source's upload IDs with new ones added at the end. Throws 400 past MAX_ATTACHMENTS. */
export function mergeUploadIds(existing = [], added = []) {
  const out = (Array.isArray(existing) ? existing : []).filter((id) => typeof id === 'string' && UPLOAD_ID.test(id));
  for (const id of added) if (UPLOAD_ID.test(id) && !out.includes(id)) out.push(id);
  if (out.length > MAX_ATTACHMENTS) throw bad(ATTACH_MESSAGES.tooMany);
  return out;
}

const idsOf = (source) => (Array.isArray(source?.uploadIds) ? source.uploadIds : [])
  .filter((id) => typeof id === 'string' && UPLOAD_ID.test(id))
  .slice(0, MAX_ATTACHMENTS);

async function readUploadRecord(store, id) {
  try {
    return await store.read(`uploads/${id}.json`);
  } catch {
    return null;
  }
}

// waiting: not out of the inbox yet; reading; done; failed. An upload that isn't a copy of a source
// (a brief, or his own writing) is never read out as one.
function statusOf(record) {
  if (!record) return { status: 'waiting', failureReason: null };
  if (record.contentKind !== ATTACHMENT_KIND) return { status: 'failed', failureReason: 'not-attachment' };
  if (record.status === 'done') return { status: 'done', failureReason: null };
  if (record.status === 'failed') {
    return { status: 'failed', failureReason: typeof record.failureReason === 'string' ? record.failureReason.slice(0, 40) : 'unreadable' };
  }
  return { status: 'reading', failureReason: null };
}

/** Each attachment's status, as code words only: [{ uploadId, status, failureReason }]. */
export async function attachmentStatus(store, source) {
  const out = [];
  for (const uploadId of idsOf(source)) out.push({ uploadId, ...statusOf(await readUploadRecord(store, uploadId)) });
  return out;
}

/** The sources, each with its attachments' status when it has any (for the task panel). */
export async function withAttachments(store, sources) {
  const out = [];
  for (const source of Array.isArray(sources) ? sources : []) {
    out.push(idsOf(source).length ? { ...source, attachments: await attachmentStatus(store, source) } : source);
  }
  return out;
}

/**
 * The attached text for a summary: { state: 'none' } (nothing attached) | { state: 'waiting' } (a copy
 * is still in the inbox or being read) | { state: 'failed' } (nothing readable) | { state: 'ready',
 * text, shortened, coverage }. Several copies (photos of pages) are joined in the order he attached
 * them. coverage (A-011) is the note saying which part a shortened copy's summary covers, or null.
 */
export async function attachmentText(store, source) {
  const ids = idsOf(source);
  if (!ids.length) return { state: 'none' };
  const parts = [];
  const facts = [];
  const seen = new Set();
  let shortened = false;
  for (const id of ids) {
    const record = await readUploadRecord(store, id);
    const { status } = statusOf(record);
    if (status === 'waiting' || status === 'reading') return { state: 'waiting' };
    if (status !== 'done') continue;
    const value = typeof record.extractedText?.value === 'string' ? record.extractedText.value.trim() : '';
    // the same copy attached twice is one part (seen live, WP-114g-fix)
    if (!value || seen.has(value)) continue;
    seen.add(value);
    if (record.truncated === true) shortened = true;
    parts.push(value);
    facts.push({
      length: value.length,
      image: typeof record.mimeType === 'string' && record.mimeType.startsWith('image/'),
      pageCount: Number.isInteger(record.pageCount) ? record.pageCount : null,
      pageEnds: Array.isArray(record.pageEnds) ? record.pageEnds.filter(Number.isInteger) : null,
      truncated: record.truncated === true,
    });
  }
  if (!parts.length) return { state: 'failed' };
  const header = (i) => (parts.length === 1 ? '' : `[Part ${i + 1} of ${parts.length}]\n`);
  let text = parts.map((p, i) => `${header(i)}${p}`).join('\n\n');
  let cut = Infinity;
  if (text.length > ATTACHED_SOURCE_MAX_CHARS) {
    text = text.slice(0, ATTACHED_SOURCE_MAX_CHARS);
    cut = ATTACHED_SOURCE_MAX_CHARS;
    shortened = true;
  }
  const coverage = coverageNote(facts, { cut, headers: parts.map((_, i) => header(i).length) });
  return { state: 'ready', text, shortened, coverage };
}
