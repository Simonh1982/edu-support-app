// WP-115b: the notebook screens (build spec §29): "Your notebook" with search, the task panel's notes
// with the earlier-research offer, and "Add a quote" under a source. Invented data only.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as server from "../server/domain/notebook.js";
import {
  NOTE_MAX_CHARS, QUOTE_MAX_CHARS, NOTE_TITLE_MAX, PAGE_MAX, SEARCH_MAX, NOTEBOOK_KINDS, NOTEBOOK_TEXT, KIND_LABELS,
  entriesFromSnapshot, filterTitles, notebookQuery, checkNote, checkQuote, insertQuote, quotesStillIn, quoteForNote, entryLine,
} from "../web/shared/notebook.js";
import { createTaskPanel, sourceItems } from "../web/task-panel.js";
import { createNotebook } from "../web/notebook.js";
import { panelSources } from "../web/shared/task-panel.js";

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
  set textContent(value) { this.ownText = String(value); this.children = []; }
  get textContent() { return this.ownText + this.children.map((c) => c.textContent).join(""); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  focus() { this.focused = true; }
  reset() { this.value = ""; }
  all(match) {
    const out = [];
    const walk = (el) => { for (const c of el.children) { if (match(c)) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
}
const IDS = [
  "task-panel", "task-panel-title", "task-panel-meta", "task-panel-due", "task-panel-question", "task-panel-question-text",
  "task-panel-sources", "task-panel-sources-label", "task-panel-sources-status", "task-panel-sources-list", "own-source",
  "own-source-form", "own-source-title", "own-source-author", "own-source-url", "own-source-add", "own-source-status",
  "task-panel-notes", "task-panel-notes-label", "task-panel-notes-status", "task-panel-earlier", "task-panel-notes-list", "task-panel-note-editor",
  "notebook-search", "notebook-q", "notebook-kind", "notebook-task", "notebook-write", "notebook-editor", "notebook-status", "notebook-list",
];
function pageDoc() {
  const els = Object.fromEntries(IDS.map((id) => [id, new FakeElement(id.includes("form") || id === "notebook-search" ? "form" : "div")]));
  return { els, doc: { createElement: (tag) => new FakeElement(tag), getElementById: (id) => els[id] ?? null } };
}
const ok = (body) => ({ kind: "ok", status: 200, body });
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
const settle = async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r)); };
const byAction = (root, action) => root.all((el) => el.dataset.action === action);
const submit = (form) => form.listeners.submit({ preventDefault() {} });
const type = (el, value) => { el.value = value; el.listeners.input?.(); };

const TASK = { id: "t_inv1", title: "Invented coast task", deadline: "2026-11-30", stage: "researching" };
const ITEM = { taskId: "t_inv1", title: "Invented coast task", deadline: "2026-11-30", stage: "researching" };
const NOTE = { id: "note_a", type: "note", title: "Invented first thoughts", author: "learner", excerpt: "Invented note.", taskId: "t_inv1", updatedAt: "2026-11-17T10:00:00Z" };
const QUOTE = { id: "note_q", type: "quote", title: "Quote: Invented Study", author: "source", excerpt: "Invented passage.", taskId: "t_inv1", citation: "(A. Inventor, “Invented Study”)", updatedAt: "2026-11-17T09:00:00Z" };
const PINNED = { id: "note_s", type: "summary", title: "Invented Study", author: "ai", excerpt: "Invented AI summary.", taskId: "t_other", updatedAt: "2026-11-01T09:00:00Z" };
const OLDER = { id: "note_o", type: "summary", title: "Invented older study", author: "ai", excerpt: "Invented older summary.", taskId: "t_old", updatedAt: "2026-10-20T09:00:00Z" };

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test("the page's copies match the server: limits and how a quote goes into a note", () => {
  assert.equal(NOTE_MAX_CHARS, server.NOTEBOOK_LIMITS.note);
  assert.equal(QUOTE_MAX_CHARS, server.NOTEBOOK_LIMITS.quote);
  assert.equal(NOTE_TITLE_MAX, server.NOTEBOOK_LIMITS.title);
  assert.equal(PAGE_MAX, server.NOTEBOOK_LIMITS.page);
  assert.equal(SEARCH_MAX, server.NOTEBOOK_LIMITS.search);
  assert.deepEqual([...NOTEBOOK_KINDS], [...server.NOTEBOOK_TYPES]);
  const entry = { text: { value: "Invented passage." }, citation: server.citation({ author: "A. Inventor", title: "Invented" }, "3") };
  assert.equal(quoteForNote(entry), server.quoteForNote(entry));
});

test("shared rules: snapshot titles, search while resting, the query, checks, and inserting quotes", () => {
  const snap = { notebook: [{ type: "notebook", id: "note_a", title: "Invented coasts", kind: "note", taskId: "t_inv1", updatedAt: "2026-11-17" }, { id: "x", kind: "nonsense" }] };
  const list = entriesFromSnapshot(snap);
  assert.deepEqual(list.map((e) => [e.id, e.type, e.author]), [["note_a", "note", "learner"]]);
  assert.equal(filterTitles(list, { q: "COASTS" }).length, 1);
  assert.equal(filterTitles(list, { kind: "summary" }).length, 0);
  assert.equal(notebookQuery({ q: " invented words ", kind: "quote", taskId: "t_inv1" }), "?q=invented+words&type=quote&taskId=t_inv1");
  assert.equal(notebookQuery({}), "");
  assert.deepEqual(checkNote({ text: "  " }), { error: NOTEBOOK_TEXT.needText });
  assert.deepEqual(checkNote({ title: " Invented ", text: " My words. " }), { title: "Invented", text: "My words." });
  assert.match(checkNote({ text: "x".repeat(NOTE_MAX_CHARS + 1) }).error, /too long/);
  assert.deepEqual(checkQuote({ text: "Invented passage.", page: " 12 " }), { text: "Invented passage.", page: "12" });
  const quote = { id: "note_q", text: { value: "Invented passage." }, citation: "(Invented)" };
  const text = insertQuote("My point.", quote);
  assert.equal(text, "My point.\n\n“Invented passage.” (Invented)");
  assert.deepEqual(quotesStillIn(text, [{ id: "note_q", text: "Invented passage." }, { id: "gone", text: "Removed passage." }]), ["note_q"]);
  assert.match(entryLine({ type: "summary", author: "ai", updatedAt: "2026-11-17T10:00:00Z" }, "Invented task"), /^Written by AI · Invented task · 17 Nov$/);
});

test("task panel: his notes and pinned entries, each labelled; earlier research offered and pinned on Use this", async () => {
  const { els, doc } = pageDoc();
  const { api, calls } = fakeApi({
    getTask: ok({ task: TASK }),
    listSources: ok({ sources: [] }),
    listNotebook: ok({ entries: [NOTE, QUOTE, PINNED] }),
    earlierResearch: ok({ entries: [OLDER], count: 1, since: "2026-10-20T09:00:00Z" }),
    pinEntry: ok({ entry: { ...OLDER, pinnedTo: ["t_inv1"] } }),
  });
  const panel = createTaskPanel({ api, doc });
  panel.setTutor("ready");
  await panel.show(ITEM);
  await settle();
  assert.equal(els["task-panel-notes"].hidden, false);
  assert.equal(els["task-panel-notes-label"].textContent, NOTEBOOK_TEXT.taskNotesCount(3));
  const items = els["task-panel-notes-list"].children;
  assert.deepEqual(items.map((i) => i.children[0].textContent), [KIND_LABELS.note, KIND_LABELS.quote, KIND_LABELS.summary]);
  assert.match(items[2].textContent, /Written by AI · Pinned from another task/);
  assert.equal(byAction(items[2], "unpin").length, 1, "an entry from elsewhere can be removed from this task");
  assert.equal(byAction(items[0], "unpin").length, 0);
  // the offer (§29)
  assert.equal(els["task-panel-earlier"].hidden, false);
  assert.match(els["task-panel-earlier"].textContent, /You researched this topic before \(from 20 Oct\): 1 entry\. Would you like to use those notes\?/);
  await byAction(els["task-panel-earlier"], "use")[0].listeners.click();
  assert.deepEqual(calls.find((c) => c[0] === "pinEntry").slice(1), ["note_o", { taskId: "t_inv1", pinned: true }]);
});

test("task panel: write a note, insert a quote with its citation, and save with the quote's ID", async () => {
  const { els, doc } = pageDoc();
  const { api, calls } = fakeApi({
    getTask: ok({ task: TASK }),
    listSources: ok({ sources: [] }),
    listNotebook: ok({ entries: [QUOTE] }),
    earlierResearch: ok({ entries: [], count: 0, since: null }),
    openItem: ok({ item: { id: "note_q", type: "quote", text: { value: "Invented passage in full.", author: "source" }, citation: "(A. Inventor, “Invented Study”)" } }),
    createNote: ok({ entry: { id: "note_new" } }),
  });
  const panel = createTaskPanel({ api, doc });
  panel.setTutor("ready");
  await panel.show(ITEM);
  await settle();
  let form = els["task-panel-note-editor"].children[0];
  type(form.all((e) => e.tagName === "TEXTAREA")[0], "My invented point.");
  await byAction(form, "insert")[0].listeners.click();
  await settle();
  form = els["task-panel-note-editor"].children[0];
  const area = form.all((e) => e.tagName === "TEXTAREA")[0];
  assert.equal(area.value, "My invented point.\n\n“Invented passage in full.” (A. Inventor, “Invented Study”)");
  await submit(form);
  await settle();
  const sent = calls.find((c) => c[0] === "createNote")[1];
  assert.deepEqual(sent, { title: null, text: area.value, taskId: "t_inv1", quoteIds: ["note_q"] });
  // AI summaries are never offered for inserting
  assert.equal(calls.filter((c) => c[0] === "listNotebook").length >= 2, true, "the list reloads after saving");
});

test("Add a quote under a saved source sends the passage and page, then shows it in the notes", async () => {
  const sources = panelSources([{ id: "src_q", title: "Invented Study", url: "https://invented.example.org/s", category: "academic" }]);
  const seen = [];
  const { doc } = pageDoc();
  const [item] = sourceItems(doc, sources, { ready: true, onQuote: (s, values) => seen.push([s.id, values]) });
  const box = item.all((e) => e.className.includes("add-quote"))[0];
  assert.equal(box.children[0].textContent, NOTEBOOK_TEXT.addQuote);
  box.all((e) => e.tagName === "TEXTAREA")[0].value = "Invented passage.";
  box.all((e) => e.tagName === "INPUT")[0].value = "4";
  byAction(box, "save-quote")[0].listeners.click();
  assert.deepEqual(seen, [["src_q", { text: "Invented passage.", page: "4" }]]);
  assert.equal(sourceItems(doc, sources, { ready: false, onQuote: () => {} })[0].all((e) => e.className.includes("add-quote")).length, 0, "needs the tutor");

  const { els, doc: page } = pageDoc();
  const { api, calls } = fakeApi({ getTask: ok({ task: TASK }), listSources: ok({ sources: [{ id: "src_q", title: "Invented Study", category: "academic" }] }), createQuote: ok({ entry: { id: "note_q2" } }) });
  const panel = createTaskPanel({ api, doc: page });
  panel.setTutor("ready");
  await panel.show(ITEM);
  await settle();
  const quoteBox = els["task-panel-sources-list"].children[0].all((e) => e.className.includes("add-quote"))[0];
  quoteBox.all((e) => e.tagName === "TEXTAREA")[0].value = "Invented passage.";
  await byAction(quoteBox, "save-quote")[0].listeners.click();
  await settle();
  assert.deepEqual(calls.find((c) => c[0] === "createQuote")[1], { sourceId: "src_q", text: "Invented passage.", page: null });
  assert.match(els["task-panel-sources-list"].textContent, /Quote saved to your notebook\./);
});

test("Your notebook: search by words and kind; an AI summary opens with its label and no Edit; his note can be edited", async () => {
  const { els, doc } = pageDoc();
  const { api, calls } = fakeApi({
    listNotebook: ok({ entries: [NOTE, PINNED] }),
    openItem: (t, id) => ok({ item: id === "note_s"
      ? { id, type: "summary", text: { value: "Invented AI summary in full.", author: "ai" } }
      : { id, type: "note", title: "Invented first thoughts", text: { value: "Invented note in full.", author: "learner" }, taskId: "t_inv1", quoteIds: [] } }),
    updateNote: ok({ entry: { id: "note_a" } }),
  });
  const notebook = createNotebook({ api, workerUrl: "https://invented-worker.example.dev", getTasks: () => [ITEM], doc });
  notebook.start("test-pass");
  notebook.setTutor("ready");
  els["notebook-q"].value = "invented coasts";
  els["notebook-kind"].value = "note";
  await notebook.show();
  assert.equal(calls.find((c) => c[0] === "listNotebook")[1], "?q=invented+coasts&type=note");
  assert.equal(els["notebook-status"].textContent, "2 entries");
  assert.equal(els["notebook-write"].hidden, false);
  const [noteItem, summaryItem] = els["notebook-list"].children;
  await byAction(summaryItem, "open")[0].listeners.click();
  await settle();
  const openSummary = els["notebook-list"].children[1];
  assert.match(openSummary.textContent, /Written by AI\. You can pin it to a task, but not copy it into your own notes\./);
  assert.equal(byAction(openSummary, "edit").length, 0);
  await byAction(noteItem, "open")[0].listeners.click();
  await settle();
  const openNote = els["notebook-list"].children[0];
  byAction(openNote, "edit")[0].listeners.click();
  await settle();
  const form = els["notebook-editor"].children[0];
  assert.equal(form.all((e) => e.tagName === "TEXTAREA")[0].value, "Invented note in full.");
  type(form.all((e) => e.tagName === "TEXTAREA")[0], "Invented better note.");
  await submit(form);
  await settle();
  assert.deepEqual(calls.find((c) => c[0] === "updateNote").slice(1), ["note_a", { title: "Invented first thoughts", text: "Invented better note.", taskId: "t_inv1", quoteIds: [] }]);
});

test("Your notebook while the tutor rests: titles from the snapshot, view-only, no Write a note", async () => {
  const { els, doc } = pageDoc();
  const { api, calls } = fakeApi({});
  globalThis.fetch = async (url) => {
    assert.match(String(url), /\/snapshot$/);
    return new Response(JSON.stringify({ notebook: [{ type: "notebook", id: "note_a", title: "Invented coasts", kind: "note", taskId: null, updatedAt: "2026-11-17" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const notebook = createNotebook({ api, workerUrl: "https://invented-worker.example.dev", doc });
  notebook.start("test-pass");
  await notebook.show();
  assert.equal(calls.length, 0, "no tutor calls while it rests");
  assert.equal(els["notebook-write"].hidden, true);
  assert.match(els["notebook-status"].textContent, /^The tutor is resting, so you can see titles only\..* 1 entry$/);
  assert.equal(els["notebook-list"].children.length, 1);
});

test("the page has the notebook view, its home button and the task panel's notes part, each control labelled", () => {
  const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
  assert.match(html, /<button type="button" id="go-notebook" class="big">Your notebook<\/button>/);
  for (const id of ["notebook-q", "notebook-kind", "notebook-task"]) assert.match(html, new RegExp(`<label for="${id}">`), id);
  assert.match(html, /<form id="notebook-search" class="notebook-search" role="search" novalidate>/);
  assert.match(html, /<details id="task-panel-notes" class="more" hidden>\s*<summary id="task-panel-notes-label">Your notes for this task<\/summary>/);
  for (const file of ["notebook.js", "notebook-parts.js", "task-notes.js"]) {
    const code = readFileSync(new URL(`../web/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(code, /innerHTML|insertAdjacentHTML|localStorage|sessionStorage|indexedDB|confirm\(/, file);
  }
  const shared = readFileSync(new URL("../web/shared/notebook.js", import.meta.url), "utf8").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(shared, /^import /m);
  assert.doesNotMatch(shared, /\b(document|window|localStorage)\b/);
});

test("WP-115c fix: Insert a quote is shown openly under the note box, not folded away (seen in the live check)", async () => {
  const { noteForm } = await import("../web/notebook-parts.js");
  const { doc } = pageDoc();
  const form = noteForm(doc, { key: "t", quotes: [{ id: "note_q", title: "Quote: Invented", excerpt: "Invented passage." }] });
  assert.equal(form.all((e) => e.tagName === "DETAILS").length, 0, "nothing to unfold");
  const group = form.all((e) => e.className === "insert-quote")[0];
  assert.equal(group.getAttribute("role"), "group");
  assert.match(group.textContent, /^Insert a quote/);
  assert.equal(byAction(group, "insert").length, 1);
});
