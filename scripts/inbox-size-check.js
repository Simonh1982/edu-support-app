// A-011 verify (WP-114g): through the live Worker, send invented captures of about 8, 14 and 20 MB to
// the inbox, then check the running server takes them in. 8 MB uses the proven route; the others are
// streamed through the Worker to GitHub. Each capture is labelled as a photo on purpose, so the server
// marks it failed against the model's image limit and never reads it. Run in the Codespace with the
// server running. Everything it adds is deleted at the end. Never prints a pass, a token, a login or
// the storage repository's name.
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
import { normaliseWorkerUrl } from './worker-check.js';
import { localHealth, waitForServerPush } from './inbox-check.js';

export const USAGE = 'Usage: node scripts/inbox-size-check.js [worker address]';
const MB = 1024 * 1024;
// Just under each size, so the largest is just under the 20 MB limit.
export const SIZES = Object.freeze([8 * MB - 64 * 1024, 14 * MB, INBOX_MAX_BYTES - 64 * 1024]);
const TYPE = 'image/jpeg';
const WAIT_MS = 180_000;
const STEP_MS = 5_000;

/** Device-style IDs for this run, one per size, so a rerun never collides with an earlier one. */
export function sizeIds(now = new Date(), sizes = SIZES) {
  const stamp = now.getTime().toString(36);
  return sizes.map((bytes) => `size-check-${Math.round(bytes / MB)}mb-${stamp}`);
}

/** An invented capture of exactly `bytes` bytes, as base64 text (the form the device sends). */
export function invented(bytes) {
  const filler = Buffer.from('Invented size-check filler. Not a real photo. ');
  const out = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i += filler.length) filler.copy(out, i, 0, Math.min(filler.length, bytes - i));
  return out.toString('base64');
}

/** What a failed send most likely means, in plain words. */
export function sendHint(status) {
  if (status === 413) return 'refused as too large: paste the new wake/worker.js into Cloudflare, then try again';
  if (status === 503) return 'Cloudflare stopped the Worker, probably its CPU or memory limit';
  if (status === 502) return "GitHub didn't accept the file";
  if (status === 0) return "couldn't reach the Worker";
  return `status ${status}`;
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
 * fetchImpl, makeStore, tmpRoot, sleep, clock, sizes and readRecord are replaceable for tests.
 */
export async function runSizeCheck({
  workerUrl, env = process.env, fetchImpl = globalThis.fetch, makeStore = createStore, tmpRoot = os.tmpdir(),
  out = console.log, sleep = sleepDefault, now = () => new Date(), clock = () => Date.now(),
  waitMs = WAIT_MS, stepMs = STEP_MS, sizes = SIZES, readRecord = null, serverHealth = null,
}) {
  let allOk = true;
  let n = 0;
  const line = (label, ok, detail) => {
    n += 1;
    if (!ok) allOk = false;
    out(`${n}. ${label}: ${ok ? 'OK' : 'FAIL'}${detail ? ` (${detail})` : ''}`);
    return ok;
  };
  const finish = () => {
    out(`Result: ${allOk ? 'PASS' : 'FAIL'}`);
    return allOk;
  };

  const { settings, errors } = passSettings(env);
  const storage = storageSettings(env);
  const learner = settings ? firstLogin(settings.accounts, 'learner') : null;
  const problems = [...errors];
  if (storage.skip) problems.push(storage.skip);
  if (settings && !learner) problems.push('ALLOWED_ACCOUNTS has no learner account');
  if (!line('Codespace settings', problems.length === 0, problems.join('; '))) return finish();

  const ids = sizeIds(now(), sizes);
  // a short shared-computer pass (4 hours), made here and never printed
  const pass = await mintPass({ login: learner, shared: true, settings });
  const send = async (clientId, base64) => {
    const query = new URLSearchParams({ clientId, type: TYPE, source: 'file', kind: 'own', capturedAt: ukIso(now()) });
    try {
      const response = await fetchImpl(`${workerUrl}/inbox?${query}`, {
        method: 'POST', headers: { Authorization: `Bearer ${pass}`, Accept: 'application/json', 'Content-Type': 'text/plain' }, body: base64,
      });
      await response.text();
      return response.status;
    } catch {
      return 0;
    }
  };
  const record = readRecord ?? ((id) => readJsonFile(path.join(storage.dir, 'uploads', `${uploadIdFor(id)}.json`)));
  const sent = [];
  try {
    for (const [i, bytes] of sizes.entries()) {
      const started = clock();
      const status = await send(ids[i], invented(bytes));
      const seconds = ((clock() - started) / 1000).toFixed(1);
      const mb = (bytes / MB).toFixed(1);
      if (line(`${mb} MB capture to the Worker inbox`, status === 201, status === 201 ? `${seconds} s` : sendHint(status))) sent.push(ids[i]);
    }

    // The running server takes them in through git, and marks each one failed (too large for a photo).
    const waitStart = clock();
    let records = {};
    while (sent.length && clock() - waitStart < waitMs) {
      records = Object.fromEntries(await Promise.all(sent.map(async (id) => [id, await record(id)])));
      if (sent.every((id) => records[id])) break;
      await sleep(stepMs);
    }
    const tookIn = sent.length > 0 && sent.every((id) => records[id]);
    // the Upload record's byte count comes from the Worker's metadata, so it shows the file arrived whole
    const wrongSize = tookIn ? sent.filter((id) => records[id].bytes !== sizes[ids.indexOf(id)]) : [];
    let detail = `within about ${Math.round((clock() - waitStart) / 1000)} s`;
    if (!sent.length) detail = 'nothing was sent';
    else if (!tookIn) detail = 'not yet: is the server running? Run npm run server, wait 30 seconds, then try again';
    else if (wrongSize.length) detail = `${wrongSize.length} arrived with the wrong size`;
    line('Server took the captures in', tookIn && wrongSize.length === 0, detail);
  } finally {
    // Always tidy up from a temporary clone. First let the server push what it took in (WP-014a-fix).
    if (serverHealth) await waitForServerPush({ serverHealth, sleep, clock, stepMs });
    const tmp = await mkdtemp(path.join(tmpRoot, 'inbox-size-check-'));
    let tidy = false;
    let detail = '';
    try {
      const store = makeStore({ dir: path.join(tmp, 'clone'), remoteUrl: storage.remoteUrl, env: gitEnv({ token: storage.token, env }) });
      if (await store.init()) {
        for (const id of ids) {
          const paths = inboxPaths(id, TYPE);
          const upload = uploadIdFor(id);
          for (const p of [paths.file, paths.meta]) await store.remove(p, { allowInbox: true });
          for (const p of [`uploads/${upload}.jpg`, `uploads/${upload}.json`]) await store.remove(p);
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
    line('Delete the test captures', tidy, detail);
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
  console.log('This takes up to 5 minutes. Leave it running.');
  const ok = await runSizeCheck({ workerUrl, serverHealth: () => localHealth() });
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
