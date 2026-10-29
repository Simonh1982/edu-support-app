// Capture logic for the learner page (blueprint §4.4, §10.4; build spec §8.1, A-002).
// No DOM-only or Node-only APIs: fetch, timers, randomness and image encoding are passed in,
// so the same code runs in the browser and in Node tests.
import { readJsonBody, timeoutSignal, workerEndpoint, workerRequest } from "./auth.js";

// ---------- copies of server constants ----------
// The front end can't import server code. test/capture.test.js checks these match
// server/storage/inbox.js (INBOX BLOCK) and server/ai/limits.js.
export const INBOX_MAX_BYTES = 8 * 1024 * 1024;
export const CLIENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;
export const INBOX_TYPES = Object.freeze({
  "image/jpeg": Object.freeze({ ext: "jpg", image: true }),
  "image/png": Object.freeze({ ext: "png", image: true }),
  "image/webp": Object.freeze({ ext: "webp", image: true }),
  "image/gif": Object.freeze({ ext: "gif", image: true }),
  "application/pdf": Object.freeze({ ext: "pdf", image: false }),
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": Object.freeze({ ext: "docx", image: false }),
});
export const INBOX_SOURCES = Object.freeze(["camera", "gallery", "file"]);
export const INBOX_KINDS = Object.freeze(["brief", "own"]);
export const IMAGE_TOO_LARGE_MESSAGE = "This photo is too large to read. Please take it again.";

/** Same rule as the server: the Upload's ID comes from the device's ID. */
export function uploadIdFor(clientId) {
  return `up_${clientId}`;
}

// ---------- settings ----------
// A-002: every image route is shrunk to 1,600 px, aiming for ~300 KB and never more than ~700 KB.
export const RESIZE = Object.freeze({
  maxEdge: 1600,
  targetBytes: 300 * 1024,
  maxBytes: 700 * 1024,
  qualities: Object.freeze([0.85, 0.78, 0.7, 0.62, 0.55, 0.48]),
  shrink: 0.8, // if even the lowest quality is too big, make the picture smaller
  maxShrinks: 3,
});
export const UPLOAD_TIMEOUT_MS = 120_000; // 8 MB over weak mobile signal can be slow
export const POLL_MS = 15_000;
export const POLL_LIMIT_MS = 15 * 60 * 1000; // stop checking 15 minutes after the last activity
export const MAX_FILES_AT_ONCE = 10;
export const MAX_ROWS = 12;
export const FILE_ACCEPT =
  "image/*,.pdf,application/pdf,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export const CAPTURE_MESSAGES = Object.freeze({
  preparingPhoto: "Getting your photo ready…",
  preparingFile: "Getting your file ready…",
  sending: "Sending…",
  sent: "Sent.",
  waiting: "Received – waiting to be read.",
  received: "Received – it'll be read once reading is switched on.",
  failed: IMAGE_TOO_LARGE_MESSAGE,
  saved: "Saved.",
  retry: "Couldn't send. Check your connection, then tap Try again.",
  rejected: "That photo or file couldn't be accepted.",
  tooBig: "This file is too big to send. The limit is 8 MB.",
  notAllowed: "Only the learner can add photos and files.",
  notConfigured: "Sending isn't connected yet. Please try again later.",
  wrongType: "Only photos, PDFs and Word (.docx) files can be added.",
  unreadable: "This picture couldn't be opened. Please try a different one.",
  tooMany: `Only ${MAX_FILES_AT_ONCE} can be added at once. The first ${MAX_FILES_AT_ONCE} are being sent.`,
});

// ---------- IDs and labels ----------

/**
 * A new client ID, made on the device. A retry reuses it, so the Worker overwrites the same
 * inbox files instead of adding a duplicate. The first letter records photo (p) or file (f),
 * so other devices can label inbox items that have no record yet.
 */
export function newClientId({
  source,
  nowMs = Date.now(),
  randomValues = (array) => globalThis.crypto.getRandomValues(array),
} = {}) {
  const bytes = randomValues(new Uint8Array(9));
  const random = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${source === "file" ? "f" : "p"}${Math.floor(nowMs).toString(36)}-${random}`;
}

export function titleForClientId(clientId) {
  if (typeof clientId !== "string") return "Photo or file";
  if (clientId.startsWith("p")) return "Photo";
  if (clientId.startsWith("f")) return "File";
  return "Photo or file";
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const TIME_FORMAT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

/** "29 Oct, 14:05" in UK time, or "" if the value isn't a date. */
export function shortTime(value) {
  if (typeof value !== "string" || value === "") return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : TIME_FORMAT.format(date);
}

// ---------- files and resizing ----------

function captureError(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

const EXT_ROUTES = Object.freeze({
  jpg: "image",
  jpeg: "image",
  png: "image",
  webp: "image",
  gif: "image",
  heic: "image",
  heif: "image",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
});

/**
 * Which route a chosen file takes: { route: "image" } (resized on the device, whatever its type),
 * { route: "file", mimeType } (PDF or Word, sent unchanged) or null (not allowed).
 * Some phones give no type, so the extension is used as a fallback.
 */
export function classifyFile({ name, type } = {}) {
  const mime = String(type ?? "").toLowerCase();
  if (mime.startsWith("image/")) return { route: "image" };
  if (Object.hasOwn(INBOX_TYPES, mime)) return { route: "file", mimeType: mime };
  const ext = (String(name ?? "").match(/\.([A-Za-z0-9]+)$/)?.[1] ?? "").toLowerCase();
  const byExt = Object.hasOwn(EXT_ROUTES, ext) ? EXT_ROUTES[ext] : null;
  if (byExt === "image") return { route: "image" };
  if (byExt) return { route: "file", mimeType: byExt };
  return null;
}

/** Size that fits inside maxEdge on the longest side, never enlarged. Null if not a real size. */
export function fitWithin(width, height, maxEdge = RESIZE.maxEdge) {
  if (!(width > 0) || !(height > 0) || !Number.isFinite(width) || !Number.isFinite(height)) return null;
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * Encodes a picture as JPEG within the A-002 limits. encode(width, height, quality) returns a
 * Blob-like object with .size (in the browser: canvas.toBlob). Tries qualities from high to low
 * and returns the first at or under the target; otherwise the smallest if it's within the maximum;
 * otherwise shrinks the picture and tries again. Throws { code: "tooLarge" } if nothing fits.
 * @returns {Promise<{ blob, width, height, quality, bytes }>}
 */
export async function encodeWithinLimits({ width, height, encode, settings = RESIZE }) {
  const first = fitWithin(width, height, settings.maxEdge);
  if (!first) throw captureError("unreadable");
  let { width: w, height: h } = first;
  for (let round = 0; round <= settings.maxShrinks; round += 1) {
    let last = null;
    for (const quality of settings.qualities) {
      const blob = await encode(w, h, quality);
      if (!blob || !Number.isFinite(blob.size)) throw captureError("unreadable");
      last = { blob, width: w, height: h, quality, bytes: blob.size };
      if (blob.size <= settings.targetBytes) return last;
    }
    if (last && last.bytes <= settings.maxBytes) return last;
    w = Math.max(1, Math.round(w * settings.shrink));
    h = Math.max(1, Math.round(h * settings.shrink));
  }
  throw captureError("tooLarge");
}

// Multiple of 3, so each chunk's base64 can simply be joined.
const BASE64_CHUNK = 3 * 8192;

/** Base64 text for the bytes (no data: prefix, padded), made on the device. */
export function bytesToBase64(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
    out += btoa(String.fromCharCode.apply(null, bytes.subarray(i, i + BASE64_CHUNK)));
  }
  return out;
}

/**
 * Turns a chosen file into something ready to send. Images go through resizeImage(file), which
 * returns { blob, width, height } (or throws { code: "tooLarge" }); PDF and Word go unchanged.
 * @returns {Promise<{ mimeType, bytes, base64, image, width?, height? } | { error }>}
 *   error is a CAPTURE_MESSAGES key: wrongType | unreadable | failed | tooBig.
 */
export async function prepareCapture({ file, resizeImage }) {
  const route = classifyFile(file);
  if (!route) return { error: "wrongType" };
  let blob = file;
  let mimeType = route.mimeType;
  let size = {};
  if (route.route === "image") {
    try {
      const resized = await resizeImage(file);
      blob = resized.blob;
      size = { width: resized.width, height: resized.height };
      mimeType = "image/jpeg";
    } catch (err) {
      return { error: err?.code === "tooLarge" ? "failed" : "unreadable" };
    }
  } else if (!(file.size <= INBOX_MAX_BYTES)) {
    return { error: "tooBig" };
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.length === 0) return { error: "unreadable" };
  if (bytes.length > INBOX_MAX_BYTES) return { error: "tooBig" };
  return { mimeType, bytes: bytes.length, base64: bytesToBase64(bytes), image: route.route === "image", ...size };
}

// ---------- sending ----------

/**
 * Sends one capture to the Worker's POST /inbox as base64 text.
 * @returns {Promise<{ kind: "ok", body } | { kind: "auth", reason } | { kind: "rejected" | "tooBig" |
 *   "notAllowed" | "notConfigured" } | { kind: "retry", status? }>}
 */
export async function sendCapture({
  workerUrl,
  token,
  clientId,
  mimeType,
  source,
  contentKind,
  capturedAt,
  base64,
  fetchImpl = globalThis.fetch,
  timeoutMs = UPLOAD_TIMEOUT_MS,
}) {
  const base = workerEndpoint(workerUrl, "inbox");
  if (!base) return { kind: "notConfigured" };
  const params = new URLSearchParams({ clientId, type: mimeType, source, kind: contentKind, capturedAt });
  let response;
  try {
    response = await fetchImpl(`${base}?${params}`, {
      method: "POST",
      headers: { Accept: "application/json", Authorization: `Bearer ${token}`, "Content-Type": "text/plain" },
      body: base64,
      cache: "no-store",
      signal: timeoutSignal(timeoutMs),
    });
  } catch {
    return { kind: "retry" };
  }
  const body = await readJsonBody(response);
  if (response.status === 401) return { kind: "auth", reason: typeof body?.reason === "string" ? body.reason : "unknown" };
  if (response.ok && body?.clientId === clientId) return { kind: "ok", body };
  if (response.status === 400) return { kind: "rejected" };
  if (response.status === 413) return { kind: "tooBig" };
  if (response.status === 403) return { kind: "notAllowed" };
  return { kind: "retry", status: response.status };
}

// ---------- the list of captures ----------

const STATE_MESSAGES = Object.freeze({
  sending: CAPTURE_MESSAGES.sending,
  sent: CAPTURE_MESSAGES.waiting,
  waiting: CAPTURE_MESSAGES.waiting,
  received: CAPTURE_MESSAGES.received,
  failed: CAPTURE_MESSAGES.failed,
  saved: CAPTURE_MESSAGES.saved,
});

/** Pending inbox items from GET /inbox, keeping only well-formed entries. */
export function inboxItems(body) {
  const items = Array.isArray(body?.items) ? body.items : [];
  return items
    .filter((item) => typeof item?.clientId === "string" && CLIENT_ID_PATTERN.test(item.clientId))
    .map((item) => ({ clientId: item.clientId, uploadId: uploadIdFor(item.clientId), bytes: Number(item.bytes) || 0 }));
}

/** Upload entries from the learner snapshot's recent list (status only, never text). */
export function snapshotUploads(body) {
  const recent = Array.isArray(body?.recent) ? body.recent : Array.isArray(body?.learner?.recent) ? body.learner.recent : [];
  return recent
    .filter((entry) => entry?.type === "upload" && typeof entry.id === "string" && entry.id.startsWith("up_"))
    .map((entry) => ({
      uploadId: entry.id,
      title: entry.title === "File" ? "File" : entry.title === "Photo" ? "Photo" : "Photo or file",
      status: typeof entry.status === "string" ? entry.status : "",
      updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : null,
    }));
}

function remoteState(status) {
  if (status === "processing") return "received";
  if (status === "failed") return "failed";
  return "saved";
}

/**
 * One list from this device's captures, the inbox and the snapshot, keyed on uploadId so a capture
 * never appears twice. The server's view wins: snapshot over inbox over this device.
 */
export function mergeCaptures({ local = [], inbox = [], uploads = [], maxRows = MAX_ROWS }) {
  const rows = [];
  const byId = new Map();
  const add = (row) => {
    byId.set(row.uploadId, row);
    rows.push(row);
  };
  for (const item of local) {
    add({
      uploadId: item.uploadId,
      title: item.title,
      time: item.capturedAt,
      state: item.state,
      bytes: item.bytes,
      width: item.width ?? null,
      height: item.height ?? null,
      message: item.message ?? null,
      canRetry: item.state === "retry",
    });
  }
  for (const item of inbox) {
    const row = byId.get(item.uploadId);
    if (row) Object.assign(row, { state: "waiting", canRetry: false, message: null });
    else add({ uploadId: item.uploadId, title: titleForClientId(item.clientId), time: null, state: "waiting", bytes: item.bytes, canRetry: false });
  }
  for (const item of uploads) {
    const state = remoteState(item.status);
    const row = byId.get(item.uploadId);
    if (row) Object.assign(row, { state, canRetry: false, message: null, time: row.time ?? item.updatedAt });
    else add({ uploadId: item.uploadId, title: item.title, time: item.updatedAt, state, bytes: null, canRetry: false });
  }
  return rows.slice(0, maxRows).map((row) => ({
    ...row,
    message: row.message ?? STATE_MESSAGES[row.state] ?? CAPTURE_MESSAGES.saved,
  }));
}

const PENDING_STATES = new Set(["sending", "sent", "waiting"]);

/** True while something on the list is still on its way to the server. */
export function needsPolling(rows) {
  return rows.some((row) => PENDING_STATES.has(row.state));
}

const SEND_FAILURES = Object.freeze({
  rejected: "rejected",
  tooBig: "tooBig",
  notAllowed: "notAllowed",
  notConfigured: "notConfigured",
});

/**
 * Keeps this device's captures (in memory only, so nothing is left on a shared computer), sends
 * them one at a time, and refreshes the list from the Worker's /inbox and /snapshot.
 * onChange(rows) after every change; onEvent({ type, message }) for the page's status line;
 * onSignedOut(reason) when the Worker rejects the pass.
 */
export function createCaptureQueue({
  workerUrl,
  getToken,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  randomValues,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
  onChange = () => {},
  onEvent = () => {},
  onSignedOut = () => {},
  log = console,
  pollMs = POLL_MS,
  pollLimitMs = POLL_LIMIT_MS,
} = {}) {
  let generation = 0;
  let local = [];
  let remote = { inbox: [], uploads: [] };
  let chain = Promise.resolve();
  let timer = null;
  let refreshing = null;
  let lastActivity = now();

  const rows = () => mergeCaptures({ local, inbox: remote.inbox, uploads: remote.uploads });
  const changed = () => onChange(rows());

  function schedulePoll() {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    if (!needsPolling(rows()) || now() - lastActivity > pollLimitMs) return;
    const mine = generation;
    timer = setTimer(() => {
      timer = null;
      if (mine === generation) refresh();
    }, pollMs);
  }

  function signedOut(reason) {
    const handler = onSignedOut;
    stop();
    handler(reason);
  }

  async function send(item) {
    const mine = generation;
    if (item.state === "sent") return;
    item.state = "sending";
    item.message = null;
    changed();
    let result;
    try {
      result = await sendCapture({
        workerUrl,
        token: getToken(),
        clientId: item.clientId,
        mimeType: item.mimeType,
        source: item.source,
        contentKind: item.contentKind,
        capturedAt: item.capturedAt,
        base64: item.base64,
        fetchImpl,
      });
    } catch (err) {
      log.error?.("[capture] send failed:", err?.message ?? String(err));
      result = { kind: "retry" };
    }
    if (mine !== generation) return;
    if (result.kind === "auth") return signedOut(result.reason);
    if (result.kind === "ok") {
      item.state = "sent";
      item.base64 = null; // free the memory; the Worker has it now
      lastActivity = now();
      onEvent({ type: "sent", message: CAPTURE_MESSAGES.sent });
    } else if (Object.hasOwn(SEND_FAILURES, result.kind)) {
      item.state = "rejected";
      item.base64 = null;
      item.message = CAPTURE_MESSAGES[SEND_FAILURES[result.kind]];
      onEvent({ type: "rejected", message: item.message });
    } else {
      item.state = "retry";
      item.message = CAPTURE_MESSAGES.retry;
      onEvent({ type: "retry", message: item.message });
    }
    changed();
    schedulePoll();
  }

  function enqueue(item) {
    chain = chain.then(() => send(item));
    return chain;
  }

  /** Adds a prepared capture (from prepareCapture) and sends it. Returns its client ID. */
  function add(prepared, { source, capturedAt = new Date(now()).toISOString(), contentKind = "brief" } = {}) {
    const clientId = newClientId({ source, nowMs: now(), ...(randomValues ? { randomValues } : {}) });
    const item = {
      clientId,
      uploadId: uploadIdFor(clientId),
      title: prepared.image ? "Photo" : "File",
      source,
      contentKind,
      capturedAt,
      mimeType: prepared.mimeType,
      bytes: prepared.bytes,
      width: prepared.width ?? null,
      height: prepared.height ?? null,
      base64: prepared.base64,
      state: "queued",
      message: CAPTURE_MESSAGES.sending,
    };
    local.unshift(item);
    lastActivity = now();
    changed();
    enqueue(item);
    return clientId;
  }

  /** Sends a capture again with the same client ID, so it can't become a duplicate. */
  function retry(clientId) {
    const item = local.find((entry) => entry.clientId === clientId);
    if (!item || item.state !== "retry" || !item.base64) return null;
    item.state = "queued";
    lastActivity = now();
    changed();
    return enqueue(item);
  }

  async function refreshOnce() {
    const mine = generation;
    const token = getToken();
    if (!token) return;
    const ask = (path) => workerRequest({ workerUrl, path, token, fetchImpl });
    const [inbox, snapshot] = await Promise.all([ask("inbox"), ask("snapshot")]);
    if (mine !== generation) return;
    const auth = [inbox, snapshot].find((result) => result.kind === "auth");
    if (auth) return signedOut(auth.reason);
    if (inbox.kind === "ok") remote.inbox = inboxItems(inbox.body);
    if (snapshot.kind === "ok") remote.uploads = snapshotUploads(snapshot.body);
    else if (snapshot.kind === "http" && snapshot.status === 404) remote.uploads = []; // no snapshot yet
    // A capture the server already has needs no retry, even if its reply was lost on the way.
    const known = new Set([...remote.inbox, ...remote.uploads].map((entry) => entry.uploadId));
    for (const item of local) {
      if (known.has(item.uploadId) && item.state === "retry") {
        item.state = "sent";
        item.base64 = null;
      }
    }
    changed();
    schedulePoll();
  }

  /** Reads the inbox and snapshot again. manual: also restarts the 15-minute checking window. */
  function refresh({ manual = false } = {}) {
    if (manual) lastActivity = now();
    if (!refreshing) {
      refreshing = refreshOnce()
        .catch((err) => log.error?.("[capture] refresh failed:", err?.message ?? String(err)))
        .finally(() => {
          refreshing = null;
        });
    }
    return refreshing;
  }

  function start() {
    lastActivity = now();
    changed();
    return refresh();
  }

  /** Forgets everything (sign-out). Replies still on their way are ignored. */
  function stop() {
    generation += 1;
    if (timer !== null) clearTimer(timer);
    timer = null;
    local = [];
    remote = { inbox: [], uploads: [] };
    chain = Promise.resolve();
    refreshing = null;
    onChange = () => {};
    onEvent = () => {};
    onSignedOut = () => {};
  }

  return { add, retry, refresh, start, stop, rows, idle: () => chain };
}
