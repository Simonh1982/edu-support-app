// WP-017: accessibility settings from the snapshot. Invented settings only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACCESSIBILITY_ATTRIBUTES,
  ACCESSIBILITY_DEFAULTS,
  ACCESSIBILITY_OPTIONS,
  ACCESSIBILITY_PROPERTIES,
  ACCESSIBILITY_STORAGE_KEY,
  DYSLEXIA_FONT_STACK,
  accessibilityStyle,
  applyAccessibility,
  clearAccessibility,
  createAccessibility,
  loadAccessibility,
  normaliseAccessibility,
  readAccessibility,
  resetAccessibility,
  saveAccessibility,
} from "../web/shared/accessibility.js";
import { memoryStorage } from "../web/shared/auth.js";

const WEB = fileURLToPath(new URL("../web/", import.meta.url));
const WORKER = "https://wake.example.dev";
const CSS = readFileSync(join(WEB, "app.css"), "utf8");

const INVENTED = Object.freeze({
  textSize: "largest",
  font: "dyslexia-friendly",
  lineSpacing: "wider",
  paragraphSpacing: "wide",
  theme: "cream",
  contrast: "high",
  reducedMotion: true,
});

/** A stand-in for the root element: records custom properties and attributes. */
function fakeRoot() {
  const props = new Map();
  const attrs = new Map();
  return {
    props,
    attrs,
    style: {
      setProperty: (name, value) => void props.set(name, value),
      removeProperty: (name) => void props.delete(name),
    },
    setAttribute: (name, value) => void attrs.set(name, String(value)),
    removeAttribute: (name) => void attrs.delete(name),
  };
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// ---------- reading and checking settings ----------

test("normaliseAccessibility keeps known choices and ignores everything else", () => {
  assert.deepEqual(normaliseAccessibility(INVENTED), INVENTED);
  assert.deepEqual(normaliseAccessibility(undefined), ACCESSIBILITY_DEFAULTS);
  assert.deepEqual(normaliseAccessibility([]), ACCESSIBILITY_DEFAULTS);
  const messy = normaliseAccessibility({
    textSize: "enormous",
    font: 3,
    theme: "toString",
    contrast: "HIGH",
    reducedMotion: "yes",
    lineSpacing: "wide",
    favouriteColour: "green",
  });
  assert.deepEqual(messy, { ...ACCESSIBILITY_DEFAULTS, lineSpacing: "wide" });
  assert.equal("favouriteColour" in messy, false, "unknown keys are dropped");
});

test("every default is one of its own choices", () => {
  for (const [key, choices] of Object.entries(ACCESSIBILITY_OPTIONS)) {
    assert.ok(Object.hasOwn(choices, ACCESSIBILITY_DEFAULTS[key]), key);
    assert.equal(choices[ACCESSIBILITY_DEFAULTS[key]], null, `${key} default leaves the stylesheet alone`);
  }
});

test("readAccessibility reads the Worker's learner section and a whole snapshot", () => {
  const settings = { accessibility: { theme: "dark", textSize: "large" }, presentation: {} };
  const expected = { ...ACCESSIBILITY_DEFAULTS, theme: "dark", textSize: "large" };
  assert.deepEqual(readAccessibility({ generatedAt: "x", recent: [], settings }), expected);
  assert.deepEqual(readAccessibility({ learner: { settings } }), expected);
  assert.deepEqual(readAccessibility({ recent: [] }), ACCESSIBILITY_DEFAULTS);
  assert.deepEqual(readAccessibility(null), ACCESSIBILITY_DEFAULTS);
});

// ---------- turning settings into styles ----------

test("defaults set nothing, so the stylesheet and the device's light or dark mode apply", () => {
  const { properties, attributes } = accessibilityStyle(ACCESSIBILITY_DEFAULTS);
  assert.ok(Object.values(properties).every((v) => v === null));
  assert.ok(Object.values(attributes).every((v) => v === null));
});

test("chosen settings become custom properties and attributes", () => {
  const { properties, attributes } = accessibilityStyle(INVENTED);
  assert.deepEqual(properties, {
    "--text-scale": "2",
    "--line-height": "2.2",
    "--paragraph-gap": "1.5em",
    "--font": DYSLEXIA_FONT_STACK,
    "--letter-spacing": "0.03em",
    "--word-spacing": "0.12em",
  });
  assert.deepEqual(attributes, { "data-theme": "cream", "data-contrast": "high", "data-motion": "reduce" });
  assert.deepEqual(Object.keys(properties), [...ACCESSIBILITY_PROPERTIES]);
  assert.deepEqual(Object.keys(attributes), [...ACCESSIBILITY_ATTRIBUTES]);
});

test("text size goes up to 200% and the dyslexia-friendly font is a choice, not the default", () => {
  const scales = Object.values(ACCESSIBILITY_OPTIONS.textSize).filter(Boolean).map(Number);
  assert.equal(Math.max(...scales), 2);
  assert.ok(scales.every((s) => s > 1 && s <= 2));
  assert.equal(ACCESSIBILITY_DEFAULTS.font, "standard");
  assert.match(DYSLEXIA_FONT_STACK, /sans-serif$/, "always ends with a font every device has");
  assert.doesNotMatch(DYSLEXIA_FONT_STACK, /url\(|https?:/, "no font is downloaded");
});

test("applyAccessibility sets and removes; resetAccessibility removes everything", () => {
  const root = fakeRoot();
  applyAccessibility(root, INVENTED);
  assert.equal(root.props.get("--text-scale"), "2");
  assert.equal(root.attrs.get("data-theme"), "cream");
  applyAccessibility(root, { textSize: "large" });
  assert.equal(root.props.get("--text-scale"), "1.25");
  assert.equal(root.props.has("--font"), false, "a setting turned off is removed");
  assert.equal(root.attrs.has("data-theme"), false);
  applyAccessibility(root, INVENTED);
  resetAccessibility(root);
  assert.equal(root.props.size, 0);
  assert.equal(root.attrs.size, 0);
});

// ---------- the stylesheet ----------

test("app.css defines every custom property and has rules for every theme, contrast and motion value", () => {
  const rootBlock = CSS.match(/:root\s*\{([^}]*)\}/)[1];
  for (const name of ACCESSIBILITY_PROPERTIES) {
    assert.match(rootBlock, new RegExp(`${name}:`), `${name} has a default in :root`);
  }
  for (const value of Object.values(ACCESSIBILITY_OPTIONS.theme).filter(Boolean)) {
    assert.match(CSS, new RegExp(`:root\\[data-theme="${value}"\\]\\s*\\{`), `theme ${value}`);
  }
  assert.match(CSS, /:root\[data-contrast="high"\]\s*\{/);
  assert.match(CSS, /:root\[data-motion="reduce"\] \*/);
  assert.match(CSS, /@media \(prefers-reduced-motion: reduce\)/, "the device's own setting still applies");
  assert.match(CSS, /font-size: calc\(var\(--text-size\) \* var\(--text-scale\)\)/);
  assert.match(CSS, /letter-spacing: var\(--letter-spacing\)/);
});

// ---------- saving on the device ----------

test("own devices keep the settings; shared computers keep nothing", () => {
  const local = memoryStorage();
  saveAccessibility(local, INVENTED);
  assert.deepEqual(loadAccessibility(local), INVENTED);
  saveAccessibility(local, INVENTED, { shared: true });
  assert.equal(local.getItem(ACCESSIBILITY_STORAGE_KEY), null, "removed, not saved, on a shared computer");
  assert.ok(ACCESSIBILITY_STORAGE_KEY.startsWith("edu-support."), "same prefix as the pass keys");
});

test("loadAccessibility removes unreadable copies and survives blocked storage", () => {
  const local = memoryStorage();
  local.setItem(ACCESSIBILITY_STORAGE_KEY, "{not json");
  assert.equal(loadAccessibility(local), null);
  assert.equal(local.getItem(ACCESSIBILITY_STORAGE_KEY), null);
  local.setItem(ACCESSIBILITY_STORAGE_KEY, JSON.stringify({ theme: "dark", extra: "dropped" }));
  assert.deepEqual(loadAccessibility(local), { ...ACCESSIBILITY_DEFAULTS, theme: "dark" });
  const blocked = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
    removeItem() { throw new Error("blocked"); },
  };
  assert.equal(loadAccessibility(blocked), null);
  assert.doesNotThrow(() => saveAccessibility(blocked, INVENTED));
  assert.doesNotThrow(() => clearAccessibility(blocked));
  assert.equal(loadAccessibility(null), null);
});

// ---------- the controller ----------

function snapshotFetch(replies) {
  const calls = [];
  let n = 0;
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, headers: { ...(init.headers ?? {}) } });
    const reply = replies[Math.min(n++, replies.length - 1)];
    if (reply === "network") throw new TypeError("Failed to fetch");
    return reply();
  };
  return { fetchImpl, calls };
}

test("start applies the saved copy at once, then the snapshot's settings, and saves them", async () => {
  const root = fakeRoot();
  const local = memoryStorage();
  saveAccessibility(local, { textSize: "large" });
  let resolveFetch;
  const fetchImpl = (url, init) => {
    assert.equal(url, `${WORKER}/snapshot`);
    assert.equal(init.headers.Authorization, "Bearer test-pass");
    return new Promise((resolve) => (resolveFetch = resolve));
  };
  const a11y = createAccessibility({ workerUrl: WORKER, root, local, fetchImpl });
  const started = a11y.start({ token: "test-pass", shared: false });
  assert.equal(root.props.get("--text-scale"), "1.25", "saved copy shown before the network answers");
  resolveFetch(json({ recent: [], settings: { accessibility: { theme: "dark", textSize: "largest" } } }));
  const settings = await started;
  assert.equal(settings.theme, "dark");
  assert.equal(root.props.get("--text-scale"), "2");
  assert.equal(root.attrs.get("data-theme"), "dark");
  assert.equal(loadAccessibility(local).textSize, "largest", "saved for next time");
});

test("on a shared computer nothing is read from or left in browser storage", async () => {
  const root = fakeRoot();
  const local = memoryStorage();
  saveAccessibility(local, { theme: "cream" }); // left over from an own-device visit
  const { fetchImpl } = snapshotFetch([() => json({ settings: { accessibility: { contrast: "high" } } })]);
  const a11y = createAccessibility({ workerUrl: WORKER, root, local, fetchImpl });
  const started = a11y.start({ token: "t", shared: true });
  assert.equal(root.attrs.has("data-theme"), false, "the saved copy isn't used");
  await started;
  assert.equal(root.attrs.get("data-contrast"), "high", "settings still apply for this visit");
  assert.equal(local.getItem(ACCESSIBILITY_STORAGE_KEY), null);
});

test("a failed read keeps what is showing; refresh picks up changes; stop resets and forgets", async () => {
  const root = fakeRoot();
  const local = memoryStorage();
  const { fetchImpl, calls } = snapshotFetch([
    () => json({ settings: { accessibility: { textSize: "larger" } } }),
    "network",
    () => json({ error: "nope" }, 502),
    () => json({ error: "Not signed in", reason: "expired" }, 401),
    () => json({ error: "no snapshot" }, 404),
    () => json({ settings: { accessibility: { textSize: "x-large", font: "dyslexia-friendly" } } }),
  ]);
  const a11y = createAccessibility({ workerUrl: WORKER, root, local, fetchImpl });
  await a11y.start({ token: "t", shared: false });
  for (let i = 0; i < 4; i += 1) assert.equal(await a11y.refresh(), null);
  assert.equal(root.props.get("--text-scale"), "1.5", "unchanged after failures");
  const latest = await a11y.refresh();
  assert.equal(latest.textSize, "x-large");
  assert.equal(root.props.get("--font"), DYSLEXIA_FONT_STACK);
  assert.equal(calls.length, 6);
  a11y.stop();
  assert.equal(root.props.size, 0);
  assert.equal(root.attrs.size, 0);
  assert.equal(local.getItem(ACCESSIBILITY_STORAGE_KEY), null, "nothing kept after signing out");
  assert.equal(await a11y.refresh(), null, "no requests after stopping");
  assert.equal(calls.length, 6);
});

test("a reply that arrives after sign-out is ignored", async () => {
  const root = fakeRoot();
  const local = memoryStorage();
  let resolveFetch;
  const fetchImpl = () => new Promise((resolve) => (resolveFetch = resolve));
  const a11y = createAccessibility({ workerUrl: WORKER, root, local, fetchImpl });
  const started = a11y.start({ token: "t", shared: false });
  a11y.stop();
  resolveFetch(json({ settings: { accessibility: { theme: "dark" } } }));
  assert.equal(await started, null);
  assert.equal(root.attrs.size, 0);
  assert.equal(local.getItem(ACCESSIBILITY_STORAGE_KEY), null);
});

test("no Worker configured: nothing is requested and nothing breaks", async () => {
  const root = fakeRoot();
  let called = false;
  const a11y = createAccessibility({ workerUrl: "", root, local: memoryStorage(), fetchImpl: async () => { called = true; } });
  assert.equal(await a11y.start({ token: "t" }), null);
  assert.equal(called, false);
});

// ---------- rules for shared code and the page ----------

test("web/shared/accessibility.js uses no DOM-only or Node-only APIs", () => {
  const source = readFileSync(join(WEB, "shared", "accessibility.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(source, /\b(document|window|localStorage|sessionStorage|navigator|process|Buffer|require)\b/);
  assert.doesNotMatch(source, /from\s+["']node:/);
});

test("the learner page starts, refreshes and stops the settings", () => {
  const app = readFileSync(join(WEB, "app.js"), "utf8");
  assert.match(app, /from "\.\/shared\/accessibility\.js"/);
  assert.match(app, /accessibility\.start\(\{ token: pass\.token, shared: pass\.payload\.shared \}\)/);
  assert.match(app, /accessibility\.refresh\(\)/);
  assert.match(app, /accessibility\.stop\(\)/);
});
