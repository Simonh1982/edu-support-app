// Files and photos attached to a source (A-010 choice 3B; WP-114f). When the tutor can't open a page,
// the learner can attach a copy: a PDF, a Word file or photos of its pages. Each one goes through the
// Worker inbox like every other capture (blueprint §4.4), becomes an Upload with contentKind 'source',
// and the reader turns it into text written by 'source'. The Source record lists its uploads in
// uploadIds, and a summary reads that text with no web tools. The text stays on the Upload record and
// follows the A-008 removal periods (WP-123). Nothing here logs text or puts it in an event.
import { bad } from './fields.js';
import { CLIENT_ID_PATTERN, uploadIdFor } from '../storage/inbox.js';

export const MAX_ATTACHMENTS = 5;
// A whole article can be long. About 6,000 words is plenty for a summary that points him to the right part.
export const ATTACHED_SOURCE_MAX_CHARS = 40_000;
export const ATTACHMENT_KIND = 'source';
const UPLOAD_ID = /^up_[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;

export const ATTACH_MESSAGES = Object.freeze({
  badList: 'attachments must be a list of capture IDs.',
  tooMany: `A source can have up to ${MAX_ATTACHMENTS} files or photos.`,
  waiting: 'Your copy is still being read. Try again in a minute.',
  failed: "I couldn't read the copy you attached. Try photos of the pages, or paste the text instead.",
  unclear: "I couldn't make sense of the copy you attached. Check it's the right one, or paste the part you need.",
});

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
 * text, shortened }. Several copies (photos of pages) are joined in the order he attached them.
 */
export async function attachmentText(store, source) {
  const ids = idsOf(source);
  if (!ids.length) return { state: 'none' };
  const parts = [];
  let shortened = false;
  for (const id of ids) {
    const record = await readUploadRecord(store, id);
    const { status } = statusOf(record);
    if (status === 'waiting' || status === 'reading') return { state: 'waiting' };
    if (status !== 'done') continue;
    const value = typeof record.extractedText?.value === 'string' ? record.extractedText.value.trim() : '';
    if (!value) continue;
    if (record.truncated === true) shortened = true;
    parts.push(value);
  }
  if (!parts.length) return { state: 'failed' };
  let text = parts.length === 1 ? parts[0] : parts.map((p, i) => `[Part ${i + 1} of ${parts.length}]\n${p}`).join('\n\n');
  if (text.length > ATTACHED_SOURCE_MAX_CHARS) {
    text = text.slice(0, ATTACHED_SOURCE_MAX_CHARS);
    shortened = true;
  }
  return { state: 'ready', text, shortened };
}
