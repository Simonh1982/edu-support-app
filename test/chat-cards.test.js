// WP-132a (A-013 §6): the "+" menu's cards in the chat (a pasted task read and checked, then added;
// a source added to the chat's task) and linking a chat with no task to the task added from it.
// Fake page and API, mock AI, temporary folder. Invented data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createChatCards, CARD_TEXT } from "../web/chat-cards.js";
import { makeEvent } from "../server/storage/records.js";
import { createMockAi } from "../server/ai/mock.js";
import { matchApiRoute, handleApi } from "../server/api.js";
import { MENU_MESSAGES } from "../server/domain/menu.js";

class FakeElement {
  constructor(tag) {
    Object.assign(this, { tagName: tag.toUpperCase(), children: [], attributes: {}, dataset: {}, listeners: {}, className: "", value: "", disabled: false, ownText: "" });
  }
  set textContent(v) { this.ownText = String(v); this.children = []; }
  get textContent() { return this.ownText + this.children.map((c) => c.textContent).join(""); }
  setAttribute(n, v) { this.attributes[n] = String(v); }
  getAttribute(n) { return this.attributes[n] ?? null; }
  append(...n) { this.children.push(...n); }
  addEventListener(t, fn) { this.listeners[t] = fn; }
  all(match) { const out = []; const walk = (el) => { for (const c of el.children) { if (match(c)) out.push(c); walk(c); } }; walk(this); return out; }
}
const doc = { createElement: (t) => new FakeElement(t) };
const ok = (body) => ({ kind: "ok", status: 200, body });
const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r)); };

const UPLOAD = {
  id: "up_tinv1", status: "done", contentKind: "brief", text: "Invented brief", spellingCorrections: [],
  proposal: { title: "Invented coast essay", deadline: "2026-12-10", question: { verbatim: "Assess the defences at Invented Bay." }, anchors: [{ type: "location", text: "Invented Bay" }] },
};

function fakeApi(reads) {
  const calls = [];
  let n = 0;
  const api = {
    pasteBrief: async (b) => { calls.push(["pasteBrief", b]); return ok({ upload: { id: "up_tinv1" } }); },
    openUpload: async (id) => { calls.push(["openUpload", id]); return reads[Math.min(n++, reads.length - 1)]; },
    confirmUpload: async (id, b) => { calls.push(["confirmUpload", id, b]); return ok({ task: { id: "t_inv9", stage: "not-started" } }); },
    addOwnSource: async (b) => { calls.push(["addOwnSource", b]); return ok({ source: { id: "src_inv" } }); },
  };
  return { api, calls };
}

test("a pasted task is sent with its date, followed while it travels and is read, then checked and added", async () => {
  const { api, calls } = fakeApi([{ kind: "http", status: 404 }, ok({ upload: { id: "up_tinv1", status: "processing" } }), ok({ upload: UPLOAD })]);
  const added = [];
  const cards = createChatCards({ doc, api, workerUrl: "https://w.invented.dev", getToken: () => "pass", sleep: async () => {}, onAdded: (t) => added.push(t) });
  assert.deepEqual(await cards.addPaste("  ", ""), { error: "Type or paste the task or question first.", field: "text" });
  const r = await cards.addPaste("Invented brief text", "2026-12-11");
  assert.equal(r.ok, true);
  await settle();
  assert.deepEqual(calls[0][1].text, "Invented brief text");
  assert.equal(calls[0][1].deadline, "2026-12-11");
  assert.equal(calls.filter((c) => c[0] === "openUpload").length, 3, "404 while it travels, then reading, then read");
  const [card] = cards.list();
  assert.equal(card.state, "check");
  const li = cards.render(card);
  assert.match(li.textContent, /Pasted task.*Check the details.*Key details.*Place or case study: Invented Bay/s);
  const title = li.all((e) => e.attributes.id === `${card.key}-title`)[0];
  title.value = "My invented title";
  title.listeners.input();
  await li.all((e) => e.tagName === "FORM")[0].listeners.submit({ preventDefault() {} });
  const confirm = calls.find((c) => c[0] === "confirmUpload");
  assert.equal(confirm[1], "up_tinv1");
  assert.equal(confirm[2].title, "My invented title");
  assert.deepEqual(added, [{ id: "t_inv9", title: "My invented title", stage: "not-started" }]);
  assert.equal(card.state, "done");
  assert.equal(card.message, CARD_TEXT.added("My invented title"));
});

test("a read that failed, or text that isn't a task, says so plainly; a source is added to the chat's task", async () => {
  const failed = fakeApi([ok({ upload: { id: "up_tinv1", status: "failed", failureReason: "unreadable" } })]);
  const a = createChatCards({ doc, api: failed.api, workerUrl: "https://w.invented.dev", getToken: () => "pass", sleep: async () => {} });
  await a.addPaste("Invented", "");
  await settle();
  assert.equal(a.list()[0].state, "note");
  const notBrief = fakeApi([ok({ upload: { id: "up_tinv1", status: "done", contentKind: "own" } })]);
  const b = createChatCards({ doc, api: notBrief.api, workerUrl: "https://w.invented.dev", getToken: () => "pass", sleep: async () => {} });
  await b.addPaste("Invented", "");
  await settle();
  assert.equal(b.list()[0].message, CARD_TEXT.notBrief);

  const s = fakeApi([]);
  const c = createChatCards({ doc, api: s.api, workerUrl: "https://w.invented.dev", getToken: () => "pass" });
  const card = c.addSource("t_inv9");
  const li = c.render(card);
  const form = li.all((e) => e.tagName === "FORM")[0];
  await form.listeners.submit({ preventDefault() {} });
  assert.equal(card.message, CARD_TEXT.needTitle);
  const input = li.all((e) => e.attributes.id === `${card.key}-title`)[0];
  input.value = "Invented shoreline plan";
  input.listeners.input();
  await form.listeners.submit({ preventDefault() {} });
  assert.deepEqual(s.calls.find((x) => x[0] === "addOwnSource")[1], { title: "Invented shoreline plan", taskId: "t_inv9" });
  assert.equal(card.state, "done");
});

// ---------- the server: linking a chat to the task added from it ----------

async function fakeStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wp132a-"));
  return {
    dir, events: [],
    status: () => ({ ready: true }),
    async put(rel, record) { await mkdir(path.dirname(path.join(dir, rel)), { recursive: true }); await writeFile(path.join(dir, rel), JSON.stringify(record)); return record; },
    async read(rel) { try { return JSON.parse(await readFile(path.join(dir, rel), "utf8")); } catch { return null; } },
    async logEvent(type, options = {}) { const e = makeEvent(type, options); this.events.push(e); return e; },
  };
}

test("a chat with no task is linked to the task added from it; once only, and never to a missing task", async () => {
  const store = await fakeStore();
  const MODELS = { conversation: "m-c", light: "m-l", checker: "m-k", review: "m-r", spelling: "m-s", judge: "m-j" };
  const ai = createMockAi({ replies: { "m-c": () => JSON.stringify({ reply: "Invented.", replyType: "other", taskSpecific: false, sources: [], wellbeingLevel: 0 }), "m-l": () => '{"title":"Invented"}', "m-k": () => '{"leak":false}' } });
  const call = (method, url, body) => handleApi({ match: matchApiRoute(method, url), pass: { role: "learner" }, store, body, getAi: () => ({ ai, models: MODELS }), log: { log() {}, error() {} } });
  try {
    const task = (await call("POST", "/api/tasks", { title: "Invented task", topicIds: ["inv-topic-1"] })).body.task;
    const other = (await call("POST", "/api/tasks", { title: "Other invented task" })).body.task;
    const conv = (await call("POST", "/api/conversations", { route: "research" })).body.conversation;
    const r = await call("PATCH", `/api/conversations/${conv.id}`, { taskId: task.id });
    assert.deepEqual([r.status, r.body.conversation.taskId, r.body.conversation.topicId], [200, task.id, "inv-topic-1"]);
    assert.equal((await call("PATCH", `/api/conversations/${conv.id}`, { taskId: task.id })).status, 200, "the same task again is fine");
    const again = await call("PATCH", `/api/conversations/${conv.id}`, { taskId: other.id });
    assert.deepEqual([again.status, again.body.error], [409, MENU_MESSAGES.alreadyLinked]);
    const free = (await call("POST", "/api/conversations", { route: "research" })).body.conversation;
    assert.equal((await call("PATCH", `/api/conversations/${free.id}`, { taskId: "t_missing1" })).status, 404);
    assert.equal((await call("PATCH", `/api/conversations/${free.id}`, { taskId: task.id, name: "x" })).status, 400);
    // linked, the attempt rule applies: his first message is his go
    const said = await call("POST", `/api/conversations/${conv.id}/messages`, { text: "Invented first go" });
    assert.equal(said.body.turn.action, "attempt");
    assert.ok(store.events.some((e) => e.type === "chat.linked"));
  } finally { await rm(store.dir, { recursive: true, force: true }); }
});

test("the page has the \"+\" menu, labelled, with the paste date and the file pickers", () => {
  const html = readFileSync(new URL("../web/chat.html", import.meta.url), "utf8");
  assert.match(html, /id="plus" aria-haspopup="menu" aria-expanded="false" aria-controls="plus-menu" aria-label="Add a photo, file, task or source"/);
  for (const [what, label] of [["camera", "Take a photo"], ["gallery", "Choose a photo"], ["file", "Attach a file"], ["paste", "Paste a task"], ["source", "Add a source"]]) {
    assert.match(html, new RegExp(`role="menuitem" data-add="${what}">${label}<`), what);
  }
  assert.match(html, /<label for="paste-due">When is it due\?<\/label>/);
  assert.match(html, /<input type="file" id="camera-input" accept="image\/\*" capture="environment" hidden>/);
  for (const file of ["chat-cards.js", "chat-app.js"]) assert.doesNotMatch(readFileSync(new URL(`../web/${file}`, import.meta.url), "utf8"), /innerHTML|\bconfirm\s*\(/, file);
});

test("phone fixes from the live check: room for a card, steady taps, and one timeline in order", () => {
  const css = readFileSync(new URL("../web/chat.css", import.meta.url), "utf8");
  assert.match(css, /\.main\.top-away \.top \{\s*display: none;/, "the top bar steps aside while scrolling down");
  assert.match(css, /\.main\.editing-card \.composer-wrap \{\s*display: none;/, "the message box steps aside while a card is filled in");
  assert.match(css, /height: 100dvh;/, "sized to the space above the keyboard");
  assert.doesNotMatch(css, /:focus-within \.composer-hint/, "nothing in the message box changes size on focus (a tap would miss)");
  const app = readFileSync(new URL("../web/chat-app.js", import.meta.url), "utf8");
  assert.match(app, /if \(!inCard\(e\.relatedTarget\)\) mainEl\.classList\.remove\("editing-card"\)/, "stays aside while focus is anywhere in the card");
  assert.match(app, /\.sort\(\(a, b\) => a\.at - b\.at \|\| a\.i - b\.i\)/, "cards and messages in the order they happened");
  assert.match(app, /setText\(els\.taskChip, phone\(\) \? MENU_TEXT\.task : task\.title\)/);
  const cards = createChatCards({ doc, api: fakeApi([]).api, workerUrl: "https://w.invented.dev", getToken: () => "pass", now: () => 1234 });
  assert.equal(cards.addSource("t_inv9").at, 1234, "each card records when it was added");
});

test("the top bar never flickers: the app's own jumps don't count, and the knock-on scroll after a change is ignored", () => {
  const app = readFileSync(new URL("../web/chat-app.js", import.meta.url), "utf8");
  assert.match(app, /function jumpTo\(y\) \{\s*settleUntil = Date\.now\(\) \+ SETTLE_MS;/);
  assert.match(app, /if \(Date\.now\(\) < settleUntil\) return;/);
  assert.match(app, /room > 240\) setTopAway\(true\)/, "only hides with plenty to scroll through");
  assert.doesNotMatch(app, /els\.view\.scrollTop = els\.view\.scrollHeight/, "every jump to the newest message goes through jumpTo");
});
