// Starts storage for the server: reads the settings, clones or pulls the storage repository,
// keeps /api/health's `storage` up to date, rewrites the snapshot once per batch, and takes in
// captures from the inbox. Never throws.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './store.js';
import { gitEnv } from './git.js';
import { buildSnapshot } from './snapshot.js';
import { SNAPSHOT_PATH } from './items.js';
import { startInboxPoller } from './inbox.js';

export const DEFAULT_STORAGE_DIR = '/workspaces/storage';
export const APP_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * The storage settings from the environment, or { skip } with a reason.
 * The repository's name only ever comes from STORAGE_REPO (never hard-coded, never logged).
 */
export function storageSettings(env = process.env, { appRoot = APP_ROOT } = {}) {
  const repo = (env.STORAGE_REPO || '').trim();
  const token = env.STORAGE_TOKEN || '';
  if (!repo || !token) return { skip: 'STORAGE_REPO or STORAGE_TOKEN is not set' };
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo)) return { skip: 'STORAGE_REPO must look like owner/name' };
  const dir = path.resolve(env.STORAGE_DIR || DEFAULT_STORAGE_DIR);
  // the clone must sit outside the public app repo, so it can never be committed there by accident
  const rel = path.relative(appRoot, dir);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) return { skip: 'STORAGE_DIR must be outside the app repository' };
  return { repo, token, dir, remoteUrl: `https://github.com/${repo}.git` };
}

/**
 * The store's before-commit step: rebuild index/snapshot.json from the clone (blueprint §4.2 step 4).
 * The first batch after start-up (the system.start event) writes it, so it is fresh after every start.
 */
export function snapshotStep(dir, { build = buildSnapshot } = {}) {
  return async ({ write }) => {
    await write(SNAPSHOT_PATH, await build({ dir }));
  };
}

/**
 * Start storage. Returns the store, or null if storage is skipped or the clone failed.
 * state.storage = { ok, ready, lastPull, lastPush, pending, detail }.
 * getImageLimits: returns the light model's image limits once the AI has read them (A-002), else null.
 */
export async function startStorage({
  state, config, env = process.env, log = console, makeStore = createStore, getImageLimits = () => null, inbox = true,
} = {}) {
  const show = (s) => {
    state.storage = { ok: s.ok, ready: s.ready, lastPull: s.lastPull, lastPush: s.lastPush, pending: s.pending, detail: s.detail };
  };
  const skip = (detail) => {
    show({ ok: false, ready: false, lastPull: null, lastPush: null, pending: 0, detail });
    return null;
  };
  try {
    // test servers never touch the real storage repository
    if (env.NODE_TEST_CONTEXT && env.STORAGE_ALLOW_IN_TESTS !== '1') return skip('not used under the test runner');
    if (config && config.port === 0) return skip('test server (port 0)');
    const settings = storageSettings(env);
    if (settings.skip) {
      log.log(`[storage] off: ${settings.skip}`);
      return skip(settings.skip);
    }
    const store = makeStore({
      dir: settings.dir, remoteUrl: settings.remoteUrl, env: gitEnv({ token: settings.token, env }),
      log, onStatus: show, beforeCommit: snapshotStep(settings.dir),
    });
    show(store.status());
    if (!(await store.init())) return null;
    log.log(`[storage] ready: ${store.status().detail}`);
    // the first event of every run, and the server's own check that it can write and push
    await store.logEvent('system.start');
    // take in captures the Worker saved while the Codespace slept, then keep checking (blueprint §4.4)
    if (inbox && typeof store.sync === 'function' && typeof store.move === 'function') {
      try {
        startInboxPoller({ store, getImageLimits, log });
      } catch (err) {
        log.error(`[inbox] could not start: ${err.message}`);
      }
    }
    return store;
  } catch (err) {
    log.error(`[storage] could not start: ${err.message}`);
    return skip(`could not start: ${err.message}`);
  }
}
