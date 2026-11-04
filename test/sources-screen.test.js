// WP-114b: source cards under research replies, Save, Summarise and the AI summary card.
// Invented data only. A tiny fake document stands in for the DOM.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SOURCE_CARDS,
  SOURCE_CATEGORIES,
  SOURCE_LABELS,
  SOURCE_MESSAGES,
  SUMMARY_TIMEOUT_MS,
  TALK_MESSAGES,
  cardKey,
  cardsFrom,
  safeLink,
  siteOf,
  sourceErrorMessage,
  sourceLabel,
  summaryFromEntry,
  summaryFromResult,
  supportLabel,
  turnFromReply,
  turnsFromServer,
} from "../web/shared/conversation.js";
import { createApi } from "../web/shared/api.js";
import { sourceList } from "../web/conversation.js";
import * as serverSources from "../server/ai/sources.js";

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
    this.ownText = "";
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
  addEventListener(type, fn) {
    this.listeners[type] = fn;
  }
  click() {
    this.listeners.click?.();
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

const CARDS = [
  { title: "Invented coasts introduction", url: "https://example.org/coasts", publisher: "Invented Society", category: "introduction", why: { value: "Covers how waves erode cliffs.", author: "ai" } },
  { title: "Bad link", url: "javascript:alert(1)", category: "other", why: "x" },
  { title: "Invented flood data", url: "https://www.example.gov.uk/data", category: "data", why: "Covers yearly flood figures." },
  { title: "Hidden login", url: "https://user:pass@example.net/", category: "other", why: "x" },
  { title: "", url: "https://example.com/no-title", category: "other", why: "x" },
];

// ---------- copies and labels ----------

test("the screen's source copies match the server", () => {
  assert.deepEqual([...SOURCE_CATEGORIES], [...serverSources.SOURCE_CATEGORIES]);
  assert.equal(SOURCE_CARDS, serverSources.SOURCE_LIMITS.cards);
  for (const category of SOURCE_CATEGORIES) assert.ok(SOURCE_LABELS[category], category);
  assert.equal(sourceLabel("academic"), "More challenging reading");
  assert.equal(sourceLabel("made-up"), "Source");
});

test("the research route shows its own support labels (build spec §23.1)", () => {
  assert.equal(supportLabel("research", "hint"), "Give me a search hint");
  assert.equal(supportLabel("research", "pointer"), "Show me a useful source");
  assert.equal(supportLabel("plan", "hint"), "Give me a hint");
});

test("the summary wait covers the server's worst case: two summaries and two checks", async () => {
  const { CHECK_TIMEOUT_MS } = await import("../server/ai/check.js");
  assert.ok(SUMMARY_TIMEOUT_MS >= 2 * serverSources.SUMMARY_TIMEOUT_MS + 2 * CHECK_TIMEOUT_MS);
});

// ---------- cleaning cards ----------

test("cardsFrom keeps safe http(s) links with titles, and each card keeps its server position", () => {
  const cards = cardsFrom(CARDS);
  assert.deepEqual(cards.map((c) => c.index), [0, 2]);
  assert.deepEqual(cards[0], {
    index: 0, title: "Invented coasts introduction", url: "https://example.org/coasts", site: "example.org",
    publisher: "Invented Society", category: "introduction", why: "Covers how waves erode cliffs.",
  });
  assert.equal(cards[1].site, "example.gov.uk");
  assert.equal(cards[1].publisher, null);
  assert.deepEqual(cardsFrom(null), []);
  assert.equal(cardsFrom(Array.from({ length: 9 }, (_, i) => ({ title: `T${i}`, url: `https://e.org/${i}` }))).length, SOURCE_CARDS);
  assert.equal(cardsFrom([{ title: "x", url: "https://e.org/", category: "nonsense" }])[0].category, "other");
});

test("safeLink and siteOf", () => {
  assert.equal(safeLink("https://example.org/a b"), "https://example.org/a%20b");
  for (const bad of ["javascript:alert(1)", "data:text/html,x", "ftp://example.org/", "https://u:p@example.org/", "", null, "not a url"]) {
    assert.equal(safeLink(bad), null, String(bad));
  }
  assert.equal(siteOf("https://www.Example.org/x"), "example.org");
  assert.equal(siteOf("nonsense"), "");
});

test("turns carry their cards, from a reply and from a reopened conversation", () => {
  const turn = turnFromReply({ id: "turn_s1", action: "attempt", reply: "Invented reply", sources: CARDS }, { learnerText: "my go" });
  assert.deepEqual(turn.sources.map((c) => c.index), [0, 2]);
  const [reopened] = turnsFromServer({ turns: [{ id: "turn_s2", action: "message", reply: "Invented", sources: CARDS.slice(0, 1) }] });
  assert.equal(reopened.sources.length, 1);
  assert.deepEqual(turnFromReply({ id: "turn_s3", reply: "x" }).sources, []);
  assert.equal(cardKey("turn_s1", 2), "turn_s1:2");
});

// ---------- summaries and errors ----------

test("a saved summary becomes an AI summary card; other outcomes show the server's message", () => {
  const entry = {
    id: "note_1", type: "summary", text: { value: "Invented summary text.", author: "ai" },
    section: { value: "Section 2", author: "ai" }, source: { title: "Invented", author: null, url: "https://example.org/coasts" },
  };
  assert.deepEqual(summaryFromResult({ outcome: "saved", entry, checkResult: "passed" }), {
    kind: "summary", id: "note_1", text: "Invented summary text.", section: "Section 2", url: "https://example.org/coasts",
  });
  for (const outcome of ["read-original", "unavailable", "too-close"]) {
    const shown = summaryFromResult({ outcome, message: `Invented ${outcome} message.`, entry: null });
    assert.deepEqual(shown, { kind: "message", text: `Invented ${outcome} message.`, outcome }, outcome);
  }
  assert.equal(summaryFromResult({ outcome: "saved", entry: { text: { value: "  " } } }).text, SOURCE_MESSAGES.failed);
  assert.equal(summaryFromResult({ message: "x".repeat(401) }).text, SOURCE_MESSAGES.failed);
  assert.equal(summaryFromEntry({ text: "Plain text form." }, { url: "https://example.org/fallback" }).url, "https://example.org/fallback");
  assert.equal(summaryFromEntry({ text: "x", source: { url: "javascript:alert(1)" } }).url, null);
});

test("save and summary errors: the server's own words for 400, 404, 409 and 429; fixed wording otherwise", () => {
  const said = "That source isn't available to save any more.";
  assert.deepEqual(sourceErrorMessage({ kind: "http", status: 404, body: { error: said } }), { message: said });
  assert.equal(sourceErrorMessage({ kind: "http", status: 502, body: { error: "upstream detail" } }).message, SOURCE_MESSAGES.failed);
  assert.match(sourceErrorMessage({ kind: "http", status: 503, body: {} }).message, /isn't quite ready/);
  assert.deepEqual(sourceErrorMessage({ kind: "network" }), { message: TALK_MESSAGES.unreachable, unreachable: true });
});

// ---------- the API calls ----------

test("save, summarise and open go to the WP-114a routes with the pass; the summary waits longer", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: url.slice(BACKEND.length), method: init.method, body: init.body ? JSON.parse(init.body) : undefined, auth: init.headers.Authorization });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const api = createApi({ getBackendUrl: () => BACKEND, getToken: () => "test-pass", fetchImpl });
  await api.saveSource({ turnId: "turn_1", index: 2 });
  await api.summariseSource("src_1");
  await api.openItem("notebook", "note_1");
  assert.deepEqual(calls.map((c) => [c.method, c.url, c.body]), [
    ["POST", "/api/sources", { turnId: "turn_1", index: 2 }],
    ["POST", "/api/sources/src_1/summary", {}],
    ["GET", "/api/item?type=notebook&id=note_1", undefined],
  ]);
  assert.ok(calls.every((c) => c.auth === "Bearer test-pass"));

  const slow = (url, init) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(new Response("{}", { status: 200 })), 60);
    init.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("timed out", "TimeoutError")); });
  });
  const timed = createApi({ getBackendUrl: () => BACKEND, getToken: () => "t", fetchImpl: slow, timeoutMs: 15, summaryTimeoutMs: 2000 });
  assert.equal((await timed.summariseSource("src_1")).kind, "ok");
  assert.equal((await timed.saveSource({ turnId: "turn_1", index: 0 })).kind, "network", "saving keeps the usual wait");
});

// ---------- the cards on screen ----------

const TURN = turnFromReply({ id: "turn_9", action: "attempt", reply: "Invented reply", sources: CARDS });

test("cards show the kind, a new-tab link, the site and what it covers, with Save and Summarise", () => {
  const section = sourceList(doc, TURN, { ready: true });
  assert.equal(section.tagName, "SECTION");
  assert.equal(section.getAttribute("aria-labelledby"), "sources-turn_9");
  const cards = byClass(section, "source-card");
  assert.equal(cards.length, 2);
  assert.equal(cards[0].getAttribute("id"), "source-turn_9-0");
  assert.equal(byClass(cards[0], "source-kind")[0].textContent, "Quick introduction");
  const [link] = byTag(cards[0], "a");
  assert.equal(link.getAttribute("href"), "https://example.org/coasts");
  assert.equal(link.getAttribute("target"), "_blank");
  assert.equal(link.getAttribute("rel"), "noopener noreferrer");
  assert.match(link.textContent, /Invented coasts introduction \(opens in a new tab\)/);
  assert.equal(byClass(cards[0], "source-site")[0].textContent, "Invented Society · example.org");
  assert.equal(byClass(cards[0], "source-why")[0].textContent, "What it covers: Covers how waves erode cliffs.");
  const buttons = byTag(cards[0], "button");
  assert.deepEqual(buttons.map((b) => [b.textContent, b.dataset.action, b.disabled]), [
    [SOURCE_MESSAGES.save, "save", false], [SOURCE_MESSAGES.summarise, "summarise", false],
  ]);
});

test("tapping Save or Summarise passes the card, with its server position", () => {
  const seen = [];
  const section = sourceList(doc, TURN, { onSave: (c) => seen.push(["save", c.index]), onSummarise: (c) => seen.push(["sum", c.index]) });
  const cards = byClass(section, "source-card");
  byTag(cards[1], "button")[0].click();
  byTag(cards[1], "button")[1].click();
  assert.deepEqual(seen, [["save", 2], ["sum", 2]]);
});

test("buttons wait for the tutor and while working; saved and summarised cards drop their buttons", () => {
  const notReady = sourceList(doc, TURN, { ready: false });
  assert.ok(byTag(notReady, "button").every((b) => b.disabled));
  const states = {
    0: { sourceId: "src_1", note: SOURCE_MESSAGES.saved },
    2: { sourceId: "src_2", summary: { kind: "summary", id: "note_1", text: "Invented summary.", section: "Part 3", url: "https://example.gov.uk/data" } },
  };
  const section = sourceList(doc, TURN, { stateOf: (i) => states[i] });
  const [first, second] = byClass(section, "source-card");
  assert.deepEqual(byTag(first, "button").map((b) => b.dataset.action), ["summarise"]);
  assert.equal(byClass(first, "source-note")[0].textContent, SOURCE_MESSAGES.saved);
  assert.equal(byTag(second, "button").length, 0);
  const busy = sourceList(doc, TURN, { stateOf: (i) => (i === 0 ? { saving: true } : {}) });
  const busyButtons = byTag(byClass(busy, "source-card")[0], "button");
  assert.equal(busyButtons[0].textContent, SOURCE_MESSAGES.saving);
  assert.ok(busyButtons.every((b) => b.disabled));
  const asked = sourceList(doc, TURN, { stateOf: () => ({ asked: true, note: "Invented read-the-original message." }) });
  assert.deepEqual(byTag(byClass(asked, "source-card")[0], "button").map((b) => b.dataset.action), ["save"]);
});

test("the AI summary card says 'AI summary' in words and links to the original", () => {
  const states = { 0: { summary: { kind: "summary", id: "note_1", text: "Invented summary.", section: "Part 3", url: "https://example.org/coasts" } } };
  const section = sourceList(doc, TURN, { stateOf: (i) => states[i] });
  const [card] = byClass(section, "ai-summary");
  assert.equal(card.getAttribute("id"), "summary-turn_9-0");
  assert.equal(card.getAttribute("aria-labelledby"), "summary-label-turn_9-0");
  assert.equal(byClass(card, "ai-summary-label")[0].textContent, "AI summary");
  assert.equal(byClass(card, "ai-summary-text")[0].textContent, "Invented summary.");
  assert.match(card.textContent, /Most useful part: Part 3/);
  assert.match(card.textContent, /Read the original/);
  assert.equal(byTag(card, "a")[0].getAttribute("href"), "https://example.org/coasts");
});

test("no cards: nothing is shown, including beside a reply that wasn't kept", () => {
  assert.equal(sourceList(doc, turnFromReply({ id: "t1", reply: "x" })), null);
  assert.equal(sourceList(doc, { id: "t2", reply: null, sources: cardsFrom(CARDS) }), null);
  assert.equal(sourceList(doc, null), null);
});

// ---------- page rules ----------

test("the page wires the cards and keeps to the page rules", () => {
  const page = read("web/conversation.js");
  assert.match(page, /const sources = sourceList\(doc, turn,/);
  assert.match(page, /cards\.clear\(\)/, "signing out forgets the cards");
  assert.match(page, /api\.saveSource\(\{ turnId, index: card\.index \}\)/);
  assert.match(page, /api\.summariseSource\(saved\.sourceId\)/);
  assert.match(page, /api\.openItem\("notebook", saved\.summaryId\)/, "a summary made before is shown again, not made twice");
  assert.doesNotMatch(page, /innerHTML|insertAdjacentHTML|localStorage|sessionStorage|indexedDB/);
  const shared = read("web/shared/conversation.js");
  assert.doesNotMatch(shared, /^import /m);
});

test("the AI summary card is tinted and labelled in text, with large tap targets on links", () => {
  const css = read("web/app.css");
  assert.match(css, /\.ai-summary\s*\{[^}]*background: color-mix\(in srgb, var\(--accent\) 10%, var\(--bg\)\);/);
  assert.match(css, /\.ai-summary-label\s*\{[^}]*background: var\(--accent\);[^}]*color: var\(--accent-fg\);/);
  assert.match(css, /\.source-title a,\s*\.ai-summary a\s*\{[^}]*min-height: var\(--tap\)/);
});
