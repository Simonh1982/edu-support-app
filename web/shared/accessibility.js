// Accessibility settings for the learner page (build spec §33, Appendix A.1; blueprint §10.6).
// Settings come from the snapshot (settings.accessibility, built from profile/accessibility.json in
// the storage repository) and are applied as CSS custom properties and data attributes on the root
// element. No DOM-only or Node-only APIs: the root element, storage and fetch are passed in.
import { workerRequest } from "./auth.js";

/**
 * The allowed settings: each key is a field in profile/accessibility.json, each value a set choice.
 * Anything else is ignored, so a typo can never break the page. "standard" (or "system") means
 * "use the stylesheet's own value", so nothing is set for it.
 */
export const ACCESSIBILITY_OPTIONS = Object.freeze({
  textSize: Object.freeze({ standard: null, large: "1.25", larger: "1.5", "x-large": "1.75", largest: "2" }),
  font: Object.freeze({ standard: null, "dyslexia-friendly": "dyslexia-friendly" }),
  lineSpacing: Object.freeze({ standard: null, wide: "1.9", wider: "2.2" }),
  paragraphSpacing: Object.freeze({ standard: null, wide: "1.5em", wider: "2em" }),
  theme: Object.freeze({ system: null, light: "light", dark: "dark", cream: "cream" }),
  contrast: Object.freeze({ standard: null, high: "high" }),
});

export const ACCESSIBILITY_DEFAULTS = Object.freeze({
  textSize: "standard",
  font: "standard",
  lineSpacing: "standard",
  paragraphSpacing: "standard",
  theme: "system",
  contrast: "standard",
  reducedMotion: false, // false = follow the device's own "reduce motion" setting
});

// A choice, not the default (build spec §33). No font is downloaded: the page uses the first of
// these the device has, and the extra letter and word spacing helps whichever font is used.
export const DYSLEXIA_FONT_STACK =
  '"Atkinson Hyperlegible", Lexend, OpenDyslexic, Verdana, Tahoma, "Trebuchet MS", "Comic Sans MS", sans-serif';
const DYSLEXIA_SPACING = Object.freeze({ letter: "0.03em", word: "0.12em" });

/** Every custom property and attribute this module may set, so reset() can remove them all. */
export const ACCESSIBILITY_PROPERTIES = Object.freeze([
  "--text-scale",
  "--line-height",
  "--paragraph-gap",
  "--font",
  "--letter-spacing",
  "--word-spacing",
]);
export const ACCESSIBILITY_ATTRIBUTES = Object.freeze(["data-theme", "data-contrast", "data-motion"]);

// Own devices keep the last settings so the next visit opens in the learner's chosen text size
// (build spec §6.1). Shared computers keep nothing.
export const ACCESSIBILITY_STORAGE_KEY = "edu-support.settings.accessibility";

/** A full, safe settings object: known keys with allowed values only, defaults for the rest. */
export function normaliseAccessibility(raw) {
  const out = { ...ACCESSIBILITY_DEFAULTS };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, choices] of Object.entries(ACCESSIBILITY_OPTIONS)) {
    const value = raw[key];
    if (typeof value === "string" && Object.hasOwn(choices, value)) out[key] = value;
  }
  if (raw.reducedMotion === true) out.reducedMotion = true;
  return out;
}

/**
 * The accessibility settings from a /snapshot reply. The Worker returns the learner section
 * directly ({ settings, … }); a whole snapshot ({ learner: { settings } }) is accepted too.
 */
export function readAccessibility(body) {
  const section = body?.settings ? body : body?.learner;
  return normaliseAccessibility(section?.settings?.accessibility);
}

/**
 * What to set on the root element. A null value means "remove it", so the stylesheet's own value
 * (including the device's light or dark mode) applies.
 * @returns {{ properties: Record<string, string | null>, attributes: Record<string, string | null> }}
 */
export function accessibilityStyle(settings) {
  const s = normaliseAccessibility(settings);
  const pick = (key) => ACCESSIBILITY_OPTIONS[key][s[key]];
  const dyslexia = s.font === "dyslexia-friendly";
  return {
    properties: {
      "--text-scale": pick("textSize"),
      "--line-height": pick("lineSpacing"),
      "--paragraph-gap": pick("paragraphSpacing"),
      "--font": dyslexia ? DYSLEXIA_FONT_STACK : null,
      "--letter-spacing": dyslexia ? DYSLEXIA_SPACING.letter : null,
      "--word-spacing": dyslexia ? DYSLEXIA_SPACING.word : null,
    },
    attributes: {
      "data-theme": pick("theme"),
      "data-contrast": pick("contrast"),
      "data-motion": s.reducedMotion ? "reduce" : null,
    },
  };
}

/** Puts the settings on the root element (anything with .style and set/removeAttribute). */
export function applyAccessibility(root, settings) {
  const { properties, attributes } = accessibilityStyle(settings);
  for (const [name, value] of Object.entries(properties)) {
    if (value === null) root.style.removeProperty(name);
    else root.style.setProperty(name, value);
  }
  for (const [name, value] of Object.entries(attributes)) {
    if (value === null) root.removeAttribute(name);
    else root.setAttribute(name, value);
  }
}

/** Back to the stylesheet's own values. */
export function resetAccessibility(root) {
  for (const name of ACCESSIBILITY_PROPERTIES) root.style.removeProperty(name);
  for (const name of ACCESSIBILITY_ATTRIBUTES) root.removeAttribute(name);
}

/** The settings saved on this device, or null. Anything unreadable is removed. */
export function loadAccessibility(store) {
  let text = null;
  try {
    text = store?.getItem(ACCESSIBILITY_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
  if (!text) return null;
  try {
    return normaliseAccessibility(JSON.parse(text));
  } catch {
    clearAccessibility(store);
    return null;
  }
}

/** Saves the settings on an own device. On a shared computer it removes them instead. */
export function saveAccessibility(store, settings, { shared = false } = {}) {
  if (shared) return clearAccessibility(store);
  try {
    store?.setItem(ACCESSIBILITY_STORAGE_KEY, JSON.stringify(normaliseAccessibility(settings)));
  } catch {
    // Storage full or blocked: the settings still apply for this visit.
  }
}

export function clearAccessibility(store) {
  try {
    store?.removeItem(ACCESSIBILITY_STORAGE_KEY);
  } catch {
    // Nothing to remove if storage is unavailable.
  }
}

/**
 * Applies the learner's settings while signed in. start({ token, shared }) applies the saved copy
 * at once (own devices only), then reads /snapshot; refresh() reads it again (e.g. once the tutor
 * is ready and the snapshot has been rebuilt); stop() resets the page and forgets the saved copy.
 * A failed read keeps whatever is showing: the waker and capture screen deal with sign-in problems.
 */
export function createAccessibility({ workerUrl, root, local = null, fetchImpl = globalThis.fetch } = {}) {
  let generation = 0;
  let token = null;
  let shared = true;

  async function refresh() {
    const mine = generation;
    if (!token) return null;
    const result = await workerRequest({ workerUrl, path: "snapshot", token, fetchImpl });
    if (mine !== generation || result.kind !== "ok") return null;
    const settings = readAccessibility(result.body);
    applyAccessibility(root, settings);
    saveAccessibility(local, settings, { shared });
    return settings;
  }

  function start({ token: newToken, shared: isShared = false } = {}) {
    generation += 1;
    token = newToken ?? null;
    shared = isShared === true;
    const saved = shared ? null : loadAccessibility(local);
    if (shared) clearAccessibility(local);
    if (saved) applyAccessibility(root, saved);
    return refresh();
  }

  function stop() {
    generation += 1;
    token = null;
    resetAccessibility(root);
    clearAccessibility(local);
  }

  return { start, refresh, stop };
}
