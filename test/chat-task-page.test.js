// WP-133 (A-013 §5): the chat page's task panel and task page (the classic panel, reused), the topic
// page (outline description, notes and summaries), and Attach a copy from a chat's source card.
// Invented data only. A tiny fake document stands in for the DOM.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { topicDescription, TOPIC_DESCRIPTION_MAX } from "../server/curriculum.js";
import { cleanMenu } from "../web/shared/menu.js";
import { notebookQuery } from "../web/shared/notebook.js";
import { createTopicNotes, TOPIC_TEXT } from "../web/chat-topic.js";
import { createSourceCards } from "../web/chat-sources.js";
import { SOURCE_MESSAGES, cardsFrom } from "../web/shared/conversation.js";

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
  click() { this.listeners.click?.(); }
  all(match) { const out = []; const walk = (el) => { for (const c of el.children) { if (match(c)) out.push(c); walk(c); } }; walk(this); return out; }
}
const doc = { createElement: (t) => new FakeElement(t), getElementById: () => null };
const ok = (body) => ({ kind: "ok", status: 200, body });
const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r)); };
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const action = (el, name) => el.all((c) => c.tagName === "BUTTON" && c.dataset.action === name)[0];

test("a topic's description comes from the outline's own words, joined and capped; none gives null", () => {
  const curriculum = { topics: new Map([
    ["inv-1", { record: { title: "Invented coasts", description: "  How invented   coasts change. " } }],
    ["inv-2", { record: { content: ["Invented waves", "invented cliffs"] } }],
    ["inv-3", { record: { summary: "x".repeat(900) } }],
    ["inv-4", { record: { title: "No words" } }],
  ]) };
  assert.equal(topicDescription(curriculum, "inv-1"), "How invented coasts change.");
  assert.equal(topicDescription(curriculum, "inv-2"), "Invented waves; invented cliffs");
  const long = topicDescription(curriculum, "inv-3");
  assert.equal(long.length, TOPIC_DESCRIPTION_MAX);
  assert.ok(long.endsWith("…"));
  assert.equal(topicDescription(curriculum, "inv-4"), null);
  assert.equal(topicDescription(curriculum, "missing"), null);
  assert.equal(topicDescription(null, "inv-1"), null);
  assert.match(read("server/domain/menu.js"), /description: topicDescription\(curriculum, id\)/, "the menu's topics carry it");
  const menu = cleanMenu({ menu: { topics: [{ id: "inv-1", title: "Invented coasts", qualId: "g", description: "How invented coasts change." }, { id: "inv-2", title: "x", description: 5 }] } });
  assert.deepEqual(menu.topics.map((t) => t.description), ["How invented coasts change.", null]);
  assert.equal(notebookQuery({ topicId: "inv-1" }), "?topicId=inv-1");
});

function topicSetup({ ready = true, list = ok({ entries: [
  { id: "nb_inv1", type: "note", title: "Invented groynes", excerpt: "Groynes trap invented sand…", author: "learner", taskId: "t_inv1", updatedAt: "2026-11-27T09:00:00Z" },
  { id: "nb_inv2", type: "summary", title: "Invented cliffs guide", excerpt: "Waves wear…", author: "ai", updatedAt: "2026-11-26T09:00:00Z" },
] }) } = {}) {
  const calls = [];
  const out = { signedOut: 0, unreachable: 0, changes: 0 };
  const api = {
    listNotebook: async (q) => { calls.push(["list", q]); return list; },
    openItem: async (kind, id) => { calls.push(["open", kind, id]); return ok({ item: { id, type: "note", text: { value: "The whole invented note.", author: "learner" } } }); },
  };
  const notes = createTopicNotes({
    doc, api, isReady: () => ready, onChange: () => { out.changes += 1; }, onSignedOut: () => { out.signedOut += 1; }, onUnreachable: () => { out.unreachable += 1; },
    taskTitle: (id) => (id === "t_inv1" ? "Invented coast essay" : null),
  });
  return { notes, calls, out };
}

test("the topic page lists his notes and summaries on the topic, named by task, and opens one", async () => {
  const { notes, calls } = topicSetup();
  assert.match(notes.render("inv-1").textContent, new RegExp(TOPIC_TEXT.loading));
  await notes.load("inv-1");
  assert.deepEqual(calls, [["list", "?topicId=inv-1"]]);
  const page = notes.render("inv-1");
  assert.match(page.textContent, /Your notes and summaries \(2\)/);
  assert.match(page.textContent, /Invented coast essay/, "the note names its task");
  assert.match(page.textContent, /AI summary/, "an AI summary is labelled in words");
  action(page, "open").click();
  await settle();
  assert.deepEqual(calls.at(-1), ["open", "notebook", "nb_inv1"]);
  assert.match(notes.render("inv-1").textContent, /The whole invented note\./);
});

test("the topic page waits for the tutor, says when there's nothing yet, and handles errors", async () => {
  const resting = topicSetup({ ready: false });
  await resting.notes.load("inv-1");
  assert.equal(resting.calls.length, 0);
  assert.match(resting.notes.render("inv-1").textContent, new RegExp(TOPIC_TEXT.waiting));
  const empty = topicSetup({ list: ok({ entries: [] }) });
  await empty.notes.load("inv-1");
  assert.match(empty.notes.render("inv-1").textContent, /Nothing saved on this topic yet/);
  const gone = topicSetup({ list: { kind: "network" } });
  await gone.notes.load("inv-1");
  assert.equal(gone.out.unreachable, 1);
  assert.match(gone.notes.render("inv-1").textContent, new RegExp(TOPIC_TEXT.failed));
  const auth = topicSetup({ list: { kind: "auth" } });
  await auth.notes.load("inv-1");
  assert.equal(auth.out.signedOut, 1);
});

test("Attach a copy: on a saved card in a chat about a task, it goes to that source in the task panel", async () => {
  const turn = { id: "turn_inv1", reply: "Two places to start.", sources: cardsFrom([{ title: "Invented cliffs guide", url: "https://example.org/cliffs", category: "introduction", why: "Covers cliffs." }]) };
  const seen = [];
  let onTask = true;
  const api = { saveSource: async () => ok({ source: { id: "src_inv0" } }) };
  const sources = createSourceCards({ doc, api, canAttach: () => onTask, onAttach: (card, sourceId) => seen.push([card.index, sourceId]) });
  assert.equal(action(sources.render(turn), "attach"), undefined, "not before the source is saved");
  action(sources.render(turn), "save").click();
  await settle();
  const attach = action(sources.render(turn), "attach");
  assert.equal(attach.textContent, SOURCE_MESSAGES.attachCopy);
  attach.click();
  assert.deepEqual(seen, [[0, "src_inv0"]]);
  onTask = false;
  assert.equal(action(sources.render(turn), "attach"), undefined, "not in a chat with no task");
});

test("the page has the classic task panel's parts, in a labelled panel the task button controls", () => {
  const chat = read("web/chat.html");
  const classic = read("web/index.html");
  const panelIds = [...classic.slice(classic.indexOf('id="task-panel"'), classic.indexOf('id="talk-routes"')).matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(panelIds.length > 20);
  for (const id of panelIds) assert.match(chat, new RegExp(`id="${id}"`), id);
  assert.match(chat, /<aside class="task-side" id="task-side" aria-label="This task" hidden>/);
  assert.match(chat, /id="task-chip" aria-controls="task-side" aria-expanded="false"/);
  assert.match(chat, /<button type="button" class="link-button" id="task-side-close">Back to the chat<\/button>/);
  const app = read("web/chat-app.js");
  assert.match(app, /const inCard = \(el\) => Boolean\(el\?\.closest\?\.\("\.chat-card, \.task-panel"\)\)/, "typing in the panel keeps the message box aside");
  assert.match(app, /if \(!\(nodes\.length === 1 && els\.view\.childNodes\.length === 1 && els\.view\.firstChild === nodes\[0\]\)\)/, "the task page isn't rebuilt under his typing");
  assert.doesNotMatch(app, /Sources, notes and your plan move onto this page/);
  const css = read("web/chat.css");
  assert.match(css, /\.shell\.panel-open \{\s*grid-template-columns: 17\.5rem minmax\(0, 1fr\) minmax\(20rem, 26rem\);/, "monitor: a third column");
  for (const file of ["web/chat-topic.js", "web/chat-app.js"]) assert.doesNotMatch(read(file), /innerHTML|\bconfirm\s*\(/, file);
});
