// Verify step 10 and the server half of step 9 (blueprint §13): through the live Worker, send a small
// invented photo and an 8 MB invented capture to the inbox, check the parent can't add captures, then
// check the running server takes both in, marks the 8 MB "photo" failed against the light model's own
// limit (A-002), and that the Worker stops listing them. Run in the Codespace with the server running.
// Everything it adds is deleted at the end. Never prints a pass, a token, a login or the storage
// repository's name.
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { passSettings, mintPass } from '../server/auth.js';
import { createStore } from '../server/storage/store.js';
import { gitEnv } from '../server/storage/git.js';
import { storageSettings } from '../server/storage/index.js';
import { ukIso } from '../server/storage/records.js';
import { INBOX_MAX_BYTES, inboxPaths, uploadIdFor } from '../server/storage/inbox.js';
import { encodePng } from './make-icons.js';
import { normaliseWorkerUrl } from './worker-check.js';

export const USAGE = 'Usage: node scripts/inbox-check.js [worker address]';
// Just under the 8 MB limit. Repeated invented text, so it compresses to almost nothing in git history.
export const LARGE_BYTES = INBOX_MAX_BYTES - 64 * 1024;
const WAIT_MS = 90_000;
const STEP_MS = 3_000;

/** Device-style IDs for this run, so a rerun never collides with an earlier one. */
export function checkIds(now = new Date()) {
  const stamp = now.getTime().toString(36);
  return { small: `inbox-check-small-${stamp}`, large: `inbox-check-large-${stamp}` };
}

/** The two invented captures, as base64 text (the form the device sends). */
export function captures(largeBytes = LARGE_BYTES) {
  const filler = Buffer.from('Invented inbox-check filler. Not a real photo. ');
  const large = Buffer.alloc(largeBytes);
  for (let i = 0; i < largeBytes; i += filler.length) filler.copy(large, i, 0, Math.min(filler.length, largeBytes - i));
  return {
    small: { type: 'image/png', base64: encodePng(64).toString('base64') },
    // labelled as a photo on purpose: it is far over the light model's per-image limit
    large: { type: 'image/jpeg', base64: large.toString('base64'), bytes: largeBytes },
  };
}

function firstLogin(accounts, role) {
  return Object.keys(accounts).find((login) => accounts[login] === role) ?? null;
}

function sleepDefault(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJsonFile(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Runs the check and prints one line per step. Returns true on PASS.
 * fetchImpl, makeStore, tmpRoot, sleep, clock and readRecord are replaceable for tests.
 */
export async function runCheck({
  workerUrl, env = process.env, fetchImpl = globalThis.fetch, makeStore = createStore, tmpRoot = os.tmpdir(),
  out = console.log, sleep = sleepDefault, now = () => new Date(), clock = () => Date.now(),
  waitMs = WAIT_MS, stepMs = STEP_MS, largeBytes = LARGE_BYTES, readRecord = null,
}) {
  let allOk = true;
  const line = (n, label, ok, detail) => {
    if (!ok) allOk = false;
    out(`${n}. ${label}: ${ok ? 'OK' : 'FAIL'}${detail ? ` (${detail})` : ''}`);
    return ok;
  };
  const finish = () => {
    out(`Result: ${allOk ? 'PASS' : 'FAIL'}`);
    return allOk;
  };

  // 1. Settings in this Codespace
  const { settings, errors } = passSettings(env);
  const storage = storageSettings(env);
  const learner = settings ? firstLogin(settings.accounts, 'learner') : null;
  const parent = settings ? firstLogin(settings.accounts, 'parent') : null;
  const problems = [...errors];
  if (storage.skip) problems.push(storage.skip);
  if (settings && !learner) problems.push('ALLOWED_ACCOUNTS has no learner account');
  if (settings && !parent) problems.push('ALLOWED_ACCOUNTS has no parent account');
  if (!line(1, 'Codespace settings', problems.length === 0, problems.join('; '))) return finish();

  const ids = checkIds(now());
  const files = captures(largeBytes);
  // short shared-computer passes (4 hours), made here and never printed
  const passes = {
    learner: await mintPass({ login: learner, shared: true, settings }),
    parent: await mintPass({ login: parent, shared: true, settings }),
  };
  const call = async (role, route, init = {}) => {
    try {
      const response = await fetchImpl(`${workerUrl}${route}`, {
        ...init, headers: { Authorization: `Bearer ${passes[role]}`, Accept: 'application/json', ...(init.headers ?? {}) },
      });
      const text = await response.text();
      let body = null;
      try { body = JSON.parse(text); } catch { body = { error: text.slice(0, 120) }; }
      return { status: response.status, body };
    } catch (err) {
      return { status: 0, body: { error: err?.name ?? 'network error' } };
    }
  };
  const send = (role, clientId, file, source) => {
    const query = new URLSearchParams({ clientId, type: file.type, source, kind: 'own', capturedAt: ukIso(now()) });
    return call(role, `/inbox?${query}`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: file.base64 });
  };
  const why = (result) => `status ${result.status}${result.body?.error ? `: ${result.body.error}` : ''}`;
  const recordFile = (id) => path.join(storage.dir, 'uploads', `${uploadIdFor(id)}.json`);
  const record = readRecord ?? ((id) => readJsonFile(recordFile(id)));

  try {
    // 2. Small photo
    const small = await send('learner', ids.small, files.small, 'camera');
    if (!line(2, 'Small photo to the Worker inbox', small.status === 201, small.status === 201 ? '' : why(small))) return finish();

    // 3. 8 MB capture: Cloudflare stops a Worker that uses too much CPU with a 503 (error 1102)
    const started = clock();
    const large = await send('learner', ids.large, files.large, 'gallery');
    const seconds = ((clock() - started) / 1000).toFixed(1);
    const cpuHint = large.status === 503 ? 'Cloudflare stopped the Worker, probably its CPU limit' : why(large);
    line(3, '8 MB capture to the Worker inbox', large.status === 201, large.status === 201 ? `${seconds} s` : cpuHint);

    // 4. The parent can't add captures
    const parentTry = await send('parent', `${ids.small}-p`, files.small, 'camera');
    line(4, "Parent can't add captures", parentTry.status === 403, parentTry.status === 403 ? 'refused' : why(parentTry));

    // 5–7. The running server takes them in
    const sent = large.status === 201 ? [ids.small, ids.large] : [ids.small];
    const waitStart = clock();
    let records = {};
    let listed = sent;
    while (clock() - waitStart < waitMs) {
      records = Object.fromEntries(await Promise.all(sent.map(async (id) => [id, await record(id)])));
      const list = await call('learner', '/inbox');
      listed = list.status === 200 ? sent.filter((id) => list.body.items.some((item) => item.clientId === id)) : sent;
      if (sent.every((id) => records[id]) && listed.length === 0) break;
      await sleep(stepMs);
    }
    const tookIn = sent.every((id) => records[id]);
    const waited = Math.round((clock() - waitStart) / 1000);
    line(5, 'Server took the captures in', tookIn,
      tookIn ? `within about ${waited} s` : 'not yet: is the server running? Run npm run server, wait 30 seconds, then try again');
    line(6, 'Worker no longer lists them', tookIn && listed.length === 0,
      listed.length === 0 ? '' : `${listed.length} still listed after ${waited} s`);
    const smallRecord = records[ids.small];
    const largeRecord = records[ids.large];
    const smallOk = smallRecord?.status === 'processing' && smallRecord?.sizeCheck === 'passed';
    const largeOk = largeRecord?.status === 'failed' && largeRecord?.failureReason === 'too-large';
    let detail = '';
    if (!largeRecord) detail = 'not tested, because step 3 or 5 failed';
    else if (largeRecord.sizeCheck === 'not-checked') detail = "the server couldn't read the model's limits: check ai in /api/health";
    else if (!smallOk || !largeOk) detail = `small: ${smallRecord?.status}/${smallRecord?.sizeCheck}, large: ${largeRecord?.status}/${largeRecord?.failureReason}`;
    line(7, 'Image check against the model limit (A-002)', smallOk && largeOk, detail || 'small photo passed, 8 MB photo marked failed');
  } finally {
    // 8. Always tidy up from a temporary clone, even after a failure
    const tmp = await mkdtemp(path.join(tmpRoot, 'inbox-check-'));
    let tidy = false;
    let detail = '';
    try {
      const store = makeStore({ dir: path.join(tmp, 'clone'), remoteUrl: storage.remoteUrl, env: gitEnv({ token: storage.token, env }) });
      if (await store.init()) {
        for (const [id, file] of [[ids.small, files.small], [ids.large, files.large]]) {
          const paths = inboxPaths(id, file.type);
          const upload = uploadIdFor(id);
          const ext = paths.file.split('.').pop();
          for (const p of [paths.file, paths.meta]) await store.remove(p, { allowInbox: true });
          for (const p of [`uploads/${upload}.${ext}`, `uploads/${upload}.json`]) await store.remove(p);
        }
        const result = await store.flush();
        tidy = !result.error;
        detail = result.error ?? '';
      } else {
        detail = store.status().detail;
      }
    } catch (err) {
      detail = err.message;
    }
    await rm(tmp, { recursive: true, force: true });
    line(8, 'Delete the test captures', tidy, detail);
  }
  return finish();
}

async function main() {
  let address = process.argv[2];
  if (!address) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    address = await rl.question('Paste the Worker address (from Cloudflare) and press Enter: ');
    rl.close();
  }
  const workerUrl = normaliseWorkerUrl(address);
  if (!workerUrl) {
    console.log(USAGE);
    process.exit(2);
  }
  console.log('This takes up to 2 minutes. Leave it running.');
  const ok = await runCheck({ workerUrl });
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
