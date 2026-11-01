// Uploads after reading (WP-108a; build spec §8, §8.1, §44, A-001, Appendix A.3). The learner opens
// what was read from a brief and confirms its draft task (only then does it become a Task), or pastes
// a brief's text, which the reader then reads like a Word file's text. Learner only (server/api.js).
// Events hold ids, counts and field names, never text.
import { DomainError, bad, notFound, plainObject, onlyKeys, textField } from './fields.js';
import { createTask, withTaskLock, TASK_LIMITS, ANCHOR_AUTHORS } from './tasks.js';
import { SCHEMA_VERSION, updateRecord, ukIso } from '../storage/records.js';
import { CLIENT_ID_PATTERN, uploadIdFor } from '../storage/inbox.js';
import { uploadPath, PASTE_TYPE, isTextUpload } from '../reader.js';
import { READ_ANCHOR_TYPES, READ_LIMITS, PROPOSAL_FIELDS, correctQuestion } from '../ai/reading.js';

const UPLOAD_ID = /^up_[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;
// A pasted brief is read like a photo's text, so it has the same length limit.
export const PASTE_MAX_CHARS = READ_LIMITS.textChars;
// Always asked for when the reading didn't find them (build spec §8: confirm only what's missing).
export const ESSENTIAL_FIELDS = Object.freeze(['title', 'subject', 'deadline', 'question']);
const CONFIRM_TASK_FIELDS = Object.freeze([
  'title', 'subject', 'qualificationId', 'topicIds', 'kind', 'workType', 'deadline', 'marks', 'wordCount',
]);
// Anything the learner leaves out keeps the draft task's value.
export const CONFIRM_FIELDS = Object.freeze([...CONFIRM_TASK_FIELDS, 'questionText', 'anchors', 'undoneCorrections']);
export const UPLOAD_MESSAGES = Object.freeze({
  notFound: 'Upload not found.',
  notRead: "This hasn't been read yet.",
  notBrief: "This upload isn't a brief, so there's no task to confirm.",
  alreadyTask: 'This has already been added as a task.',
  clientIdUsed: 'clientId is already used by another upload.',
});

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// one confirmation or paste per upload at a time, so a double tap can't make two tasks
const lockKey = (id) => `upload:${id}`;

/** The fields the confirmation screen should ask about: the reader's unsure fields plus missing essentials. */
export function fieldsToAsk(proposal) {
  if (!isObject(proposal)) return [];
  const ask = new Set(Array.isArray(proposal.uncertainFields) ? proposal.uncertainFields : []);
  for (const field of ESSENTIAL_FIELDS) if (!proposal[field]) ask.add(field);
  return PROPOSAL_FIELDS.filter((f) => ask.has(f));
}

/** What the learner's screen needs from an Upload record. The text appears only once it has been read. */
export function uploadView(record) {
  const proposal = isObject(record.proposal) ? record.proposal : null;
  const taskId = typeof record.taskId === 'string' ? record.taskId : null;
  return {
    id: record.id,
    status: record.status ?? null,
    failureReason: record.failureReason ?? null,
    origin: record.origin ?? null,
    contentKind: record.contentKind === 'brief' ? 'brief' : 'own',
    mimeType: record.mimeType ?? null,
    createdAt: record.createdAt ?? null,
    readAt: record.readAt ?? null,
    taskId,
    text: record.status === 'done' && typeof record.extractedText?.value === 'string' ? record.extractedText.value : null,
    truncated: record.truncated === true,
    uncertain: Array.isArray(record.uncertain) ? record.uncertain : [],
    spellingCorrections: Array.isArray(record.spellingCorrections) ? record.spellingCorrections : [],
    proposal,
    ask: proposal && !taskId ? fieldsToAsk(proposal) : [],
  };
}

/** The Upload record, or null if the id isn't an upload id or there is no such upload. */
export async function openUpload(store, id) {
  if (typeof id !== 'string' || !UPLOAD_ID.test(id)) return null;
  const record = await store.read(uploadPath(id));
  return record?.id === id ? record : null;
}

// The saved corrections with `undone` set from the learner's list of positions (A-001: one-tap undo).
function withUndone(saved, undone) {
  const list = Array.isArray(saved) ? saved : [];
  if (undone === undefined) return list.map((c) => ({ ...c, undone: c.undone === true }));
  if (!Array.isArray(undone)) throw bad('undoneCorrections must be a list');
  if (undone.length > READ_LIMITS.corrections) throw bad(`undoneCorrections has more than ${READ_LIMITS.corrections} items`);
  const positions = new Set(list.map((c) => c.position));
  if (!undone.every((p) => Number.isInteger(p) && positions.has(p))) throw bad('undoneCorrections: unknown correction');
  const set = new Set(undone);
  return list.map((c) => ({ ...c, undone: set.has(c.position) }));
}

// The Task's question: the verbatim question with the kept corrections (A-001), unless the learner
// typed his own version (an extraction mistake fixed, build spec §44).
function questionFor(body, proposal, text, corrections) {
  const verbatim = typeof proposal.question?.verbatim === 'string' ? proposal.question.verbatim : null;
  const computed = verbatim ? (correctQuestion(verbatim, text, corrections) ?? verbatim) : null;
  if (!Object.hasOwn(body, 'questionText')) return { value: computed, edited: false };
  const given = body.questionText;
  if (given !== null && typeof given !== 'string') throw bad('questionText must be text');
  const value = given === null || given.trim() === '' ? null : given.trim();
  return { value, edited: value !== computed };
}

const anchorKey = (a) => `${a?.type}:${String(isObject(a?.text) ? a.text.value : a?.text ?? '').trim()}`;

// The anchors the learner kept, edited or added (the chips). All are confirmed by confirming.
function confirmedAnchors(list, proposal, question) {
  const draft = Array.isArray(proposal.anchors) ? proposal.anchors : [];
  const items = list === undefined ? draft.map((a) => ({ type: a?.type, text: a?.text })) : list;
  if (!Array.isArray(items)) throw bad('anchors must be a list');
  if (items.length > TASK_LIMITS.anchors) throw bad(`a task has at most ${TASK_LIMITS.anchors} anchors`);
  // a question chip the learner left alone follows the corrections he kept, or his own edit
  const drafts = new Set([proposal.question?.corrected, proposal.question?.verbatim]
    .filter((v) => typeof v === 'string')
    .flatMap((v) => [v.trim(), v.trim().slice(0, TASK_LIMITS.anchorText)]));
  return items.map((item) => {
    plainObject(item, 'anchor');
    onlyKeys(item, ['type', 'text'], 'anchor');
    if (!READ_ANCHOR_TYPES.includes(item.type)) throw bad(`anchor type must be one of ${READ_ANCHOR_TYPES.join(', ')}`);
    const text = textField(item.text, 'anchor text', {
      max: TASK_LIMITS.anchorText, authors: ANCHOR_AUTHORS, defaultAuthor: 'learner', required: true,
    });
    const follows = item.type === 'question' && question.value && drafts.has(text.value);
    return {
      type: item.type,
      text: follows ? { value: question.value.slice(0, TASK_LIMITS.anchorText), author: text.author } : text,
      confirmed: true,
    };
  });
}

// Field names the learner changed from the draft task, for tuning the reading (never values).
function changedFields(body, proposal, question) {
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const out = CONFIRM_TASK_FIELDS.filter((key) => Object.hasOwn(body, key) && !same(body[key], proposal[key]));
  if (question.edited) out.push('question');
  if (Array.isArray(body.anchors)) {
    const draft = (Array.isArray(proposal.anchors) ? proposal.anchors : []).map(anchorKey);
    if (!same(draft, body.anchors.map(anchorKey))) out.push('anchors');
  }
  return out;
}

/**
 * Turn a read brief's draft task into a Task (build spec §8, §8.1). Returns { task, upload }, or
 * { alreadyTaskId } if this upload is already a task. Throws DomainError for anything else.
 */
export async function confirmUpload(store, id, body, { curriculum = null, now = new Date() } = {}) {
  plainObject(body, 'confirmation');
  onlyKeys(body, CONFIRM_FIELDS, 'confirmation');
  return withTaskLock(lockKey(id), async () => {
    const upload = await openUpload(store, id);
    if (!upload) throw notFound('Upload');
    if (upload.taskId) return { alreadyTaskId: upload.taskId };
    if (upload.status !== 'done') throw new DomainError(409, UPLOAD_MESSAGES.notRead);
    const proposal = upload.proposal;
    if (upload.contentKind !== 'brief' || !isObject(proposal)) throw new DomainError(409, UPLOAD_MESSAGES.notBrief);

    const text = typeof upload.extractedText?.value === 'string' ? upload.extractedText.value : '';
    const corrections = withUndone(upload.spellingCorrections, body.undoneCorrections);
    const question = questionFor(body, proposal, text, corrections);
    const anchors = confirmedAnchors(body.anchors, proposal, question);
    const fields = Object.fromEntries(CONFIRM_TASK_FIELDS.map((key) => [key, Object.hasOwn(body, key) ? body[key] : proposal[key] ?? null]));
    // the question is the brief's own words, so its author is the source, even after the learner's fixes
    const questionText = question.value ? { value: question.value, author: 'source' } : null;
    const task = await createTask(store, { ...fields, questionText, confirmed: true, anchors }, {
      curriculum, createdBy: 'ai', now, sourceUploads: [id],
    });
    const saved = updateRecord(upload, { taskId: task.id, spellingCorrections: corrections, confirmedAt: ukIso(now) }, { now });
    await store.put(uploadPath(id), saved);
    await store.logEvent('upload.confirmed', {
      createdBy: 'learner',
      links: { uploadId: id, taskId: task.id },
      payload: {
        uploadId: id,
        anchors: anchors.length,
        corrections: corrections.length,
        undone: corrections.filter((c) => c.undone).length,
        changed: changedFields(body, proposal, question),
      },
    });
    return { task, upload: saved };
  });
}

/**
 * Save a pasted brief as an Upload waiting to be read (origin 'paste'). The device's clientId makes a
 * retry return the same upload. Returns { upload, duplicate }.
 */
export async function addPastedBrief(store, body, { now = new Date() } = {}) {
  plainObject(body, 'paste');
  onlyKeys(body, ['clientId', 'text'], 'paste');
  if (typeof body.clientId !== 'string' || !CLIENT_ID_PATTERN.test(body.clientId)) throw bad('clientId is not valid');
  if (body.text === undefined || body.text === null) throw bad('text is required');
  if (typeof body.text !== 'string') throw bad('text must be text');
  const text = body.text.replace(/\r\n?/g, '\n').trim();
  if (!text) throw bad('text is required');
  if (text.length > PASTE_MAX_CHARS) throw bad(`text is longer than ${PASTE_MAX_CHARS} characters`);
  const id = uploadIdFor(body.clientId);
  return withTaskLock(lockKey(id), async () => {
    const existing = await store.read(uploadPath(id));
    if (existing) {
      if (isTextUpload(existing)) return { upload: existing, duplicate: true };
      throw new DomainError(409, UPLOAD_MESSAGES.clientIdUsed);
    }
    const at = ukIso(now);
    const record = {
      id,
      createdAt: at,
      updatedAt: at,
      createdBy: 'learner',
      schemaVersion: SCHEMA_VERSION,
      clientId: body.clientId,
      file: null,
      mimeType: PASTE_TYPE,
      bytes: Buffer.byteLength(text, 'utf8'),
      origin: 'paste',
      source: 'paste',
      contentKind: 'brief',
      capturedAt: at,
      receivedAt: at,
      status: 'processing',
      failureReason: null,
      sizeCheck: 'not-checked',
      // he pasted it, but the words are the brief's (A-001), so it gets shown, undoable corrections
      extractedText: { value: text, author: 'source' },
      uncertain: [],
      corrections: [],
      spellingCorrections: [],
      taskId: null,
      topicId: null,
    };
    await store.put(uploadPath(id), record);
    await store.logEvent('upload.received', {
      createdBy: 'learner',
      links: { uploadId: id },
      payload: { uploadId: id, source: 'paste', chars: text.length },
    });
    return { upload: record, duplicate: false };
  });
}
