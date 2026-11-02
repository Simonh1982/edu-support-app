// WP-111b: "Get help with a task", the conversation screen, the Back button and the tutor status panel.
// Invented data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  ATTEMPT_PROMPTS,
  CONVERSATION_TIMEOUT_MS,
  FIRST_PAIR,
  MESSAGE_MAX_CHARS,
  ROUTE_BY_STAGE,
  ROUTE_LABELS,
  SUPPORT_LABELS,
  SUPPORT_TYPES,
  TALK_MESSAGES,
  VOTES,
  WORK_ROUTES,
  canEscape,
  checkMessage,
  learnerLine,
  nextVote,
  promptFor,
  routeChoices,
  routeForStage,
  shownVote,
  supportHeading,
  supportLabel,
  talkErrorMessage,
  taskChoices,
  turnFromReply,
  turnsFromServer,
} from "../web/shared/conversation.js";
import { API_TIMEOUT_MS, createApi } from "../web/shared/api.js";
import { TUTOR_PANELS, WAKE_MESSAGES, tutorPanel } from "../web/shared/wake.js";
import * as serverRoute from "../server/derived/route.js";
import * as serverWork from "../server/domain/work.js";
import * as serverConversations from "../server/domain/conversations.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const WEB = join(ROOT, "web");
const BACKEND = "https://example-codespace-3000.app.github.dev";
const read = (...parts) => readFileSync(join(WEB, ...parts), "utf8");

// ---------- copies of server values ----------

test("the screen's copies match the server", () => {
  assert.deepEqual([...WORK_ROUTES], [...serverRoute.WORK_ROUTES]);
  assert.deepEqual({ ...ROUTE_BY_STAGE }, { ...serverRoute.ROUTE_BY_STAGE });
  assert.deepEqual([...SUPPORT_TYPES], [...serverWork.SUPPORT_TYPES]);
  assert.equal(MESSAGE_MAX_CHARS, serverWork.WORK_LIMITS.attemptText);
  assert.deepEqual([...FIRST_PAIR], [...serverConversations.FIRST_PAIR]);
  assert.deepEqual([...VOTES], [...serverConversations.VOTES]);
  const html = read("index.html");
  for (const id of ["talk-text", "help-other-text"]) {
    assert.match(html, new RegExp(`id="${id}"[^>]*maxlength="${MESSAGE_MAX_CHARS}"`), id);
  }
});

// ---------- routes and tasks ----------

test("a task's stage suggests its route, and the others follow in order", () => {
  assert.equal(routeForStage("not-started"), "research");
  assert.equal(routeForStage("planning"), "plan");
  assert.equal(routeForStage("drafting"), "review");
  assert.equal(routeForStage("made-up"), "research");
  assert.deepEqual(routeChoices("plan"), ["plan", "research", "review"]);
  assert.deepEqual(routeChoices("learn"), ["research", "plan", "review"]);
  for (const route of WORK_ROUTES) {
    assert.ok(ROUTE_LABELS[route] && ATTEMPT_PROMPTS[route], route);
  }
});

test("taskChoices: soonest first, no deadline last, queued and finished tasks left out", () => {
  const items = [
    { taskId: "t-later", title: "Invented later", deadline: "2026-11-20", stage: "planning" },
    { taskId: "t-none", title: "Invented undated", deadline: null, stage: "not-started" },
    { taskId: "t-soon", title: "Invented soon", deadline: "2026-11-04", stage: "drafting" },
    { taskId: "e0000001a", title: "Invented queued", deadline: "2026-11-03", stage: "not-started", queued: true },
    { taskId: "t-in", title: "Invented handed in", deadline: "2026-11-03", stage: "submitted" },
    { taskId: "t-done", title: "Invented done", deadline: "2026-11-03", stage: "done" },
    { title: "no id" },
    null,
  ];
  const choices = taskChoices(items, { dueOf: (d) => (d ? `Due ${d}` : "") });
  assert.deepEqual(choices.map((c) => c.taskId), ["t-soon", "t-later", "t-none"]);
  assert.deepEqual(choices[0], { taskId: "t-soon", title: "Invented soon", route: "review", due: "Due 2026-11-04" });
  assert.equal(choices[2].due, "");
  assert.deepEqual(taskChoices(null), []);
});

// ---------- support pairs and prompts ----------

test("support buttons use the route's wording, keeping the four types", () => {
  assert.equal(supportLabel("research", "hint"), "Give me a search hint");
  assert.equal(supportLabel("review", "explanation"), "Explain the feedback");
  assert.equal(supportLabel("plan", "breakdown"), "Help me break it down");
  assert.equal(supportLabel("plan", "explanation"), "Explain the difficult bit");
  for (const set of Object.values(SUPPORT_LABELS)) assert.deepEqual(Object.keys(set), [...SUPPORT_TYPES]);
});

test("pair headings: first pair, second pair, and Break it down only after the escape", () => {
  assert.equal(supportHeading(["hint", "breakdown"]), "Need some help?");
  assert.equal(supportHeading(["pointer", "explanation"]), "Still stuck?");
  assert.equal(supportHeading(["breakdown"]), "Let's break it down");
  assert.equal(supportHeading([]), "");
  assert.equal(supportHeading(undefined), "");
});

test("the writing box asks for the route's attempt, then a fresh try after help, then a reply", () => {
  assert.equal(promptFor(null, "plan").label, ATTEMPT_PROMPTS.plan);
  assert.equal(promptFor({ needsAttempt: true }, "research").label, ATTEMPT_PROMPTS.research);
  assert.equal(promptFor({ needsAttempt: true }, "research", { asked: true }).label, TALK_MESSAGES.tryAgain);
  assert.equal(promptFor({ needsAttempt: false }, "review", { asked: true }).label, TALK_MESSAGES.reply);
  assert.equal(canEscape(null), true, "offered before the conversation starts");
  assert.equal(canEscape({ canEscape: true }), true);
  assert.equal(canEscape({ canEscape: false }), false);
});

test("checkMessage accepts anything written, however rough, and refuses empty or over-long text", () => {
  assert.deepEqual(checkMessage("  dunno, sumthing about rivers  "), { text: "dunno, sumthing about rivers" });
  assert.equal(checkMessage("   ").error, TALK_MESSAGES.needText);
  assert.equal(checkMessage(undefined).error, TALK_MESSAGES.needText);
  assert.equal(checkMessage("x".repeat(MESSAGE_MAX_CHARS + 1)).error, TALK_MESSAGES.tooLong);
  assert.ok(checkMessage("x".repeat(MESSAGE_MAX_CHARS)).text);
});

// ---------- votes and turns ----------

test("votes: tap to choose, tap again to remove, tap the other to change", () => {
  assert.equal(nextVote(null, "up"), "up");
  assert.equal(nextVote("up", "up"), "removed");
  assert.equal(nextVote("up", "down"), "down");
  assert.equal(nextVote("removed", "down"), "down");
  assert.equal(nextVote("up", "sideways"), "up");
  assert.equal(shownVote("removed"), null);
  assert.equal(shownVote("down"), "down");
});

test("turns from a reply and from a reopened conversation", () => {
  const sent = turnFromReply({ id: "turn_a1", action: "attempt", type: null, reply: "Invented reply" }, { learnerText: "my go" });
  assert.deepEqual(sent, { id: "turn_a1", action: "attempt", type: null, learnerText: "my go", reply: "Invented reply", wellbeingLevel: null });
  const helped = turnFromReply({ id: "turn_a2", action: "support", type: "hint", reply: "Invented hint" }, { learnerText: "ignored" });
  assert.equal(helped.learnerText, null);
  assert.equal(learnerLine(helped, "research"), "You asked: Give me a search hint");
  assert.equal(learnerLine(sent, "research"), "my go");
  assert.equal(turnFromReply(null), null);
  const reopened = turnsFromServer({
    turns: [
      { id: "turn_b1", action: "attempt", learnerText: "first go", reply: "Invented reply", textRemoved: false },
      { id: "turn_b2", action: "message", learnerText: null, reply: null, textRemoved: true },
      { action: "message" },
    ],
  });
  assert.deepEqual(reopened.map((t) => [t.id, t.learnerText, t.reply]), [["turn_b1", "first go", "Invented reply"], ["turn_b2", null, null]]);
  assert.deepEqual(turnsFromServer(null), []);
});

test("error messages: the server's own words for 400, 409 and 429; fixed wording otherwise", () => {
  const said = "That help isn't available yet. Have another go first.";
  assert.deepEqual(talkErrorMessage({ kind: "http", status: 409, body: { error: said } }), { message: said });
  assert.equal(talkErrorMessage({ kind: "http", status: 502, body: { error: "upstream detail" } }).message, TALK_MESSAGES.failed);
  assert.match(talkErrorMessage({ kind: "http", status: 503, body: {} }).message, /isn't quite ready/);
  assert.match(talkErrorMessage({ kind: "http", status: 429, body: {} }).message, /wait a minute/);
  for (const kind of ["network", "not-json", "no-address"]) {
    assert.deepEqual(talkErrorMessage({ kind }), { message: TALK_MESSAGES.unreachable, unreachable: true }, kind);
  }
  assert.equal(talkErrorMessage({ kind: "http", status: 400, body: { error: "x".repeat(400) } }).message, TALK_MESSAGES.failed, "long text isn't shown");
});

// ---------- the API calls ----------

function fakeFetch({ delayMs = 0 } = {}) {
  const calls = [];
  const fetchImpl = (url, init) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined, auth: init.headers.Authorization });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })), delayMs);
      init.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("timed out", "TimeoutError"));
      });
    });
  };
  return { calls, fetchImpl };
}

test("the conversation calls go to the WP-111a routes with the pass", async () => {
  const { calls, fetchImpl } = fakeFetch();
  const api = createApi({ getBackendUrl: () => BACKEND, getToken: () => "test-pass", fetchImpl });
  await api.suggestRoute({ message: "invented" });
  await api.startConversation({ route: "plan", taskId: "t1" });
  await api.openConversation("conv_1");
  await api.sendMessage("conv_1", { text: "my go" });
  await api.sendMessage("conv_1", { escape: true });
  await api.requestSupport("conv_1", "hint");
  await api.vote("turn_1", "up");
  assert.deepEqual(calls.map((c) => [c.method, c.url.slice(BACKEND.length)]), [
    ["POST", "/api/route"],
    ["POST", "/api/conversations"],
    ["GET", "/api/conversations/conv_1"],
    ["POST", "/api/conversations/conv_1/messages"],
    ["POST", "/api/conversations/conv_1/messages"],
    ["POST", "/api/conversations/conv_1/support"],
    ["POST", "/api/turns/turn_1/vote"],
  ]);
  assert.deepEqual(calls.map((c) => c.body), [
    { message: "invented" }, { route: "plan", taskId: "t1" }, undefined, { text: "my go" }, { escape: true }, { type: "hint" }, { vote: "up" },
  ]);
  assert.ok(calls.every((c) => c.auth === "Bearer test-pass"));
});

test("calls that wait for a tutor reply get the longer timeout; the others keep the usual one", async () => {
  assert.ok(CONVERSATION_TIMEOUT_MS >= 120_000, "a reply can take up to about two minutes");
  assert.ok(CONVERSATION_TIMEOUT_MS > API_TIMEOUT_MS);
  const { fetchImpl } = fakeFetch({ delayMs: 60 });
  const api = createApi({ getBackendUrl: () => BACKEND, getToken: () => "t", fetchImpl, timeoutMs: 15, talkTimeoutMs: 2000 });
  assert.equal((await api.sendMessage("conv_1", { text: "go" })).kind, "ok");
  assert.equal((await api.requestSupport("conv_1", "hint")).kind, "ok");
  assert.equal((await api.suggestRoute({ message: "x" })).kind, "ok");
  assert.equal((await api.openTasks()).kind, "network", "an ordinary call still gives up sooner");
  assert.equal((await api.vote("turn_1", "down")).kind, "network");
});

// ---------- the tutor status panel ----------

test("every wake state has a status panel: offline, waking or ready", () => {
  for (const state of Object.keys(WAKE_MESSAGES)) {
    assert.ok(["offline", "waking", "ready"].includes(TUTOR_PANELS[state]), state);
  }
  assert.equal(tutorPanel("ready"), "ready");
  assert.equal(tutorPanel("waking"), "waking");
  assert.equal(tutorPanel("timeout"), "offline");
  assert.equal(tutorPanel("readyNoAi"), "offline", "the tutor can't help without the AI");
  assert.equal(tutorPanel("made-up"), "waking");
  assert.equal(tutorPanel(undefined), "waking");
});

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test("each panel colour pair meets AA contrast, in standard and high contrast", () => {
  const css = read("app.css");
  const blocks = [...css.matchAll(/:root(?:\[data-contrast="high"\])?\s*\{([^}]*--tutor-offline-bg[^}]*)\}/g)].map((m) => m[1]);
  assert.equal(blocks.length, 2, "a standard block and a high-contrast block");
  for (const block of blocks) {
    for (const state of ["offline", "waking", "ready"]) {
      const bg = block.match(new RegExp(`--tutor-${state}-bg:\\s*(#[0-9a-f]{6})`, "i"))[1];
      const fg = block.match(new RegExp(`--tutor-${state}-fg:\\s*(#[0-9a-f]{6})`, "i"))[1];
      assert.ok(contrast(bg, fg) >= 4.5, `${state} ${bg} on ${fg}: ${contrast(bg, fg).toFixed(2)}`);
    }
  }
  for (const state of ["offline", "waking", "ready"]) {
    assert.match(css, new RegExp(`#wake-status\\[data-tutor="${state}"\\]\\s*\\{[^}]*background: var\\(--tutor-${state}-bg\\);[^}]*color: var\\(--tutor-${state}-fg\\);`), state);
  }
});

test("Back is a clear outlined button, and a chosen vote is ticked as well as filled", () => {
  const css = read("app.css");
  const back = css.match(/\nbutton\.back\s*\{([^}]*)\}/)[1];
  assert.match(back, /border: 2px solid var\(--accent\)/);
  assert.match(back, /text-decoration: none/);
  assert.match(back, /min-height: var\(--tap\)/);
  assert.match(css, /button\.back::before\s*\{\s*content: "\\2190" \/ "";/);
  assert.doesNotMatch(css, /button\.link,\s*button\.back/, "Back no longer looks like a link");
  assert.match(css, /button\.vote\[aria-pressed="true"\]::after/);
});

// ---------- the page ----------

test("the work view starts with Get help with a task; the conversation view has the support area", () => {
  const html = read("index.html");
  const work = html.slice(html.indexOf('<div id="view-work"'), html.indexOf('<div id="view-talk"'));
  assert.ok(work.indexOf('id="help-start"') < work.indexOf('id="capture"'), "help comes first");
  assert.match(work, /<h2 id="help-heading" tabindex="-1">Get help with a task<\/h2>/);
  assert.match(work, /id="help-other"[^>]*aria-controls="help-other-form" aria-expanded="false">Something else<\/button>/);
  const talk = html.slice(html.indexOf('<div id="view-talk"'), html.indexOf('<div id="view-upcoming"'));
  assert.match(talk, /<div id="view-talk" class="view" hidden>\s*<button type="button" id="talk-back" class="back">Back<\/button>/);
  assert.match(talk, /<label id="talk-prompt-label" for="talk-text">/);
  assert.match(talk, /<textarea id="talk-text"[^>]*aria-describedby="talk-prompt-hint"/);
  assert.match(talk, /id="talk-escape"[^>]*>I don't know where to start<\/button>/);
  assert.match(talk, /<section id="talk-support" class="support" aria-labelledby="support-heading" hidden>/);
  assert.match(talk, /<ol id="talk-turns" class="turns" aria-label="Your conversation" hidden><\/ol>/);
  assert.match(talk, /id="talk-status" class="status" role="status" aria-live="polite"/);
  assert.match(talk, /id="talk-error" class="error" role="alert"/);
  assert.doesNotMatch(talk, /\son[a-z]+=/, "no inline handlers");
});

test("home knows the conversation view, with no button of its own on the home view", async () => {
  const { VIEWS, HOME_OPENERS } = await import("../web/home.js");
  assert.ok(VIEWS.includes("talk"));
  assert.deepEqual([...HOME_OPENERS], ["work", "upcoming", "learn", "more"]);
});

test("the page wires the conversation and the coloured status panel", () => {
  const app = read("app.js");
  assert.match(app, /import \{ createConversation \} from "\.\/conversation\.js";/);
  assert.match(app, /conversation\?\.setTutor\(state\)/);
  assert.match(app, /conversation\?\.stop\(\)/, "signing out clears the conversation");
  assert.match(app, /conversation\?\.start\(\)/);
  assert.match(app, /els\.wakeStatus\.dataset\.tutor = tutorPanel\(state\)/);
  assert.match(app, /els\.wakeStatus\.removeAttribute\("data-tutor"\)/);
});

test("conversation code keeps to the page rules", () => {
  const shared = read("shared", "conversation.js")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
  assert.doesNotMatch(shared, /\b(document|window|localStorage|sessionStorage|indexedDB|navigator|process|Buffer|require)\b/);
  assert.doesNotMatch(shared, /^import /m, "no imports");
  const page = read("conversation.js");
  assert.doesNotMatch(page, /innerHTML|insertAdjacentHTML|localStorage|sessionStorage|indexedDB/);
});

test("the conversation page code imports under Node without a DOM", async () => {
  assert.equal(typeof (await import("../web/conversation.js")).createConversation, "function");
});

test("deploy stamping covers the new modules", { skip: !existsSync(join(ROOT, "scripts", "stamp-versions.sh")) }, () => {
  const dir = mkdtempSync(join(tmpdir(), "wp111b-stamp-"));
  try {
    cpSync(WEB, join(dir, "web"), { recursive: true });
    execFileSync("bash", [join(ROOT, "scripts", "stamp-versions.sh"), join(dir, "web"), "abc12345"], { stdio: "pipe" });
    assert.match(readFileSync(join(dir, "web", "app.js"), "utf8"), /from "\.\/conversation\.js\?v=abc12345"/);
    assert.match(readFileSync(join(dir, "web", "conversation.js"), "utf8"), /from "\.\/shared\/conversation\.js\?v=abc12345"/);
    assert.match(readFileSync(join(dir, "web", "shared", "api.js"), "utf8"), /from "\.\/conversation\.js\?v=abc12345"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
