// Waking the tutor from the browser (blueprint §9.1, proven pattern).
// No DOM-only or Node-only APIs: fetch, the clock and sleep are passed in for tests.
import { readJsonBody, timeoutSignal, workerRequest, REQUEST_TIMEOUT_MS } from "./auth.js";

export const WAKE_SETTINGS = Object.freeze({
  pollMs: 5000, // check the backend every 5 s
  maxMs: 5 * 60 * 1000, // for up to 5 minutes
  statusEvery: 3, // read the Worker's /status on every third check
  reringAfterMs: 30 * 1000, // ring again if still Shutdown 30 s after the last ring
  portHintAfterMs: 90 * 1000, // Available this long with no answer: port probably Private
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
});

export const WAKE_MESSAGES = Object.freeze({
  checking: "Checking the tutor…",
  waking: "Waking the tutor – this usually takes a minute or two.",
  starting: "Tutor getting ready – about a minute.",
  nearly: "Tutor nearly ready…",
  ready: "Tutor ready.",
  readyNoAi: "Connected, but the AI isn't available right now.",
  port: "The tutor is awake but can't be reached yet. Its connection is probably still private. This usually sorts itself out within 3 minutes.",
  warning: "GitHub is showing a warning page instead of the tutor.",
  timeout: "The tutor didn't wake up within 5 minutes. Please try again.",
  worker: "Can't reach the sign-in service. Check your internet connection, then try again.",
  wakeFailed: "The tutor couldn't be woken. Please try again later.",
  notConfigured: "Sign-in isn't connected yet. Please try again later.",
  signedOut: "Your sign-in is no longer valid. Please sign in again.",
});

/**
 * Asks the backend's /api/health whether it is ready. Sends Accept: application/json and
 * no custom headers, so the browser makes a simple request with no preflight.
 * @returns {Promise<{ kind: "ok", aiReady, restsAt } | { kind: "starting" } |
 *   { kind: "not-json", status } | { kind: "http", status } | { kind: "network" } |
 *   { kind: "no-address" }>}
 *   "not-json" means something answered with a page that isn't ours (e.g. GitHub's
 *   warning page). A Private port and a blocked page both look like "network".
 */
export async function probeHealth({ backendUrl, fetchImpl = globalThis.fetch, timeoutMs = REQUEST_TIMEOUT_MS }) {
  if (typeof backendUrl !== "string" || !/^https:\/\/[^\s/]+/.test(backendUrl)) return { kind: "no-address" };
  const url = `${backendUrl.replace(/\/+$/, "")}/api/health`;
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: timeoutSignal(timeoutMs),
    });
  } catch {
    return { kind: "network" };
  }
  const body = await readJsonBody(response);
  if (!body) return { kind: "not-json", status: response.status };
  if (!response.ok || body.ok !== true) return { kind: "http", status: response.status };
  if (body.ai?.mode === "starting") return { kind: "starting" };
  return {
    kind: "ok",
    aiReady: body.ai?.ready === true,
    restsAt: typeof body.restsAt === "string" ? body.restsAt : null,
  };
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Creates a waker. run() resolves with the final state:
 * ready | readyNoAi | timeout | worker | wakeFailed | notConfigured | signedOut | stopped.
 * onUpdate({ state, message }) is called on every check; the page skips repeats.
 */
export function createWaker({
  workerUrl,
  token,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  sleep = defaultSleep,
  onUpdate = () => {},
  log = console,
  settings = WAKE_SETTINGS,
} = {}) {
  let stopped = false;
  const STOPPED = Object.freeze({ state: "stopped" });

  const update = (state, extra = {}) => {
    if (!stopped) onUpdate({ state, message: WAKE_MESSAGES[state], ...extra });
  };
  const finish = (state, extra = {}) => {
    if (stopped) return STOPPED;
    update(state, extra);
    return { state, ...extra };
  };
  const worker = (path, method) =>
    workerRequest({ workerUrl, path, token, method, fetchImpl, timeoutMs: settings.requestTimeoutMs });
  const health = (backendUrl) => probeHealth({ backendUrl, fetchImpl, timeoutMs: settings.requestTimeoutMs });

  const workerFailure = (result) => {
    if (result.kind === "auth") return finish("signedOut", { reason: result.reason });
    if (result.kind === "not-configured") return finish("notConfigured");
    if (result.kind === "network") return finish("worker");
    return finish("wakeFailed", { status: result.status ?? null });
  };
  const ready = (h) => finish(h.aiReady ? "ready" : "readyNoAi", { restsAt: h.restsAt });
  const fatal = (result) => result.kind === "auth" || result.kind === "not-configured";

  async function run() {
    stopped = false;
    update("checking");

    const first = await worker("status", "GET");
    if (stopped) return STOPPED;
    if (first.kind !== "ok") return workerFailure(first);

    let codespace = String(first.body.state ?? "Unknown");
    let backendUrl = first.body.backendUrl ?? null;

    if (codespace === "Available") {
      const h = await health(backendUrl);
      if (stopped) return STOPPED;
      if (h.kind === "ok") return ready(h);
    }

    const startedAt = now();
    let availableSince = codespace === "Available" ? startedAt : null;
    let lastRing = null;
    let portLogged = false;

    const noteState = (state) => {
      codespace = state;
      if (state === "Available") availableSince ??= now();
      else availableSince = null;
    };
    // Returns null on success, or the failed Worker result.
    const ring = async () => {
      const result = await worker("wake", "POST");
      lastRing = now();
      if (result.kind !== "ok") return result;
      if (typeof result.body.state === "string") noteState(result.body.state);
      backendUrl = result.body.backendUrl ?? backendUrl;
      return null;
    };

    if (codespace !== "Available") {
      const failed = await ring();
      if (stopped) return STOPPED;
      if (failed) return workerFailure(failed);
    }
    update(codespace === "Available" ? "starting" : "waking");

    let checks = 0;
    while (now() - startedAt < settings.maxMs) {
      await sleep(settings.pollMs);
      if (stopped) return STOPPED;
      checks += 1;

      const h = await health(backendUrl);
      if (stopped) return STOPPED;
      if (h.kind === "ok") return ready(h);

      if (checks % settings.statusEvery === 0) {
        const status = await worker("status", "GET");
        if (stopped) return STOPPED;
        if (fatal(status)) return workerFailure(status);
        if (status.kind === "ok") {
          noteState(String(status.body.state ?? codespace));
          backendUrl = status.body.backendUrl ?? backendUrl;
          // The first ring may have arrived while the Codespace was still shutting down.
          if (codespace === "Shutdown" && (lastRing === null || now() - lastRing > settings.reringAfterMs)) {
            const failed = await ring();
            if (stopped) return STOPPED;
            if (failed && fatal(failed)) return workerFailure(failed);
          }
        }
      }

      if (h.kind === "starting") {
        update("nearly");
      } else if (h.kind === "not-json") {
        update("warning");
      } else if (availableSince !== null && now() - availableSince > settings.portHintAfterMs) {
        if (!portLogged) {
          log.warn?.("[wake] Codespace has been Available for over 90 s but the tutor isn't answering");
          portLogged = true;
        }
        update("port");
      } else {
        update(codespace === "Available" ? "starting" : "waking");
      }
    }
    return finish("timeout");
  }

  return {
    run,
    stop() {
      stopped = true;
    },
  };
}
