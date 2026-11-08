// WP-114f: the task panel's stage control and attached copies of a source (A-010 choice 3B).
// Invented data only. A tiny fake document stands in for the DOM; sending to the Worker is faked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_ATTACHMENTS, PANEL_MESSAGES, attachInfo, attachNote, panelSources, panelStage } from "../web/shared/task-panel.js";
import { UPCOMING_MESSAGES } from "../web/shared/upcoming.js";
import { ATTACH_POLL, createTaskPanel, sourceItems } from "../web/task-panel.js";

class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.listeners = {};
    this.className = "";
    this.disabled = false;
    this.hidden = false;
    this.open = false;
    this.value = "";
    this.files = [];
    this.ownText = "";
    this.focused = false;
  }
  set textContent(value) {
    this.ownText = String(value);
    this.children = [];
  }
  get textContent() {
    return this.ownText + this.children.map((c) => c.textContent).join("");
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  getAttribute(name) {
    return this.attributes[name] ?? null;
  }
  append(...nodes) {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes) {
    this.children = [...nodes];
  }
  addEventListener(type, fn) {
    this.listeners[type] = fn;
  }
  focus() {
    this.focused = true;
  }
  reset() {
    this.files = [];
  }
  all(match) {
    const out = [];
    const walk = (el) => {
      for (const c of el.children) {
        if (match(c)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
}
const doc = { createElement: (tag) => new FakeElement(tag) };
const byClass = (root, name) => root.all((el) => el.className.split(" ").includes(name));
const byAction = (root, action) => root.all((el) => el.dataset.action === action);

const IDS = [
  "task-panel", "task-panel-title", "task-panel-meta", "task-panel-due", "task-panel-question", "task-panel-question-text",
  "task-panel-sources", "task-panel-sources-label", "task-panel-sources-status", "task-panel-sources-list", "own-source",
  "own-source-form", "own-source-title", "own-source-author", "own-source-url", "own-source-add", "own-source-status",
  "own-source-files", "task-panel-stage", "task-panel-stage-select", "task-panel-stage-save", "task-panel-stage-status",
];
function pageDoc() {
  const els = Object.fromEntries(IDS.map((id) => [id, new FakeElement(id.includes("form") ? "form" : "div")]));
  return { els, doc: { ...doc, getElementById: (id) => els[id] ?? null } };
}

const ok = (body, status = 200) => ({ kind: "ok", status, body });
const TASK = { id: "t_inv1", title: "Invented coast task", subject: "Invented Geography", deadline: "2026-11-20", stage: "researching" };
const ITEM = { taskId: "t_inv1", title: "Invented coast task", deadline: "2026-11-20", stage: "researching" };
const copies = (...statuses) => statuses.map((status, i) => ({ uploadId: `up_sinv000${i}-aa`, status, failureReason: null }));

function fakeApi(answers = {}) {
  const calls = [];
  const api = new Proxy({}, {
    get: (_, name) => async (...args) => {
      calls.push([name, ...args]);
      const a = answers[name];
      return typeof a === "function" ? a(...args) : a ?? ok({});
    },
  });
  return { api, calls };
}

/** A fake inbox: prepare and send are recorded; results[n] is the nth send's kind (default "ok"). */
function fakeAttach(results = []) {
  const prepared = [];
  const sent = [];
  return {
    prepared,
    sent,
    attach: {
      workerUrl: "https://invented-worker.example.dev",
      getToken: () => "test-pass",
      resizeImage: () => {},
      prepare: async ({ file }) => {
        prepared.push(file.name);
        if (file.bad) return { error: "wrongType" };
        return { mimeType: file.image ? "image/jpeg" : "application/pdf", bytes: 10, base64: "AAAA", image: Boolean(file.image) };
      },
      send: async (args) => {
        sent.push(args);
        return { kind: results[sent.length - 1] ?? "ok" };
      },
    },
  };
}

function fakeTimers() {
  const timers = [];
  return {
    timers,
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimer: () => {},
  };
}

const settle = () => new Promise((r) => setImmediate(r));

// ---------- rules ----------

test("attachInfo: none, waiting, ready and failed; bad entries are ignored", () => {
  assert.deepEqual(attachInfo({}), { count: 0, state: "none" });
  assert.equal(attachInfo({ attachments: copies("waiting", "done") }).state, "waiting");
  assert.equal(attachInfo({ attachments: copies("reading") }).state, "waiting");
  assert.deepEqual(attachInfo({ attachments: copies("done", "failed") }), { count: 2, done: 1, state: "ready" });
  assert.equal(attachInfo({ attachments: copies("failed", "failed") }).state, "failed");
  assert.equal(attachInfo({ attachments: [{ uploadId: "../x", status: "done" }, { uploadId: "up_sinv0000-aa", status: "odd" }] }).state, "none");
  assert.equal(attachNote({ state: "none" }), "");
  assert.equal(attachNote(attachInfo({ attachments: copies("done", "done") })), PANEL_MESSAGES.attachReady(2));
  assert.equal(attachNote({ state: "waiting" }), PANEL_MESSAGES.attachWaiting);
  assert.equal(attachNote({ state: "failed" }), PANEL_MESSAGES.attachFailed);
  assert.equal(MAX_ATTACHMENTS, 5);
});

test("panelStage: the task's stage, else the list entry's, else not started", () => {
  assert.equal(panelStage({ task: TASK }), "researching");
  assert.equal(panelStage({ item: { stage: "planning" } }), "planning");
  assert.equal(panelStage({ task: { stage: "odd" } }), "not-started");
  assert.equal(panelStage(), "not-started");
});

test("source items: the attach box only when attaching is wired up, and never on videos or summarised sources", () => {
  const list = panelSources([
    { id: "src_a", title: "Invented page", url: "https://invented.example.org/a", category: "official" },
    { id: "src_v", title: "Invented video", url: "https://video.invented.example.org/v", category: "video" },
    { id: "src_s", title: "Invented summarised", url: "https://invented.example.org/s", category: "official", summaryId: "note_s" },
  ]);
  const without = sourceItems(doc, list, {});
  assert.equal(without.flatMap((i) => byClass(i, "attach-source")).length, 0);
  const seen = [];
  const items = sourceItems(doc, list, { canAttach: true, onAttach: (s, files) => seen.push([s.id, files]) });
  assert.deepEqual(items.map((i) => byClass(i, "attach-source").length), [1, 0, 0]);
  const [box] = byClass(items[0], "attach-source");
  assert.equal(box.tagName, "DETAILS");
  const [input] = box.all((el) => el.tagName === "INPUT");
  assert.equal(input.getAttribute("type"), "file");
  assert.equal(input.getAttribute("multiple"), "");
  assert.equal(box.all((el) => el.tagName === "LABEL")[0].getAttribute("for"), input.getAttribute("id"));
  input.files = [{ name: "invented.pdf" }];
  byAction(box, "attach")[0].listeners.click();
  assert.deepEqual(seen, [["src_a", [{ name: "invented.pdf" }]]]);
  assert.equal(byAction(items[0], "summarise").length, 1, "Summarise still comes first");
});

test("source items: a source with no link gets Summarise once its copy is ready; waiting shows a note", () => {
  const [own] = panelSources([{ id: "src_o", title: "Invented article", url: null, category: "other", origin: "learner" }]);
  const waiting = sourceItems(doc, [own], { canAttach: true, attachOf: () => ({ count: 1, state: "waiting" }) })[0];
  assert.equal(byAction(waiting, "summarise").length, 0);
  assert.equal(byClass(waiting, "source-attach-note")[0].textContent, PANEL_MESSAGES.attachWaiting);
  const ready = sourceItems(doc, [own], { attachOf: () => ({ count: 1, done: 1, state: "ready" }) })[0];
  assert.equal(byAction(ready, "summarise").length, 1);
  assert.equal(byClass(ready, "paste-source").length, 1, "pasting is still offered");
  const full = sourceItems(doc, [own], { canAttach: true, attachOf: () => ({ count: MAX_ATTACHMENTS, done: 5, state: "ready" }) })[0];
  assert.equal(byClass(full, "attach-source").length, 0, "no more than five copies");
});

// ---------- attaching on the page ----------

test("add a source with a copy: prepared first, linked by capture ID, then sent to the inbox as kind 'source'", async () => {
  const { els, doc: page } = pageDoc();
  let sources = [];
  const { api, calls } = fakeApi({
    getTask: ok({ task: TASK }),
    listSources: () => ok({ sources }),
    addOwnSource: (body) => {
      sources = [{ id: "src_own", title: body.title, url: null, category: "other", origin: "learner",
        attachments: body.attachments.map((c) => ({ uploadId: `up_${c}`, status: "waiting" })) }];
      return ok({ source: sources[0] }, 201);
    },
  });
  const fa = fakeAttach();
  const t = fakeTimers();
  const panel = createTaskPanel({ api, doc: page, attach: fa.attach, setTimer: t.setTimer, clearTimer: t.clearTimer });
  panel.setTutor("ready");
  await panel.show(ITEM);
  els["own-source-title"].value = "Invented student article";
  els["own-source-files"].files = [{ name: "invented.pdf" }];
  await els["own-source-form"].listeners.submit({ preventDefault() {} });
  await settle();
  const add = calls.find((c) => c[0] === "addOwnSource")[1];
  assert.equal(add.title, "Invented student article");
  assert.equal(add.attachments.length, 1);
  assert.match(add.attachments[0], /^s[a-z0-9]+-[0-9a-f]{18}$/, "a device-made capture ID starting with s");
  assert.deepEqual(fa.prepared, ["invented.pdf"]);
  assert.equal(fa.sent.length, 1);
  assert.deepEqual([fa.sent[0].clientId, fa.sent[0].contentKind, fa.sent[0].source, fa.sent[0].mimeType, fa.sent[0].token],
    [add.attachments[0], "source", "file", "application/pdf", "test-pass"]);
  const [item] = els["task-panel-sources-list"].children;
  assert.equal(byClass(item, "source-attach-note")[0].textContent, PANEL_MESSAGES.attachWaiting);
  assert.equal(t.timers.at(-1)?.ms, ATTACH_POLL.stepMs, "checks again while the copy is read");
  sources = [{ ...sources[0], attachments: [{ uploadId: sources[0].attachments[0].uploadId, status: "done" }] }];
  await t.timers.at(-1).fn();
  await settle();
  const [after] = els["task-panel-sources-list"].children;
  assert.equal(byAction(after, "summarise").length, 1, "Summarise appears once the copy is read");
});

test("a copy that can't be prepared stops the form before anything is saved", async () => {
  const { els, doc: page } = pageDoc();
  const { api, calls } = fakeApi({ getTask: ok({ task: TASK }), listSources: ok({ sources: [] }) });
  const fa = fakeAttach();
  const panel = createTaskPanel({ api, doc: page, attach: fa.attach });
  panel.setTutor("ready");
  await panel.show(ITEM);
  els["own-source-title"].value = "Invented";
  els["own-source-files"].files = [{ name: "invented.txt", bad: true }];
  await els["own-source-form"].listeners.submit({ preventDefault() {} });
  assert.equal(calls.some((c) => c[0] === "addOwnSource"), false);
  assert.ok(els["own-source-status"].textContent.length > 0);
  assert.ok(els["own-source-files"].focused);
  els["own-source-files"].files = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => ({ name: `p${i}.jpg`, image: true }));
  await els["own-source-form"].listeners.submit({ preventDefault() {} });
  assert.equal(els["own-source-status"].textContent, PANEL_MESSAGES.attachTooMany(MAX_ATTACHMENTS));
  assert.equal(fa.sent.length, 0);
});

test("attach photos to a saved source; a send that fails offers Try again with the same capture ID", async () => {
  const { els, doc: page } = pageDoc();
  const sources = [{ id: "src_c", title: "Invented council page", url: "https://invented-council.example.gov.uk/coast", category: "official" }];
  const { api, calls } = fakeApi({ getTask: ok({ task: TASK }), listSources: () => ok({ sources }), attachToSource: ok({ source: sources[0] }) });
  const fa = fakeAttach(["ok", "retry", "ok"]);
  const panel = createTaskPanel({ api, doc: page, attach: fa.attach });
  panel.setTutor("ready");
  await panel.show(ITEM);
  const [item] = els["task-panel-sources-list"].children;
  const [box] = byClass(item, "attach-source");
  box.all((el) => el.tagName === "INPUT")[0].files = [{ name: "page1.jpg", image: true }, { name: "page2.jpg", image: true }];
  await byAction(box, "attach")[0].listeners.click();
  await settle();
  const linked = calls.find((c) => c[0] === "attachToSource");
  assert.equal(linked[1], "src_c");
  assert.equal(linked[2].length, 2);
  assert.deepEqual(fa.sent.map((s) => [s.clientId, s.source, s.contentKind]), [[linked[2][0], "gallery", "source"], [linked[2][1], "gallery", "source"]]);
  const [after] = els["task-panel-sources-list"].children;
  assert.equal(byClass(after, "source-note")[0].textContent, PANEL_MESSAGES.attachRetry(1));
  assert.equal(byClass(after, "attach-source").length, 0, "no new copies while one waits to be sent");
  await byAction(after, "retry")[0].listeners.click();
  await settle();
  assert.equal(fa.sent.length, 3);
  assert.equal(fa.sent[2].clientId, linked[2][1], "the retry reuses the capture ID, so no duplicate");
  assert.equal(calls.filter((c) => c[0] === "attachToSource").length, 1);
  const [done] = els["task-panel-sources-list"].children;
  assert.equal(byClass(done, "source-note")[0].textContent, PANEL_MESSAGES.attachSent);
});

test("without the attach settings the panel works as before and offers no attach box", async () => {
  const { els, doc: page } = pageDoc();
  const { api } = fakeApi({ getTask: ok({ task: TASK }), listSources: ok({ sources: [{ id: "src_c", title: "Invented", url: "https://invented.example.org/c", category: "official" }] }) });
  const panel = createTaskPanel({ api, doc: page });
  panel.setTutor("ready");
  await panel.show(ITEM);
  assert.equal(byClass(els["task-panel-sources-list"].children[0], "attach-source").length, 0);
});

// ---------- the stage ----------

test("change the stage: saved with PATCH, the panel updates and Coming up is told", async () => {
  const { els, doc: page } = pageDoc();
  let changed = 0;
  const { api, calls } = fakeApi({
    getTask: ok({ task: TASK }),
    listSources: ok({ sources: [] }),
    updateTask: (id, body) => ok({ task: { ...TASK, ...body } }),
  });
  const panel = createTaskPanel({ api, doc: page, onTaskChanged: () => { changed += 1; }, now: () => new Date("2026-11-06T10:00:00Z") });
  await panel.show(ITEM);
  assert.equal(els["task-panel-stage-save"].disabled, true, "waits for the tutor");
  assert.equal(els["task-panel-stage-status"].textContent, PANEL_MESSAGES.stageWait);
  await panel.setTutor("ready");
  assert.equal(els["task-panel-stage"].open, false, "collapsed");
  assert.equal(els["task-panel-stage-select"].value, "researching");
  await els["task-panel-stage-save"].listeners.click();
  assert.equal(els["task-panel-stage-status"].textContent, UPCOMING_MESSAGES.nothingChanged);
  assert.equal(calls.some((c) => c[0] === "updateTask"), false);
  els["task-panel-stage-select"].value = "planning";
  els["task-panel-stage-select"].listeners.change();
  await els["task-panel-stage-save"].listeners.click();
  assert.deepEqual(calls.find((c) => c[0] === "updateTask").slice(1), ["t_inv1", { stage: "planning" }]);
  assert.equal(els["task-panel-meta"].textContent, "Invented Geography · Planning");
  assert.equal(els["task-panel-stage-status"].textContent, UPCOMING_MESSAGES.updated);
  assert.equal(changed, 1);
  els["task-panel-stage-select"].value = "submitted";
  els["task-panel-stage-select"].listeners.change();
  await els["task-panel-stage-save"].listeners.click();
  assert.equal(els["task-panel-stage-status"].textContent, PANEL_MESSAGES.stageLeaves);
  assert.equal(changed, 2);
});

test("a stage change that fails keeps the old stage and says why", async () => {
  const { els, doc: page } = pageDoc();
  const { api } = fakeApi({
    getTask: ok({ task: TASK }),
    listSources: ok({ sources: [] }),
    updateTask: { kind: "http", status: 400, body: { error: "stage must be one of the stages" } },
  });
  const panel = createTaskPanel({ api, doc: page });
  panel.setTutor("ready");
  await panel.show(ITEM);
  els["task-panel-stage-select"].value = "drafting";
  els["task-panel-stage-select"].listeners.change();
  await els["task-panel-stage-save"].listeners.click();
  assert.ok(els["task-panel-stage-status"].textContent.length > 0);
  assert.equal(els["task-panel-meta"].textContent, "Invented Geography · Researching");
});
