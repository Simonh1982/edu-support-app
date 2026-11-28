// WP-131b (A-013 §1–§4): the chat-first page's shell: the side menu's rules (subjects, sections,
// focus level), the menu itself on a fake page, and the new page's markup. Invented data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, cpSync, rmSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MENU_SHOW, MENU_TEXT, cleanMenu, menuLists, focusLists, dueLabel, whenLabel, statusOf } from "../web/shared/menu.js";
import { createSideMenu } from "../web/side-menu.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const WEB = path.join(ROOT, "web");
const NOW = new Date("2026-11-27T12:00:00Z");
const MENU = cleanMenu({ menu: {
  subjects: [{ id: "g", label: "Invented Geography" }, { id: "h", label: "Invented History" }],
  chats: [
    { id: "c1", name: "Invented coast – plan", route: "plan", taskId: "t1", topicIds: ["p1"], qualId: "g", updatedAt: "2026-11-27T09:00:00Z" },
    { id: "c2", name: "Invented coast – research", route: "research", taskId: "t1", topicIds: ["p1"], qualId: "g", updatedAt: "2026-11-26T09:00:00Z" },
    { id: "c3", name: "Invented drift explained", route: "learn", taskId: null, topicIds: ["p2"], qualId: "g", updatedAt: "2026-11-25T09:00:00Z", renamable: true },
    { id: "c4", name: "Invented treaty chat", route: "learn", taskId: null, topicIds: [], qualId: "h", updatedAt: "2026-11-20T09:00:00Z", renamable: true },
    { bad: true },
  ],
  tasks: [
    { id: "t1", title: "Invented coast essay", qualId: "g", subject: "Invented Geography", deadline: "2026-11-29", stage: "planning", topicIds: ["p1"] },
    { id: "t2", title: "Invented war essay", qualId: "h", deadline: "2026-12-10", stage: "not-started", topicIds: [] },
    { id: "t3", title: "Invented river notes", qualId: "g", deadline: "2026-12-02", stage: "researching", topicIds: ["p2"] },
    { id: "t4", title: "Invented map task", qualId: "g", deadline: "2026-12-20", stage: "drafting", topicIds: [] },
    { id: "t5", title: "Invented old worksheet", qualId: "g", deadline: "2026-11-01", stage: "done", topicIds: [] },
  ],
  topics: [{ id: "p1", title: "Invented coasts", qualId: "g", lastWorked: "2026-11-27T09:00:00Z" }, { id: "p2", title: "Invented processes", qualId: "g", lastWorked: "2026-11-25T09:00:00Z" }],
} });

test("menu rules: subject filter, search, open and done tasks, and each focus level", () => {
  assert.equal(MENU.chats.length, 4, "bad entries dropped");
  const all = menuLists(MENU);
  assert.deepEqual(all.chats.map((c) => c.id), ["c1", "c2", "c3", "c4"]);
  assert.deepEqual(all.open.map((t) => t.id), ["t1", "t3", "t2", "t4"], "soonest due first");
  assert.deepEqual(all.done.map((t) => t.id), ["t5"]);
  const history = menuLists(MENU, { subject: "h" });
  assert.deepEqual([history.chats.map((c) => c.id), history.open.map((t) => t.id), history.topics.length], [["c4"], ["t2"], 0]);
  assert.deepEqual(menuLists(MENU, { search: "COAST plan" }).chats.map((c) => c.id), ["c1"]);
  const chat = focusLists(MENU, { kind: "chat", id: "c1" });
  assert.deepEqual([chat.task.id, chat.topics.map((t) => t.id)], ["t1", ["p1"]]);
  const task = focusLists(MENU, { kind: "task", id: "t1" });
  assert.deepEqual(task.chats.map((c) => c.id), ["c1", "c2"]);
  const topic = focusLists(MENU, { kind: "topic", id: "p2" });
  assert.deepEqual([topic.chats.map((c) => c.id), topic.tasks.map((t) => t.id)], [["c3"], ["t3"]]);
});

test("labels in UK time: when a chat was used, when a task is due, and the tutor's dot", () => {
  assert.equal(whenLabel("2026-11-27T08:00:00Z", NOW), "Today");
  assert.equal(whenLabel("2026-11-26T08:00:00Z", NOW), "Yesterday");
  assert.equal(whenLabel("2026-11-01T08:00:00Z", NOW), "1 Nov");
  assert.deepEqual(dueLabel("2026-11-29", NOW), { text: "due Sunday", soon: true });
  assert.deepEqual(dueLabel("2026-11-28", NOW), { text: "due tomorrow", soon: true });
  assert.deepEqual(dueLabel("2026-12-20", NOW), { text: "due 20 Dec", soon: false });
  assert.equal(dueLabel(null, NOW).text, "no due date");
  assert.deepEqual([statusOf("ready").word, statusOf("offline").word, statusOf("anything").word], ["Ready", "Resting", "Waking"]);
});

class FakeElement {
  constructor(tag) {
    Object.assign(this, { tagName: tag.toUpperCase(), children: [], attributes: {}, dataset: {}, listeners: {}, className: "", value: "", ownText: "" });
    this.classList = { add: (c) => { this.className = `${this.className} ${c}`.trim(); }, contains: (c) => this.className.split(" ").includes(c) };
  }
  set textContent(v) { this.ownText = String(v); this.children = []; }
  get textContent() { return this.ownText + this.children.map((c) => c.textContent).join(""); }
  setAttribute(n, v) { this.attributes[n] = String(v); }
  getAttribute(n) { return this.attributes[n] ?? null; }
  append(...n) { this.children.push(...n); }
  replaceChildren(...n) { this.children = [...n]; }
  addEventListener(t, fn) { this.listeners[t] = fn; }
  focus() {}
  all(match) { const out = []; const walk = (el) => { for (const c of el.children) { if (match(c)) out.push(c); walk(c); } }; walk(this); return out; }
  querySelector(sel) { const cls = sel.startsWith(".") ? sel.slice(1) : null; return cls ? this.all((e) => e.className.split(" ").includes(cls))[0] ?? null : null; }
}

function menuOnPage() {
  const doc = { createElement: (t) => new FakeElement(t), activeElement: null, querySelector: () => null };
  const root = new FakeElement("nav");
  const opened = [];
  const side = createSideMenu({ doc, root, onOpen: (kind, id) => opened.push([kind, id]), now: () => NOW });
  side.setMenu(MENU);
  const items = (kind) => root.all((e) => e.dataset.kind === kind).map((e) => e.dataset.id);
  const head = (key) => root.all((e) => e.dataset.section === key)[0];
  return { root, side, opened, items, head };
}

test("the side menu opens on All: 3 chats, 3 tasks, Done and Topics closed, labelled sections", () => {
  const { root, items, head } = menuOnPage();
  const subjects = root.all((e) => e.className === "menu-subject");
  assert.deepEqual(subjects.map((s) => [s.textContent, s.getAttribute("aria-pressed")]), [["All", "true"], ["Invented Geography", "false"], ["Invented History", "false"]]);
  assert.deepEqual(items("chat"), ["c1", "c2", "c3"]);
  assert.deepEqual(items("task"), ["t1", "t3", "t2"]);
  assert.deepEqual(items("topic"), [], "topics closed");
  assert.equal(head("tasks").getAttribute("aria-expanded"), "false");
  assert.equal(head("done"), undefined, "Done only once the task list is open");
  assert.match(root.textContent, new RegExp(MENU_TEXT.showAll(4)));
  assert.equal(MENU_SHOW, 3);
  assert.deepEqual(root.all((e) => e.dataset.foot).map((e) => e.dataset.foot), ["notebook", "files", "settings", "sign-out"]);
});

test("the side menu: arrows open lists, a subject filters, and a choice shows its focus level with a way back", () => {
  const { root, side, opened, items, head } = menuOnPage();
  head("tasks").listeners.click();
  assert.deepEqual(items("task"), ["t1", "t3", "t2", "t4"]);
  head("done").listeners.click();
  assert.ok(items("task").includes("t5"), "Done opens");
  head("topics").listeners.click();
  assert.deepEqual(items("topic"), ["p1", "p2"]);
  root.all((e) => e.textContent === "Invented History" && e.className === "menu-subject")[0].listeners.click();
  assert.deepEqual([items("chat"), side.state().subject], [["c4"], "h"]);
  root.all((e) => e.dataset.id === "c4")[0].listeners.click();
  assert.deepEqual(opened, [["chat", "c4"]]);
  side.setFocus({ kind: "task", id: "t1" });
  assert.match(root.textContent, /All tasks/);
  assert.deepEqual(items("chat"), ["c1", "c2"]);
  root.all((e) => e.className === "menu-back")[0].listeners.click();
  assert.equal(side.state().focus, null);
});

test("the new page: labelled controls, the status dot, a sign-out dialog, and a way back to sign in", () => {
  const html = readFileSync(path.join(WEB, "index.html"), "utf8");
  assert.match(html, /<html lang="en-GB">/);
  assert.match(html, /<link rel="stylesheet" href="app.css">\s*<link rel="stylesheet" href="chat.css">/, "the learner's accessibility settings apply");
  assert.match(html, /<nav class="side" id="side" aria-label="Your chats, tasks and topics">/);
  assert.match(html, /id="menu-open" aria-controls="side" aria-expanded="false" aria-label="Open the menu"/);
  assert.match(html, /<label for="message" class="visually-hidden">Your message<\/label>/);
  assert.match(html, /<p class="tutor-dot" id="tutor-dot" role="status"/);
  assert.match(html, /<dialog id="sign-out-dialog"/);
  // WP-134a: this is the main page now, with sign-in; the old chat.html address forwards here
  assert.match(html, /<section class="signed-out" id="sign-in-screen" aria-labelledby="sign-in-heading" hidden>/);
  assert.match(html, /<form id="sign-in-form" novalidate>/);
  assert.match(html, /<script type="module" src="chat-app.js"><\/script>/);
  assert.doesNotMatch(html, /src="app\.js"|id="home-screen"|id="view-upcoming"|id="talk-support"/, "the classic screens are gone");
  assert.match(readFileSync(path.join(WEB, "chat.html"), "utf8"), /<meta http-equiv="refresh" content="0; url=\.\/">/);
  for (const file of ["chat-app.js", "side-menu.js"]) {
    assert.doesNotMatch(readFileSync(path.join(WEB, file), "utf8"), /innerHTML|insertAdjacentHTML|confirm\(|indexedDB\.open|localStorage\./, file);
  }
  assert.match(readFileSync(path.join(WEB, "chat-app.js"), "utf8"), /win\.indexedDB\?\.deleteDatabase\?\.\(OLD_DEVICE_DB\)/, "the classic page's saved view is removed on sign-out");
  const shared = readFileSync(path.join(WEB, "shared", "menu.js"), "utf8").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(shared, /^import /m);
  assert.doesNotMatch(shared, /\b(document|window|localStorage)\b/);
});

test("deploy stamping covers the new page", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wp131b-stamp-"));
  try {
    cpSync(WEB, path.join(dir, "web"), { recursive: true });
    execFileSync("bash", [path.join(ROOT, "scripts", "stamp-versions.sh"), path.join(dir, "web"), "abc12345"], { stdio: "pipe" });
    const html = readFileSync(path.join(dir, "web", "index.html"), "utf8");
    assert.match(html, /src="chat-app\.js\?v=abc12345"/);
    assert.match(html, /href="chat\.css\?v=abc12345"/);
    assert.match(readFileSync(path.join(dir, "web", "chat-app.js"), "utf8"), /from "\.\/side-menu\.js\?v=abc12345"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("WP-134a: sign-in, Try again and the pages from the menu's foot live on the chat page", () => {
  const app = readFileSync(path.join(WEB, "chat-app.js"), "utf8");
  assert.match(app, /const fragment = readFragment\(win\.location\?\.hash \?\? ""\);/, "the pass is read from the address after GitHub");
  assert.match(app, /win\.history\?\.replaceState\?\.\(null, "", win\.location\.pathname \+ win\.location\.search\);/, "and taken out of it straight away");
  assert.match(app, /const checked = checkNewPass\(fragment\.pass, ROLE\);/);
  assert.match(app, /const target = loginUrl\(config\.workerUrl, els\.signInShared\.checked\);/);
  assert.match(app, /if \(RETRY_STATES\.has\(result\.state\)\) \{\s*els\.wakeRetry\.hidden = false;/);
  assert.match(app, /if \(view\.kind === "notebook"\) return \[els\.notebookPage\];/);
  assert.match(app, /if \(view\.kind === "files"\) return \[els\.filesPage\];/);
  assert.match(app, /onCheck: \(uploadId\) => \{ newChat\(\); cards\.addUpload\(uploadId\); \}/);
  assert.match(app, /showSignIn\("signed-out", \{ focus: true \}\);/);
  assert.doesNotMatch(app, /Open the classic page|on the classic page/, "nothing points to the retired page");
  for (const gone of ["app.js", "home.js", "upcoming.js", "check.js", "conversation.js", "device-store.js", path.join("shared", "offline.js"), path.join("shared", "recommend.js")]) {
    assert.equal(existsSync(path.join(WEB, gone)), false, gone);
  }
});
