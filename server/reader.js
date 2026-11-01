// Reads uploads waiting as `processing` (build spec §8.1, §44, A-001, A-002, A-003; blueprint §4.4,
// §7.1, §7.13, §10.4). One upload at a time.
// - Photos go to the light model as blob attachments (never a server path); the conversation model
//   reads a photo again when the light model is unsure.
// - Word and PDF files: the text is extracted on the server (server/documents.js). The learner's own
//   writing needs no AI call; a brief's text goes to the light model, in tags, for the draft task.
// - Scanned PDFs (A-003): sent as a blob like a photo when the model's own limits allow it, otherwise
//   marked failed so the learner is asked for photos of the pages.
// A brief also gets a draft task (anchors, corrected question, matched topics) for the confirmation
// screen (WP-108); nothing becomes a Task until the learner confirms it. Logs, events and AI turn
// records hold ids, counts and reasons, never text.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { INBOX_TYPES } from './storage/inbox.js';
import { checkImage, loadImageLimits } from './ai/limits.js';
import { updateRecord, ukIso } from './storage/records.js';
import { saveAiTurn } from './domain/work.js';
import { DOCUMENT_TYPES, extractDocument } from './documents.js';
import {
  READ_SYSTEM, MATCH_SYSTEM, DOC_SYSTEM, READ_RETRY_BELOW, TOPIC_UNSURE_BELOW, readPrompt, documentPrompt,
  normaliseReading, normaliseDocumentBrief, pageUncertainty, buildProposal, qualificationsFor, topicCandidates,
  matchPrompt, parseMatch, fillFromTopics,
} from './ai/reading.js';

export const READER_POLL_MS = 10_000;
export const READER_BACKOFF_MS = 60_000;
export const READ_TIMEOUT_MS = 90_000;
// unusable replies or extraction timeouts (not AI errors) before an upload is marked failed
export const MAX_READ_TRIES = 3;
export const READS_PER_CYCLE = 3;
// password: a locked PDF; scanned-pdf: a scan the model's limits won't take (A-003: "take photos")
export const READ_FAILURE_REASONS = Object.freeze([
  'too-large', 'unsupported-type', 'no-vision', 'file-missing', 'unreadable', 'password', 'scanned-pdf',
]);
const UPLOAD_ID = /^up_[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;
const UPLOAD_FILE = /^uploads\/up_[A-Za-z0-9][A-Za-z0-9_-]{7,63}\.(?:jpg|png|webp|gif|pdf|docx)$/;
// Asked for when a brief's text gave no usable draft task: the confirmation screen asks for these.
const ESSENTIAL_FIELDS = Object.freeze(['title', 'question', 'deadline']);

export const uploadPath = (id) => `uploads/${id}.json`;

export function isImageUpload(record) {
  return Boolean(INBOX_TYPES[record?.mimeType]?.image);
}

export function isDocumentUpload(record) {
  return DOCUMENT_TYPES.includes(record?.mimeType);
}

// Pasted text (WP-108a): no file; the text is saved on the record when it is pasted.
export const PASTE_TYPE = 'text/plain';

export function isTextUpload(record) {
  return record?.mimeType === PASTE_TYPE && record?.origin === 'paste';
}

async function waitingUploads(store, accept) {
  const out = [];
  for (const name of await store.list('uploads')) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -'.json'.length);
    if (!UPLOAD_ID.test(id)) continue;
    let record = null;
    try {
      record = await store.read(uploadPath(id));
    } catch {
      record = null;
    }
    if (record?.id === id && record.status === 'processing' && accept(record)) out.push(record);
  }
  return out.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

/** Image uploads still waiting to be read, oldest first. */
export function pendingImageUploads(store) {
  return waitingUploads(store, isImageUpload);
}

/** Every upload still waiting to be read (photos, Word and PDF files, pasted text), oldest first. */
export function pendingUploads(store) {
  return waitingUploads(store, (r) => isImageUpload(r) || isDocumentUpload(r) || isTextUpload(r));
}

/** Each model's image limits, read once from the model list (A-002). Null until known. */
export function createLimitCache(loadLimits = loadImageLimits) {
  const cache = new Map();
  return async (handle, role) => {
    const model = handle?.models?.[role];
    if (!model) return null;
    if (!cache.has(model)) {
      const limits = await loadLimits(handle, role);
      if (!limits) return null;
      cache.set(model, limits);
    }
    return cache.get(model);
  };
}

async function markFailed(store, record, reason, now, extra = {}) {
  const updated = updateRecord(record, { ...extra, status: 'failed', failureReason: reason }, { now: now() });
  await store.put(uploadPath(record.id), updated);
  await store.logEvent('upload.failed', { links: { uploadId: record.id }, payload: { uploadId: record.id, stage: 'reading', reason } });
  return { status: 'failed', reason };
}

// An unusable reading counts as one try; the upload is marked failed after MAX_READ_TRIES.
async function countTry(store, record, now) {
  const tries = (Number.isInteger(record.readTries) ? record.readTries : 0) + 1;
  if (tries >= MAX_READ_TRIES) return markFailed(store, record, 'unreadable', now, { readTries: tries });
  await store.put(uploadPath(record.id), updateRecord(record, { readTries: tries }, { now: now() }));
  return { status: 'again', reason: 'unreadable' };
}

// The upload's own file, or null if the path isn't one of ours or the file has gone.
async function readUploadBytes(store, record) {
  if (typeof record.file !== 'string' || !UPLOAD_FILE.test(record.file)) return null;
  try {
    return await readFile(path.join(store.dir, record.file));
  } catch {
    return null;
  }
}

// One AI call, counted against the daily ceiling and recorded as an AI turn with no text.
function makeAsk({ store, handle, aiCeiling, timeoutMs }) {
  return async (role, feature, system, text, attachments) => {
    const model = handle?.models?.[role];
    if (!model) return { skipped: 'no-model' };
    if (aiCeiling && !aiCeiling.take().ok) return { skipped: 'ai-ceiling' };
    const started = Date.now();
    let result;
    try {
      const reply = await handle.ai.ask({ model, system, prompt: text, ...(attachments ? { attachments } : {}), timeoutMs });
      result = { role, model, text: typeof reply?.text === 'string' ? reply.text : '' };
    } catch (err) {
      result = { role, model, error: err?.name || 'Error' };
    }
    try {
      await saveAiTurn(store, { feature, role, model, latencyMs: Math.max(0, Date.now() - started), success: !result.error });
    } catch {
      // cost logging must never stop reading
    }
    return result;
  };
}

const stopFor = (r) => (r.skipped === 'ai-ceiling' ? { status: 'waiting', reason: 'ai-ceiling' } : { status: 'error', reason: r.error ? 'ai-error' : r.skipped });
const today = (now) => ukIso(now()).slice(0, 10);

// Topic matching (light role), then the WP-106 follow-up: one qualification behind every topic fills
// in the qualification and subject.
async function addTopics({ ask, proposal, curriculum }) {
  const candidates = topicCandidates(curriculum, proposal.qualificationId);
  const matchText = matchPrompt({ candidates, proposal });
  let out = proposal;
  let unsure = true;
  if (matchText) {
    const r = await ask('light', 'match-topics', MATCH_SYSTEM, matchText);
    const match = 'text' in r ? parseMatch(r.text, candidates) : null;
    if (match) {
      out = { ...out, topicIds: match.topicIds };
      unsure = match.topicIds.length === 0 || match.confidence < TOPIC_UNSURE_BELOW;
    }
  }
  if (!unsure) return fillFromTopics(out, curriculum);
  return out.uncertainFields.includes('topics') ? out : { ...out, uncertainFields: [...out.uncertainFields, 'topics'] };
}

async function saveDone(ctx, { method, text, truncated, uncertain, corrections, proposal, readBy, reread, extra = {} }) {
  const { store, record, now, kind } = ctx;
  const changes = {
    ...extra,
    status: 'done',
    failureReason: null,
    // briefs are someone else's words; own work is the learner's, kept exactly
    extractedText: { value: text, author: kind === 'brief' ? 'source' : 'learner' },
    truncated,
    uncertain,
    spellingCorrections: kind === 'brief' ? corrections : [],
    proposal: proposal ?? null,
    readBy,
    reread,
    readAt: ukIso(now()),
  };
  await store.put(uploadPath(record.id), updateRecord(record, changes, { now: now() }));
  await store.logEvent('upload.read', {
    links: { uploadId: record.id },
    payload: {
      uploadId: record.id,
      kind,
      method,
      role: readBy.role,
      reread,
      chars: text.length,
      uncertain: uncertain.length,
      corrections: changes.spellingCorrections.length,
      anchors: changes.proposal?.anchors.length ?? 0,
      topics: changes.proposal?.topicIds.length ?? 0,
    },
  });
  return { status: 'done' };
}

// A photo, or a scanned PDF (source 'scan', bytes already read), sent to a model as a blob.
async function readImage(ctx, { source = 'photo', bytes = null } = {}) {
  const { store, handle, record, curriculum, limitsFor, now, kind, ask } = ctx;
  const lightLimits = await limitsFor(handle, 'light');
  if (!lightLimits) return { status: 'waiting', reason: 'limits-unknown' };
  const image = { bytes: record.bytes, mimeType: record.mimeType };
  const check = checkImage(image, lightLimits);
  // A-003: a scan the model can't take gets its own reason, so the learner is asked for photos
  if (!check.ok) return markFailed(store, record, source === 'scan' ? 'scanned-pdf' : check.reason, now, { sizeCheck: 'failed' });
  const file = bytes ?? await readUploadBytes(store, record);
  if (!file) return markFailed(store, record, 'file-missing', now);
  // VERIFY: blob attachment shape { type, data, mimeType, displayName } (proven for images in WP-006; a PDF uses the same shape)
  const attachment = { type: 'blob', data: file.toString('base64'), mimeType: record.mimeType, displayName: path.basename(record.file) };
  const qualifications = kind === 'brief' ? qualificationsFor(curriculum) : [];
  const prompt = readPrompt({ kind, today: today(now), qualifications, source });

  const readAs = async (role) => {
    const r = await ask(role, 'read-upload', READ_SYSTEM, prompt, [attachment]);
    return 'text' in r ? { ...r, reading: normaliseReading(r.text, { kind }) } : r;
  };
  const first = await readAs('light');
  if (!first.reading) return stopFor(first);
  let best = first.reading.ok ? first : null;
  let reread = false;
  if (!best || best.reading.confidence < READ_RETRY_BELOW) {
    // a more capable model reads it again before the learner is asked to correct anything (§8.1)
    const bigLimits = await limitsFor(handle, 'conversation');
    if (bigLimits && checkImage(image, bigLimits).ok) {
      const second = await readAs('conversation');
      if (second.reading) {
        reread = true;
        if (second.reading.ok && (!best || second.reading.confidence >= best.reading.confidence)) best = second;
      } else if (!best) {
        return stopFor(second);
      }
    }
  }
  if (!best) return countTry(store, record, now);

  const { reading } = best;
  const proposal = kind === 'brief'
    ? await addTopics({ ask, curriculum, proposal: buildProposal(reading, { qualifications }) })
    : null;
  return saveDone(ctx, {
    method: source === 'scan' ? 'scan' : 'image',
    text: reading.text,
    truncated: reading.truncated,
    uncertain: reading.uncertain,
    corrections: kind === 'brief' ? reading.corrections : [],
    proposal,
    readBy: { role: best.role, model: best.model },
    reread,
    extra: { sizeCheck: 'passed' },
  });
}

// A Word or PDF file: text from the server; a scan goes on to readImage (A-003). Pasted text (WP-108a)
// is already exact, so it skips extraction and goes straight on to the draft task.
async function readDocument(ctx) {
  const { store, record, curriculum, now, kind, ask, extract } = ctx;
  let result;
  if (isTextUpload(record)) {
    const pasted = record.extractedText?.value;
    result = { ok: true, text: typeof pasted === 'string' ? pasted : '', truncated: false, lowTextPages: [] };
  } else {
    const bytes = await readUploadBytes(store, record);
    if (!bytes) return markFailed(store, record, 'file-missing', now);
    try {
      result = await extract({ bytes, mimeType: record.mimeType });
    } catch {
      result = { ok: false, reason: 'unreadable' };
    }
    if (!result?.ok) {
      const reason = result?.reason;
      // the libraries are missing (npm install not run): leave the file waiting and read the others
      if (reason === 'not-installed') return { status: 'skipped', reason: 'extractor-missing' };
      if (reason === 'timeout') return countTry(store, record, now);
      if (['password', 'too-large', 'unsupported-type'].includes(reason)) return markFailed(store, record, reason, now);
      return markFailed(store, record, 'unreadable', now);
    }
    if (result.scanned) return readImage(ctx, { source: 'scan', bytes });
  }
  const text = typeof result.text === 'string' ? result.text : '';
  if (!text.trim()) return markFailed(store, record, 'unreadable', now);
  const pages = pageUncertainty(result.lowTextPages);
  const readBy = { role: 'text', model: null };

  if (kind !== 'brief') {
    return saveDone(ctx, { method: 'text', text, truncated: result.truncated === true, uncertain: pages, corrections: [], proposal: null, readBy, reread: false });
  }

  const qualifications = qualificationsFor(curriculum);
  const prompt = documentPrompt({ today: today(now), qualifications, text });
  let reading = null;
  let proposalBy = null;
  for (const role of ['light', 'conversation']) {
    const r = await ask(role, 'read-upload', DOC_SYSTEM, prompt);
    if (!('text' in r)) {
      if (r.skipped === 'no-model') continue;
      return stopFor(r);
    }
    const n = normaliseDocumentBrief(r.text, text);
    if (n.ok) {
      reading = n;
      proposalBy = { role: r.role, model: r.model };
      break;
    }
  }
  // the text itself is exact, so an unusable reply never loses it: the learner fills in the essentials
  if (!reading) reading = { text, uncertain: [], corrections: [], task: {}, anchors: [], uncertainFields: [...ESSENTIAL_FIELDS] };
  const proposal = await addTopics({ ask, curriculum, proposal: buildProposal(reading, { qualifications }) });
  return saveDone(ctx, {
    method: 'text',
    text,
    truncated: result.truncated === true,
    uncertain: [...pages, ...reading.uncertain],
    corrections: reading.corrections,
    proposal,
    readBy,
    reread: false,
    extra: { proposalBy },
  });
}

/**
 * Read one upload. Returns { status, reason? } where status is:
 * done | failed | again (an unusable reply, counted) | waiting (limits unknown or the daily AI
 * ceiling reached: try later) | error (the AI didn't answer: back off) | skipped (a document whose
 * extraction libraries aren't installed: left waiting).
 */
export async function readUpload({
  store, handle, record, curriculum = null, aiCeiling = null, limitsFor = createLimitCache(),
  extract = extractDocument, now = () => new Date(), timeoutMs = READ_TIMEOUT_MS,
}) {
  const ctx = {
    store, handle, record, curriculum, limitsFor, extract, now,
    kind: record.contentKind === 'brief' ? 'brief' : 'own',
    ask: makeAsk({ store, handle, aiCeiling, timeoutMs }),
  };
  return isDocumentUpload(record) || isTextUpload(record) ? readDocument(ctx) : readImage(ctx);
}

/**
 * Read up to `limit` waiting uploads. Stops early when waiting or when the AI doesn't answer.
 * Skipped documents don't count towards the limit, so they can't hold up photos behind them.
 */
export async function processBacklog({
  store, handle, curriculum = null, aiCeiling = null, limitsFor = createLimitCache(), extract = extractDocument,
  now = () => new Date(), log = console, limit = READS_PER_CYCLE, timeoutMs = READ_TIMEOUT_MS,
}) {
  const summary = { pending: 0, done: 0, failed: 0, again: 0, waiting: 0, error: 0, skipped: 0, reason: null, skipReason: null };
  const pending = await pendingUploads(store);
  summary.pending = pending.length;
  let tried = 0;
  for (const record of pending) {
    if (tried >= limit) break;
    const result = await readUpload({ store, handle, record, curriculum, aiCeiling, limitsFor, extract, now, timeoutMs });
    summary[result.status] += 1;
    if (result.status === 'skipped') {
      summary.skipReason = result.reason;
      continue;
    }
    tried += 1;
    if (result.status === 'failed') log.log(`[reader] an upload could not be read: ${result.reason}`);
    if (result.status === 'waiting' || result.status === 'error') {
      summary.reason = result.reason;
      break;
    }
  }
  return summary;
}

/**
 * Check for waiting uploads every 10 seconds once isReady() says storage, the curriculum and the AI
 * are all up; back off for a minute when the AI doesn't answer. Never throws.
 */
export function startReader({
  getStore, getAi, getCurriculum = () => null, isReady = () => true, aiCeiling = null, log = console,
  loadLimits = loadImageLimits, extract = extractDocument, pollMs = READER_POLL_MS, backoffMs = READER_BACKOFF_MS,
  now = () => new Date(), setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  const limitsFor = createLimitCache(loadLimits);
  let timer = null;
  let stopped = false;
  let running = null;
  let lastReason = null;

  function runOnce() {
    if (running) return running;
    running = (async () => {
      if (!isReady()) return { ok: true, skipped: true };
      try {
        const summary = await processBacklog({
          store: getStore(), handle: getAi(), curriculum: getCurriculum(), aiCeiling, limitsFor, extract, now, log,
        });
        const read = summary.done + summary.failed;
        if (read > 0) log.log(`[reader] read ${summary.done} upload${summary.done === 1 ? '' : 's'}; ${summary.failed} could not be read`);
        // say why reading has paused once, not every 10 seconds
        const reason = summary.reason ?? summary.skipReason;
        if (reason && reason !== lastReason) log.log(`[reader] paused: ${reason}`);
        lastReason = reason;
        return { ok: summary.error === 0, ...summary };
      } catch (err) {
        log.error(`[reader] reading failed: ${err?.name || 'Error'}`);
        return { ok: false };
      }
    })().finally(() => {
      running = null;
    });
    return running;
  }

  function schedule(ms) {
    if (stopped) return;
    timer = setTimer(async () => {
      timer = null;
      const result = await runOnce();
      schedule(result.ok ? pollMs : backoffMs);
    }, ms);
    timer?.unref?.();
  }

  schedule(pollMs);
  return {
    runOnce,
    stop() {
      stopped = true;
      if (timer) clearTimer(timer);
      timer = null;
    },
  };
}
