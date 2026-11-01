// Reads uploads waiting as `processing` (build spec §8.1, §44, A-001, A-002; blueprint §4.4, §7.1,
// §7.13). Photos only: Word and PDF files keep waiting for WP-107. One upload at a time. The photo
// goes to the light model as a blob attachment (never a server path), and the conversation model
// reads it again when the light model is unsure. A brief also gets a draft task (anchors, corrected
// question, matched topics) for the confirmation screen (WP-108); nothing becomes a Task until the
// learner confirms it. Logs, events and AI turn records hold ids, counts and reasons, never text.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { INBOX_TYPES } from './storage/inbox.js';
import { checkImage, loadImageLimits } from './ai/limits.js';
import { updateRecord, ukIso } from './storage/records.js';
import { saveAiTurn } from './domain/work.js';
import {
  READ_SYSTEM, MATCH_SYSTEM, READ_RETRY_BELOW, TOPIC_UNSURE_BELOW, readPrompt, normaliseReading,
  buildProposal, qualificationsFor, topicCandidates, matchPrompt, parseMatch,
} from './ai/reading.js';

export const READER_POLL_MS = 10_000;
export const READER_BACKOFF_MS = 60_000;
export const READ_TIMEOUT_MS = 90_000;
// unusable replies (not AI errors) before an upload is marked failed
export const MAX_READ_TRIES = 3;
export const READS_PER_CYCLE = 3;
export const READ_FAILURE_REASONS = Object.freeze(['too-large', 'unsupported-type', 'no-vision', 'file-missing', 'unreadable']);
const UPLOAD_ID = /^up_[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;
const UPLOAD_FILE = /^uploads\/up_[A-Za-z0-9][A-Za-z0-9_-]{7,63}\.(?:jpg|png|webp|gif)$/;

export const uploadPath = (id) => `uploads/${id}.json`;

export function isImageUpload(record) {
  return Boolean(INBOX_TYPES[record?.mimeType]?.image);
}

/** Image uploads still waiting to be read, oldest first. */
export async function pendingImageUploads(store) {
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
    if (record?.id === id && record.status === 'processing' && isImageUpload(record)) out.push(record);
  }
  return out.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
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

// An unusable reading counts as one try; the photo is marked failed after MAX_READ_TRIES.
async function countTry(store, record, now) {
  const tries = (Number.isInteger(record.readTries) ? record.readTries : 0) + 1;
  if (tries >= MAX_READ_TRIES) return markFailed(store, record, 'unreadable', now, { readTries: tries });
  await store.put(uploadPath(record.id), updateRecord(record, { readTries: tries }, { now: now() }));
  return { status: 'again', reason: 'unreadable' };
}

/**
 * Read one upload. Returns { status, reason? } where status is:
 * done | failed | again (an unusable reply, counted) | waiting (limits unknown or the daily AI
 * ceiling reached: try later) | error (the AI didn't answer: back off).
 */
export async function readUpload({
  store, handle, record, curriculum = null, aiCeiling = null, limitsFor = createLimitCache(),
  now = () => new Date(), timeoutMs = READ_TIMEOUT_MS,
}) {
  const lightLimits = await limitsFor(handle, 'light');
  if (!lightLimits) return { status: 'waiting', reason: 'limits-unknown' };
  const image = { bytes: record.bytes, mimeType: record.mimeType };
  const check = checkImage(image, lightLimits);
  if (!check.ok) return markFailed(store, record, check.reason, now, { sizeCheck: 'failed' });
  if (typeof record.file !== 'string' || !UPLOAD_FILE.test(record.file)) return markFailed(store, record, 'file-missing', now);
  let data;
  try {
    data = (await readFile(path.join(store.dir, record.file))).toString('base64');
  } catch {
    return markFailed(store, record, 'file-missing', now);
  }
  // VERIFY: blob attachment shape { type, data, mimeType, displayName } (proven in WP-006; same as blobAttachment())
  const attachment = { type: 'blob', data, mimeType: record.mimeType, displayName: path.basename(record.file) };
  const kind = record.contentKind === 'brief' ? 'brief' : 'own';
  const qualifications = kind === 'brief' ? qualificationsFor(curriculum) : [];
  const prompt = readPrompt({ kind, today: ukIso(now()).slice(0, 10), qualifications });

  // One AI call, counted against the daily ceiling and recorded as an AI turn with no text.
  const ask = async (role, feature, system, text, attachments) => {
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
  const readAs = async (role) => {
    const r = await ask(role, 'read-upload', READ_SYSTEM, prompt, [attachment]);
    return 'text' in r ? { ...r, reading: normaliseReading(r.text, { kind }) } : r;
  };
  const stopFor = (r) => (r.skipped === 'ai-ceiling' ? { status: 'waiting', reason: 'ai-ceiling' } : { status: 'error', reason: r.error ? 'ai-error' : r.skipped });

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
  const changes = {
    status: 'done',
    failureReason: null,
    sizeCheck: 'passed',
    // briefs are someone else's words; own work is the learner's, transcribed exactly
    extractedText: { value: reading.text, author: kind === 'brief' ? 'source' : 'learner' },
    truncated: reading.truncated,
    uncertain: reading.uncertain,
    spellingCorrections: kind === 'brief' ? reading.corrections : [],
    proposal: null,
    readBy: { role: best.role, model: best.model },
    reread,
    readAt: ukIso(now()),
  };
  if (kind === 'brief') {
    const proposal = buildProposal(reading, { qualifications });
    const candidates = topicCandidates(curriculum, proposal.qualificationId);
    const matchText = matchPrompt({ candidates, proposal });
    let unsure = true;
    if (matchText) {
      const r = await ask('light', 'match-topics', MATCH_SYSTEM, matchText);
      const match = 'text' in r ? parseMatch(r.text, candidates) : null;
      if (match) {
        proposal.topicIds = match.topicIds;
        unsure = match.topicIds.length === 0 || match.confidence < TOPIC_UNSURE_BELOW;
      }
    }
    if (unsure && !proposal.uncertainFields.includes('topics')) proposal.uncertainFields.push('topics');
    changes.proposal = proposal;
  }
  await store.put(uploadPath(record.id), updateRecord(record, changes, { now: now() }));
  await store.logEvent('upload.read', {
    links: { uploadId: record.id },
    payload: {
      uploadId: record.id,
      kind,
      role: best.role,
      reread,
      chars: reading.text.length,
      uncertain: reading.uncertain.length,
      corrections: changes.spellingCorrections.length,
      anchors: changes.proposal?.anchors.length ?? 0,
      topics: changes.proposal?.topicIds.length ?? 0,
    },
  });
  return { status: 'done' };
}

/** Read up to `limit` waiting photos. Stops early when waiting or when the AI doesn't answer. */
export async function processBacklog({
  store, handle, curriculum = null, aiCeiling = null, limitsFor = createLimitCache(), now = () => new Date(),
  log = console, limit = READS_PER_CYCLE, timeoutMs = READ_TIMEOUT_MS,
}) {
  const summary = { pending: 0, done: 0, failed: 0, again: 0, waiting: 0, error: 0, reason: null };
  const pending = await pendingImageUploads(store);
  summary.pending = pending.length;
  for (const record of pending.slice(0, limit)) {
    const result = await readUpload({ store, handle, record, curriculum, aiCeiling, limitsFor, now, timeoutMs });
    summary[result.status] += 1;
    if (result.status === 'failed') log.log(`[reader] an upload could not be read: ${result.reason}`);
    if (result.status === 'waiting' || result.status === 'error') {
      summary.reason = result.reason;
      break;
    }
  }
  return summary;
}

/**
 * Check for waiting photos every 10 seconds once isReady() says storage, the curriculum and the AI
 * are all up; back off for a minute when the AI doesn't answer. Never throws.
 */
export function startReader({
  getStore, getAi, getCurriculum = () => null, isReady = () => true, aiCeiling = null, log = console,
  loadLimits = loadImageLimits, pollMs = READER_POLL_MS, backoffMs = READER_BACKOFF_MS, now = () => new Date(),
  setTimer = setTimeout, clearTimer = clearTimeout,
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
          store: getStore(), handle: getAi(), curriculum: getCurriculum(), aiCeiling, limitsFor, now, log,
        });
        const read = summary.done + summary.failed;
        if (read > 0) log.log(`[reader] read ${summary.done} upload${summary.done === 1 ? '' : 's'}; ${summary.failed} could not be read`);
        // say why reading has paused once, not every 10 seconds
        if (summary.reason && summary.reason !== lastReason) log.log(`[reader] paused: ${summary.reason}`);
        lastReason = summary.reason;
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
