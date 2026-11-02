// Calls from the learner page to the tutor's own server (WP-108b): pasting a brief, opening what was
// read, confirming the draft task and adding a typed task. The address is the one the Worker's
// /status gave the waker. No DOM-only or Node-only APIs: fetch and the clock are passed in for tests.
// WP-111b: the conversation calls, which wait longer because a tutor reply can take a minute or two.
import { readJsonBody, timeoutSignal } from "./auth.js";
import { CONVERSATION_TIMEOUT_MS } from "./conversation.js";

export const API_TIMEOUT_MS = 20_000;
// Waiting for a pasted brief (or a photo still being read) before showing "Check the details".
export const READ_POLL = Object.freeze({ stepMs: 3000, limitMs: 90_000 });

export const API_ERRORS = Object.freeze({
  network: "Can't reach the tutor. Check your connection, then try again.",
  notReady: "The tutor isn't quite ready. Please try again in a minute.",
  busy: "That's a lot in a short time. Please wait a minute, then try again.",
  notAllowed: "Only the learner can do this.",
  notFound: "That couldn't be found. It may have been removed.",
  tooBig: "That's too much to send in one go.",
  server: "Something went wrong. Please try again.",
});

/** The server address for a path, or null if the address isn't a plain https origin. */
export function apiUrl(backendUrl, path) {
  if (typeof backendUrl !== "string" || !/^https:\/\/[^\s/]+\/?$/.test(backendUrl.trim())) return null;
  return `${backendUrl.trim().replace(/\/+$/, "")}/${String(path).replace(/^\/+/, "")}`;
}

/**
 * One request with the pass. The pass and JSON body make the browser send a preflight first,
 * which the server answers for the Pages origin.
 * @returns {Promise<{ kind: "ok", status, body } | { kind: "auth", status: 401, reason } |
 *   { kind: "http", status, body } | { kind: "not-json", status } | { kind: "network" } | { kind: "no-address" }>}
 */
export async function apiRequest({
  backendUrl, path, token, method = "GET", body, fetchImpl = globalThis.fetch, timeoutMs = API_TIMEOUT_MS,
}) {
  const url = apiUrl(backendUrl, path);
  if (!url || !token) return { kind: "no-address" };
  const headers = { Accept: "application/json", Authorization: `Bearer ${token}` };
  const init = { method, headers, cache: "no-store", signal: timeoutSignal(timeoutMs) };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetchImpl(url, init);
  } catch {
    return { kind: "network" };
  }
  const json = await readJsonBody(response);
  if (response.status === 401) return { kind: "auth", status: 401, reason: typeof json?.reason === "string" ? json.reason : "unknown" };
  if (!json) return { kind: "not-json", status: response.status };
  if (!response.ok) return { kind: "http", status: response.status, body: json };
  return { kind: "ok", status: response.status, body: json };
}

/** A plain message for a failed request. The server's own 400/409 messages name fields only. */
export function apiErrorMessage(result) {
  if (!result || result.kind === "network" || result.kind === "no-address" || result.kind === "not-json") return API_ERRORS.network;
  if (result.kind !== "http") return API_ERRORS.server;
  if (result.status === 503) return API_ERRORS.notReady;
  if (result.status === 429) return API_ERRORS.busy;
  if (result.status === 403) return API_ERRORS.notAllowed;
  if (result.status === 404) return API_ERRORS.notFound;
  if (result.status === 413) return API_ERRORS.tooBig;
  if ((result.status === 400 || result.status === 409) && typeof result.body?.error === "string") return result.body.error;
  return API_ERRORS.server;
}

/** The calls the learner page makes, bound to the current address and pass. */
export function createApi({
  getBackendUrl, getToken, fetchImpl = globalThis.fetch, timeoutMs = API_TIMEOUT_MS, talkTimeoutMs = CONVERSATION_TIMEOUT_MS,
}) {
  const call = (path, { method = "GET", body, timeout = timeoutMs } = {}) =>
    apiRequest({ backendUrl: getBackendUrl(), path, token: getToken(), method, body, fetchImpl, timeoutMs: timeout });
  const uploadPath = (id) => `api/uploads/${encodeURIComponent(id)}`;
  const conversationPath = (id) => `api/conversations/${encodeURIComponent(id)}`;
  // calls that wait for a tutor reply
  const talk = (path, body) => call(path, { method: "POST", body, timeout: talkTimeoutMs });
  return {
    call,
    pasteBrief: ({ clientId, text }) => call("api/uploads/paste", { method: "POST", body: { clientId, text } }),
    openUpload: (id) => call(uploadPath(id)),
    confirmUpload: (id, body) => call(`${uploadPath(id)}/confirm`, { method: "POST", body }),
    addTask: (body) => call("api/tasks", { method: "POST", body }),
    // WP-109: the open tasks for "Coming up", and changing a task's stage or deadline
    openTasks: () => call("api/tasks?open=1"),
    updateTask: (id, body) => call(`api/tasks/${encodeURIComponent(id)}`, { method: "PATCH", body }),
    // WP-111b: route choice, conversations, the support pairs and votes (server routes from WP-111a)
    suggestRoute: (body) => talk("api/route", body),
    startConversation: (body) => call("api/conversations", { method: "POST", body }),
    openConversation: (id) => call(conversationPath(id)),
    sendMessage: (id, body) => talk(`${conversationPath(id)}/messages`, body),
    requestSupport: (id, type) => talk(`${conversationPath(id)}/support`, { type }),
    vote: (turnId, vote) => call(`api/turns/${encodeURIComponent(turnId)}/vote`, { method: "POST", body: { vote } }),
  };
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Opens an upload, checking again while it is still being read.
 * @returns {Promise<{ kind: "ok", upload } | { kind: "timeout" } | { kind: "stopped" } | a failed apiRequest result>}
 */
export async function waitForReading({
  api, uploadId, sleep = defaultSleep, now = () => Date.now(), stepMs = READ_POLL.stepMs,
  limitMs = READ_POLL.limitMs, stopped = () => false, onWaiting = () => {},
}) {
  const started = now();
  for (;;) {
    const result = await api.openUpload(uploadId);
    if (stopped()) return { kind: "stopped" };
    if (result.kind !== "ok") return result;
    const upload = result.body?.upload;
    if (upload?.status !== "processing") return { kind: "ok", upload };
    if (now() - started >= limitMs) return { kind: "timeout" };
    onWaiting();
    await sleep(stepMs);
    if (stopped()) return { kind: "stopped" };
  }
}
