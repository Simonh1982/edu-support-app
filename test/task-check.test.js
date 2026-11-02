// WP-108b: paste, type and "Check the details", the PDF file check and the capture messages.
// Invented data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as serverTasks from "../server/domain/tasks.js";
import * as serverReading from "../server/ai/reading.js";
import * as serverUploads from "../server/domain/uploads.js";
import { READ_FAILURE_REASONS } from "../server/reader.js";
import * as serverInbox from "../server/storage/inbox.js";
import {
  ANCHOR_LABELS,
  CHECK_FIELDS,
  CHECK_MESSAGES,
  FIELD_PROMPTS,
  PASTE_MAX_CHARS,
  READ_ANCHOR_TYPES,
  TASK_KINDS,
  TASK_LIMITS,
  WORK_TYPES,
  addChip,
  anchorsBody,
  checkPlan,
  chipText,
  confirmationBody,
  correctQuestion,
  editChip,
  formatDeadline,
  initialChips,
  initialUndone,
  pasteCheck,
  previewQuestion,
  readNotes,
  removeChip,
  textSegments,
  typedTaskBody,
} from "../web/shared/task-check.js";
import { API_ERRORS, apiErrorMessage, apiRequest, apiUrl, createApi, waitForReading } from "../web/shared/api.js";
import {
  CAPTURE_MESSAGES,
  FAILURE_MESSAGES,
  IMAGE_TOO_LARGE_MESSAGE,
  createCaptureQueue,
  failureMessage,
  mergeCaptures,
  needsPolling,
  newClientId,
  prepareCapture,
  routeFromBytes,
  rowMessage,
  snapshotUploads,
  titleForClientId,
} from "../web/shared/capture.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const WEB = join(ROOT, "web");
const BACKEND = "https://invented-space-3000.app.github.dev";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// An invented brief, read with one correction ("strech" → "stretch") and one unclear name.
const TEXT = "Geography homework\nEvaluate the coastal defences along a strech of Imaginary Bay.\nDue: next week";
const VERBATIM = "Evaluate the coastal defences along a strech of Imaginary Bay.";
const STRECH = TEXT.indexOf("strech");
const BAY = TEXT.indexOf("Imaginary Bay");
function invitedView(overrides = {}) {
  return {
    id: "up_tInvented-0001",
    status: "done",
    failureReason: null,
    contentKind: "brief",
    taskId: null,
    text: TEXT,
    truncated: false,
    uncertain: [{ text: "Imaginary Bay", start: BAY, end: BAY + 13 }],
    spellingCorrections: [{ original: "strech", corrected: "stretch", position: STRECH, undone: false }],
    proposal: {
      title: "Coastal defences",
      subject: null,
      qualificationId: null,
      kind: "homework",
      workType: "essay",
      question: { verbatim: VERBATIM, corrected: VERBATIM.replace("strech", "stretch") },
      deadline: null,
      marks: 12,
      wordCount: null,
      anchors: [
        { type: "question", text: { value: VERBATIM.replace("strech", "stretch"), author: "source" }, confirmed: false },
        { type: "location", text: { value: "Imaginary Bay", author: "source" }, confirmed: false },
      ],
      topicIds: [],
      uncertainFields: [],
    },
    ask: ["subject", "deadline"],
    ...overrides,
  };
}

// ---------- copies of server values ----------

test("front-end copies match the server's task, reading and paste values", () => {
  assert.deepEqual([...TASK_KINDS], [...serverTasks.TASK_KINDS]);
  assert.deepEqual([...WORK_TYPES], [...serverTasks.WORK_TYPES]);
  assert.deepEqual([...READ_ANCHOR_TYPES], [...serverReading.READ_ANCHOR_TYPES]);
  for (const key of Object.keys(TASK_LIMITS)) assert.equal(TASK_LIMITS[key], serverTasks.TASK_LIMITS[key], key);
  assert.equal(PASTE_MAX_CHARS, serverUploads.PASTE_MAX_CHARS);
  for (const field of CHECK_FIELDS) assert.ok(serverReading.PROPOSAL_FIELDS.includes(field), field);
  for (const type of READ_ANCHOR_TYPES) assert.ok(ANCHOR_LABELS[type], type);
});

test("every server failure reason has its own message, with the A-002 and A-003 wording", () => {
  for (const reason of READ_FAILURE_REASONS) assert.ok(FAILURE_MESSAGES[reason], reason);
  assert.equal(failureMessage("too-large"), IMAGE_TOO_LARGE_MESSAGE);
  assert.equal(failureMessage("scanned-pdf"), "This PDF can't be read as it is. Please take photos of the pages instead.");
  assert.equal(failureMessage("made-up"), CAPTURE_MESSAGES.couldNotRead);
  assert.equal(failureMessage(null), CAPTURE_MESSAGES.couldNotRead);
  assert.equal(failureMessage("toString"), CAPTURE_MESSAGES.couldNotRead);
});

test("the question preview matches the server's corrected question, with and without undo", () => {
  const corrections = [{ original: "strech", corrected: "stretch", position: STRECH }];
  for (const undone of [false, true]) {
    const list = corrections.map((c) => ({ ...c, undone }));
    assert.equal(correctQuestion(VERBATIM, TEXT, list), serverReading.correctQuestion(VERBATIM, TEXT, list));
  }
  // a question the model tidied (not found in the text as written)
  const tidied = "Evaluate the coastal defences along a strech of Imaginary Bay";
  const list = corrections.map((c) => ({ ...c, undone: false }));
  assert.equal(correctQuestion(tidied, "other words", list), serverReading.correctQuestion(tidied, "other words", list));
  const view = invitedView();
  assert.match(previewQuestion(view), /a stretch of/);
  assert.match(previewQuestion(view, new Set([STRECH])), /a strech of/);
  assert.equal(previewQuestion(invitedView({ proposal: { ...view.proposal, question: null } })), "");
});

// ---------- what to ask ----------

test("checkPlan asks only for what's missing or unsure, in plain words", () => {
  const plan = checkPlan(invitedView());
  assert.deepEqual(plan.ask.map((a) => a.field), ["subject", "deadline"]);
  assert.equal(plan.ask[1].prompt, "I couldn't find a deadline. Do you know when it's due?");
  assert.equal(plan.ask[0].prompt, FIELD_PROMPTS.subject.missing);
  assert.deepEqual(plan.other, ["title", "question", "kind", "workType", "marks", "wordCount"]);
  assert.equal(plan.values.title, "Coastal defences");
  assert.equal(plan.values.marks, 12);
  assert.match(plan.values.question, /stretch/);

  const unsure = checkPlan(invitedView({ ask: ["question", "topics", "qualificationId"] }));
  assert.deepEqual(unsure.ask, [{ field: "question", prompt: FIELD_PROMPTS.question.unsure }], "topics and qualification aren't asked here");
  assert.deepEqual(checkPlan(invitedView({ ask: [] })).ask, []);
});

// ---------- what was read ----------

test("textSegments highlights unclear parts and shows corrections, as written once undone", () => {
  const view = invitedView();
  const segs = textSegments(view.text, view.uncertain, view.spellingCorrections);
  assert.equal(segs.map((s) => (s.kind === "correction" ? s.original : s.text)).join(""), TEXT, "nothing lost or doubled");
  const correction = segs.find((s) => s.kind === "correction");
  assert.deepEqual([correction.text, correction.undone], ["stretch", false]);
  assert.equal(segs.find((s) => s.kind === "uncertain").text, "Imaginary Bay");
  const undone = textSegments(view.text, view.uncertain, view.spellingCorrections, new Set([STRECH]));
  assert.equal(undone.find((s) => s.kind === "correction").text, "strech");

  // overlapping or out-of-range marks are skipped, never doubled
  const odd = textSegments("abcdef", [{ start: 0, end: 4 }, { start: 2, end: 5 }, { start: 3, end: 99 }], []);
  assert.deepEqual(odd.map((s) => [s.kind, s.text]), [["uncertain", "abcd"], ["plain", "ef"]]);
  assert.deepEqual(textSegments(null, null, []), []);
});

test("readNotes counts unclear parts, lists ones it couldn't place and flags thin PDF pages", () => {
  assert.deepEqual(readNotes([]), []);
  const notes = readNotes([
    { text: "Imaginary Bay", start: 5, end: 18 },
    { text: "a smudged word", start: null, end: null },
    { text: null, start: null, end: null, page: 3, reason: "little-text" },
  ]);
  assert.equal(notes[0], "1 unclear part is highlighted.");
  assert.match(notes[1], /“a smudged word”/);
  assert.match(notes[2], /^Page 3 has very little text/);
});

// ---------- anchor chips ----------

test("chips start from the draft anchors; an untouched question chip follows the question", () => {
  const view = invitedView();
  const chips = initialChips(view.proposal);
  assert.deepEqual(chips.map((c) => [c.type, c.author, c.draft, c.edited]), [
    ["question", "source", true, false],
    ["location", "source", true, false],
  ]);
  assert.match(chipText(chips[0], previewQuestion(view, new Set([STRECH]))), /strech/, "follows the undo");
  assert.equal(chipText(chips[1], "anything"), "Imaginary Bay");

  const edited = editChip(chips, chips[1].key, "  Imaginary   Bay  north ").chips;
  assert.deepEqual([edited[1].value, edited[1].edited], ["Imaginary Bay north", true]);
  assert.equal(editChip(chips, chips[1].key, "   ").error, CHECK_MESSAGES.chipEmpty);
  assert.equal(removeChip(chips, chips[0].key).length, 1);
  const more = addChip(chips, { type: "text", value: "An invented play" }, "new-1").chips;
  assert.equal(more.at(-1).author, "learner");
  assert.equal(addChip(chips, { type: "thesis", value: "x" }, "k").error, CHECK_MESSAGES.chipEmpty, "thesis comes from his plan");
  const full = Array.from({ length: TASK_LIMITS.anchors }, (_, i) => ({ key: `k${i}`, type: "location", value: "x" }));
  assert.equal(addChip(full, { type: "location", value: "y" }, "k99").error, CHECK_MESSAGES.chipsFull);

  assert.deepEqual(anchorsBody(edited), [
    { type: "question", text: { value: chips[0].value, author: "source" } },
    { type: "location", text: { value: "Imaginary Bay north", author: "learner" } },
  ]);
});

// ---------- request bodies, checked against the real server code ----------

function memoryStore(records = {}) {
  const files = new Map(Object.entries(records));
  const events = [];
  return {
    files,
    events,
    read: async (path) => (files.has(path) ? structuredClone(files.get(path)) : null),
    put: async (path, record) => void files.set(path, structuredClone(record)),
    logEvent: async (type, options) => void events.push({ type, ...options }),
  };
}

function uploadRecord(view) {
  return {
    id: view.id,
    createdAt: "2026-11-01T10:00:00+00:00",
    updatedAt: "2026-11-01T10:00:00+00:00",
    createdBy: "learner",
    schemaVersion: 1,
    status: "done",
    contentKind: "brief",
    extractedText: { value: view.text, author: "source" },
    uncertain: view.uncertain,
    spellingCorrections: view.spellingCorrections,
    proposal: view.proposal,
    taskId: null,
  };
}

test("the confirmation body is accepted by the server and keeps the learner's undo", async () => {
  const view = invitedView();
  const undone = new Set([STRECH]);
  const plan = checkPlan(view, undone);
  const values = Object.fromEntries(CHECK_FIELDS.map((f) => [f, plan.values[f] === null ? "" : String(plan.values[f])]));
  values.subject = "Geography";
  values.deadline = "2026-11-13";
  const { body } = confirmationBody({ values, chips: initialChips(view.proposal), undone });
  assert.deepEqual(body.undoneCorrections, [STRECH]);
  assert.equal(body.marks, 12);
  assert.equal(body.wordCount, null);
  assert.equal("questionText" in body, false, "the server works the question out from the undo");

  const store = memoryStore({ [`uploads/${view.id}.json`]: uploadRecord(view) });
  const { task, upload } = await serverUploads.confirmUpload(store, view.id, body, { now: new Date("2026-11-02T09:00:00Z") });
  assert.equal(task.questionText.value, VERBATIM, "the undone correction isn't applied");
  assert.equal(task.anchors[0].text.value, VERBATIM, "the question chip follows");
  assert.equal(task.anchors[1].text.value, "Imaginary Bay");
  assert.ok(task.anchors.every((a) => a.confirmed === true));
  assert.deepEqual([task.subject, task.deadline, task.kind, task.workType, task.marks], ["Geography", "2026-11-13", "homework", "essay", 12]);
  assert.equal(upload.taskId, task.id);
  const confirmed = store.events.find((e) => e.type === "upload.confirmed");
  assert.deepEqual(confirmed.payload.changed, ["subject", "deadline"], "only what he changed");
});

test("an edited question is sent as his text, and blanks become null", async () => {
  const view = invitedView();
  const values = { title: "  Coastal   defences ", subject: "", deadline: "", question: "Evaluate the sea wall.", kind: "", workType: "essay", marks: "", wordCount: "1500" };
  const { body } = confirmationBody({ values, chips: [], questionEdited: true });
  assert.deepEqual(
    { title: body.title, subject: body.subject, deadline: body.deadline, kind: body.kind, marks: body.marks, wordCount: body.wordCount, questionText: body.questionText },
    { title: "Coastal defences", subject: null, deadline: null, kind: null, marks: null, wordCount: 1500, questionText: "Evaluate the sea wall." },
  );
  const store = memoryStore({ [`uploads/${view.id}.json`]: uploadRecord(view) });
  const { task } = await serverUploads.confirmUpload(store, view.id, body);
  assert.equal(task.questionText.value, "Evaluate the sea wall.");
  assert.deepEqual(task.anchors, [], "he removed every chip");
});

test("confirmationBody and the typed form catch problems before anything is sent", () => {
  const base = { title: "A title", subject: "", deadline: "", question: "", kind: "", workType: "", marks: "", wordCount: "" };
  const fields = (values) => confirmationBody({ values: { ...base, ...values }, chips: [] }).errors?.map((e) => e.field);
  assert.deepEqual(fields({ title: "   " }), ["title"]);
  assert.deepEqual(fields({ title: "x".repeat(121) }), ["title"]);
  assert.deepEqual(fields({ subject: "x".repeat(41) }), ["subject"]);
  assert.deepEqual(fields({ deadline: "2026-02-30" }), ["deadline"]);
  assert.deepEqual(fields({ marks: "12.5" }), ["marks"]);
  assert.deepEqual(fields({ marks: "1001" }), ["marks"]);
  assert.deepEqual(fields({ wordCount: "lots" }), ["wordCount"]);
  assert.equal(fields({ marks: "0", wordCount: "100000" }), undefined);
  assert.equal(confirmationBody({ values: { ...base, title: "" }, chips: [] }).errors[0].message, CHECK_MESSAGES.needTitle);
  assert.deepEqual(typedTaskBody({ title: "", deadline: "" }).errors.map((e) => e.field), ["title"]);
});

test("a typed task needs only a title and a deadline, and the server accepts it", () => {
  const { body } = typedTaskBody({ title: "Invented worksheet", deadline: "2026-11-20", question: "" });
  assert.deepEqual(body, { title: "Invented worksheet", deadline: "2026-11-20", questionText: null, anchors: [] });
  const task = serverTasks.newTask({ confirmed: true, ...body });
  assert.deepEqual([task.title, task.deadline, task.confirmed], ["Invented worksheet", "2026-11-20", true]);

  const withQuestion = typedTaskBody({ title: "Invented essay", deadline: "", question: " Discuss an invented theme. " }).body;
  const typed = serverTasks.newTask({ confirmed: true, ...withQuestion });
  assert.equal(typed.questionText.value, "Discuss an invented theme.");
  assert.equal(typed.questionText.author, "learner");
  assert.deepEqual([typed.anchors[0].type, typed.anchors[0].confirmed], ["question", true]);
});

test("pasteCheck trims, refuses empty text and keeps to the server's limit", () => {
  assert.deepEqual(pasteCheck("  line one\r\nline two  "), { text: "line one\nline two" });
  assert.equal(pasteCheck("   ").error, CHECK_MESSAGES.pasteEmpty);
  assert.equal(pasteCheck("x".repeat(PASTE_MAX_CHARS)).text.length, PASTE_MAX_CHARS);
  assert.equal(pasteCheck("x".repeat(PASTE_MAX_CHARS + 1)).error, CHECK_MESSAGES.pasteTooLong);
});

test("deadlines are shown as UK calendar dates, unmoved by the clock change", () => {
  assert.equal(formatDeadline("2026-11-07"), "Saturday 7 November 2026");
  assert.equal(formatDeadline("2026-03-29"), "Sunday 29 March 2026");
  assert.equal(formatDeadline("2026-10-25"), "Sunday 25 October 2026");
  assert.equal(formatDeadline(""), "");
  assert.equal(formatDeadline("2026-02-30"), "");
});

test("initialUndone keeps corrections already undone", () => {
  const view = invitedView({ spellingCorrections: [{ original: "strech", corrected: "stretch", position: STRECH, undone: true }] });
  assert.deepEqual([...initialUndone(view)], [STRECH]);
});

// ---------- talking to the tutor ----------

function fakeFetch(responses) {
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

test("apiRequest sends the pass, JSON only with a body, and sorts the answers", async () => {
  const { fetchImpl, calls } = fakeFetch([() => json({ upload: { id: "up_x" } }, 201)]);
  const ok = await apiRequest({ backendUrl: BACKEND, path: "api/uploads/paste", token: "t", method: "POST", body: { a: 1 }, fetchImpl });
  assert.equal(ok.kind, "ok");
  assert.equal(calls[0].url, `${BACKEND}/api/uploads/paste`);
  assert.deepEqual(calls[0].init.headers, { Accept: "application/json", Authorization: "Bearer t", "Content-Type": "application/json" });
  assert.equal(calls[0].init.body, '{"a":1}');

  const get = fakeFetch([() => json({ upload: {} })]);
  await apiRequest({ backendUrl: `${BACKEND}/`, path: "/api/uploads/up_x", token: "t", fetchImpl: get.fetchImpl });
  assert.equal(get.calls[0].url, `${BACKEND}/api/uploads/up_x`);
  assert.equal("Content-Type" in get.calls[0].init.headers, false);
  assert.equal(get.calls[0].init.body, undefined);

  const kind = async (response) => (await apiRequest({ backendUrl: BACKEND, path: "x", token: "t", fetchImpl: fakeFetch([response]).fetchImpl }));
  assert.deepEqual(await kind(() => json({ error: "x", reason: "expired" }, 401)), { kind: "auth", status: 401, reason: "expired" });
  assert.equal((await kind(() => json({ error: "x" }, 409))).kind, "http");
  assert.equal((await kind("network")).kind, "network");
  assert.equal((await kind(() => new Response("<html>", { status: 200 }))).kind, "not-json");
  assert.equal((await apiRequest({ backendUrl: "http://plain.example", path: "x", token: "t" })).kind, "no-address");
  assert.equal((await apiRequest({ backendUrl: BACKEND, path: "x", token: null })).kind, "no-address");
  assert.equal(apiUrl(`${BACKEND}/some/path`, "x"), null, "origin only");
});

test("apiErrorMessage gives plain messages and passes on the server's field messages", () => {
  assert.equal(apiErrorMessage({ kind: "network" }), API_ERRORS.network);
  assert.equal(apiErrorMessage({ kind: "http", status: 503, body: {} }), API_ERRORS.notReady);
  assert.equal(apiErrorMessage({ kind: "http", status: 429, body: {} }), API_ERRORS.busy);
  assert.equal(apiErrorMessage({ kind: "http", status: 403, body: {} }), API_ERRORS.notAllowed);
  assert.equal(apiErrorMessage({ kind: "http", status: 400, body: { error: "deadline must be a date (YYYY-MM-DD)" } }), "deadline must be a date (YYYY-MM-DD)");
  assert.equal(apiErrorMessage({ kind: "http", status: 500, body: { error: "Internal error" } }), API_ERRORS.server);
});

test("createApi uses the agreed routes and encodes the upload id", async () => {
  const { fetchImpl, calls } = fakeFetch([() => json({})]);
  const api = createApi({ getBackendUrl: () => BACKEND, getToken: () => "t", fetchImpl });
  await api.pasteBrief({ clientId: "tInvented-0001", text: "An invented brief." });
  await api.openUpload("up_tInvented-0001");
  await api.confirmUpload("up_tInvented-0001", { title: "x" });
  await api.addTask({ title: "x" });
  assert.deepEqual(calls.map((c) => [c.init.method, new URL(c.url).pathname]), [
    ["POST", "/api/uploads/paste"],
    ["GET", "/api/uploads/up_tInvented-0001"],
    ["POST", "/api/uploads/up_tInvented-0001/confirm"],
    ["POST", "/api/tasks"],
  ]);
  assert.deepEqual(JSON.parse(calls[0].init.body), { clientId: "tInvented-0001", text: "An invented brief." });
});

test("waitForReading checks again while the upload is being read, and gives up after the limit", async () => {
  let clock = 0;
  const sleep = async (ms) => void (clock += ms);
  const reading = () => json({ upload: { id: "up_x", status: "processing" } });
  const done = () => json({ upload: { id: "up_x", status: "done" } });
  let waits = 0;
  const api = createApi({ getBackendUrl: () => BACKEND, getToken: () => "t", fetchImpl: fakeFetch([reading, reading, done]).fetchImpl });
  const result = await waitForReading({ api, uploadId: "up_x", sleep, now: () => clock, onWaiting: () => waits++ });
  assert.equal(result.kind, "ok");
  assert.equal(result.upload.status, "done");
  assert.equal(waits, 2);

  clock = 0;
  const slow = createApi({ getBackendUrl: () => BACKEND, getToken: () => "t", fetchImpl: fakeFetch([reading]).fetchImpl });
  assert.equal((await waitForReading({ api: slow, uploadId: "up_x", sleep, now: () => clock, stepMs: 10, limitMs: 50 })).kind, "timeout");

  const out = createApi({ getBackendUrl: () => BACKEND, getToken: () => "t", fetchImpl: fakeFetch([() => json({ reason: "version" }, 401)]).fetchImpl });
  assert.equal((await waitForReading({ api: out, uploadId: "up_x", sleep, now: () => 0 })).kind, "auth");
  let stop = false;
  const stopping = createApi({ getBackendUrl: () => BACKEND, getToken: () => "t", fetchImpl: fakeFetch([reading]).fetchImpl });
  const stopped = waitForReading({ api: stopping, uploadId: "up_x", sleep: async () => void (stop = true), now: () => 0, stopped: () => stop });
  assert.equal((await stopped).kind, "stopped");
});

// ---------- the PDF file check and the list ----------

const blobNamed = (bytes, name, type = "") => Object.assign(new Blob([bytes], { type }), { name });

test("a file with no type or extension is recognised from its first bytes", async () => {
  const pdfBytes = new TextEncoder().encode("%PDF-1.7 invented");
  assert.deepEqual(routeFromBytes(pdfBytes), { route: "file", mimeType: "application/pdf" });
  assert.deepEqual(routeFromBytes(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0])), { route: "file", mimeType: DOCX });
  assert.deepEqual(routeFromBytes(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), { route: "image" });
  assert.deepEqual(routeFromBytes(new TextEncoder().encode("RIFF0000WEBPVP8 ")), { route: "image" });
  assert.equal(routeFromBytes(new TextEncoder().encode("plain words")), null);
  assert.equal(routeFromBytes(new Uint8Array(0)), null);
  assert.equal(routeFromBytes(null), null);

  const scan = await prepareCapture({ file: blobNamed(pdfBytes, "Invented scan"), resizeImage: async () => assert.fail("not an image") });
  assert.equal(scan.mimeType, "application/pdf");
  assert.equal(scan.bytes, pdfBytes.length);
  const text = await prepareCapture({ file: blobNamed(new TextEncoder().encode("notes"), "notes"), resizeImage: async () => {} });
  assert.deepEqual(text, { error: "wrongType" });
});

test("pasted text gets its own client ID letter and title", () => {
  const id = newClientId({ source: "paste", nowMs: Date.UTC(2026, 10, 1) });
  assert.match(id, serverInbox.CLIENT_ID_PATTERN);
  assert.equal(id[0], "t");
  assert.equal(titleForClientId(id), "Pasted text");
});

test("snapshotUploads keeps the failure reason and task id, and nothing else new", () => {
  const recent = [
    { type: "upload", id: "up_fA-11111111", title: "File", status: "failed", failureReason: "scanned-pdf", updatedAt: "2026-11-01T10:00:00+00:00" },
    { type: "upload", id: "up_tB-22222222", title: "Pasted text", status: "done", taskId: "t_abc_01", updatedAt: "2026-11-01T10:01:00+00:00" },
    { type: "upload", id: "up_pC-33333333", title: "Photo", status: "failed", failureReason: "<b>odd</b>", text: "never shown" },
  ];
  const list = snapshotUploads({ recent });
  assert.deepEqual(list.map((u) => [u.title, u.failureReason, u.taskId]), [
    ["File", "scanned-pdf", null],
    ["Pasted text", null, "t_abc_01"],
    ["Photo", null, null],
  ]);
  assert.ok(list.every((u) => !("text" in u)));
});

test("the list shows reading, read, added and the reason for a failure", () => {
  const uploads = [
    { uploadId: "up_pA-11111111", title: "Photo", status: "processing", updatedAt: null },
    { uploadId: "up_pB-22222222", title: "Photo", status: "done", updatedAt: null },
    { uploadId: "up_fC-33333333", title: "File", status: "failed", failureReason: "scanned-pdf", updatedAt: null },
    { uploadId: "up_tD-44444444", title: "Pasted text", status: "done", taskId: "t_abc_01", updatedAt: null },
  ];
  const asleep = Object.fromEntries(mergeCaptures({ uploads }).map((r) => [r.uploadId, r]));
  assert.equal(asleep["up_pA-11111111"].message, CAPTURE_MESSAGES.waiting, "no 'Reading…' while the tutor sleeps");
  assert.equal(asleep["up_pB-22222222"].message, CAPTURE_MESSAGES.readLater);
  assert.equal(asleep["up_pB-22222222"].canCheck, false, "checking needs the tutor");
  assert.equal(asleep["up_fC-33333333"].message, FAILURE_MESSAGES["scanned-pdf"]);
  assert.equal(asleep["up_tD-44444444"].message, CAPTURE_MESSAGES.added);

  const awake = Object.fromEntries(mergeCaptures({ uploads, tutor: "ready" }).map((r) => [r.uploadId, r]));
  assert.equal(awake["up_pA-11111111"].message, CAPTURE_MESSAGES.reading);
  assert.equal(awake["up_pB-22222222"].canCheck, true);
  assert.equal(awake["up_tD-44444444"].canCheck, false);
  const noAi = Object.fromEntries(mergeCaptures({ uploads, tutor: "readyNoAi" }).map((r) => [r.uploadId, r]));
  assert.equal(noAi["up_pA-11111111"].message, CAPTURE_MESSAGES.waiting, "the server is up but can't read");
  assert.equal(noAi["up_pB-22222222"].canCheck, true);

  const added = mergeCaptures({ uploads, tutor: "ready", added: new Map([["up_pB-22222222", "t_new_01"]]) });
  assert.equal(added.find((r) => r.uploadId === "up_pB-22222222").state, "added");
  assert.equal(needsPolling(mergeCaptures({ uploads: [uploads[0]] })), true, "keeps checking while reading");
  assert.equal(rowMessage({ state: "failed", failureReason: null }), CAPTURE_MESSAGES.couldNotRead);
});

test("the queue shows a pasted brief at once, follows the tutor, and marks a brief added", async () => {
  const pending = [];
  const fetchImpl = async (url) => (new URL(url).pathname === "/snapshot" ? json({ error: "none" }, 404) : json({ items: [], count: 0 }));
  const queue = createCaptureQueue({
    workerUrl: "https://wake.example.dev", getToken: () => "t", fetchImpl, now: () => 0,
    setTimer: (fn, ms) => pending.push(ms), clearTimer: () => {},
  });
  await queue.start();
  const uploadId = queue.addPasted({ clientId: "tInvented-0001" });
  assert.equal(uploadId, "up_tInvented-0001");
  assert.deepEqual(queue.rows().map((r) => [r.title, r.message]), [["Pasted text", CAPTURE_MESSAGES.waiting]]);
  queue.addPasted({ clientId: "tInvented-0001" });
  assert.equal(queue.rows().length, 1, "no duplicate row");
  assert.ok(pending.length > 0, "checks again for the reading");
  queue.setTutor("ready");
  queue.markAdded(uploadId, "t_new_01");
  assert.equal(queue.rows()[0].message, CAPTURE_MESSAGES.added);
  queue.stop();
  assert.deepEqual(queue.rows(), []);
});

// ---------- page and code rules ----------

test("new shared modules use no DOM-only or Node-only APIs", () => {
  for (const file of ["api.js", "task-check.js"]) {
    const source = readFileSync(join(WEB, "shared", file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "")
      .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
      .replace(/`(?:[^`\\]|\\.)*`/g, "``");
    assert.doesNotMatch(source, /\b(document|window|localStorage|sessionStorage|navigator|process|Buffer|require)\b/, file);
    assert.doesNotMatch(source, /from\s+["']node:/, file);
  }
});

test("check.js builds the page with text only, keeps nothing in the browser and logs nothing", () => {
  const source = readFileSync(join(WEB, "check.js"), "utf8");
  assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB/);
  assert.doesNotMatch(source, /console\./, "brief text must never reach the console");
});

test("learner page has the paste and type forms and the check screen, every control labelled", () => {
  const html = readFileSync(join(WEB, "index.html"), "utf8");
  assert.match(html, /<button type="button" id="paste-open"[^>]*disabled>Paste the task<\/button>/);
  assert.match(html, /<button type="button" id="type-open"[^>]*disabled>Type it in<\/button>/);
  assert.match(html, new RegExp(`<textarea id="paste-text"[^>]*maxlength="${PASTE_MAX_CHARS}"`));
  assert.match(html, /<input type="date" id="type-deadline"/);
  assert.match(html, /<input type="date" id="check-deadline"/);
  assert.match(html, /<section id="check-screen"[^>]*hidden>/);
  assert.match(html, /<h2 id="check-heading" tabindex="-1">Check the details<\/h2>/);
  for (const field of CHECK_FIELDS) {
    assert.match(html, new RegExp(`id="check-field-${field}"`), field);
    assert.match(html, new RegExp(`id="check-prompt-${field}"`), field);
  }
  for (const [value, label] of [...TASK_KINDS.map((k) => [k, null]), ...WORK_TYPES.map((w) => [w, null])]) {
    assert.match(html, new RegExp(`<option value="${value}">`), label ?? value);
  }
  const controls = [...html.matchAll(/<(input|textarea|select)\b[^>]*\bid="([^"]+)"/g)]
    .filter(([tag]) => !/type="file"/.test(tag))
    .map((m) => m[2]);
  for (const id of controls) assert.match(html, new RegExp(`<label for="${id}">`), `label for ${id}`);
});

test("deploy stamping covers the new modules", () => {
  const dir = mkdtempSync(join(tmpdir(), "wp108b-stamp-"));
  try {
    cpSync(WEB, join(dir, "web"), { recursive: true });
    execFileSync("bash", [join(ROOT, "scripts", "stamp-versions.sh"), join(dir, "web"), "abc12345"], { stdio: "pipe" });
    const appJs = readFileSync(join(dir, "web", "app.js"), "utf8");
    assert.match(appJs, /from "\.\/check\.js\?v=abc12345"/);
    assert.match(appJs, /from "\.\/shared\/api\.js\?v=abc12345"/);
    const checkJs = readFileSync(join(dir, "web", "check.js"), "utf8");
    assert.match(checkJs, /from "\.\/shared\/task-check\.js\?v=abc12345"/);
    assert.match(readFileSync(join(dir, "web", "shared", "api.js"), "utf8"), /from "\.\/auth\.js\?v=abc12345"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the waker hands back the tutor's address when it's ready", async () => {
  const { createWaker } = await import("../web/shared/wake.js");
  const fetchImpl = async (url) => {
    if (url.endsWith("/status")) return json({ state: "Available", backendUrl: BACKEND });
    return json({ ok: true, ai: { ready: true, mode: "copilot" }, restsAt: "2026-11-01T18:00:00+00:00" });
  };
  const result = await createWaker({ workerUrl: "https://wake.example.dev", token: "t", fetchImpl }).run();
  assert.equal(result.state, "ready");
  assert.equal(result.backendUrl, BACKEND);
});

test("the new page code imports under Node without a DOM", async () => {
  const check = await import("../web/check.js");
  assert.equal(typeof check.createTaskEntry, "function");
  const app = await import("../web/app.js");
  assert.equal(typeof app.loginUrl, "function");
});
