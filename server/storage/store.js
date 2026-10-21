// The storage repository is the database (blueprint §4). Writes land in the local clone at once
// and are committed in batches; every push is preceded by `git pull --rebase`, because the
// Worker also commits (to inbox/ only).
import { mkdir, readFile, writeFile, rename, appendFile, readdir, stat, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { runGit as defaultRunGit, cleanGitText, createLock } from './git.js';
import { makeEvent, eventsPath, ukIso } from './records.js';

export const BATCH_MS = 5_000;
export const RETRY_DELAYS_MS = Object.freeze([5_000, 15_000, 30_000, 60_000, 120_000]);
const LOCK_WAIT_MS = 10_000;

/**
 * Checks a repository-relative path. The server writes everything except inbox/ (Worker only),
 * and nothing may escape the clone or touch .git.
 */
export function checkPath(relPath, { allowInbox = false } = {}) {
  if (typeof relPath !== 'string' || !/^[A-Za-z0-9._\/-]+$/.test(relPath)) throw new Error('invalid storage path');
  const parts = relPath.split('/');
  if (relPath.startsWith('/') || parts.some((p) => p === '' || p === '.' || p === '..' || p === '.git')) {
    throw new Error('invalid storage path');
  }
  if (!allowInbox && parts[0] === 'inbox') throw new Error('inbox/ is written by the Worker only');
  return relPath;
}

function sleepDefault(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

/**
 * createStore({ dir, remoteUrl, env, ... }) → store
 * env is the git environment from gitEnv(); tests pass a fake runGit instead of real git.
 */
export function createStore({
  dir, remoteUrl, env, runGit = defaultRunGit, batchMs = BATCH_MS, retryDelays = RETRY_DELAYS_MS,
  log = console, now = () => new Date(), sleep = sleepDefault, onStatus = () => {},
} = {}) {
  if (!dir || !path.isAbsolute(dir)) throw new Error('storage dir must be an absolute path');
  const lock = createLock();
  const dirty = new Set();
  let timer = null;
  let retryIndex = 0;
  let stopped = false;
  const status = { ok: false, ready: false, lastPull: null, lastPush: null, pending: 0, detail: 'not started' };

  const git = (args, cwd = dir) => runGit(args, { cwd, env });
  const update = (changes) => {
    Object.assign(status, changes, { pending: dirty.size });
    try { onStatus({ ...status }); } catch { /* status display must never break saving */ }
  };
  // git errors quote the remote URL; /api/health is public, so the repository's name is hidden
  const repoName = String(remoteUrl ?? '').replace(/^https:\/\/[^/]+\//, '').replace(/\.git$/, '');
  const fail = (what, result) => {
    let text = cleanGitText(result.stderr || result.stdout);
    if (repoName) text = text.split(repoName).join('<storage-repo>');
    const detail = `${what} failed: ${text || `exit ${result.code}`}`;
    log.error(`[storage] ${detail}`);
    return detail;
  };

  function schedule(ms = batchMs) {
    if (stopped || timer) return;
    timer = setTimeout(() => { timer = null; flush().catch(() => {}); }, ms);
    timer.unref?.();
  }

  function scheduleRetry() {
    const ms = retryDelays[Math.min(retryIndex, retryDelays.length - 1)];
    retryIndex += 1;
    schedule(ms);
  }

  // A server killed mid-command can leave .git/index.lock behind; the old process has gone by now.
  async function clearStaleLock() {
    const lockFile = path.join(dir, '.git', 'index.lock');
    const started = Date.now();
    while (existsSync(lockFile) && Date.now() - started < LOCK_WAIT_MS) await sleep(500);
    if (existsSync(lockFile)) {
      await unlink(lockFile).catch(() => {});
      log.log('[storage] removed a stale .git/index.lock');
    }
  }

  async function aheadCount() {
    const r = await git(['rev-list', '--count', '@{u}..HEAD']);
    return r.code === 0 ? Number(r.stdout.trim()) || 0 : 0;
  }

  /** Pull, then push anything committed locally. Returns { pulled, pushed, error? }. Lock must be held. */
  async function syncLocked() {
    const before = await git(['rev-parse', '@{u}']);
    // --autostash: a record written while this runs (outside the lock) mustn't block the pull
    const pull = await git(['pull', '--rebase', '--autostash', '--quiet']);
    if (pull.code !== 0) {
      await git(['rebase', '--abort']);
      return { pulled: 0, pushed: false, error: fail('pull', pull) };
    }
    let pulled = 0;
    if (before.code === 0) {
      const count = await git(['rev-list', '--count', `${before.stdout.trim()}..@{u}`]);
      pulled = count.code === 0 ? Number(count.stdout.trim()) || 0 : 0;
    }
    status.lastPull = ukIso(now());
    if ((await aheadCount()) === 0) return { pulled, pushed: false };
    const push = await git(['push', '--quiet', 'origin', 'HEAD']);
    if (push.code !== 0) return { pulled, pushed: false, error: fail('push', push) };
    status.lastPush = ukIso(now());
    return { pulled, pushed: true };
  }

  /** Stage and commit everything changed. Lock must be held. Returns the number of files committed. */
  async function commitLocked() {
    if (dirty.size === 0) return 0;
    const add = await git(['add', '-A']);
    if (add.code !== 0) throw new Error(fail('add', add));
    const names = await git(['diff', '--cached', '--name-only']);
    const count = names.stdout.split('\n').filter(Boolean).length;
    dirty.clear();
    if (count === 0) return 0;
    // the message never names records or content: a count is enough
    const commit = await git(['commit', '--quiet', '-m', `server: save ${count} file${count === 1 ? '' : 's'}`]);
    if (commit.code !== 0) throw new Error(fail('commit', commit));
    return count;
  }

  /** Clone if missing, otherwise pull; then push any commits left from a previous run. */
  async function init() {
    return lock.run(async () => {
      update({ detail: 'starting' });
      if (!existsSync(path.join(dir, '.git'))) {
        await mkdir(path.dirname(dir), { recursive: true });
        const clone = await git(['clone', '--quiet', remoteUrl, dir], path.dirname(dir));
        if (clone.code !== 0) {
          update({ ok: false, detail: fail('clone', clone) });
          return false;
        }
      } else {
        await clearStaleLock();
      }
      const result = await syncLocked();
      if (result.error) {
        update({ ok: false, ready: true, detail: result.error });
        scheduleRetry();
        return true; // the clone is usable; pushing will be retried
      }
      retryIndex = 0;
      update({ ok: true, ready: true, detail: 'up to date' });
      return true;
    });
  }

  /** Commit pending changes, pull --rebase, push. Never rejects; returns a summary. */
  async function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    return lock.run(async () => {
      let committed = 0;
      try {
        committed = await commitLocked();
      } catch (err) {
        update({ ok: false, detail: err.message });
        scheduleRetry();
        return { committed: 0, pulled: 0, pushed: false, error: err.message };
      }
      const result = await syncLocked();
      if (result.error) {
        update({ ok: false, detail: result.error });
        scheduleRetry();
        return { committed, ...result };
      }
      retryIndex = 0;
      update({ ok: true, detail: 'up to date' });
      return { committed, ...result };
    });
  }

  /** On shutdown: commit locally without pushing (fast). The next start pushes it. */
  async function commitLocal() {
    stopped = true;
    if (timer) { clearTimeout(timer); timer = null; }
    return lock.run(async () => {
      try {
        return await commitLocked();
      } catch (err) {
        log.error(`[storage] ${err.message}`);
        return 0;
      }
    });
  }

  async function writeAtomic(file, text) {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    await writeFile(tmp, text);
    await rename(tmp, file);
  }

  const store = {
    dir,
    status: () => ({ ...status, pending: dirty.size }),
    init,
    flush,
    commitLocal,

    /** Write one JSON record. The file is written now; the commit follows in the next batch. */
    async put(relPath, record) {
      if (!status.ready) throw new Error('storage is not ready');
      checkPath(relPath);
      if (!relPath.endsWith('.json')) throw new Error('records are .json files');
      if (!record || typeof record !== 'object' || !record.id) throw new Error('a record needs an id');
      await writeAtomic(path.join(dir, relPath), `${JSON.stringify(record, null, 2)}\n`);
      dirty.add(relPath);
      update({});
      schedule();
      return record;
    },

    /** Append one line to a JSONL log (append-only). */
    async append(relPath, entry) {
      if (!status.ready) throw new Error('storage is not ready');
      checkPath(relPath);
      if (!relPath.endsWith('.jsonl')) throw new Error('logs are .jsonl files');
      const file = path.join(dir, relPath);
      await mkdir(path.dirname(file), { recursive: true });
      await appendFile(file, `${JSON.stringify(entry)}\n`);
      dirty.add(relPath);
      update({});
      schedule();
      return entry;
    },

    /** Append a system event to this UK month's log. */
    async logEvent(type, options = {}) {
      const event = makeEvent(type, { now: now(), ...options });
      return store.append(eventsPath(now()), event);
    },

    /** Read one JSON record, or null if it doesn't exist. */
    async read(relPath) {
      checkPath(relPath, { allowInbox: true });
      try {
        return JSON.parse(await readFile(path.join(dir, relPath), 'utf8'));
      } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
      }
    },

    /** File names in a folder, or [] if it doesn't exist. */
    async list(relDir) {
      checkPath(relDir, { allowInbox: true });
      try {
        const entries = await readdir(path.join(dir, relDir));
        const out = [];
        for (const name of entries.sort()) {
          if ((await stat(path.join(dir, relDir, name))).isFile()) out.push(name);
        }
        return out;
      } catch (err) {
        if (err.code === 'ENOENT') return [];
        throw err;
      }
    },
  };
  return store;
}
