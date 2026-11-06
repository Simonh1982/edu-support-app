// WP-114e: the task panel (question, sources, own sources) and "Paste the text instead" (A-010).
// Invented data only. A tiny fake document stands in for the DOM.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PASTED_SOURCE_MAX_CHARS,
  PASTE_OUTCOMES,
  SOURCE_MESSAGES,
  checkPasted,
  turnFromReply,
} from "../web/shared/conversation.js";
import { OWN_SOURCE_LIMITS, PANEL_MESSAGES, ownSourceBody, panelFacts, panelSources } from "../web/shared/task-panel.js";
import { longDateText } from "../web/shared/upcoming.js";
import { createApi } from "../web/shared/api.js";
import { sourceList } from "../web/conversation.js";
import { createTaskPanel, sourceItems } from "../web/task-panel.js";
import * as serverSources from "../server/ai/sources.js";
import * as serverDomain from "../server/domain/sources.js";

const BACKEND = "https://example-codespace-3000.app.github.dev";
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// ---------- a tiny fake DOM ----------
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
  click() {
    this.listeners.click?.();
  }
  focus() {
    this.focused = true;
  }
  reset() {
    this.resetCount = (this.resetCount ?? 0) + 1;
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
const byTag = (root, tag) => root.all((el) => el.tagName === tag.toUpperCase());

const PANEL_IDS = [
  "task-panel", "task-panel-title", "task-panel-meta", "task-panel-due", "task-panel-question", "task-panel-question-text",
  "task-panel-sources", "task-panel-sources-label", "task-panel-sources-status", "task-panel-sources-list", "own-source",
  "own-source-form", "own-source-title", "own-source-author", "own-source-url", "own-source-add", "own-source-status",
];
function pageDoc() {
  const els = Object.fromEntries(PANEL_IDS.map((id) => [id, new FakeElement(id.includes("form") ? "form" : "div")]));
  return { els, doc: { ...doc, getElementById: (id) => els[id] ?? null } };
}

const TASK = {
  id: "t_inv1", title: "Invented coast task", subject: "Invented Geography", deadline: "2026-11-20", stage: "researching",
  questionText: { value: "Evaluate the invented Sandy Point scheme.", author: "learner" },
};
const SOURCES = [
  { id: "src_a", title: "Invented guide", url: "https://www.invented.example.org/guide", publisher: "Invented Society", category: "introduction", summaryId: "note_a" },
  { id: "src_b", title: "Invented textbook, chapter 4", url: null, publisher: "A. Inventor", category: "other", origin: "learner", summaryId: null },
  { id: "src_c", title: "Invented video", url: "https://video.invented.example.org/v", category: "video" },
  { id: "../bad", title: "Bad id" },
  { id: "src_d", title: "  " },
];

const ok = (body) => ({ kind: "ok", status: 200, body });

/** A fake API: answers by method name, records every call. */
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

// ---------- copies and rules ----------

test("the screen's copies match the server", () => {
  assert.equal(PASTED_SOURCE_MAX_CHARS, serverSources.PASTED_SOURCE_MAX_CHARS);
  assert.equal(OWN_SOURCE_LIMITS.title, serverDomain.OWN_SOURCE_LIMITS.title);
  assert.equal(OWN_SOURCE_LIMITS.author, serverDomain.OWN_SOURCE_LIMITS.author);
  assert.equal(OWN_SOURCE_LIMITS.url, serverSources.SOURCE_LIMITS.url);
  assert.equal(SOURCE_MESSAGES.pasteEmpty, serverDomain.SOURCE_MESSAGES.pasteEmpty);
  assert.equal(SOURCE_MESSAGES.pasteTooLong, serverDomain.SOURCE_MESSAGES.pasteTooLong);
  assert.deepEqual([...PASTE_OUTCOMES], ["unavailable", "subscription", "unclear"]);
});

test("checkPasted: trimmed text within the limit; empty and over-long are refused", () => {
  assert.deepEqual(checkPasted("  invented text  "), { text: "invented text" });
  assert.equal(checkPasted("   ").error, SOURCE_MESSAGES.pasteEmpty);
  assert.equal(checkPasted(undefined).error, SOURCE_MESSAGES.pasteEmpty);
  assert.equal(checkPasted("x".repeat(PASTED_SOURCE_MAX_CHARS + 1)).error, SOURCE_MESSAGES.pasteTooLong);
  assert.ok(checkPasted("x".repeat(PASTED_SOURCE_MAX_CHARS)).text);
});

test("panelFacts: title, subject and stage, the due date in full, and the question once the task is loaded", () => {
  const facts = panelFacts({ task: TASK, today: "2026-11-06" });
  assert.deepEqual(facts, {
    title: "Invented coast task", meta: "Invented Geography · Researching", due: `Due ${longDateText("2026-11-20")}`,
    question: "Evaluate the invented Sandy Point scheme.", loaded: true,
  });
  assert.equal(facts.due, "Due Friday 20 November 2026");
  const early = panelFacts({ item: { taskId: "t_inv1", title: "Invented coast task", deadline: "2026-11-07", stage: "not-started" }, today: "2026-11-06" });
  assert.deepEqual([early.due, early.meta, early.question, early.loaded], ["Due tomorrow (Saturday 7 November 2026)", "Not started", null, false]);
  assert.equal(panelFacts({ task: { ...TASK, deadline: "2026-11-05" }, today: "2026-11-06" }).due, "Was due yesterday (Thursday 5 November 2026)");
  assert.equal(panelFacts({ task: { ...TASK, deadline: null, questionText: null }, today: "2026-11-06" }).due, PANEL_MESSAGES.noDeadline);
  assert.equal(panelFacts({ task: { title: "x", questionText: "Plain text question" }, today: "2026-11-06" }).question, "Plain text question");
  assert.equal(panelFacts({ today: "2026-11-06" }).title, "Task");
});

test("panelSources: safe links, his own sources labelled, videos can't be summarised, bad entries left out", () => {
  const list = panelSources(SOURCES);
  assert.deepEqual(list.map((s) => s.id), ["src_a", "src_b", "src_c"]);
  assert.deepEqual(list[0], {
    id: "src_a", title: "Invented guide", url: "https://www.invented.example.org/guide", own: false, kind: "Quick introduction",
    byline: "Invented Society · invented.example.org", summaryId: "note_a", canSummarise: true,
  });
  assert.deepEqual([list[1].kind, list[1].url, list[1].byline, list[1].own], [PANEL_MESSAGES.ownKind, null, "A. Inventor", true]);
  assert.equal(list[2].canSummarise, false);
  assert.equal(panelSources([{ id: "src_x", title: "x", url: "javascript:alert(1)" }])[0].url, null);
  assert.deepEqual(panelSources(null), []);
});

test("ownSourceBody: a title is needed; author and link are optional; a link without https:// gets it", () => {
  assert.deepEqual(ownSourceBody({ title: "  Invented   book ", author: "", url: "" }), { body: { title: "Invented book" } });
  assert.deepEqual(ownSourceBody({ title: "x", author: "A. Inventor", url: "invented.example.org/page" }),
    { body: { title: "x", author: "A. Inventor", url: "https://invented.example.org/page" } });
  assert.deepEqual(ownSourceBody({ title: "" }), { error: PANEL_MESSAGES.needTitle, field: "title" });
  assert.equal(ownSourceBody({ title: "x".repeat(201) }).field, "title");
  assert.equal(ownSourceBody({ title: "x", author: "y".repeat(121) }).field, "author");
  for (const url of ["javascript:alert(1)", "https://user:pw@invented.example.org/", "not a link", "localhost/x"]) {
    assert.equal(ownSourceBody({ title: "x", url }).field, "url", url);
  }
});

// ---------- the API calls ----------

test("the panel's calls go to the right routes with the pass; a pasted summary sends { text }", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push([init.method, url.slice(BACKEND.length), init.body ? JSON.parse(init.body) : undefined, init.headers.Authorization]);
    return new Response("{}", { status: 200 });
  };
  const api = createApi({ getBackendUrl: () => BACKEND, getToken: () => "test-pass", fetchImpl });
  await api.getTask("t_inv1");
  await api.listSources("t_inv1");
  await api.addOwnSource({ title: "x", taskId: "t_inv1" });
  await api.summariseSource("src_a", { text: "invented" });
  await api.summariseSource("src_a");
  assert.deepEqual(calls.map((c) => c.slice(0, 3)), [
    ["GET", "/api/tasks/t_inv1", undefined],
    ["GET", "/api/sources?taskId=t_inv1", undefined],
    ["POST", "/api/sources/own", { title: "x", taskId: "t_inv1" }],
    ["POST", "/api/sources/src_a/summary", { text: "invented" }],
    ["POST", "/api/sources/src_a/summary", {}],
  ]);
  assert.ok(calls.every((c) => c[3] === "Bearer test-pass"));
});

// ---------- paste on the conversation's cards ----------

const TURN = turnFromReply({
  id: "turn_p", reply: "Invented reply", sources: [
    { title: "Invented council page", url: "https://invented-council.example.gov.uk/coast", category: "official", why: "Covers the invented scheme." },
    { title: "Invented video", url: "https://video.invented.example.org/v", category: "video", why: "x" },
  ],
});

test("a card offers 'Paste the text instead' only after the tutor couldn't open it, never on videos", () => {
  assert.equal(byClass(sourceList(doc, TURN, {}), "paste-source").length, 0);
  const seen = [];
  const section = sourceList(doc, TURN, {
    stateOf: () => ({ sourceId: "src_1", asked: false, canPaste: true, pasteText: "kept text", pasteOpen: true, note: "Invented couldn't-open message." }),
    onPaste: (card, text) => seen.push(["paste", card.index, text]),
    onPasteChange: (card, changes) => seen.push(["change", card.index, changes]),
  });
  const boxes = byClass(section, "paste-source");
  assert.equal(boxes.length, 1, "the video card has none");
  const [box] = boxes;
  assert.equal(box.tagName, "DETAILS");
  assert.equal(box.getAttribute("open"), "", "stays open across a redraw");
  assert.equal(byTag(box, "summary")[0].textContent, SOURCE_MESSAGES.pasteHeading);
  const [area] = byTag(box, "textarea");
  assert.equal(area.value, "kept text");
  assert.equal(byTag(box, "label")[0].getAttribute("for"), area.getAttribute("id"));
  assert.equal(area.getAttribute("maxlength"), null, "a long paste is told, not cut short");
  area.value = "new invented text";
  area.listeners.input();
  byTag(box, "button")[0].click();
  assert.deepEqual(seen, [["change", 0, { pasteText: "new invented text" }], ["paste", 0, "new invented text"]]);
  const busy = sourceList(doc, TURN, { stateOf: () => ({ sourceId: "s", canPaste: true, summarising: true }) });
  assert.ok(byTag(byClass(busy, "paste-source")[0], "button")[0].disabled);
  const done = sourceList(doc, TURN, { stateOf: () => ({ sourceId: "s", canPaste: true, summary: { kind: "summary", text: "x" } }) });
  assert.equal(byClass(done, "paste-source").length, 0, "gone once there is a summary");
});

// ---------- the panel's source list ----------

test("panel sources: an earlier summary on request, Summarise for links, and the paste box for sources with no link", () => {
  const seen = [];
  const items = sourceItems(doc, panelSources(SOURCES), {
    onOpenSummary: (s, open) => seen.push(["open", s.id, open]), onSummarise: (s) => seen.push(["sum", s.id]),
    onPaste: (s, t) => seen.push(["paste", s.id, t]),
  });
  assert.equal(items.length, 3);
  const [a, b, c] = items;
  const details = byTag(a, "details")[0];
  assert.equal(byTag(details, "summary")[0].textContent, PANEL_MESSAGES.openSummary);
  details.open = true;
  details.listeners.toggle();
  assert.equal(byTag(a, "button").length, 0, "no second summary");
  assert.equal(byTag(byClass(b, "source-title")[0], "a").length, 0, "no link, so plain text");
  assert.equal(byClass(b, "paste-source").length, 1);
  byTag(b, "button")[0].click();
  assert.equal(byTag(c, "button").length + byClass(c, "paste-source").length, 0, "a video gets neither");
  assert.deepEqual(seen, [["open", "src_a", true], ["paste", "src_b", ""]]);
  const withLink = sourceItems(doc, panelSources([{ id: "src_e", title: "Invented page", url: "https://invented.example.org/e" }]), { onSummarise: (s) => seen.push(["sum", s.id]) });
  assert.equal(byClass(withLink[0], "paste-source").length, 0, "with a link: Summarise first");
  byTag(withLink[0], "button")[0].click();
  assert.deepEqual(seen.at(-1), ["sum", "src_e"]);
  const after = sourceItems(doc, panelSources([{ id: "src_e", title: "Invented page", url: "https://invented.example.org/e" }]), {
    stateOf: () => ({ canPaste: true, asked: true, note: "Invented note." }),
  });
  assert.equal(byClass(after[0], "paste-source").length, 1, "after 'couldn't open', the paste box");
  assert.equal(byClass(after[0], "source-note")[0].textContent, "Invented note.");
});

// ---------- the panel on the page ----------

test("the panel: list entry at once, then the question and sources once the tutor's ready; every part starts closed", async () => {
  const { els, doc: page } = pageDoc();
  const { api, calls } = fakeApi({ getTask: ok({ task: TASK }), listSources: ok({ sources: SOURCES }) });
  const panel = createTaskPanel({ api, doc: page, now: () => new Date("2026-11-06T10:00:00Z") });
  assert.ok(panel);
  els["task-panel-question"].open = true;
  await panel.show({ taskId: "t_inv1", title: "Invented coast task", deadline: "2026-11-20", stage: "researching" });
  assert.equal(els["task-panel"].hidden, false);
  assert.equal(els["task-panel-question"].open, false, "collapsed");
  assert.equal(els["task-panel-sources"].open, false, "collapsed");
  assert.equal(els["task-panel-title"].textContent, "Invented coast task");
  assert.equal(els["task-panel-question-text"].textContent, PANEL_MESSAGES.waitQuestion);
  assert.equal(calls.length, 0, "nothing is asked before the tutor's ready");
  await panel.setTutor("ready");
  assert.deepEqual(calls.map((c) => c[0]), ["getTask", "listSources"]);
  assert.equal(els["task-panel-question-text"].textContent, "Evaluate the invented Sandy Point scheme.");
  assert.equal(els["task-panel-meta"].textContent, "Invented Geography · Researching");
  assert.equal(els["task-panel-due"].textContent, "Due Friday 20 November 2026");
  assert.equal(els["task-panel-sources-label"].textContent, "Your sources for this task (3)");
  assert.equal(els["task-panel-sources-list"].children.length, 3);
  await panel.show(null);
  assert.equal(els["task-panel"].hidden, true, "no task, no panel");
});

test("the panel: add a source he found himself, then paste text from it for a summary", async () => {
  const { els, doc: page } = pageDoc();
  let sources = [];
  const { api, calls } = fakeApi({
    getTask: ok({ task: TASK }),
    listSources: () => ok({ sources }),
    addOwnSource: (body) => {
      sources = [{ id: "src_own", title: body.title, url: null, publisher: body.author, category: "other", origin: "learner" }];
      return { kind: "ok", status: 201, body: { source: sources[0] } };
    },
    summariseSource: () => ok({ outcome: "saved", entry: { id: "note_own", text: { value: "Invented summary.", author: "ai" }, source: { url: null } } }),
  });
  const panel = createTaskPanel({ api, doc: page });
  panel.setTutor("ready");
  await panel.show({ taskId: "t_inv1", title: "Invented coast task" });
  els["own-source-title"].value = "";
  await els["own-source-form"].listeners.submit({ preventDefault() {} });
  assert.equal(els["own-source-status"].textContent, PANEL_MESSAGES.needTitle);
  assert.ok(els["own-source-title"].focused);
  els["own-source-title"].value = "Invented textbook";
  els["own-source-author"].value = "A. Inventor";
  els["own-source-url"].value = "";
  await els["own-source-form"].listeners.submit({ preventDefault() {} });
  assert.deepEqual(calls.find((c) => c[0] === "addOwnSource")[1], { title: "Invented textbook", author: "A. Inventor", taskId: "t_inv1" });
  assert.equal(els["own-source-status"].textContent, PANEL_MESSAGES.added);
  assert.equal(els["task-panel-sources-label"].textContent, "Your sources for this task (1)");
  const [item] = els["task-panel-sources-list"].children;
  const area = byTag(item, "textarea")[0];
  area.value = "  INVENTED pasted words  ";
  await byTag(byClass(item, "paste-source")[0], "button")[0].listeners.click();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls.find((c) => c[0] === "summariseSource").slice(1), ["src_own", { text: "INVENTED pasted words" }]);
  const [after] = els["task-panel-sources-list"].children;
  assert.equal(byClass(after, "ai-summary-text")[0].textContent, "Invented summary.");
  assert.equal(byClass(after, "ai-summary-label")[0].textContent, "AI summary");
});

test("the panel: signed out on a 401; nothing is kept after clear()", async () => {
  const { els, doc: page } = pageDoc();
  const reasons = [];
  const { api } = fakeApi({ getTask: { kind: "auth", reason: "expired" }, listSources: { kind: "ok", body: { sources: [] } } });
  const panel = createTaskPanel({ api, doc: page, onSignedOut: (r) => reasons.push(r) });
  panel.setTutor("ready");
  await panel.show({ taskId: "t_inv1", title: "x" });
  assert.deepEqual(reasons, ["expired"]);
  assert.equal(els["task-panel"].hidden, true);
  assert.equal(createTaskPanel({ api, doc: { ...doc, getElementById: () => null } }), null, "no panel on the page: the conversation works without it");
});

// ---------- page rules ----------

test("the page has the panel in the conversation view, collapsed, with every control labelled", () => {
  const html = read("web/index.html");
  const talk = html.slice(html.indexOf('<div id="view-talk"'), html.indexOf('<div id="view-upcoming"'));
  const panel = talk.slice(talk.indexOf('<section id="task-panel"'), talk.indexOf("</section>", talk.indexOf('<section id="task-panel"')));
  assert.match(talk, /<section id="task-panel" class="task-panel" aria-labelledby="task-panel-title" hidden>/);
  assert.ok(talk.indexOf('id="talk-task"') < talk.indexOf('id="task-panel"'));
  for (const id of ["task-panel-question", "task-panel-sources", "own-source"]) {
    assert.match(panel, new RegExp(`<details id="${id}" class="more">`), `${id} starts closed`);
  }
  assert.match(panel, /<summary>Show the question<\/summary>/);
  assert.match(panel, /<summary id="task-panel-sources-label">Your sources for this task<\/summary>/);
  for (const id of ["own-source-title", "own-source-author", "own-source-url"]) {
    assert.match(panel, new RegExp(`<label for="${id}">`), id);
  }
  assert.match(panel, /id="own-source-title" maxlength="200"/);
  assert.match(panel, /id="own-source-author" maxlength="120"/);
  assert.match(panel, /id="own-source-url" maxlength="500"/);
  assert.doesNotMatch(panel, /\son[a-z]+=/, "no inline handlers");
});

test("the panel code keeps to the page rules", () => {
  for (const file of ["web/task-panel.js", "web/source-parts.js"]) {
    assert.doesNotMatch(read(file), /innerHTML|insertAdjacentHTML|localStorage|sessionStorage|indexedDB/, file);
  }
  const shared = read("web/shared/task-panel.js").replace(/\/\/.*$/gm, "").replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
  assert.doesNotMatch(shared, /\b(document|window|localStorage|sessionStorage|indexedDB|navigator|process|Buffer|require)\b/);
  const page = read("web/conversation.js");
  assert.match(page, /import \{ createTaskPanel \} from "\.\/task-panel\.js";/);
  assert.match(page, /panel\?\.clear\(\)/, "signing out clears the panel");
  assert.match(page, /api\.summariseSource\(state\.sourceId, \{ text: checked\.text \}\)/);
  const css = read("web/app.css");
  assert.match(css, /\.task-panel input,\s*\.paste-source textarea\s*\{[^}]*min-height: var\(--tap\)/);
});
