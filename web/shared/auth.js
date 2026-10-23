// Pass handling shared by the learner page and the parent page.
// No DOM-only or Node-only APIs here (blueprint §10.6): storage and fetch are passed in,
// so the same code runs in the browser and in Node tests.
// The browser can't check a pass's signature (it has no key). It only reads the role,
// expiry and shared flag; the Worker and the server do the real checks on every request.

export const PASS_ROLES = Object.freeze(["learner", "parent"]);
export const PASS_KEY_PREFIX = "edu-support.pass.";
export const REQUEST_TIMEOUT_MS = 8000;
const MAX_TOKEN_LENGTH = 4096;

export const SIGN_IN_MESSAGES = Object.freeze({
  "not-configured": "Sign-in isn't set up properly yet. Please tell the person who looks after the app.",
  cancelled: "Sign-in was cancelled. You can try again whenever you're ready.",
  expired: "Sign-in took too long. Please try again.",
  github: "GitHub didn't answer properly. Please try again in a minute.",
  "not-allowed": "This GitHub account can't use this app.",
  "wrong-page": "This account signs in on a different page.",
  "pass-expired": "Your sign-in has run out. Please sign in again.",
  "signed-out": "You've signed out.",
  revoked: "Your sign-in is no longer valid. Please sign in again.",
  invalid: "That sign-in didn't work. Please try again.",
  unknown: "Something went wrong with sign-in. Please try again.",
});

/** @param {string | undefined} code */
export function signInMessage(code) {
  return Object.hasOwn(SIGN_IN_MESSAGES, code ?? "") ? SIGN_IN_MESSAGES[code] : SIGN_IN_MESSAGES.unknown;
}

/** Absolute address of a Worker path, or null if no Worker is configured. */
export function workerEndpoint(workerUrl, path) {
  if (typeof workerUrl !== "string" || workerUrl.trim() === "") return null;
  const base = workerUrl.trim().replace(/\/+$/, "") + "/";
  return new URL(String(path).replace(/^\/+/, ""), base).href;
}

/**
 * Builds the Worker's sign-in address, or returns null if no Worker is configured.
 * @param {string} workerUrl
 * @param {boolean} shared  true on a shared computer (shorter pass, nothing saved)
 */
export function loginUrl(workerUrl, shared) {
  const href = workerEndpoint(workerUrl, "auth/login");
  if (!href) return null;
  const url = new URL(href);
  if (shared) url.searchParams.set("shared", "1");
  return url.href;
}

/**
 * Reads what the Worker put after the # on its way back from sign-in.
 * @returns {{ pass: string } | { error: string } | null}
 */
export function readFragment(hash) {
  if (typeof hash !== "string") return null;
  const text = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!text) return null;
  const params = new URLSearchParams(text);
  const pass = params.get("pass");
  if (pass) return { pass };
  const error = params.get("error");
  if (error) return { error: /^[a-z-]{1,40}$/.test(error) ? error : "unknown" };
  return null;
}

function b64urlToText(part) {
  const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * Reads a pass's public part (blueprint §6.2) without checking the signature.
 * The login is deliberately not returned: the pages never need to show it.
 * @returns {{ role: "learner" | "parent", exp: number, shared: boolean } | null}
 */
export function decodePass(token) {
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split(".");
  if (parts.length !== 2 || !parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p))) return null;
  try {
    const payload = JSON.parse(b64urlToText(parts[0]));
    if (!payload || typeof payload !== "object") return null;
    if (!PASS_ROLES.includes(payload.role)) return null;
    if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) return null;
    return { role: payload.role, exp: payload.exp, shared: payload.shared === true };
  } catch {
    return null;
  }
}

/** True while the pass's expiry (epoch seconds) is in the future. */
export function passIsCurrent(payload, nowMs = Date.now()) {
  return Boolean(payload) && payload.exp * 1000 > nowMs;
}

/**
 * Checks a pass that has just arrived from the Worker, for the page's own role.
 * @returns {{ payload } | { error: "invalid" | "wrong-page" | "pass-expired" }}
 */
export function checkNewPass(token, role, nowMs = Date.now()) {
  const payload = decodePass(token);
  if (!payload) return { error: "invalid" };
  if (payload.role !== role) return { error: "wrong-page" };
  if (!passIsCurrent(payload, nowMs)) return { error: "pass-expired" };
  return { payload };
}

/** Storage that lives only as long as the page (used if browser storage is blocked). */
export function memoryStorage() {
  const items = new Map();
  return {
    getItem: (key) => (items.has(key) ? items.get(key) : null),
    setItem: (key, value) => void items.set(key, String(value)),
    removeItem: (key) => void items.delete(key),
  };
}

/**
 * Returns the store from getStore() if it can be written to, otherwise memory storage.
 * Some privacy modes throw on access, so the page passes a getter, not the object.
 */
export function usableStorage(getStore) {
  try {
    const store = getStore();
    const probe = `${PASS_KEY_PREFIX}probe`;
    store.setItem(probe, "1");
    store.removeItem(probe);
    return store;
  } catch {
    return memoryStorage();
  }
}

export function storageKey(role) {
  return PASS_KEY_PREFIX + role;
}

function safeGet(store, key) {
  try {
    return store?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function safeSet(store, key, value) {
  try {
    store?.setItem(key, value);
    return Boolean(store);
  } catch {
    return false;
  }
}

function safeRemove(store, key) {
  try {
    store?.removeItem(key);
  } catch {
    // Nothing to clean up if storage is unavailable.
  }
}

/**
 * Saves a pass. Own devices: localStorage (30 days). Shared computer: sessionStorage only,
 * so nothing survives closing the tab (blueprint §6.2). Each role has its own key, because
 * both pages share one origin.
 */
export function savePass({ token, payload, local, session }) {
  const key = storageKey(payload.role);
  const [keep, other] = payload.shared ? [session, local] : [local, session];
  safeRemove(other, key);
  return safeSet(keep, key, token);
}

/**
 * Loads the saved pass for a role. Removes anything unreadable or expired.
 * @returns {{ token: string, payload } | { expired: true } | null}
 */
export function loadPass({ role, local, session, nowMs = Date.now() }) {
  const key = storageKey(role);
  let expired = false;
  for (const store of [session, local]) {
    const token = safeGet(store, key);
    if (!token) continue;
    const payload = decodePass(token);
    if (!payload || payload.role !== role) {
      safeRemove(store, key);
      continue;
    }
    if (!passIsCurrent(payload, nowMs)) {
      safeRemove(store, key);
      expired = true;
      continue;
    }
    return { token, payload };
  }
  return expired ? { expired: true } : null;
}

export function clearPass({ role, local, session }) {
  const key = storageKey(role);
  safeRemove(local, key);
  safeRemove(session, key);
}

/** Reads a response body as a JSON object, or returns null. */
export async function readJsonBody(response) {
  try {
    const value = JSON.parse(await response.text());
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

export function timeoutSignal(ms) {
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(ms)
    : undefined;
}

/**
 * Calls a Worker endpoint with the pass.
 * @returns {Promise<
 *   { kind: "ok", status, body } | { kind: "auth", status: 401, reason } |
 *   { kind: "http", status, body } | { kind: "not-json", status } |
 *   { kind: "network" } | { kind: "not-configured" }>}
 */
export async function workerRequest({
  workerUrl,
  path,
  token,
  method = "GET",
  fetchImpl = globalThis.fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
}) {
  const url = workerEndpoint(workerUrl, path);
  if (!url) return { kind: "not-configured" };
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: timeoutSignal(timeoutMs),
    });
  } catch {
    return { kind: "network" };
  }
  const body = await readJsonBody(response);
  if (response.status === 401) {
    return { kind: "auth", status: 401, reason: typeof body?.reason === "string" ? body.reason : "unknown" };
  }
  if (!response.ok) return { kind: "http", status: response.status, body };
  if (!body) return { kind: "not-json", status: response.status };
  return { kind: "ok", status: response.status, body };
}
