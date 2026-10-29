// Alerts to the owner (blueprint §8): the server sends a repository_dispatch event to the storage
// repository, whose alert.yml workflow opens or comments on an issue as github-actions[bot], so
// GitHub notifies the owner. The payload holds the kind, level and UK date only: never anything the
// learner wrote, and never the repository's name in logs or results. Uses the server's existing
// STORAGE_TOKEN (Contents read/write on the storage repository), so no new secret is needed.
import { ukIso } from './storage/records.js';

export const ALERT_EVENT_TYPE = 'app-alert';
// wake-failed is normally sent by the Worker (WP-016); it is allowed here so the check script can test it.
export const ALERT_KINDS = Object.freeze(['wellbeing', 'wake-failed']);
// Only levels 2 and 3 alert the owner (build spec §32.1); level 1 gets a kind reply only.
export const ALERT_LEVELS = Object.freeze([2, 3]);
export const ALERT_TIMEOUT_MS = 10_000;
export const GITHUB_API = 'https://api.github.com';
const REPO_PATTERN = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

/** The UK calendar date, e.g. "2026-10-30" (the workflow uses it in the issue title). */
export function ukDate(now = new Date()) {
  return ukIso(now).slice(0, 10);
}

/** The repository and token to send alerts with, or { skip } with a reason (names only). */
export function alertSettings(env = process.env) {
  const repo = (env.STORAGE_REPO || '').trim();
  const token = env.STORAGE_TOKEN || '';
  if (!repo || !token) return { skip: 'STORAGE_REPO or STORAGE_TOKEN is not set' };
  if (!REPO_PATTERN.test(repo)) return { skip: 'STORAGE_REPO must look like owner/name' };
  return { repo, token };
}

/**
 * The client_payload for alert.yml, or { error }. Only these three fields are ever sent.
 * @returns {{ payload: { kind, level?, date } } | { error: string }}
 */
export function alertPayload({ kind, level, now = new Date() } = {}) {
  if (!ALERT_KINDS.includes(kind)) return { error: `kind must be one of ${ALERT_KINDS.join(', ')}` };
  const date = ukDate(now);
  if (kind === 'wake-failed') return { payload: { kind, date } };
  if (!ALERT_LEVELS.includes(level)) return { error: 'a wellbeing alert needs level 2 or 3' };
  return { payload: { kind, level, date } };
}

// Error text that is safe to log and to show: no repository name, no token, short.
function safeText(text, settings) {
  let out = String(text ?? '');
  if (settings?.token) out = out.split(settings.token).join('<token>');
  if (settings?.repo) out = out.split(settings.repo).join('<storage-repo>');
  return out.replace(/\s+/g, ' ').trim().slice(0, 200);
}

async function githubMessage(response) {
  try {
    const body = JSON.parse(await response.text());
    return typeof body?.message === 'string' ? body.message : '';
  } catch {
    return '';
  }
}

/**
 * Sends one alert. Never throws.
 * GitHub answers 204 (no content) when the dispatch is accepted; the workflow then runs on its own.
 * @returns {Promise<{ ok: true, status: number } |
 *   { ok: false, status: number | null, error: string, acceptedPermissions?: string }>}
 */
export async function sendAlert({
  kind,
  level,
  env = process.env,
  settings = alertSettings(env),
  fetchImpl = globalThis.fetch,
  now = new Date(),
  log = console,
  timeoutMs = ALERT_TIMEOUT_MS,
} = {}) {
  const fail = (status, error, extra = {}) => {
    log.error?.(`[alert] not sent: ${error}`);
    return { ok: false, status, error, ...extra };
  };
  try {
    if (!settings || settings.skip) return fail(null, settings?.skip ?? 'no settings');
    const built = alertPayload({ kind, level, now });
    if (built.error) return fail(null, built.error);

    // VERIFY: POST /repos/{owner}/{repo}/dispatches with a fine-grained token needs Contents: write,
    // and answers 204 on success (GitHub REST docs, "Create a repository dispatch event").
    let response;
    try {
      response = await fetchImpl(`${GITHUB_API}/repos/${settings.repo}/dispatches`, {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${settings.token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'edu-support-app',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({ event_type: ALERT_EVENT_TYPE, client_payload: built.payload }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const reason = err?.name === 'TimeoutError' ? `GitHub didn't answer within ${timeoutMs / 1000} s` : `network error (${safeText(err?.message, settings)})`;
      return fail(null, reason);
    }

    if (response.status === 204 || response.ok) {
      log.log?.(`[alert] sent (${built.payload.kind})`);
      return { ok: true, status: response.status };
    }
    const message = safeText(await githubMessage(response), settings);
    const extra = {};
    // Blueprint §5.3: show the permissions GitHub wanted only for 401, 403 and 404.
    if ([401, 403, 404].includes(response.status)) {
      const wanted = response.headers?.get?.('x-accepted-github-permissions');
      if (wanted) extra.acceptedPermissions = safeText(wanted, settings);
    }
    return fail(response.status, `GitHub answered ${response.status}${message ? `: ${message}` : ''}`, extra);
  } catch (err) {
    return fail(null, `unexpected error (${safeText(err?.message, settings)})`);
  }
}
