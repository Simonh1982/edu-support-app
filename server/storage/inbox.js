// The capture inbox (blueprint §4.4, §10.4). While the Codespace sleeps, the Worker saves each capture
// as inbox/<clientId>.<ext> plus inbox/<clientId>.json. The server moves each one into uploads/,
// creates its Upload record and deletes the inbox files. The block between the INBOX BLOCK markers is
// copied verbatim into wake/worker.js, so both sides agree on names, types and limits.
import { SCHEMA_VERSION, ukIso } from './records.js';
import { checkImage } from '../ai/limits.js';

// ===== INBOX BLOCK START (no imports; copied verbatim into wake/worker.js) =====
// The device sends each file as base64 text, so the Worker passes it on without encoding 8 MB itself
// (the free plan's CPU limit, blueprint §5.3).
const INBOX_MAX_BYTES = 8 * 1024 * 1024;
const INBOX_MAX_BASE64 = Math.ceil(INBOX_MAX_BYTES / 3) * 4;
// Made on the device, so a retry overwrites the same files instead of adding a duplicate.
const CLIENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;
const INBOX_TYPES = Object.freeze({
  'image/jpeg': Object.freeze({ ext: 'jpg', image: true }),
  'image/png': Object.freeze({ ext: 'png', image: true }),
  'image/webp': Object.freeze({ ext: 'webp', image: true }),
  'image/gif': Object.freeze({ ext: 'gif', image: true }),
  'application/pdf': Object.freeze({ ext: 'pdf', image: false }),
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': Object.freeze({ ext: 'docx', image: false }),
});
const INBOX_SOURCES = Object.freeze(['camera', 'gallery', 'file']);
// A-001: the route decides. Anything unclear counts as the learner's own writing, so nothing is changed.
const INBOX_KINDS = Object.freeze(['brief', 'own']);
const INBOX_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

// The two inbox files for a capture, or null if the ID or type isn't allowed. The phone's own file
// name is never used.
function inboxPaths(clientId, mimeType) {
  if (typeof clientId !== 'string' || !CLIENT_ID_PATTERN.test(clientId)) return null;
  const type = typeof mimeType === 'string' && Object.hasOwn(INBOX_TYPES, mimeType) ? INBOX_TYPES[mimeType] : null;
  if (!type) return null;
  return { file: `inbox/${clientId}.${type.ext}`, meta: `inbox/${clientId}.json` };
}

// The Upload's ID comes from the device's ID, so the same capture can never become two uploads.
function uploadIdFor(clientId) {
  return `up_${clientId}`;
}

// How many bytes base64 text decodes to, or null if it can't be base64.
function base64Bytes(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length % 4 !== 0) return null;
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  return (text.length / 4) * 3 - padding;
}

// The metadata file's contents: facts about the capture only, never its content.
function inboxMetadata({ clientId, mimeType, bytes, source, kind, capturedAt, receivedAt, role }) {
  return {
    clientId,
    mimeType,
    bytes,
    source: INBOX_SOURCES.includes(source) ? source : 'file',
    kind: INBOX_KINDS.includes(kind) ? kind : 'own',
    capturedAt: typeof capturedAt === 'string' && INBOX_TIME_PATTERN.test(capturedAt) ? capturedAt : null,
    receivedAt: typeof receivedAt === 'string' && INBOX_TIME_PATTERN.test(receivedAt) ? receivedAt : null,
    uploaderRole: role,
    schemaVersion: 1,
  };
}
// ===== INBOX BLOCK END =====

// Built in two parts, so these lines don't count as a second copy of the markers.
export const INBOX_BLOCK_START = `// ===== INBOX BLOCK ${'START'}`;
export const INBOX_BLOCK_END = `// ===== INBOX BLOCK ${'END'} =====`;

/** The text between (and including) the INBOX BLOCK markers, or null unless there is exactly one block. */
export function extractInboxBlock(source) {
  const start = source.indexOf(INBOX_BLOCK_START);
  const end = source.indexOf(INBOX_BLOCK_END);
  if (start < 0 || end < start) return null;
  if (source.indexOf(INBOX_BLOCK_START, start + 1) >= 0 || source.indexOf(INBOX_BLOCK_END, end + 1) >= 0) return null;
  return source.slice(start, end + INBOX_BLOCK_END.length);
}

export const POLL_MS = 10_000;
export const POLL_BACKOFF_MS = 60_000;
// Right after start-up the AI may not have read the model list yet; photos wait this long for the
// image limits before being taken in unchecked (phase 1 checks again before sending to a model).
export const LIMITS_WAIT_MS = 45_000;

/** Checks a metadata file written by the Worker. Returns { meta } or { error } (safe to log). */
export function checkInboxMetadata(raw, clientId) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'metadata is not an object' };
  if (raw.clientId !== clientId) return { error: 'metadata does not match its file name' };
  if (!inboxPaths(clientId, raw.mimeType)) return { error: 'type is not allowed' };
  if (!Number.isInteger(raw.bytes) || raw.bytes <= 0 || raw.bytes > INBOX_MAX_BYTES) return { error: 'size is not valid' };
  const meta = inboxMetadata({ ...raw, role: raw.uploaderRole === 'learner' ? 'learner' : null });
  if (meta.uploaderRole !== 'learner') return { error: 'only the learner adds captures' };
  return { meta };
}

/**
 * The Upload record (build spec Appendix A.3). In phase 0 nothing is read yet, so a capture that
 * passes the image check waits as `processing`; phase 1 reads the backlog. No text exists yet.
 */
export function uploadRecord({ meta, sizeCheck, now = new Date() }) {
  const at = ukIso(now);
  const id = uploadIdFor(meta.clientId);
  const failed = sizeCheck.state === 'failed';
  return {
    id,
    createdAt: at,
    updatedAt: at,
    createdBy: 'learner',
    schemaVersion: SCHEMA_VERSION,
    clientId: meta.clientId,
    file: `uploads/${id}.${INBOX_TYPES[meta.mimeType].ext}`,
    mimeType: meta.mimeType,
    bytes: meta.bytes,
    origin: meta.source === 'file' ? 'file' : 'photo',
    source: meta.source,
    contentKind: meta.kind,
    capturedAt: meta.capturedAt,
    receivedAt: meta.receivedAt,
    status: failed ? 'failed' : 'processing',
    failureReason: failed ? sizeCheck.reason : null,
    sizeCheck: sizeCheck.state,
    extractedText: null,
    uncertain: [],
    corrections: [],
    spellingCorrections: [],
    taskId: null,
    topicId: null,
  };
}

function imageCheck(meta, limits) {
  const result = checkImage({ bytes: meta.bytes, mimeType: meta.mimeType }, limits);
  return { state: result.ok ? 'passed' : 'failed', reason: result.reason };
}

/**
 * Process everything waiting in inbox/ in the local clone. Idempotent: a capture whose Upload record
 * already exists is a retry, so its inbox files are simply removed. Never reads or logs content.
 * getImageLimits() returns the light model's limits, or null if they aren't known yet.
 */
export async function processInbox({ store, getImageLimits = () => null, waitForLimits = false, now = () => new Date(), log = console }) {
  const summary = { processed: 0, failed: 0, duplicates: 0, waiting: 0, skipped: 0 };
  const inboxNames = new Set(await store.list('inbox'));
  const uploadNames = new Set(await store.list('uploads'));
  for (const name of [...inboxNames].sort()) {
    if (!name.endsWith('.json')) continue;
    const clientId = name.slice(0, -'.json'.length);
    if (!CLIENT_ID_PATTERN.test(clientId)) {
      summary.skipped += 1;
      continue;
    }
    let raw = null;
    try {
      raw = await store.read(`inbox/${name}`);
    } catch {
      raw = null;
    }
    const checked = checkInboxMetadata(raw, clientId);
    if (checked.error) {
      log.error(`[inbox] skipped a capture: ${checked.error}`);
      summary.skipped += 1;
      continue;
    }
    const { meta } = checked;
    const type = INBOX_TYPES[meta.mimeType];
    const paths = inboxPaths(clientId, meta.mimeType);
    const id = uploadIdFor(clientId);
    const recordPath = `uploads/${id}.json`;
    const target = `uploads/${id}.${type.ext}`;
    const inInbox = inboxNames.has(paths.file.slice('inbox/'.length));
    const alreadyMoved = uploadNames.has(target.slice('uploads/'.length));

    // A retry from the device after the first copy was processed: keep the first, drop the repeat.
    if (await store.read(recordPath)) {
      if (inInbox) await store.remove(paths.file, { allowInbox: true });
      await store.remove(paths.meta, { allowInbox: true });
      summary.duplicates += 1;
      continue;
    }
    // The Worker writes the file first, then the metadata; a missing file means it hasn't arrived.
    if (!inInbox && !alreadyMoved) {
      summary.skipped += 1;
      continue;
    }

    let sizeCheck = { state: 'not-checked', reason: null };
    if (type.image) {
      const limits = getImageLimits();
      if (limits) sizeCheck = imageCheck(meta, limits);
      else if (waitForLimits) {
        summary.waiting += 1;
        continue;
      }
    }

    if (inInbox) await store.move(paths.file, target);
    const record = uploadRecord({ meta, sizeCheck, now: now() });
    await store.put(recordPath, record);
    await store.remove(paths.meta, { allowInbox: true });
    const failed = record.status === 'failed';
    // the event carries the upload's ID, size and type only (blueprint §10.4: logged without content)
    await store.logEvent(failed ? 'upload.failed' : 'upload.received', {
      payload: { uploadId: id, source: meta.source, bytes: meta.bytes, mimeType: meta.mimeType, ...(failed ? { reason: record.failureReason } : {}) },
    });
    if (failed) {
      log.log(`[inbox] a capture failed the image check: ${record.failureReason}`);
      summary.failed += 1;
    } else {
      summary.processed += 1;
    }
  }
  return summary;
}

/**
 * Process the inbox once now (storage has just pulled), then pull and process every 10 seconds, so
 * captures sent from any device while the server is awake are picked up too. After a failed pull it
 * waits a minute before trying again. Never throws.
 */
export function startInboxPoller({
  store, getImageLimits = () => null, log = console, pollMs = POLL_MS, backoffMs = POLL_BACKOFF_MS,
  limitsWaitMs = LIMITS_WAIT_MS, now = () => new Date(), clock = () => Date.now(),
  setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  const started = clock();
  let timer = null;
  let stopped = false;
  let running = null;

  function runOnce({ pull = true } = {}) {
    if (running) return running;
    running = (async () => {
      let ok = true;
      try {
        if (pull) {
          const result = await store.sync();
          if (result?.error) ok = false;
        }
        const summary = await processInbox({
          store, getImageLimits, waitForLimits: clock() - started < limitsWaitMs, now, log,
        });
        const done = summary.processed + summary.failed + summary.duplicates;
        if (done > 0) log.log(`[inbox] took in ${done} capture${done === 1 ? '' : 's'} (${summary.failed} failed the image check)`);
        return { ok, ...summary };
      } catch (err) {
        log.error(`[inbox] processing failed: ${err.message}`);
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

  const first = runOnce({ pull: false }).then((result) => {
    schedule(pollMs);
    return result;
  });
  return {
    first,
    runOnce,
    stop() {
      stopped = true;
      if (timer) clearTimer(timer);
      timer = null;
    },
  };
}

export {
  INBOX_MAX_BYTES, INBOX_MAX_BASE64, CLIENT_ID_PATTERN, INBOX_TYPES, INBOX_SOURCES, INBOX_KINDS,
  inboxPaths, uploadIdFor, base64Bytes, inboxMetadata,
};
