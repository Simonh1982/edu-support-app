// Verify step 8, parent-role part (blueprint §13): through the live Worker, the learner can open
// both of two invented test notes, the parent can open only the shared one, and each role gets only
// its own section of the snapshot. Run in the Codespace, after the Worker has STORAGE_TOKEN and
// STORAGE_REPO. The notes are written to the storage repository from a temporary clone and deleted
// at the end. Never prints a pass, a token, a login or the storage repository's name.
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { passSettings, mintPass } from '../server/auth.js';
import { createStore } from '../server/storage/store.js';
import { gitEnv } from '../server/storage/git.js';
import { storageSettings } from '../server/storage/index.js';
import { ukIso, SCHEMA_VERSION } from '../server/storage/records.js';
import { normaliseWorkerUrl } from './worker-check.js';

export const USAGE = 'Usage: node scripts/item-check.js [worker address]';
export const TEST_IDS = Object.freeze({ shared: 'item-check-shared', unshared: 'item-check-unshared' });
const ATTEMPTS = 6;
const RETRY_MS = 2_000;

/** An invented notebook entry with every standard record field. */
export function testNote(id, shared, now = new Date()) {
  const at = ukIso(now);
  return {
    id,
    createdAt: at,
    updatedAt: at,
    createdBy: 'system',
    schemaVersion: SCHEMA_VERSION,
    type: 'note',
    title: 'Item check (test note)',
    text: { value: 'An invented note written by the item check. It is deleted at the end.', author: 'ai' },
    sharedWithParent: shared ? at : null,
  };
}

function firstLogin(accounts, role) {
  return Object.keys(accounts).find((login) => accounts[login] === role) ?? null;
}

function sleepDefault(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs the check and prints one line per step. Returns true on PASS.
 * fetchImpl, makeStore, tmpRoot and sleep are replaceable for tests.
 */
export async function runCheck({
  workerUrl, env = process.env, fetchImpl = globalThis.fetch, makeStore = createStore,
  tmpRoot = os.tmpdir(), out = console.log, sleep = sleepDefault, now = () => new Date(),
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

  // Short shared-computer passes (4 hours), made here and never printed
  const passes = {
    learner: await mintPass({ login: learner, shared: true, settings }),
    parent: await mintPass({ login: parent, shared: true, settings }),
  };
  const get = async (role, route) => {
    try {
      const response = await fetchImpl(`${workerUrl}${route}`, {
        headers: { Authorization: `Bearer ${passes[role]}`, Accept: 'application/json' },
      });
      const body = await response.json().catch(() => null);
      return { status: response.status, body };
    } catch (err) {
      return { status: 0, body: { error: err?.name ?? 'network error' } };
    }
  };
  // GitHub can take a moment to serve a file that has just been pushed
  const getWhenThere = async (role, route) => {
    let result;
    for (let i = 0; i < ATTEMPTS; i += 1) {
      result = await get(role, route);
      if (result.status !== 404) return result;
      await sleep(RETRY_MS);
    }
    return result;
  };
  const why = (result) => `status ${result.status}${result.body?.error ? `: ${result.body.error}` : ''}`;
  const itemRoute = (id) => `/item?type=notebook&id=${id}`;

  // 3–6. Through the live Worker
  async function checkWorker() {
    // 3. Snapshot: each role gets only its own section
    const learnerSnap = await get('learner', '/snapshot');
    const parentSnap = await get('parent', '/snapshot');
    if (learnerSnap.status === 404 || parentSnap.status === 404) {
      line(3, 'Snapshot sections', false, 'no snapshot yet: run npm run server, wait 30 seconds, then try again');
    } else {
      const learnerOk = learnerSnap.status === 200 && Array.isArray(learnerSnap.body?.recent) && !('shared' in learnerSnap.body);
      const parentOk = parentSnap.status === 200 && Array.isArray(parentSnap.body?.shared)
        && !['recent', 'settings', 'inboxPending'].some((key) => key in parentSnap.body);
      line(3, 'Snapshot sections', learnerOk && parentOk,
        learnerOk && parentOk ? '' : `learner ${why(learnerSnap)}, parent ${why(parentSnap)}`);
    }

    // 4–6. Items
    const learnerShared = await getWhenThere('learner', itemRoute(TEST_IDS.shared));
    const learnerUnshared = await getWhenThere('learner', itemRoute(TEST_IDS.unshared));
    const learnerOk = learnerShared.status === 200 && learnerUnshared.status === 200;
    line(4, 'Learner can open both notes', learnerOk, learnerOk ? '' : `${why(learnerShared)}; ${why(learnerUnshared)}`);
    const parentShared = await getWhenThere('parent', itemRoute(TEST_IDS.shared));
    line(5, 'Parent can open the shared note', parentShared.status === 200, parentShared.status === 200 ? '' : why(parentShared));
    // only meaningful once step 4 has shown the note is there
    const parentUnshared = await get('parent', itemRoute(TEST_IDS.unshared));
    const blocked = learnerOk && parentUnshared.status === 404;
    line(6, "Parent can't open the unshared note", blocked,
      blocked ? 'refused' : learnerOk ? why(parentUnshared) : 'not tested, because step 4 failed');
  }

  // 2. Write the two test notes from a temporary clone
  const tmp = await mkdtemp(path.join(tmpRoot, 'item-check-'));
  let store = null;
  try {
    store = makeStore({ dir: path.join(tmp, 'clone'), remoteUrl: storage.remoteUrl, env: gitEnv({ token: storage.token, env }) });
    let wrote = false;
    let detail = '';
    if (await store.init()) {
      await store.put(`notebook/${TEST_IDS.shared}.json`, testNote(TEST_IDS.shared, true, now()));
      await store.put(`notebook/${TEST_IDS.unshared}.json`, testNote(TEST_IDS.unshared, false, now()));
      const result = await store.flush();
      wrote = !result.error;
      detail = result.error ?? '';
    } else {
      detail = store.status().detail;
    }
    if (line(2, 'Write two invented test notes', wrote, detail)) await checkWorker();
  } finally {
    // 7. Always tidy up, even after a failure
    let tidy = false;
    let detail = '';
    try {
      if (store && store.status().ready) {
        await store.remove(`notebook/${TEST_IDS.shared}.json`);
        await store.remove(`notebook/${TEST_IDS.unshared}.json`);
        const result = await store.flush();
        tidy = !result.error;
        detail = result.error ?? '';
      } else {
        tidy = true;
      }
    } catch (err) {
      detail = err.message;
    }
    await rm(tmp, { recursive: true, force: true });
    line(7, 'Delete the test notes', tidy, detail);
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
  const ok = await runCheck({ workerUrl });
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
