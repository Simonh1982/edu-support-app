// npm run storage:check — verify step 7 (blueprint §13): clone the storage repository, write and
// push, then prove that a push still succeeds after someone else commits to inbox/ (pull-before-push).
// Uses its own temporary clone, so it never runs git at the same time as the server's clone.
// Prints no token and no repository name.
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { createStore } from '../server/storage/store.js';
import { gitEnv } from '../server/storage/git.js';
import { storageSettings } from '../server/storage/index.js';

export const INBOX_TEST_FILE = 'inbox/storage-check.txt';
export const USAGE = 'Usage: npm run storage:check [-- --no-wait]';

export function parseArgs(argv) {
  const out = { wait: true };
  for (const arg of argv) {
    if (arg === '--no-wait') out.wait = false;
    else throw new Error(`Unknown option: ${arg}\n${USAGE}`);
  }
  return out;
}

/** Runs the check. `waitForOwner` pauses while Simon commits to inbox/ on GitHub. */
export async function runCheck({ settings, wait = true, waitForOwner, makeStore = createStore, tmpRoot = os.tmpdir(), out = console.log }) {
  const base = await mkdtemp(path.join(tmpRoot, 'storage-check-'));
  const dir = path.join(base, 'clone');
  const lines = [];
  const say = (line) => { lines.push(line); out(line); };
  let verdict = 'FAIL';
  try {
    const store = makeStore({
      dir, remoteUrl: settings.remoteUrl, env: settings.env ?? gitEnv({ token: settings.token }),
      log: { log() {}, error() {} }, batchMs: 60_000,
    });
    if (!(await store.init())) {
      say(`1. clone: FAIL (${store.status().detail})`);
      return { verdict, lines };
    }
    say('1. clone: OK');
    await store.logEvent('storage.check', { payload: { step: 1 } });
    const first = await store.flush();
    if (!first.pushed) {
      say(`2. write and push: FAIL (${first.error || 'nothing was pushed'})`);
      return { verdict, lines };
    }
    say('2. write and push: OK');
    if (!wait) {
      verdict = 'PASS (steps 1–2 only; run without --no-wait for the inbox test)';
      say(`Result: ${verdict}`);
      return { verdict, lines };
    }
    await waitForOwner();
    await store.logEvent('storage.check', { payload: { step: 2 } });
    const second = await store.flush();
    const sawInbox = existsSync(path.join(dir, INBOX_TEST_FILE));
    if (!second.pushed) {
      say(`3. push after an inbox commit: FAIL (${second.error || 'nothing was pushed'})`);
      return { verdict, lines };
    }
    say(`3. push after an inbox commit: OK (pulled ${second.pulled} new commit${second.pulled === 1 ? '' : 's'} first)`);
    if (second.pulled > 0 && sawInbox) verdict = 'PASS';
    else verdict = `CHECK (${sawInbox ? 'no new commits were pulled' : `${INBOX_TEST_FILE} was not found`}; was it committed on GitHub before pressing Enter?)`;
    say(`Result: ${verdict}`);
    return { verdict, lines };
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  const settings = storageSettings(process.env);
  if (settings.skip) {
    console.error(`Storage check not run: ${settings.skip}.`);
    console.error('Add the STORAGE_REPO and STORAGE_TOKEN Codespaces secrets, then fully stop and start the Codespace.');
    process.exit(1);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const { verdict } = await runCheck({
      settings,
      wait: args.wait,
      waitForOwner: async () => {
        console.log('');
        console.log(`Now, on GitHub, add a file called ${INBOX_TEST_FILE} to the storage repository`);
        console.log('(any short text will do) and commit it. Then come back here.');
        await rl.question('Press Enter once the commit is made… ');
      },
    });
    process.exitCode = verdict.startsWith('PASS') ? 0 : 1;
  } finally {
    rl.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
