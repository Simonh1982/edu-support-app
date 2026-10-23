// WP-012: pass handling, waking and the parent page. Invented data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  checkNewPass,
  clearPass,
  decodePass,
  loadPass,
  loginUrl,
  memoryStorage,
  readFragment,
  savePass,
  signInMessage,
  storageKey,
  usableStorage,
  workerRequest,
} from "../web/shared/auth.js";
import { createWaker, probeHealth, WAKE_MESSAGES, WAKE_SETTINGS } from "../web/shared/wake.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const WEB = join(ROOT, "web");
const WORKER = "https://wake.example.dev";
const BACKEND = "https://example-codespace-3000.app.github.dev";
const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);

const b64url = (text) => Buffer.from(text).toString("base64url");
function fakePass({ role = "learner", exp = NOW / 1000 + 3600, shared = false, extra = {} } = {}) {
  const body = b64url(JSON.stringify({ sub: "invented-user", role, ver: 1, iat: NOW / 1000, exp, shared, ...extra }));
  return `${body}.${b64url("not-a-real-signature")}`;
}

// ---------- fragment and pass reading ----------

test("readFragment reads a pass or an error and ignores anything else", () => {
  assert.deepEqual(readFragment("#pass=abc.def"), { pass: "abc.def" });
  assert.deepEqual(readFragment("#error=not-allowed"), { error: "not-allowed" });
  assert.deepEqual(readFragment("#error=<script>"), { error: "unknown" });
  assert.equal(readFragment(""), null);
  assert.equal(readFragment("#"), null);
  assert.equal(readFragment("#section-2"), null);
  assert.equal(readFragment(undefined), null);
});

test("decodePass reads role, expiry and shared flag, and rejects bad passes", () => {
  const payload = decodePass(fakePass({ role: "parent", shared: true }));
  assert.deepEqual(payload, { role: "parent", exp: NOW / 1000 + 3600, shared: true });
  assert.equal("sub" in payload, false, "the login is never handed to the page");
  assert.equal(decodePass("nodot"), null);
  assert.equal(decodePass("a.b.c"), null);
  assert.equal(decodePass("!!!.abc"), null);
  assert.equal(decodePass(`${b64url("not json")}.sig`), null);
  assert.equal(decodePass(fakePass({ role: "admin" })), null);
  assert.equal(decodePass(fakePass({ exp: "soon" })), null);
  assert.equal(decodePass("x".repeat(5000)), null);
});

test("decodePass reads a pass minted by server/auth.js", async () => {
  const auth = await import("../server/auth.js");
  const env = {
    PASS_SIGNING_KEY: "k".repeat(40),
    PASS_VERSION: "1",
    ALLOWED_ACCOUNTS: JSON.stringify({ "invented-parent": "parent", "invented-learner": "learner" }),
  };
  const { settings, errors } = auth.passSettings(env);
  assert.deepEqual(errors, []);
  for (const shared of [false, true]) {
    const minted = await auth.mintPass({ login: "invented-learner", shared, settings });
    const token = typeof minted === "string" ? minted : minted?.token ?? minted?.pass;
    const payload = decodePass(token);
    assert.ok(payload, "front end can read the server's pass format");
    assert.equal(payload.role, "learner");
    assert.equal(payload.shared, shared);
    assert.ok(payload.exp * 1000 > Date.now());
  }
});

test("checkNewPass rejects the wrong role and expired passes", () => {
  assert.ok(checkNewPass(fakePass(), "learner", NOW).payload);
  assert.deepEqual(checkNewPass(fakePass({ role: "parent" }), "learner", NOW), { error: "wrong-page" });
  assert.deepEqual(checkNewPass(fakePass({ exp: NOW / 1000 - 1 }), "learner", NOW), { error: "pass-expired" });
  assert.deepEqual(checkNewPass("rubbish", "learner", NOW), { error: "invalid" });
});

test("signInMessage covers every Worker error code, with a fallback", () => {
  for (const code of ["not-configured", "cancelled", "expired", "github", "not-allowed"]) {
    assert.notEqual(signInMessage(code), signInMessage("unknown"), code);
  }
  assert.equal(signInMessage("made-up"), signInMessage("unknown"));
  assert.equal(signInMessage("toString"), signInMessage("unknown"));
});

test("loginUrl is unchanged after moving to web/shared", () => {
  assert.equal(loginUrl("", false), null);
  assert.equal(loginUrl("https://w.example.dev/", false), "https://w.example.dev/auth/login");
  assert.equal(loginUrl("https://w.example.dev", true), "https://w.example.dev/auth/login?shared=1");
});

// ---------- storage ----------

test("own-device passes go in localStorage, shared ones in sessionStorage only", () => {
  const local = memoryStorage();
  const session = memoryStorage();
  const own = fakePass();
  savePass({ token: own, payload: decodePass(own), local, session });
  assert.equal(local.getItem(storageKey("learner")), own);
  assert.equal(session.getItem(storageKey("learner")), null);

  const shared = fakePass({ shared: true });
  savePass({ token: shared, payload: decodePass(shared), local, session });
  assert.equal(session.getItem(storageKey("learner")), shared);
  assert.equal(local.getItem(storageKey("learner")), null, "nothing left on a shared computer");
  assert.equal(loadPass({ role: "learner", local, session, nowMs: NOW }).token, shared);
});

test("each role has its own key, and loadPass ignores the other role", () => {
  const local = memoryStorage();
  const session = memoryStorage();
  const parent = fakePass({ role: "parent" });
  savePass({ token: parent, payload: decodePass(parent), local, session });
  assert.equal(loadPass({ role: "learner", local, session, nowMs: NOW }), null);
  assert.equal(loadPass({ role: "parent", local, session, nowMs: NOW }).token, parent);
  local.setItem(storageKey("learner"), parent); // wrong role under the learner key
  assert.equal(loadPass({ role: "learner", local, session, nowMs: NOW }), null);
  assert.equal(local.getItem(storageKey("learner")), null, "bad entry removed");
});

test("expired passes are removed and reported; clearPass empties both stores", () => {
  const local = memoryStorage();
  const session = memoryStorage();
  local.setItem(storageKey("learner"), fakePass({ exp: NOW / 1000 - 10 }));
  assert.deepEqual(loadPass({ role: "learner", local, session, nowMs: NOW }), { expired: true });
  assert.equal(local.getItem(storageKey("learner")), null);

  local.setItem(storageKey("learner"), fakePass());
  session.setItem(storageKey("learner"), fakePass({ shared: true }));
  clearPass({ role: "learner", local, session });
  assert.equal(local.getItem(storageKey("learner")), null);
  assert.equal(session.getItem(storageKey("learner")), null);
});

test("usableStorage falls back to memory when storage throws", () => {
  const store = usableStorage(() => {
    throw new Error("blocked");
  });
  store.setItem("a", "1");
  assert.equal(store.getItem("a"), "1");
});

// ---------- fake network ----------

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/**
 * routes: { status: [..], wake: [..], health: [..] } — each entry is a Response factory,
 * "network" (fetch throws) or the last entry repeats.
 */
function fakeNetwork(routes) {
  const calls = [];
  const counts = { status: 0, wake: 0, health: 0 };
  const fetchImpl = async (url, init = {}) => {
    const route = url === `${WORKER}/status` ? "status" : url === `${WORKER}/wake` ? "wake" : url === `${BACKEND}/api/health` ? "health" : null;
    calls.push({ route, url, method: init.method ?? "GET", headers: { ...(init.headers ?? {}) } });
    if (!route) throw new TypeError("unexpected address in test");
    const list = routes[route] ?? [];
    const entry = list[Math.min(counts[route]++, list.length - 1)];
    if (entry === undefined || entry === "network") throw new TypeError("Failed to fetch");
    return entry();
  };
  return { fetchImpl, calls };
}

function fakeClock() {
  let t = NOW;
  return { now: () => t, sleep: async (ms) => void (t += ms), elapsed: () => t - NOW };
}

const status = (state) => () => json({ state, backendUrl: BACKEND });
const healthOk = (ai = { ready: true, mode: "copilot" }) => () =>
  json({ ok: true, ai, restsAt: "2026-10-22T13:30:00+01:00" });
const quietLog = { warn() {}, error() {} };

function runWaker(routes, extra = {}) {
  const net = fakeNetwork(routes);
  const clock = fakeClock();
  const updates = [];
  const warnings = [];
  const waker = createWaker({
    workerUrl: WORKER,
    token: "test-pass",
    fetchImpl: net.fetchImpl,
    now: clock.now,
    sleep: clock.sleep,
    onUpdate: (u) => updates.push(u),
    log: { warn: (m) => warnings.push(m), error() {} },
    ...extra,
  });
  return { waker, net, clock, updates, warnings };
}

// ---------- waking ----------

test("already awake and healthy: ready at once, no wake request", async () => {
  const { waker, net, updates } = runWaker({ status: [status("Available")], health: [healthOk()] });
  const result = await waker.run();
  assert.equal(result.state, "ready");
  assert.equal(result.restsAt, "2026-10-22T13:30:00+01:00");
  assert.equal(net.calls.filter((c) => c.route === "wake").length, 0);
  assert.equal(updates.at(-1).message, WAKE_MESSAGES.ready);
});

test("asleep: rings once, polls every 5 s and reports ready", async () => {
  const { waker, net, clock, updates } = runWaker({
    status: [status("Shutdown"), status("Starting")],
    wake: [() => json({ state: "Starting", started: true, backendUrl: BACKEND })],
    health: ["network", "network", "network", "network", healthOk()],
  });
  const result = await waker.run();
  assert.equal(result.state, "ready");
  assert.equal(clock.elapsed(), 5 * WAKE_SETTINGS.pollMs, "ready on the fifth 5-second check");
  assert.equal(net.calls.filter((c) => c.route === "wake").length, 1);
  assert.equal(net.calls.filter((c) => c.route === "status").length, 2, "first check plus every third poll");
  assert.ok(updates.some((u) => u.message === WAKE_MESSAGES.waking));
});

test("still Shutdown after 30 s: rings again", async () => {
  const { waker, net } = runWaker({
    status: [status("Shutdown")],
    wake: [() => json({ state: "ShuttingDown", started: true, backendUrl: BACKEND })],
    health: [...Array(12).fill("network"), healthOk()],
  });
  const result = await waker.run();
  assert.equal(result.state, "ready");
  assert.ok(net.calls.filter((c) => c.route === "wake").length >= 2, "second ring sent");
});

test("Available for over 90 s with no answer: port message, logged once, then timeout at 5 min", async () => {
  const { waker, clock, updates, warnings } = runWaker({ status: [status("Available")], health: ["network"] });
  const result = await waker.run();
  assert.equal(result.state, "timeout");
  assert.equal(clock.elapsed(), WAKE_SETTINGS.maxMs);
  const firstPort = updates.findIndex((u) => u.state === "port");
  assert.ok(firstPort > 0, "port message shown");
  assert.ok(updates.slice(0, firstPort).every((u) => u.state !== "port"));
  assert.equal(warnings.length, 1);
  assert.equal(updates.at(-1).message, WAKE_MESSAGES.timeout);
});

test("a page that isn't JSON is reported as a warning page, not as a Private port", async () => {
  const page = () => new Response("<html>warning</html>", { status: 200, headers: { "Content-Type": "text/html" } });
  const { waker, updates } = runWaker({ status: [status("Available")], health: [page, page, healthOk()] });
  const result = await waker.run();
  assert.equal(result.state, "ready");
  assert.ok(updates.some((u) => u.state === "warning"));
  assert.ok(!updates.some((u) => u.state === "port"));
});

test("AI still starting: 'nearly ready', then ready", async () => {
  const { waker, updates } = runWaker({
    status: [status("Available")],
    health: [healthOk({ ready: false, mode: "starting" }), healthOk({ ready: false, mode: "starting" }), healthOk()],
  });
  const result = await waker.run();
  assert.equal(result.state, "ready");
  assert.ok(updates.some((u) => u.state === "nearly"));
});

test("server up but AI off: readyNoAi", async () => {
  const { waker } = runWaker({ status: [status("Available")], health: [healthOk({ ready: false, mode: "off" })] });
  assert.equal((await waker.run()).state, "readyNoAi");
});

test("pass rejected by the Worker: signedOut with the reason", async () => {
  const { waker } = runWaker({ status: [() => json({ error: "Not signed in", reason: "version" }, 401)] });
  assert.deepEqual(await waker.run(), { state: "signedOut", reason: "version" });
});

test("Worker unreachable or failing", async () => {
  assert.equal((await runWaker({ status: ["network"] }).waker.run()).state, "worker");
  const bad = runWaker({
    status: [status("Shutdown")],
    wake: [() => json({ error: "GitHub said no", githubStatus: 403 }, 502)],
  });
  assert.deepEqual(await bad.waker.run(), { state: "wakeFailed", status: 502 });
  assert.equal((await createWaker({ workerUrl: "", token: "t", fetchImpl: async () => {}, log: quietLog }).run()).state, "notConfigured");
});

test("stop() ends the loop quietly", async () => {
  const net = fakeNetwork({ status: [status("Shutdown")], wake: [status("Starting")], health: ["network"] });
  const clock = fakeClock();
  const updates = [];
  let sleeps = 0;
  const waker = createWaker({
    workerUrl: WORKER,
    token: "t",
    fetchImpl: net.fetchImpl,
    now: clock.now,
    sleep: async (ms) => {
      if (++sleeps === 2) waker.stop();
      return clock.sleep(ms);
    },
    onUpdate: (u) => updates.push(u),
    log: quietLog,
  });
  assert.deepEqual(await waker.run(), { state: "stopped" });
  const countAtStop = updates.length;
  assert.ok(countAtStop >= 2, "updates before stopping");
  assert.equal(net.calls.filter((c) => c.route === "health").length, 1, "no checks after stopping");
});

test("headers: the backend gets Accept JSON and no pass; the Worker gets the pass", async () => {
  const { waker, net } = runWaker({
    status: [status("Shutdown")],
    wake: [status("Starting")],
    health: ["network", healthOk()],
  });
  await waker.run();
  for (const call of net.calls) {
    assert.equal(call.headers.Accept, "application/json", call.url);
    if (call.route === "health") {
      assert.deepEqual(Object.keys(call.headers), ["Accept"], "simple request: no preflight, no pass sent to the backend");
    } else {
      assert.equal(call.headers.Authorization, "Bearer test-pass");
    }
  }
  assert.equal(net.calls.find((c) => c.route === "wake").method, "POST");
});

test("probeHealth refuses a missing or non-https address and reads HTTP errors", async () => {
  assert.equal((await probeHealth({ backendUrl: null })).kind, "no-address");
  assert.equal((await probeHealth({ backendUrl: "http://plain.example" })).kind, "no-address");
  const r = await probeHealth({ backendUrl: BACKEND, fetchImpl: async () => json({ error: "nope" }, 500) });
  assert.deepEqual(r, { kind: "http", status: 500 });
});

test("workerRequest reports a 401 reason without throwing", async () => {
  const r = await workerRequest({
    workerUrl: WORKER,
    path: "status",
    token: "t",
    fetchImpl: async () => json({ error: "x", reason: "expired" }, 401),
  });
  assert.deepEqual(r, { kind: "auth", status: 401, reason: "expired" });
});

// ---------- pages ----------

test("web/shared code uses no DOM-only or Node-only APIs", () => {
  for (const file of ["auth.js", "wake.js"]) {
    const source = readFileSync(join(WEB, "shared", file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(source, /\b(document|window|localStorage|sessionStorage|navigator|process|Buffer|require)\b/, file);
    assert.doesNotMatch(source, /from\s+["']node:/, file);
  }
});

test("parent page is accessible, separate, and uses the shared stylesheet", () => {
  const html = readFileSync(join(WEB, "parent", "index.html"), "utf8");
  assert.match(html, /<html lang="en-GB">/);
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(html, /<link rel="stylesheet" href="\.\.\/app\.css">/);
  assert.match(html, /<script type="module" src="parent\.js"><\/script>/);
  assert.match(html, /<label for="shared-computer">This is a shared computer<\/label>/);
  assert.match(html, /role="status"/);
  assert.doesNotMatch(html, /rel="manifest"/, "only the learner app is installable");
  assert.doesNotMatch(html, /user-scalable=no|maximum-scale/);
});

test("the learner app never links to the parent page and the parent page never wakes the Codespace", () => {
  for (const file of ["index.html", "app.js"]) {
    assert.doesNotMatch(readFileSync(join(WEB, file), "utf8"), /parent\//, file);
  }
  const parentJs = readFileSync(join(WEB, "parent", "parent.js"), "utf8");
  assert.doesNotMatch(parentJs, /wake\.js|createWaker|["']wake["']/);
});

test("learner page has the signed-in screen, status line and sign-out button", () => {
  const html = readFileSync(join(WEB, "index.html"), "utf8");
  assert.match(html, /<section id="home-screen"[^>]*hidden>/);
  assert.match(html, /id="wake-status" class="status" role="status" aria-live="polite"/);
  assert.match(html, /<button type="button" id="sign-out"/);
  assert.match(html, /<button type="button" id="wake-retry"[^>]*hidden>/);
});

test("deploy stamping covers the parent page and the shared modules", () => {
  const dir = mkdtempSync(join(tmpdir(), "wp012-stamp-"));
  try {
    cpSync(WEB, join(dir, "web"), { recursive: true });
    execFileSync("bash", [join(ROOT, "scripts", "stamp-versions.sh"), join(dir, "web"), "abc12345"], { stdio: "pipe" });
    const parentHtml = readFileSync(join(dir, "web", "parent", "index.html"), "utf8");
    assert.match(parentHtml, /href="\.\.\/app\.css\?v=abc12345"/);
    assert.match(parentHtml, /src="parent\.js\?v=abc12345"/);
    const parentJs = readFileSync(join(dir, "web", "parent", "parent.js"), "utf8");
    assert.match(parentJs, /from "\.\.\/shared\/auth\.js\?v=abc12345"/);
    assert.match(parentJs, /from "\.\.\/config\.js\?v=abc12345"/);
    const appJs = readFileSync(join(dir, "web", "app.js"), "utf8");
    assert.match(appJs, /from "\.\/shared\/wake\.js\?v=abc12345"/);
    const wakeJs = readFileSync(join(dir, "web", "shared", "wake.js"), "utf8");
    assert.match(wakeJs, /from "\.\/auth\.js\?v=abc12345"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config points at an https Worker with no path", async () => {
  const { config } = await import("../web/config.js");
  assert.match(config.workerUrl, /^https:\/\/[a-z0-9.-]+\.workers\.dev$/);
  assert.ok(Object.isFrozen(config));
});
