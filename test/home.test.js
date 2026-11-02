// WP-110: the home screen, "Recommended next", the saved view and the edit queue. Invented data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { addDays } from "../web/shared/upcoming.js";
import { RECOMMEND_RULES, STAGE_STEPS, recommendNext, stageStep } from "../web/shared/recommend.js";
import {
  OFFLINE_DB,
  OFFLINE_KEYS,
  OFFLINE_MESSAGES,
  QUEUE_LIMIT,
  cleanEdit,
  cleanView,
  createOffline,
  droppedMessage,
  editOutcome,
  memoryKeyValue,
  mergeEdit,
  newEditId,
  overlayEdits,
  queueNote,
  signOutMessage,
} from "../web/shared/offline.js";
import { DEVICE_STORE, openDeviceStore } from "../web/device-store.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const WEB = join(ROOT, "web");
// Monday 2 November 2026
const TODAY = "2026-11-02";
const item = (taskId, deadline, extra = {}) => ({ taskId, title: `Invented ${taskId}`, subject: "Imaginary studies", deadline, stage: "planning", kind: "homework", ...extra });
const quiet = { error() {} };

// ---------- Recommended next ----------

test("rule 1: overdue work comes first, most overdue first", () => {
  const rec = recommendNext([item("soon", "2026-11-03"), item("late", "2026-10-29"), item("later", "2026-10-31")], { today: TODAY });
  assert.deepEqual(rec, {
    rule: "overdue",
    taskId: "late",
    title: "Invented late",
    text: "“Invented late” was due Thursday. Spend 15 minutes on it, or change the deadline.",
  });
});

test("rule 2: due today or tomorrow, with a step for its stage", () => {
  const rec = recommendNext([item("week", "2026-11-06", { stage: "not-started" }), item("tomorrow", "2026-11-03", { stage: "drafting" })], { today: TODAY });
  assert.equal(rec.rule, "dueSoon");
  assert.equal(rec.text, "“Invented tomorrow” is due tomorrow. Spend 20 minutes writing.");
  const today = recommendNext([item("t", TODAY, { stage: "researching" })], { today: TODAY });
  assert.equal(today.text, "“Invented t” is due today. Spend 20 minutes on research.");
});

test("rule 3: a task due within 7 days and not started beats one already going", () => {
  const rec = recommendNext([item("going", "2026-11-04", { stage: "drafting" }), item("fresh", "2026-11-08", { stage: "not-started" })], { today: TODAY });
  assert.equal(rec.rule, "makeStart");
  assert.equal(rec.taskId, "fresh");
  assert.equal(rec.text, "Make a start on “Invented fresh”: 15 minutes working out what the question asks.");
});

test("rule 4: otherwise the next dated task, with a step for its stage", () => {
  const rec = recommendNext([item("far", "2026-11-20", { stage: "reviewing" }), item("near", "2026-11-05", { stage: "planning" })], { today: TODAY });
  assert.equal(rec.rule, "next");
  assert.equal(rec.text, "“Invented near” is due Thursday. Spend 20 minutes planning your answer.");
  const far = recommendNext([item("far", "2026-11-20", { stage: "not-started" })], { today: TODAY });
  assert.equal(far.rule, "next", "not started but more than a week away");
  assert.equal(far.text, "“Invented far” is due Fri 20 Nov. Spend 15 minutes working out what the question asks.");
});

test("rule 5: no deadline; rule 6: nothing open gives no line", () => {
  assert.deepEqual(recommendNext([item("nodate", null)], { today: TODAY }), {
    rule: "noDeadline", taskId: "nodate", title: "Invented nodate", text: "Add a deadline to “Invented nodate”.",
  });
  assert.equal(recommendNext([], { today: TODAY }), null);
  assert.equal(recommendNext([item("done", TODAY, { stage: "done" }), item("in", null, { stage: "submitted" })], { today: TODAY }), null);
  assert.equal(recommendNext(null, { today: TODAY }), null);
});

test("ties: soonest first, then assessments, then list order", () => {
  const rec = recommendNext([item("a", "2026-11-03"), item("b", "2026-11-03", { kind: "assessment" }), item("c", "2026-11-03")], { today: TODAY });
  assert.equal(rec.taskId, "b");
  const order = recommendNext([item("x", "2026-11-03"), item("y", "2026-11-03")], { today: TODAY });
  assert.equal(order.taskId, "x");
  const nodates = recommendNext([item("n1", null), item("n2", null, { kind: "assessment" })], { today: TODAY });
  assert.equal(nodates.taskId, "n2");
});

test("every stage in progress has a step, and the rules are fixed", () => {
  assert.deepEqual(Object.keys(STAGE_STEPS), ["not-started", "researching", "planning", "drafting", "reviewing"]);
  assert.equal(stageStep("made-up"), STAGE_STEPS["not-started"]);
  assert.deepEqual([...RECOMMEND_RULES], ["overdue", "dueSoon", "makeStart", "next", "noDeadline"]);
});

test("the recommendation follows queued changes and moves on as the days pass", () => {
  const list = [item("t1", "2026-11-10", { stage: "not-started" })];
  assert.equal(recommendNext(list, { today: TODAY }).rule, "next");
  assert.equal(recommendNext(list, { today: "2026-11-04" }).rule, "makeStart");
  assert.equal(recommendNext(list, { today: "2026-11-09" }).rule, "dueSoon");
  assert.equal(recommendNext(list, { today: "2026-11-11" }).rule, "overdue");
  const edits = [{ id: "eaaaaaaa1", at: 1, type: "update", taskId: "t1", changes: { stage: "submitted" } }];
  assert.equal(recommendNext(overlayEdits(list, edits), { today: TODAY }), null, "handed in while waking");
});

// ---------- the edit queue: pure parts ----------

test("cleanEdit keeps well-formed changes and typed tasks, and refuses anything else", () => {
  const update = { id: "eabc12345", at: 5, type: "update", taskId: "t_1", changes: { stage: "drafting", deadline: null, extra: 1 } };
  assert.deepEqual(cleanEdit(update), { id: "eabc12345", at: 5, type: "update", taskId: "t_1", changes: { stage: "drafting", deadline: null } });
  const add = { id: "eabc12346", at: 6, type: "add", body: { title: "Invented worksheet", deadline: "2026-11-20", questionText: null, anchors: [], other: "dropped" } };
  assert.deepEqual(cleanEdit(add).body, { title: "Invented worksheet", deadline: "2026-11-20", questionText: null, anchors: [] });
  for (const bad of [
    { ...update, id: "nope" },
    { ...update, at: "soon" },
    { ...update, taskId: "../x" },
    { ...update, changes: { stage: "napping" } },
    { ...update, changes: { deadline: "2026-02-30" } },
    { ...update, changes: {} },
    { ...update, type: "delete" },
    { ...add, body: { title: "  " } },
    { ...add, body: { title: "x".repeat(121) } },
    { ...add, body: { title: "x", questionText: "y".repeat(20000) } },
    null,
  ]) assert.equal(cleanEdit(bad), null, JSON.stringify(bad)?.slice(0, 60));
  assert.match(newEditId(Date.UTC(2026, 10, 2), () => 0.5), /^e[a-z0-9]{6,40}$/);
});

test("mergeEdit folds changes to the same task together, but never into one being sent", () => {
  const first = { id: "e0000001a", at: 1, type: "update", taskId: "t1", changes: { stage: "drafting" } };
  const second = { id: "e0000002a", at: 2, type: "update", taskId: "t1", changes: { deadline: "2026-11-20" } };
  const other = { id: "e0000003a", at: 3, type: "update", taskId: "t2", changes: { stage: "done" } };
  const merged = mergeEdit(mergeEdit([first], other), second);
  assert.deepEqual(merged.map((e) => e.id), ["e0000001a", "e0000003a"], "keeps its place in the queue");
  assert.deepEqual(merged[0].changes, { stage: "drafting", deadline: "2026-11-20" });
  assert.equal(merged[0].at, 2);
  assert.equal(mergeEdit([first], second, { skipId: "e0000001a" }).length, 2);
});

test("overlayEdits shows changes on top and typed tasks not yet added", () => {
  const list = [item("t1", "2026-11-06")];
  const edits = [
    { id: "e0000001a", at: 1, type: "update", taskId: "t1", changes: { deadline: "2026-11-20" } },
    { id: "e0000002a", at: 2, type: "update", taskId: "gone", changes: { stage: "done" } },
    { id: "e0000003a", at: 3, type: "add", body: { title: "Invented typed task", deadline: null } },
  ];
  const shown = overlayEdits(list, edits);
  assert.equal(list[0].deadline, "2026-11-06", "the list itself is untouched");
  assert.deepEqual([shown[0].deadline, shown[0].pending], ["2026-11-20", true]);
  assert.deepEqual([shown[1].taskId, shown[1].title, shown[1].stage, shown[1].queued], ["e0000003a", "Invented typed task", "not-started", true]);
  assert.equal(shown.length, 2);
});

test("editOutcome: sent, dropped for changes that can never succeed, otherwise kept for later", () => {
  assert.equal(editOutcome({ kind: "ok" }), "sent");
  assert.equal(editOutcome({ kind: "auth", reason: "version" }), "auth");
  for (const status of [400, 404, 409]) assert.equal(editOutcome({ kind: "http", status }), "dropped", String(status));
  for (const result of [{ kind: "network" }, { kind: "http", status: 503 }, { kind: "http", status: 429 }, { kind: "http", status: 500 }, { kind: "not-json" }, { kind: "no-address" }, undefined]) {
    assert.equal(editOutcome(result), "later", JSON.stringify(result));
  }
});

test("messages agree with the count", () => {
  assert.equal(queueNote(0), "");
  assert.equal(queueNote(1), "1 change will save when the tutor's ready.");
  assert.equal(queueNote(3), "3 changes will save when the tutor's ready.");
  assert.match(queueNote(2, { shared: true }), /shared computer/);
  assert.match(signOutMessage(1), /^1 change hasn't .* it will be lost\.$/);
  assert.match(signOutMessage(2), /^2 changes haven't .* they will be lost\.$/);
  assert.match(droppedMessage(1), /^1 change couldn't/);
});

// ---------- the edit queue and the saved view ----------

function fakeApi(replies = []) {
  const calls = [];
  let n = 0;
  const reply = async (call) => {
    calls.push(call);
    const next = replies[Math.min(n++, replies.length - 1)] ?? { kind: "ok", body: {} };
    return typeof next === "function" ? next(call) : next;
  };
  return {
    calls,
    addTask: (body) => reply({ type: "add", body }),
    updateTask: (taskId, body) => reply({ type: "update", taskId, body }),
  };
}

function clock(start = Date.UTC(2026, 10, 2, 9)) {
  let t = start;
  return () => (t += 1000);
}

test("own device: queued changes are kept on the device and survive a reload", async () => {
  const store = memoryKeyValue();
  const offline = createOffline({ now: clock(), log: quiet });
  const counts = [];
  offline.onChange((n) => counts.push(n));
  await offline.start({ store });
  assert.equal((await offline.add({ type: "update", taskId: "t1", changes: { stage: "drafting" } })).ok, true);
  await offline.add({ type: "add", body: { title: "Invented task", deadline: "2026-11-20", questionText: null, anchors: [] } });
  await offline.add({ type: "update", taskId: "t1", changes: { deadline: "2026-11-21" } });
  assert.equal(offline.count(), 2, "the two changes to t1 were merged");
  assert.ok(counts.includes(2));
  assert.equal((await store.get(OFFLINE_KEYS.queue)).length, 2);

  const reloaded = createOffline({ now: clock(), log: quiet });
  await reloaded.start({ store });
  assert.deepEqual(reloaded.edits().map((e) => e.type), ["update", "add"]);
  assert.deepEqual(reloaded.edits()[0].changes, { stage: "drafting", deadline: "2026-11-21" });
});

test("flush sends in order, drops what can't succeed, and stops at the first that must wait", async () => {
  const offline = createOffline({ now: clock(), log: quiet });
  await offline.start({ store: memoryKeyValue() });
  await offline.add({ type: "update", taskId: "t1", changes: { stage: "done" } });
  await offline.add({ type: "update", taskId: "gone", changes: { stage: "done" } });
  await offline.add({ type: "add", body: { title: "Invented task" } });
  await offline.add({ type: "update", taskId: "t3", changes: { deadline: null } });
  const api = fakeApi([{ kind: "ok" }, { kind: "http", status: 404, body: {} }, { kind: "network" }]);
  const first = await offline.flush(api);
  assert.deepEqual(first, { sent: 1, dropped: 1, stop: "later" });
  assert.deepEqual(api.calls.map((c) => c.taskId ?? c.type), ["t1", "gone", "add"]);
  assert.deepEqual(api.calls[0].body, { stage: "done" });
  assert.equal(offline.count(), 2, "the typed task and the last change still wait");

  const second = await offline.flush(fakeApi([{ kind: "ok" }]));
  assert.deepEqual(second, { sent: 2, dropped: 0, stop: null });
  assert.equal(offline.count(), 0);
});

test("flush stops on a rejected pass and keeps the queue", async () => {
  const offline = createOffline({ now: clock(), log: quiet });
  await offline.start({ store: memoryKeyValue() });
  await offline.add({ type: "update", taskId: "t1", changes: { stage: "drafting" } });
  const result = await offline.flush(fakeApi([{ kind: "auth", status: 401, reason: "version" }]));
  assert.deepEqual(result, { sent: 0, dropped: 0, stop: "auth", reason: "version" });
  assert.equal(offline.count(), 1);
  assert.deepEqual(await offline.flush(fakeApi([() => { throw new Error("boom"); }])), { sent: 0, dropped: 0, stop: "later" }, "a thrown error waits");
});

test("a change made while one is being sent is kept, not merged into it", async () => {
  const offline = createOffline({ now: clock(), log: quiet });
  await offline.start({ store: memoryKeyValue() });
  await offline.add({ type: "update", taskId: "t1", changes: { stage: "drafting" } });
  let release;
  const api = fakeApi([() => new Promise((resolve) => (release = () => resolve({ kind: "ok" }))), { kind: "ok" }]);
  const flushing = offline.flush(api);
  await new Promise((resolve) => setImmediate(resolve));
  await offline.add({ type: "update", taskId: "t1", changes: { stage: "reviewing" } });
  assert.equal(offline.flush(api), flushing, "one flush at a time");
  release();
  const result = await flushing;
  assert.equal(result.sent, 2);
  assert.deepEqual(api.calls.map((c) => c.body.stage), ["drafting", "reviewing"]);
});

test("the queue refuses more than its limit and anything malformed", async () => {
  const offline = createOffline({ now: clock(), log: quiet });
  assert.equal((await offline.add({ type: "update", taskId: "t1", changes: { stage: "done" } })).error, OFFLINE_MESSAGES.notStarted);
  await offline.start({ store: memoryKeyValue() });
  for (let i = 0; i < QUEUE_LIMIT; i += 1) await offline.add({ type: "update", taskId: `t${i}`, changes: { stage: "done" } });
  assert.equal((await offline.add({ type: "update", taskId: "one-more", changes: { stage: "done" } })).error, OFFLINE_MESSAGES.queueFull);
  assert.equal((await offline.add({ type: "update", taskId: "t1", changes: { stage: "planning" } })).ok, true, "a merge still fits");
  assert.equal((await offline.add({ type: "update", taskId: "t1", changes: { stage: "lazing" } })).error, OFFLINE_MESSAGES.badEdit);
});

test("the saved view keeps list fields and the app name only, never question text", async () => {
  const store = memoryKeyValue();
  const offline = createOffline({ now: clock(), log: quiet });
  await offline.start({ store });
  await offline.saveView({
    items: [{ ...item("t1", "2026-11-06"), questionText: "QUESTION-TEXT-HIDDEN", anchors: ["ANCHOR-HIDDEN"] }],
    appName: "Invented app",
  });
  const raw = await store.get(OFFLINE_KEYS.view);
  assert.equal(JSON.stringify(raw).includes("HIDDEN"), false);
  assert.deepEqual(Object.keys(raw.items[0]).sort(), ["deadline", "kind", "stage", "subject", "taskId", "title"]);
  await offline.saveView({ items: [] });
  const again = await offline.loadView();
  assert.equal(again.appName, "Invented app", "kept when the tutor's list has no name");
  assert.deepEqual(cleanView({ items: "no", appName: 5 }), { items: [], appName: null, savedAt: null });
  assert.equal(cleanView(null), null);
});

test("shared computer: no saved view, and the queue is forgotten at sign-out", async () => {
  const store = memoryKeyValue();
  const offline = createOffline({ now: clock(), log: quiet });
  await offline.start({ store, shared: true });
  await offline.saveView({ items: [item("t1", "2026-11-06")], appName: "Invented app" });
  assert.equal(await store.get(OFFLINE_KEYS.view), undefined, "the view is never written");
  assert.equal(await offline.loadView(), null);
  await offline.add({ type: "update", taskId: "t1", changes: { stage: "done" } });
  assert.equal(offline.isShared(), true);
  await offline.clear();
  assert.equal(offline.count(), 0);
  assert.equal(await store.get(OFFLINE_KEYS.queue), undefined);
  assert.equal(offline.active(), false);
});

test("stop forgets what is in memory but leaves the device copy; clear empties both", async () => {
  const store = memoryKeyValue();
  const offline = createOffline({ now: clock(), log: quiet });
  await offline.start({ store });
  await offline.add({ type: "update", taskId: "t1", changes: { stage: "done" } });
  await offline.saveView({ items: [item("t1", "2026-11-06")] });
  offline.stop();
  assert.equal(offline.count(), 0);
  assert.equal((await store.get(OFFLINE_KEYS.queue)).length, 1, "an expired pass keeps the queue for next time");
  await offline.start({ store });
  assert.equal(offline.count(), 1);
  await offline.clear();
  assert.equal(await store.get(OFFLINE_KEYS.queue), undefined);
  assert.equal(await store.get(OFFLINE_KEYS.view), undefined);
});

test("device storage failures are logged by name only and never break the page", async () => {
  const logged = [];
  const broken = {
    get: async () => { throw Object.assign(new Error("secret detail"), { name: "QuotaExceededError" }); },
    set: async () => { throw Object.assign(new Error("secret detail"), { name: "QuotaExceededError" }); },
    delete: async () => {},
    clear: async () => { throw new Error("secret detail"); },
  };
  const offline = createOffline({ now: clock(), log: { error: (...args) => logged.push(args.join(" ")) } });
  await offline.start({ store: broken });
  assert.equal((await offline.add({ type: "update", taskId: "t1", changes: { stage: "done" } })).ok, true, "kept in memory");
  assert.equal(await offline.loadView(), null);
  await offline.clear();
  assert.ok(logged.length >= 3);
  assert.ok(logged.every((line) => !line.includes("secret detail")));
});

// ---------- IndexedDB adapter, against a small fake ----------

function fakeIndexedDb() {
  const databases = new Map();
  const later = (fn) => queueMicrotask(fn);
  function makeDb() {
    const stores = new Map();
    return {
      stores,
      objectStoreNames: { contains: (name) => stores.has(name) },
      createObjectStore: (name) => void stores.set(name, new Map()),
      transaction(name, mode) {
        const data = stores.get(name);
        const tx = {};
        const request = (fn) => {
          const req = {};
          try {
            req.result = fn();
          } catch (err) {
            tx.error = err;
            later(() => tx.onerror?.());
            return req;
          }
          later(() => tx.oncomplete?.());
          return req;
        };
        const writable = () => {
          if (mode !== "readwrite") throw Object.assign(new Error("read only"), { name: "ReadOnlyError" });
        };
        tx.objectStore = () => ({
          get: (key) => request(() => (data.has(key) ? structuredClone(data.get(key)) : undefined)),
          put: (value, key) => request(() => { writable(); data.set(key, structuredClone(value)); return key; }),
          delete: (key) => request(() => { writable(); data.delete(key); }),
          clear: () => request(() => { writable(); data.clear(); }),
        });
        return tx;
      },
    };
  }
  return {
    databases,
    open(name, version) {
      const req = {};
      later(() => {
        let db = databases.get(name);
        const fresh = !db;
        if (fresh) databases.set(name, (db = makeDb()));
        req.result = db;
        if (fresh) req.onupgradeneeded?.({ oldVersion: 0, newVersion: version });
        req.onsuccess?.();
      });
      return req;
    },
  };
}

test("openDeviceStore keeps values in one IndexedDB store under the edu-support. name", async () => {
  const idb = fakeIndexedDb();
  const store = openDeviceStore({ idb });
  assert.equal(await store.get("view"), undefined);
  await store.set("queue", [{ a: 1 }]);
  assert.deepEqual(await store.get("queue"), [{ a: 1 }]);
  await store.delete("queue");
  assert.equal(await store.get("queue"), undefined);
  await store.set("view", { items: [] });
  await store.clear();
  assert.equal(await store.get("view"), undefined);
  assert.ok(idb.databases.has(OFFLINE_DB));
  assert.ok(OFFLINE_DB.startsWith("edu-support."), "same prefix as the pass keys");
  assert.ok(idb.databases.get(OFFLINE_DB).stores.has(DEVICE_STORE));
  assert.equal(openDeviceStore({ idb: undefined }), null, "no IndexedDB: the page uses memory");
});

test("the queue works through the IndexedDB adapter end to end", async () => {
  const idb = fakeIndexedDb();
  const offline = createOffline({ now: clock(), log: quiet });
  await offline.start({ store: openDeviceStore({ idb }) });
  await offline.add({ type: "update", taskId: "t1", changes: { deadline: addDays(TODAY, 3) } });
  const again = createOffline({ now: clock(), log: quiet });
  await again.start({ store: openDeviceStore({ idb }) });
  assert.equal(again.count(), 1);
  await again.clear();
  assert.equal(await openDeviceStore({ idb }).get(OFFLINE_KEYS.queue), undefined);
});

// ---------- code rules and the page ----------

function jsFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return jsFiles(path);
    return entry.name.endsWith(".js") ? [path] : [];
  });
}

test("the new shared modules use no DOM-only or Node-only APIs", () => {
  for (const file of ["offline.js", "recommend.js"]) {
    const source = readFileSync(join(WEB, "shared", file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "")
      .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
      .replace(/`(?:[^`\\]|\\.)*`/g, "``");
    assert.doesNotMatch(source, /\b(document|window|localStorage|sessionStorage|indexedDB|navigator|process|Buffer|require)\b/, file);
    assert.doesNotMatch(source, /from\s+["']node:/, file);
  }
});

test("only device-store.js touches IndexedDB, and only own devices open it", () => {
  for (const file of jsFiles(WEB)) {
    const source = readFileSync(file, "utf8").replace(/\/\/.*$/gm, "");
    if (file.endsWith(join("web", "device-store.js"))) continue;
    assert.doesNotMatch(source, /\bindexedDB\b/, file);
  }
  const app = readFileSync(join(WEB, "app.js"), "utf8");
  assert.match(app, /sharedComputer \? memoryKeyValue\(\) : openDeviceStore\(\) \?\? memoryKeyValue\(\)/);
  assert.match(app, /offline\.clear\(\)/, "sign-out empties the saved view and the queue");
  assert.doesNotMatch(readFileSync(join(WEB, "home.js"), "utf8"), /localStorage|sessionStorage|indexedDB|innerHTML/);
});

test("the home view has the three large actions, Recommended next and a smaller More", () => {
  const html = readFileSync(join(WEB, "index.html"), "utf8");
  const home = html.slice(html.indexOf('<div id="view-home"'), html.indexOf('<div id="view-work"'));
  const big = [...home.matchAll(/<button type="button" id="go-(\w+)" class="big">([^<]+)<\/button>/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(big, [["work", "Help me with some work"], ["learn", "Learn or revise"], ["upcoming", "See what's coming up"]]);
  assert.match(home, /<button type="button" id="go-more" class="link">More<\/button>/);
  assert.match(home, /<section id="recommend"[^>]*hidden>/);
  assert.match(home, /<h2 id="recommend-heading">Recommended next<\/h2>/);
  for (const view of ["work", "upcoming", "learn", "more"]) {
    assert.match(html, new RegExp(`<div id="view-${view}" class="view" hidden>\\s*<button type="button" class="back" data-back>Back</button>`), view);
  }
  const work = html.slice(html.indexOf('<div id="view-work"'), html.indexOf('<div id="view-upcoming"'));
  assert.match(work, /<section id="capture"/);
  assert.match(work, /<section id="check-screen"/);
  assert.match(html.slice(html.indexOf('<div id="view-upcoming"')), /<section id="upcoming"/);
  const more = html.slice(html.indexOf('<div id="view-more"'));
  assert.match(more, /id="sign-out"/);
  assert.match(html, /<p id="queue-note" class="queue-note" role="status" aria-live="polite" hidden><\/p>/);
});

test("signing out with changes waiting asks first, in a dialog", () => {
  const html = readFileSync(join(WEB, "index.html"), "utf8");
  assert.match(html, /<dialog id="sign-out-dialog" aria-labelledby="sign-out-heading"/);
  assert.match(html, /id="sign-out-confirm"[^>]*>Sign out anyway<\/button>/);
  assert.match(html, /id="sign-out-cancel"[^>]*>Stay signed in<\/button>/);
  const app = readFileSync(join(WEB, "app.js"), "utf8");
  assert.match(app, /showModal\(\)/);
  assert.match(app, /signOutMessage\(waiting\)/);
});

test("the page code imports under Node without a DOM", async () => {
  assert.equal(typeof (await import("../web/home.js")).createHome, "function");
  assert.equal(typeof (await import("../web/upcoming.js")).createUpcoming, "function");
  assert.equal(typeof (await import("../web/app.js")).loginUrl, "function");
});

test("deploy stamping covers the new modules", { skip: !existsSync(join(ROOT, "scripts", "stamp-versions.sh")) }, () => {
  const dir = mkdtempSync(join(tmpdir(), "wp110-stamp-"));
  try {
    cpSync(WEB, join(dir, "web"), { recursive: true });
    execFileSync("bash", [join(ROOT, "scripts", "stamp-versions.sh"), join(dir, "web"), "abc12345"], { stdio: "pipe" });
    const appJs = readFileSync(join(dir, "web", "app.js"), "utf8");
    for (const name of ["home", "device-store", "shared/offline", "shared/recommend"]) {
      assert.match(appJs, new RegExp(`from "\\./${name}\\.js\\?v=abc12345"`), name);
    }
    assert.match(readFileSync(join(dir, "web", "upcoming.js"), "utf8"), /from "\.\/shared\/offline\.js\?v=abc12345"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
