// WP-132b (A-013 §6): source cards in the chat page's tutor replies (Save, Summarise, Paste the text),
// the help-type menu, and no thumbs (A-014). Invented data only. A tiny fake document stands in for the DOM.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
const buttons = (el) => el.all((c) => c.tagName === "BUTTON");
const action = (el, name) => buttons(el).find((b) => b.dataset.action === name);

const TURN = {
  id: "turn_inv1",
  reply: "Here are two places to start.",
  sources: cardsFrom([
    { title: "Invented cliffs guide", url: "https://example.org/cliffs", category: "introduction", why: "Covers how waves wear cliffs." },
    { title: "Invented flood figures", url: "https://example.gov.uk/floods", category: "data", why: "Covers yearly floods." },
  ]),
};

function setup(answers = {}) {
  const calls = [];
  let changes = 0;
  let saved = 0;
  const api = {
    saveSource: async (b) => { calls.push(["save", b]); return answers.save ?? ok({ source: { id: `src_inv${b.index}` } }); },
    summariseSource: async (id, b) => { calls.push(["summarise", id, b ?? null]); return (b ? answers.paste : answers.summarise) ?? ok({ outcome: "saved", entry: { id: "nb_inv1", text: "An invented summary." } }); },
    openItem: async (kind, id) => { calls.push(["open", kind, id]); return ok({ item: { id, text: "An earlier invented summary." } }); },
  };
  const out = { signedOut: 0, unreachable: 0 };
  const sources = createSourceCards({
    doc, api, onChange: () => { changes += 1; }, onSaved: () => { saved += 1; },
    onSignedOut: () => { out.signedOut += 1; }, onUnreachable: () => { out.unreachable += 1; },
  });
  return { sources, calls, out, counts: () => ({ changes, saved }) };
}

test("a reply's sources show as cards with Save and Summarise; Save keeps the card's place in the reply", async () => {
  const { sources, calls, counts } = setup();
  const first = sources.render(TURN);
  assert.equal(first.all((c) => c.className.split(" ").includes("source-card")).length, 2);
  action(first, "save").click();
  await settle();
  assert.deepEqual(calls, [["save", { turnId: "turn_inv1", index: 0 }]]);
  const after = sources.render(TURN);
  assert.equal(action(after.children[1].children[0], "save"), undefined, "a saved card drops Save");
  assert.match(after.children[1].children[0].textContent, new RegExp(SOURCE_MESSAGES.saved));
  assert.ok(counts().saved >= 1, "the menu refreshes after a save");
  assert.equal(action(after.children[1].children[0], "attach"), undefined, "Attach a copy is on the task page (WP-133)");
});

test("Summarise saves first, then shows the AI summary; a source summarised before opens that summary", async () => {
  const fresh = setup();
  action(fresh.sources.render(TURN), "summarise").click();
  await settle();
  assert.deepEqual(fresh.calls.map((c) => c[0]), ["save", "summarise"]);
  assert.match(fresh.sources.render(TURN).textContent, /An invented summary\./);

  const before = setup({ save: ok({ source: { id: "src_old", summaryId: "nb_old" } }) });
  action(before.sources.render(TURN), "summarise").click();
  await settle();
  assert.deepEqual(before.calls.map((c) => c[0]), ["save", "open"]);
  assert.match(before.sources.render(TURN).textContent, /An earlier invented summary\./);
});

test("a page the tutor can't open offers Paste the text, which is sent once and summarised", async () => {
  const { sources, calls } = setup({
    summarise: ok({ outcome: "unavailable", message: "I couldn't open that page. You can paste its text instead." }),
    paste: ok({ outcome: "saved", entry: { id: "nb_inv2", text: "A summary of the pasted invented text." } }),
  });
  action(sources.render(TURN), "summarise").click();
  await settle();
  const offered = sources.render(TURN);
  assert.match(offered.textContent, /couldn't open that page/);
  const area = offered.all((c) => c.tagName === "TEXTAREA")[0];
  assert.ok(area, "a box to paste into");
  area.value = "Invented text copied from the page, long enough to summarise properly for the test.";
  action(offered, "paste").click();
  await settle();
  assert.deepEqual(calls.at(-1), ["summarise", "src_inv0", { text: area.value }]);
  assert.match(sources.render(TURN).textContent, /A summary of the pasted invented text\./);
});

test("errors: signed out goes to sign-in, an unreachable tutor is woken, others show a message", async () => {
  const auth = setup({ save: { kind: "auth" } });
  action(auth.sources.render(TURN), "save").click();
  await settle();
  assert.equal(auth.out.signedOut, 1);
  const gone = setup({ save: { kind: "network" } });
  action(gone.sources.render(TURN), "save").click();
  await settle();
  assert.equal(gone.out.unreachable, 1);
  assert.ok(action(gone.sources.render(TURN), "save"), "Save is offered again");
});

test("leaving the chat forgets the cards, and a late answer doesn't come back", async () => {
  const { sources } = setup();
  action(sources.render(TURN), "save").click();
  sources.clear();
  await settle();
  assert.ok(action(sources.render(TURN), "save"), "the card is fresh");
});

test("the help chip is a menu of the kinds of help, and the page has no thumbs (A-014)", () => {
  const html = read("web/chat.html");
  assert.match(html, /<button type="button" class="type-chip" id="type-chip" aria-haspopup="menu" aria-expanded="false" aria-controls="help-menu">/);
  for (const [kind, label] of [["auto", "Help: automatic"], ["research", "Understand and research it"], ["plan", "Plan my answer"], ["review", "Review my work"], ["learn", "Learn something"]]) {
    assert.match(html, new RegExp(`role="menuitemradio" aria-checked="(true|false)" data-help="${kind}">${label}<`), kind);
  }
  const app = read("web/chat-app.js");
  assert.match(app, /if \(pendingRoute\) return pendingRoute;\n    if \(view\.kind === "task"\)/, "a chosen kind wins over the task's stage");
  assert.match(app, /if \(taskId\) \{ conv = null; side\.setFocus\(\{ kind: "task", id: taskId \}\); show\(\{ kind: "task", id: taskId \}\); \} else newChat\(\);/, "another kind starts a new chat on the same task");
  for (const file of ["web/chat.html", "web/chat-app.js", "web/chat-sources.js", "web/chat-cards.js"]) {
    assert.doesNotMatch(read(file), /thumb|rateTurn|helpful/i, file);
    assert.doesNotMatch(read(file), /innerHTML|\bconfirm\s*\(/, file);
  }
});
