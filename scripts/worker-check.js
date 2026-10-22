// Phase 0 check after WP-011: is the Worker set up, and do its pass secrets match this Codespace's?
// It mints a short (4-hour) pass here, then asks the Worker for /status and /wake. Waking an
// already-running Codespace starts nothing. Prints no secret, pass or account name.
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { passSettings, mintPass } from '../server/auth.js';

export const USAGE = 'Usage: node scripts/worker-check.js [worker address]';

const HINTS = Object.freeze({
  signature: 'PASS_SIGNING_KEY is different in the Worker and the Codespace',
  version: 'PASS_VERSION is different in the Worker and the Codespace',
  account: 'ALLOWED_ACCOUNTS is different in the Worker and the Codespace',
  malformed: 'the Worker could not read the pass; check PASS_SIGNING_KEY in both places',
  missing: 'the pass was not sent',
});

export function normaliseWorkerUrl(text) {
  try {
    const url = new URL(String(text ?? '').trim());
    return url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

export function expectedBackendUrl(env = process.env) {
  const name = String(env.CODESPACE_NAME ?? '').trim();
  const domain = String(env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN ?? '').trim();
  return name && domain ? `https://${name}-3000.${domain}` : null;
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function githubDetail(status, body) {
  const parts = [`${status}: ${body.error ?? 'no detail'}`];
  if (body.acceptedPermissions) parts.push(`the token needs: ${body.acceptedPermissions}`);
  return parts.join('; ');
}

// Returns true when every step passes. fetchImpl is replaceable for tests.
export async function runCheck({ workerUrl, env = process.env, fetchImpl = fetch, out = console.log }) {
  let allOk = true;
  const step = (n, label, ok, detail = '') => {
    out(`${n}. ${label}: ${ok ? 'OK' : 'FAIL'}${detail ? ` (${detail})` : ''}`);
    if (!ok) allOk = false;
    return ok;
  };

  let response;
  let body;
  try {
    response = await fetchImpl(`${workerUrl}/`, { headers: { Accept: 'application/json' } });
    body = await readJson(response);
  } catch (err) {
    step(1, 'Worker answers', false, `could not reach it: ${err?.name ?? 'error'}`);
    return false;
  }
  const missing = Array.isArray(body.missing) ? body.missing : [];
  const problems = Array.isArray(body.settingsErrors) ? body.settingsErrors : [];
  const detail = missing.length > 0 ? `missing: ${missing.join(', ')}` : problems.join('; ');
  step(1, 'Worker settings', response.ok && body.ok === true, detail || (response.ok ? '' : `status ${response.status}`));

  const { settings, errors } = passSettings(env);
  if (!step(2, 'Codespace pass secrets', Boolean(settings), errors.join('; '))) return false;

  const login = Object.keys(settings.accounts)[0];
  const pass = await mintPass({ login, shared: true, settings });
  const headers = { Authorization: `Bearer ${pass}`, Accept: 'application/json' };

  response = await fetchImpl(`${workerUrl}/status`, { headers });
  body = await readJson(response);
  if (response.status === 401) {
    step(3, 'Worker accepts a pass made in the Codespace', false, HINTS[body.reason] ?? `reason: ${body.reason ?? 'unknown'}`);
    return false;
  }
  if (!step(3, 'Worker accepts a pass and reads the Codespace status', response.ok,
    response.ok ? `state: ${body.state}` : githubDetail(response.status, body))) return false;

  const expected = expectedBackendUrl(env);
  if (expected) {
    step(4, 'Backend address matches this Codespace', body.backendUrl === expected,
      body.backendUrl === expected ? '' : 'CODESPACE_NAME in the Worker is not this Codespace\'s name');
  } else {
    step(4, 'Backend address matches this Codespace', false, 'not running in a Codespace, so it cannot be compared');
  }

  response = await fetchImpl(`${workerUrl}/wake`, { method: 'POST', headers });
  body = await readJson(response);
  step(5, 'Wake request (Codespace already awake)', response.ok,
    response.ok ? `state: ${body.state}, started: ${body.started}` : githubDetail(response.status, body));
  return allOk;
}

async function main() {
  const arg = process.argv[2];
  if (arg === '--help' || arg === '-h') {
    console.log(USAGE);
    return 0;
  }
  let input = arg;
  if (!input) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    input = await rl.question('Paste the Worker address (from Cloudflare) and press Enter: ');
    rl.close();
  }
  const workerUrl = normaliseWorkerUrl(input);
  if (!workerUrl) {
    console.log('That is not an https:// address.');
    console.log(USAGE);
    return 2;
  }
  const ok = await runCheck({ workerUrl });
  console.log(`Result: ${ok ? 'PASS' : 'FAIL'}`);
  return ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }, (err) => {
    console.error(`worker-check failed: ${err?.message ?? err}`);
    process.exitCode = 1;
  });
}
