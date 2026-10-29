// WP-014b: capture screen, device resizing and the captures list. Invented data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as serverInbox from "../server/storage/inbox.js";
import { IMAGE_TOO_LARGE_MESSAGE as SERVER_TOO_LARGE } from "../server/ai/limits.js";
import {
  CAPTURE_MESSAGES,
  CLIENT_ID_PATTERN,
  FILE_ACCEPT,
  IMAGE_TOO_LARGE_MESSAGE,
  INBOX_KINDS,
  INBOX_MAX_BYTES,
  INBOX_SOURCES,
  INBOX_TYPES,
  RESIZE,
  bytesToBase64,
  classifyFile,
  createCaptureQueue,
  encodeWithinLimits,
  fitWithin,
  formatBytes,
  mergeCaptures,
  needsPolling,
  newClientId,
  prepareCapture,
  sendCapture,
  shortTime,
  snapshotUploads,
  titleForClientId,
  uploadIdFor,
} from "../web/shared/capture.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const WEB = join(ROOT, "web");
const WORKER = "https://wake.example.dev";
const NOW = Date.UTC(2026, 9, 29, 14, 5, 0);
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const fixedRandom = (array) => array.fill(7);

// ---------- copies of server constants ----------

test("front-end constants match the server's INBOX BLOCK and image message", () => {
  assert.equal(CLIENT_ID_PATTERN.source, serverInbox.CLIENT_ID_PATTERN.source);
  assert.equal(CLIENT_ID_PATTERN.flags, serverInbox.CLIENT_ID_PATTERN.flags);
  assert.deepEqual(JSON.parse(JSON.stringify(INBOX_TYPES)), JSON.parse(JSON.stringify(serverInbox.INBOX_TYPES)));
  assert.equal(INBOX_MAX_BYTES, serverInbox.INBOX_MAX_BYTES);
  assert.deepEqual([...INBOX_SOURCES], [...serverInbox.INBOX_SOURCES]);
  assert.deepEqual([...INBOX_KINDS], [...serverInbox.INBOX_KINDS]);
  assert.equal(IMAGE_TOO_LARGE_MESSAGE, SERVER_TOO_LARGE);
  assert.equal(CAPTURE_MESSAGES.failed, SERVER_TOO_LARGE);
  for (const id of ["p1abc-0011223344", "f-invented-12345678", "x".repeat(64)]) {
    assert.equal(uploadIdFor(id), serverInbox.uploadIdFor(id));
  }
});

test("the phase 0 status messages use the agreed wording", () => {
  assert.equal(CAPTURE_MESSAGES.received, "Received – it'll be read once reading is switched on.");
  assert.equal(CAPTURE_MESSAGES.failed, "This photo is too large to read. Please take it again.");
});

// ---------- IDs and labels ----------

test("client IDs are made on the device, match the server's pattern and record photo or file", () => {
  const ids = new Set();
  for (const source of ["camera", "gallery", "file"]) {
    for (let i = 0; i < 50; i += 1) {
      const id = newClientId({ source, nowMs: NOW });
      assert.match(id, serverInbox.CLIENT_ID_PATTERN, id);
      assert.equal(id[0], source === "file" ? "f" : "p");
      ids.add(id);
    }
  }
  assert.equal(ids.size, 150, "random part makes them unique");
  assert.equal(newClientId({ source: "camera", nowMs: NOW, randomValues: fixedRandom }), `p${NOW.toString(36)}-${"07".repeat(9)}`);
  assert.equal(titleForClientId("p123-abc"), "Photo");
  assert.equal(titleForClientId("f123-abc"), "File");
  assert.equal(titleForClientId("wp014-test-file"), "Photo or file");
  assert.equal(titleForClientId(undefined), "Photo or file");
});

test("sizes and times are shown plainly, in UK time", () => {
  assert.equal(formatBytes(300 * 1024), "300 KB");
  assert.equal(formatBytes(5.2 * 1024 * 1024), "5.2 MB");
  assert.equal(formatBytes(0), "");
  const winter = shortTime("2026-10-29T14:05:00.000Z");
  assert.match(winter, /29 Oct/);
  assert.match(winter, /14:05/);
  assert.match(shortTime("2026-07-01T09:00:00Z"), /10:00/, "British Summer Time");
  assert.equal(shortTime("not a date"), "");
  assert.equal(shortTime(null), "");
});

// ---------- classifying and resizing ----------

test("classifyFile sends every image to resizing and lets PDF and Word through", () => {
  assert.deepEqual(classifyFile({ name: "a.jpg", type: "image/jpeg" }), { route: "image" });
  assert.deepEqual(classifyFile({ name: "a.heic", type: "image/heic" }), { route: "image" });
  assert.deepEqual(classifyFile({ name: "scan.PNG", type: "" }), { route: "image" });
  assert.deepEqual(classifyFile({ name: "brief.pdf", type: "application/pdf" }), { route: "file", mimeType: "application/pdf" });
  assert.deepEqual(classifyFile({ name: "brief.docx", type: DOCX }), { route: "file", mimeType: DOCX });
  assert.deepEqual(classifyFile({ name: "brief.docx", type: "application/octet-stream" }), { route: "file", mimeType: DOCX });
  assert.equal(classifyFile({ name: "old.doc", type: "application/msword" }), null);
  assert.equal(classifyFile({ name: "notes.txt", type: "text/plain" }), null);
  assert.equal(classifyFile({}), null);
});

test("fitWithin keeps the shape, caps the longest edge at 1,600 px and never enlarges", () => {
  assert.deepEqual(fitWithin(4032, 3024), { width: 1600, height: 1200 });
  assert.deepEqual(fitWithin(3024, 4032), { width: 1200, height: 1600 });
  assert.deepEqual(fitWithin(800, 600), { width: 800, height: 600 });
  assert.deepEqual(fitWithin(10000, 10), { width: 1600, height: 2 });
  assert.equal(fitWithin(0, 100), null);
  assert.equal(fitWithin(Number.NaN, 100), null);
});

// A stand-in for canvas.toBlob: size grows with pixels and quality, scaled by how detailed the picture is.
function fakeEncoder(detail) {
  const calls = [];
  const encode = async (width, height, quality) => {
    calls.push({ width, height, quality });
    return { size: Math.round(width * height * quality * detail) };
  };
  return { encode, calls };
}

test("a detailed photo over 4 MB comes out at ≤ 1,600 px and within 700 KB", async () => {
  for (const detail of [0.15, 0.3, 0.45, 0.6, 1.0]) {
    const { encode, calls } = fakeEncoder(detail);
    const result = await encodeWithinLimits({ width: 4032, height: 3024, encode });
    assert.ok(Math.max(result.width, result.height) <= RESIZE.maxEdge, `detail ${detail}: edge`);
    assert.ok(result.bytes <= RESIZE.maxBytes, `detail ${detail}: ${result.bytes} bytes`);
    assert.ok(calls.every((c) => Math.max(c.width, c.height) <= RESIZE.maxEdge));
  }
});

test("encodeWithinLimits prefers the highest quality that meets the ~300 KB aim", async () => {
  const easy = fakeEncoder(0.1); // 1600×1200×0.85×0.1 ≈ 163 KB
  const r1 = await encodeWithinLimits({ width: 4032, height: 3024, encode: easy.encode });
  assert.equal(r1.quality, RESIZE.qualities[0]);
  assert.equal(easy.calls.length, 1);

  const medium = fakeEncoder(0.25); // needs a lower quality to reach 300 KB
  const r2 = await encodeWithinLimits({ width: 4032, height: 3024, encode: medium.encode });
  assert.ok(r2.bytes <= RESIZE.targetBytes);
  assert.ok(r2.quality < RESIZE.qualities[0]);
  assert.deepEqual([r2.width, r2.height], [1600, 1200], "no shrinking needed");
});

test("encodeWithinLimits shrinks the picture when quality alone isn't enough, and gives up cleanly", async () => {
  const heavy = fakeEncoder(0.9); // lowest quality at 1600×1200 ≈ 811 KB > 700 KB
  const r = await encodeWithinLimits({ width: 4032, height: 3024, encode: heavy.encode });
  assert.ok(r.width < 1600, "made smaller");
  assert.ok(r.bytes <= RESIZE.maxBytes);

  const impossible = { encode: async () => ({ size: RESIZE.maxBytes + 1 }) };
  await assert.rejects(encodeWithinLimits({ width: 4000, height: 3000, encode: impossible.encode }), { code: "tooLarge" });
  await assert.rejects(encodeWithinLimits({ width: 0, height: 0, encode: impossible.encode }), { code: "unreadable" });
});

test("bytesToBase64 matches Node's encoder and the server's size check", () => {
  for (const length of [1, 2, 3, 4, 100, 24575, 24576, 24577, 100003]) {
    const bytes = new Uint8Array(length).map((_, i) => (i * 31 + length) % 256);
    const text = bytesToBase64(bytes);
    assert.equal(text, Buffer.from(bytes).toString("base64"), `length ${length}`);
    assert.equal(serverInbox.base64Bytes(text), length, "server reads the same size");
    assert.doesNotMatch(text, /^data:/);
  }
  assert.equal(bytesToBase64(new Uint8Array(0)), "");
});

// ---------- preparing a capture ----------

const blobOf = (size, type = "image/jpeg", name = "photo.jpg") => {
  const blob = new Blob([new Uint8Array(size).fill(1)], { type });
  return Object.assign(blob, { name });
};

test("prepareCapture resizes images to JPEG and sends PDF and Word unchanged", async () => {
  const resized = blobOf(1234, "image/jpeg");
  const photo = await prepareCapture({
    file: blobOf(10, "image/png", "screen.png"),
    resizeImage: async () => ({ blob: resized, width: 1600, height: 900 }),
  });
  assert.equal(photo.mimeType, "image/jpeg");
  assert.equal(photo.bytes, 1234);
  assert.equal(photo.image, true);
  assert.deepEqual([photo.width, photo.height], [1600, 900]);
  assert.equal(serverInbox.base64Bytes(photo.base64), 1234);

  let resizeCalled = false;
  const pdf = await prepareCapture({
    file: blobOf(500, "application/pdf", "brief.pdf"),
    resizeImage: async () => {
      resizeCalled = true;
    },
  });
  assert.equal(resizeCalled, false);
  assert.equal(pdf.mimeType, "application/pdf");
  assert.equal(pdf.bytes, 500);
  assert.equal(pdf.image, false);

  const word = await prepareCapture({ file: blobOf(10, "", "brief.docx"), resizeImage: async () => {} });
  assert.equal(word.mimeType, DOCX);
});

test("prepareCapture reports problems without sending anything", async () => {
  const tooLarge = Object.assign(new Error("tooLarge"), { code: "tooLarge" });
  assert.deepEqual(
    await prepareCapture({ file: blobOf(10), resizeImage: async () => Promise.reject(tooLarge) }),
    { error: "failed" },
  );
  assert.deepEqual(
    await prepareCapture({ file: blobOf(10), resizeImage: async () => Promise.reject(new Error("decode")) }),
    { error: "unreadable" },
  );
  const bigPdf = { name: "big.pdf", type: "application/pdf", size: INBOX_MAX_BYTES + 1, arrayBuffer: async () => new ArrayBuffer(0) };
  assert.deepEqual(await prepareCapture({ file: bigPdf, resizeImage: async () => {} }), { error: "tooBig" });
  assert.deepEqual(await prepareCapture({ file: blobOf(10, "text/plain", "a.txt"), resizeImage: async () => {} }), { error: "wrongType" });
  assert.deepEqual(await prepareCapture({ file: blobOf(0, "application/pdf", "empty.pdf"), resizeImage: async () => {} }), { error: "unreadable" });
  for (const key of ["failed", "unreadable", "tooBig", "wrongType"]) assert.ok(CAPTURE_MESSAGES[key], key);
});

// ---------- sending ----------

function captureFetch(responses) {
  const calls = [];
  let n = 0;
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    const entry = responses[Math.min(n++, responses.length - 1)];
    if (entry === "network") throw new TypeError("Failed to fetch");
    return entry(url, init);
  };
  return { fetchImpl, calls };
}

const sendArgs = (fetchImpl, extra = {}) => ({
  workerUrl: WORKER,
  token: "test-pass",
  clientId: "p123abc-0011223344",
  mimeType: "image/jpeg",
  source: "camera",
  contentKind: "brief",
  capturedAt: "2026-10-29T14:05:00.000Z",
  base64: "AAAA",
  fetchImpl,
  ...extra,
});

test("sendCapture posts base64 text to /inbox with the agreed query and headers", async () => {
  const { fetchImpl, calls } = captureFetch([
    (url) => json({ clientId: new URL(url).searchParams.get("clientId"), uploadId: "up_x", bytes: 3, status: "received" }, 201),
  ]);
  const result = await sendCapture(sendArgs(fetchImpl));
  assert.equal(result.kind, "ok");
  const { url, init } = calls[0];
  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, `${WORKER}/inbox`);
  assert.deepEqual(Object.fromEntries(parsed.searchParams), {
    clientId: "p123abc-0011223344",
    type: "image/jpeg",
    source: "camera",
    kind: "brief",
    capturedAt: "2026-10-29T14:05:00.000Z",
  });
  assert.equal(init.method, "POST");
  assert.equal(init.body, "AAAA");
  assert.deepEqual(init.headers, { Accept: "application/json", Authorization: "Bearer test-pass", "Content-Type": "text/plain" });
  // the server would keep this capturedAt (not store it as null)
  assert.equal(serverInbox.inboxMetadata({ capturedAt: parsed.searchParams.get("capturedAt") }).capturedAt, "2026-10-29T14:05:00.000Z");
});

test("sendCapture sorts the Worker's answers into retry and no-retry", async () => {
  const kindFor = async (response) => (await sendCapture(sendArgs(captureFetch([response]).fetchImpl))).kind;
  assert.equal(await kindFor(() => json({ error: "x", reason: "the body must be base64 text" }, 400)), "rejected");
  assert.equal(await kindFor(() => json({ error: "The request is too large." }, 413)), "tooBig");
  assert.equal(await kindFor(() => json({ error: "Only the learner can add photos and files." }, 403)), "notAllowed");
  assert.equal(await kindFor(() => json({ error: "GitHub", githubStatus: 500 }, 502)), "retry");
  assert.equal(await kindFor("network"), "retry");
  assert.equal(await kindFor(() => new Response("<html>", { status: 200 })), "retry", "a page that isn't ours");
  assert.deepEqual(await sendCapture(sendArgs(captureFetch([() => json({ error: "x", reason: "expired" }, 401)]).fetchImpl)), {
    kind: "auth",
    reason: "expired",
  });
  assert.equal((await sendCapture(sendArgs(async () => {}, { workerUrl: "" }))).kind, "notConfigured");
});

// ---------- the list ----------

test("snapshotUploads keeps upload entries only, from either snapshot shape", () => {
  const recent = [
    { type: "notebook", id: "n_1", title: "Invented note", updatedAt: "2026-10-29T10:00:00+00:00" },
    { type: "upload", id: "up_p1-aaaaaaaa", title: "Photo", status: "processing", updatedAt: "2026-10-29T10:01:00+00:00" },
    { type: "upload", id: "up_f1-bbbbbbbb", title: "File", status: "failed", updatedAt: "2026-10-29T10:02:00+00:00" },
    { type: "upload", id: "u_old", title: "Photo", status: "processing" },
  ];
  const flat = snapshotUploads({ recent });
  assert.deepEqual(flat.map((u) => u.uploadId), ["up_p1-aaaaaaaa", "up_f1-bbbbbbbb"]);
  assert.deepEqual(snapshotUploads({ learner: { recent } }), flat);
  assert.deepEqual(snapshotUploads({}), []);
  assert.deepEqual(snapshotUploads(null), []);
});

test("mergeCaptures shows each capture once, with the server's status winning", () => {
  const rows = mergeCaptures({
    local: [
      { uploadId: "up_pA-11111111", title: "Photo", capturedAt: "2026-10-29T14:05:00Z", state: "retry", message: CAPTURE_MESSAGES.retry, bytes: 100 },
      { uploadId: "up_pB-22222222", title: "Photo", capturedAt: "2026-10-29T14:04:00Z", state: "sent", bytes: 100 },
    ],
    inbox: [
      { clientId: "pA-11111111", uploadId: "up_pA-11111111", bytes: 100 }, // the "failed" send actually arrived
      { clientId: "fC-33333333", uploadId: "up_fC-33333333", bytes: 900 }, // from another device
    ],
    uploads: [
      { uploadId: "up_pB-22222222", title: "Photo", status: "processing", updatedAt: "2026-10-29T14:06:00+00:00" },
      { uploadId: "up_pD-44444444", title: "Photo", status: "failed", updatedAt: "2026-10-29T13:00:00+00:00" },
    ],
  });
  assert.equal(rows.length, 4, "no duplicates");
  const byId = Object.fromEntries(rows.map((r) => [r.uploadId, r]));
  assert.equal(byId["up_pA-11111111"].state, "waiting");
  assert.equal(byId["up_pA-11111111"].canRetry, false, "no Try again once the Worker has it");
  assert.equal(byId["up_pA-11111111"].message, CAPTURE_MESSAGES.waiting);
  assert.equal(byId["up_pB-22222222"].message, CAPTURE_MESSAGES.received);
  assert.equal(byId["up_fC-33333333"].title, "File");
  assert.equal(byId["up_pD-44444444"].message, IMAGE_TOO_LARGE_MESSAGE);
  assert.equal(needsPolling(rows), true);
  assert.equal(needsPolling(rows.filter((r) => r.state === "received" || r.state === "failed")), false);
});

// ---------- the queue ----------

function fakeWorker({ inboxResponses = [], snapshotResponses = [], postResponses = [] } = {}) {
  const calls = [];
  const counters = { post: 0, inbox: 0, snapshot: 0 };
  const pick = (list, key) => {
    const entry = list[Math.min(counters[key]++, list.length - 1)];
    return entry;
  };
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    const method = init.method ?? "GET";
    const route = method === "POST" && parsed.pathname === "/inbox" ? "post" : parsed.pathname.slice(1);
    calls.push({ route, url, init });
    const list = route === "post" ? postResponses : route === "inbox" ? inboxResponses : snapshotResponses;
    const entry = pick(list, route);
    if (entry === undefined) return route === "snapshot" ? json({ error: "none" }, 404) : json({ items: [], count: 0 });
    if (entry === "network") throw new TypeError("Failed to fetch");
    return entry(parsed, init);
  };
  return { fetchImpl, calls };
}

const accepted = (parsed) => json({ clientId: parsed.searchParams.get("clientId"), uploadId: `up_${parsed.searchParams.get("clientId")}`, bytes: 3, status: "received" }, 201);
const prepared = { mimeType: "image/jpeg", bytes: 3, base64: "AAAA", image: true, width: 1600, height: 1200 };

function fakeTimers() {
  const pending = [];
  return {
    setTimer: (fn, ms) => {
      pending.push({ fn, ms });
      return pending.length;
    },
    clearTimer: () => {},
    pending,
  };
}

test("a failed send keeps its client ID; Try again reuses it and the body, so no duplicate", async () => {
  const worker = fakeWorker({ postResponses: ["network", accepted] });
  const events = [];
  let latest = [];
  const timers = fakeTimers();
  const queue = createCaptureQueue({
    workerUrl: WORKER,
    getToken: () => "test-pass",
    fetchImpl: worker.fetchImpl,
    now: () => NOW,
    onChange: (rows) => (latest = rows),
    onEvent: (e) => events.push(e.type),
    log: { error() {} },
    ...timers,
  });
  const clientId = queue.add(prepared, { source: "camera", capturedAt: "2026-10-29T14:05:00.000Z" });
  await queue.idle();
  assert.equal(latest[0].state, "retry");
  assert.equal(latest[0].canRetry, true);
  assert.equal(latest[0].message, CAPTURE_MESSAGES.retry);

  await queue.retry(clientId);
  const posts = worker.calls.filter((c) => c.route === "post");
  assert.equal(posts.length, 2);
  const ids = posts.map((c) => new URL(c.url).searchParams.get("clientId"));
  assert.deepEqual(ids, [clientId, clientId], "same client ID both times");
  assert.deepEqual(posts.map((c) => c.init.body), ["AAAA", "AAAA"]);
  assert.equal(latest.length, 1);
  assert.equal(latest[0].state, "sent");
  assert.equal(latest[0].message, CAPTURE_MESSAGES.waiting);
  assert.deepEqual(events, ["retry", "sent"]);
  assert.equal(queue.retry(clientId), null, "nothing to retry once sent");
  assert.ok(timers.pending.length > 0, "checks the list again while the capture is waiting");
});

test("captures are sent one at a time, as briefs, with the source given", async () => {
  const worker = fakeWorker({ postResponses: [accepted] });
  const queue = createCaptureQueue({ workerUrl: WORKER, getToken: () => "t", fetchImpl: worker.fetchImpl, now: () => NOW, ...fakeTimers() });
  queue.add(prepared, { source: "gallery" });
  queue.add({ ...prepared, mimeType: "application/pdf", image: false }, { source: "file" });
  await queue.idle();
  const posts = worker.calls.filter((c) => c.route === "post").map((c) => Object.fromEntries(new URL(c.url).searchParams));
  assert.deepEqual(posts.map((p) => [p.source, p.kind, p.type, p.clientId[0]]), [
    ["gallery", "brief", "image/jpeg", "p"],
    ["file", "brief", "application/pdf", "f"],
  ]);
  assert.deepEqual(queue.rows().map((r) => r.title), ["File", "Photo"], "newest first");
});

test("a rejected capture shows why and offers no retry", async () => {
  const worker = fakeWorker({ postResponses: [() => json({ error: "x" }, 413)] });
  const queue = createCaptureQueue({ workerUrl: WORKER, getToken: () => "t", fetchImpl: worker.fetchImpl, now: () => NOW, ...fakeTimers() });
  queue.add(prepared, { source: "camera" });
  await queue.idle();
  const [row] = queue.rows();
  assert.equal(row.state, "rejected");
  assert.equal(row.canRetry, false);
  assert.equal(row.message, CAPTURE_MESSAGES.tooBig);
});

test("refresh merges the inbox and snapshot, and clears a retry the Worker already has", async () => {
  const worker = fakeWorker({ postResponses: ["network"] });
  let clientId;
  worker.fetchImpl = ((inner) => async (url, init) => {
    const path = new URL(url).pathname;
    if ((init?.method ?? "GET") === "GET" && path === "/inbox") return json({ items: [{ clientId, uploadId: `up_${clientId}`, bytes: 3 }], count: 1 });
    if (path === "/snapshot") {
      return json({ recent: [{ type: "upload", id: "up_pZ-99999999", title: "Photo", status: "processing", updatedAt: "2026-10-29T13:00:00+00:00" }] });
    }
    return inner(url, init);
  })(worker.fetchImpl);
  const queue = createCaptureQueue({ workerUrl: WORKER, getToken: () => "t", fetchImpl: worker.fetchImpl, now: () => NOW, log: { error() {} }, ...fakeTimers() });
  clientId = queue.add(prepared, { source: "camera" });
  await queue.idle();
  assert.equal(queue.rows()[0].state, "retry");
  await queue.refresh();
  const rows = queue.rows();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].state, "waiting");
  assert.equal(rows[0].canRetry, false);
  assert.equal(rows[1].message, CAPTURE_MESSAGES.received);
  assert.equal(queue.retry(clientId), null);
});

test("no snapshot yet (404) is not an error", async () => {
  const worker = fakeWorker();
  const queue = createCaptureQueue({ workerUrl: WORKER, getToken: () => "t", fetchImpl: worker.fetchImpl, now: () => NOW, ...fakeTimers() });
  await queue.start();
  assert.deepEqual(queue.rows(), []);
  assert.deepEqual(worker.calls.map((c) => c.route).sort(), ["inbox", "snapshot"]);
  assert.ok(worker.calls.every((c) => c.init.headers.Authorization === "Bearer t"));
});

test("a rejected pass signs out, and later replies are ignored", async () => {
  let signedOut = null;
  const worker = fakeWorker({ inboxResponses: [() => json({ error: "x", reason: "version" }, 401)] });
  const queue = createCaptureQueue({
    workerUrl: WORKER,
    getToken: () => "t",
    fetchImpl: worker.fetchImpl,
    now: () => NOW,
    onSignedOut: (reason) => (signedOut = reason),
    ...fakeTimers(),
  });
  await queue.start();
  assert.equal(signedOut, "version");
  assert.deepEqual(queue.rows(), [], "nothing kept after sign-out");

  const slow = fakeWorker({ postResponses: [accepted] });
  let changes = 0;
  const q2 = createCaptureQueue({ workerUrl: WORKER, getToken: () => "t", fetchImpl: slow.fetchImpl, now: () => NOW, onChange: () => changes++, ...fakeTimers() });
  q2.add(prepared, { source: "camera" });
  const before = changes;
  q2.stop();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(changes, before, "no updates after stop()");
  assert.deepEqual(q2.rows(), []);
});

test("checking stops 15 minutes after the last activity, and never runs with nothing pending", async () => {
  let clock = NOW;
  const timers = fakeTimers();
  const worker = fakeWorker({ inboxResponses: [() => json({ items: [{ clientId: "pOther-12345678", bytes: 5 }], count: 1 })] });
  const queue = createCaptureQueue({ workerUrl: WORKER, getToken: () => "t", fetchImpl: worker.fetchImpl, now: () => clock, ...timers });
  await queue.start();
  assert.equal(timers.pending.length, 1, "pending capture: check again");
  assert.equal(timers.pending[0].ms, 15_000);
  clock += 16 * 60 * 1000;
  await queue.refresh();
  assert.equal(timers.pending.length, 1, "no new check after 15 minutes");
  await queue.refresh({ manual: true });
  assert.equal(timers.pending.length, 2, "Check again restarts the window");

  const idleTimers = fakeTimers();
  const idle = createCaptureQueue({ workerUrl: WORKER, getToken: () => "t", fetchImpl: fakeWorker().fetchImpl, now: () => NOW, ...idleTimers });
  await idle.start();
  assert.equal(idleTimers.pending.length, 0);
});

// ---------- pages and code rules ----------

test("web/shared/capture.js uses no DOM-only or Node-only APIs", () => {
  // Comments and string literals are removed first: the Word MIME type contains ".document".
  const source = readFileSync(join(WEB, "shared", "capture.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
  assert.doesNotMatch(source, /\b(document|window|localStorage|sessionStorage|navigator|process|Buffer|require)\b/);
  assert.doesNotMatch(source, /from\s+["']node:/);
});

test("capture code builds the list with text only and never logs file names", () => {
  for (const file of ["capture.js", join("shared", "capture.js")]) {
    const source = readFileSync(join(WEB, file), "utf8");
    assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML/, file);
    assert.doesNotMatch(source, /console\.\w+\([^)]*\.name\b/, file);
    assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB/, `${file}: nothing kept in the browser`);
  }
});

test("learner page has the capture section with camera, gallery and file inputs", () => {
  const html = readFileSync(join(WEB, "index.html"), "utf8");
  assert.match(html, /<h2 id="capture-heading">What are you working on\?<\/h2>/);
  assert.match(html, /<button type="button" id="capture-camera"[^>]*>Take a photo<\/button>/);
  assert.match(html, /<button type="button" id="capture-gallery"[^>]*>Choose a photo<\/button>/);
  assert.match(html, /<button type="button" id="capture-file"[^>]*>Add a file<\/button>/);
  assert.match(html, /<input type="file" id="capture-camera-input" accept="image\/\*" capture="environment" hidden>/);
  assert.match(html, /<input type="file" id="capture-gallery-input" accept="image\/\*" multiple hidden>/);
  const fileAccept = html.match(/id="capture-file-input" accept="([^"]+)"/)?.[1];
  assert.equal(fileAccept, FILE_ACCEPT);
  assert.match(html, /id="capture-status" class="status" role="status" aria-live="polite"/);
  assert.match(html, /<ul id="captures-list"/);
  assert.match(html, /<button type="button" id="captures-refresh"/);
  assert.doesNotMatch(html, /More of the app is on its way/);
});

test("deploy stamping covers the capture modules", () => {
  const dir = mkdtempSync(join(tmpdir(), "wp014b-stamp-"));
  try {
    cpSync(WEB, join(dir, "web"), { recursive: true });
    execFileSync("bash", [join(ROOT, "scripts", "stamp-versions.sh"), join(dir, "web"), "abc12345"], { stdio: "pipe" });
    const appJs = readFileSync(join(dir, "web", "app.js"), "utf8");
    assert.match(appJs, /from "\.\/capture\.js\?v=abc12345"/);
    const captureJs = readFileSync(join(dir, "web", "capture.js"), "utf8");
    assert.match(captureJs, /from "\.\/shared\/capture\.js\?v=abc12345"/);
    const sharedJs = readFileSync(join(dir, "web", "shared", "capture.js"), "utf8");
    assert.match(sharedJs, /from "\.\/auth\.js\?v=abc12345"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("app.js still imports under Node without a DOM", async () => {
  const app = await import("../web/app.js");
  assert.equal(typeof app.loginUrl, "function");
  const capture = await import("../web/capture.js");
  assert.equal(typeof capture.createCaptureScreen, "function");
  assert.equal(typeof capture.resizeImage, "function");
});
