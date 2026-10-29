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
// A pull can replay many local commits; each may stop on a clash. More than this means something is wrong.
const MAX_REBASE_STEPS = 100;
// Files the server rebuilds from the rest of the clone, so either side of a clash will do.
const GENERATED_FILES = Object.freeze(['index/snapshot.json']);

/**
 * How a sync clash on one path is settled automatically (WP-014a-fix), or null if a person must look.
 * union: append-only event logs keep both sides' lines. generated: take either side, then rebuild.
 * prefer-remote: inbox/ (the Worker's side wins; a repeat capture is later dropped as a duplicate).
 * prefer-local: uploads/ (the server owns them; a learner's photo is never deleted by a clash).
 * Anything else (learner records) stops syncing until someone checks it.
 */
export function conflictRule(relPath) {
  if (typeof relPath !== 'string') return null;
  if (/^events\/[A-Za-z0-9._-]+\.jsonl$/.test(relPath)) return 'union';
  if (GENERATED_FILES.includes(relPath)) return 'generated';
  if (relPath.startsWith('inbox/')) return 'prefer-remote';
  if (relPath.startsWith('uploads/')) return 'prefer-local';
  return null;
}

/** Both sides of an append-only log: the remote's lines in order, then local lines it doesn't have. */
export function unionLines(remoteText, localText) {
  const remote = String(remoteText ?? '').split('\n').filter((l) => l !== '');
  const seen = new Set(remote);
  const extra = String(localText ?? '').split('\n').filter((l) => l !== '' && !seen.has(l) && seen.add(l));
  const lines = [...remote, ...extra];
  return lines.length ? `${lines.join('\n')}\n` : '';
}

/**
 * Parses `git ls-files -u` into [{ path, stages }]. During a rebase, stage 2 is the remote's version
 * (git calls it "ours") and stage 3 is the local commit being replayed ("theirs").
 */
export function parseUnmerged(text) {
  const byPath = new Map();
  for (const line of String(text ?? '').split('\n')) {
    const m = /^\d+ [0-9a-f]+ ([123])\t(.+)$/.exec(line);
    if (!m) continue;
    if (!byPath.has(m[2])) byPath.set(m[2], new Set());
    byPath.get(m[2]).add(Number(m[1]));
  }
  return [...byPath].map(([p, stages]) => ({ path: p, stages }));
}

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
  log = console, now = () => new Date(), sleep = sleepDefault, onStatus = () => {}, beforeCommit = null,
} = {}) {
  if (!dir || !path.isAbsolute(dir)) throw new Error('storage dir must be an absolute path');
  const lock = createLock();
  const dirty = new Set();
  let timer = null;
  let retryIndex = 0;
  let stopped = false;
  // Set when a sync clash needs a person. Pulls stop (saving still works locally) until a restart.
  let attention = null;
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

  // Runs once per batch, inside the git lock and before the commit, so the snapshot is rewritten at
  // most once per batch (blueprint §4.2). A failure here is logged and never blocks saving.
  async function runBeforeCommit() {
    if (!beforeCommit || dirty.size === 0) return;
    try {
      await beforeCommit({
        write: async (relPath, data) => {
          checkPath(relPath);
          await writeAtomic(path.join(dir, relPath), `${JSON.stringify(data, null, 2)}\n`);
          dirty.add(relPath);
        },
      });
    } catch (err) {
      log.error(`[storage] before-commit step failed: ${err.message}`);
    }
  }

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

  async function unmergedPaths() {
    const r = await git(['ls-files', '-u']);
    return r.code === 0 ? parseUnmerged(r.stdout) : [];
  }

  /** Settle one clashing path by its rule. Throws if git refuses. Lock must be held, rebase stopped. */
  async function resolvePath({ path: relPath, stages }) {
    const hasRemote = stages.has(2);
    const hasLocal = stages.has(3);
    const must = async (args) => {
      const r = await git(args);
      if (r.code !== 0) throw new Error(`${args[0]} failed for ${relPath}`);
      return r;
    };
    if (!hasRemote && !hasLocal) {
      await must(['rm', '--quiet', '--', relPath]);
      return;
    }
    if (conflictRule(relPath) === 'union' && hasRemote && hasLocal) {
      const remote = await must(['show', `:2:${relPath}`]);
      const local = await must(['show', `:3:${relPath}`]);
      await writeAtomic(path.join(dir, relPath), unionLines(remote.stdout, local.stdout));
      await must(['add', '--', relPath]);
      return;
    }
    // checkout keeps binary files (photos) byte for byte; --ours is the remote side during a rebase
    const preferLocal = conflictRule(relPath) === 'prefer-local';
    const side = preferLocal ? (hasLocal ? '--theirs' : '--ours') : (hasRemote ? '--ours' : '--theirs');
    await must(['checkout', side, '--', relPath]);
    await must(['add', '--', relPath]);
  }

  /**
   * Finish a rebase that stopped on clashes, step by step. Returns { ok, rebuild, resolved } or
   * { ok: false, reason }. Never names the repository or quotes file contents.
   */
  async function recoverLocked(firstConflicts) {
    let conflicts = firstConflicts;
    let rebuild = false;
    const resolved = new Set();
    for (let step = 0; step < MAX_REBASE_STEPS; step += 1) {
      const blocked = conflicts.filter((c) => conflictRule(c.path) === null).map((c) => c.path);
      if (blocked.length) {
        const shown = blocked.slice(0, 3).join(', ');
        return { ok: false, reason: `sync clash in ${shown}${blocked.length > 3 ? ` and ${blocked.length - 3} more` : ''}` };
      }
      try {
        for (const c of conflicts) {
          await resolvePath(c);
          resolved.add(c.path);
          if (conflictRule(c.path) === 'generated') rebuild = true;
        }
      } catch (err) {
        return { ok: false, reason: `could not settle a sync clash (${err.message})` };
      }
      // a commit left with no changes after settling is skipped rather than committed empty
      const staged = await git(['diff', '--cached', '--quiet']);
      const next = await git(staged.code === 0 ? ['rebase', '--skip'] : ['-c', 'core.editor=true', 'rebase', '--continue']);
      if (next.code === 0) return { ok: true, rebuild, resolved: [...resolved] };
      conflicts = await unmergedPaths();
      if (conflicts.length === 0) return { ok: false, reason: 'the pull stopped part-way without a clash' };
    }
    return { ok: false, reason: 'too many clashing commits' };
  }

  /**
   * Pull, then push anything committed locally. Returns { pulled, pushed, error?, attention?, recovered? }.
   * Lock must be held. A clash on server-made files is settled automatically; any other clash stops
   * syncing with a clear message instead of retrying for ever (WP-014a-fix).
   */
  async function syncLocked() {
    if (attention) return { pulled: 0, pushed: false, error: attention, attention: true };
    const before = await git(['rev-parse', '@{u}']);
    // --autostash: a record written while this runs (outside the lock) mustn't block the pull
    const pull = await git(['pull', '--rebase', '--autostash', '--quiet']);
    let recovered = null;
    if (pull.code !== 0) {
      const conflicts = await unmergedPaths();
      if (conflicts.length === 0) {
        // not a clash (for example, offline): undo any half-started rebase and retry later
        await git(['rebase', '--abort']);
        return { pulled: 0, pushed: false, error: fail('pull', pull) };
      }
      recovered = await recoverLocked(conflicts);
      if (!recovered.ok) {
        await git(['rebase', '--abort']);
        attention = `needs attention: ${recovered.reason}. Local changes are kept; syncing restarts with the server`;
        log.error(`[storage] ${attention}`);
        return { pulled: 0, pushed: false, error: attention, attention: true };
      }
      log.log(`[storage] settled a sync clash automatically: ${recovered.resolved.join(', ')}`);
      if (recovered.rebuild) {
        // the next batch rebuilds the snapshot from the merged clone (beforeCommit)
        for (const file of GENERATED_FILES) dirty.add(file);
        schedule();
      }
    }
    let pulled = 0;
    if (before.code === 0) {
      const count = await git(['rev-list', '--count', `${before.stdout.trim()}..@{u}`]);
      pulled = count.code === 0 ? Number(count.stdout.trim()) || 0 : 0;
    }
    status.lastPull = ukIso(now());
    const extra = recovered ? { recovered: recovered.resolved } : {};
    if ((await aheadCount()) === 0) return { pulled, pushed: false, ...extra };
    const push = await git(['push', '--quiet', 'origin', 'HEAD']);
    if (push.code !== 0) return { pulled, pushed: false, error: fail('push', push), ...extra };
    status.lastPush = ukIso(now());
    return { pulled, pushed: true, ...extra };
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
        if (!result.attention) scheduleRetry();
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
      await runBeforeCommit();
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
        if (!result.attention) scheduleRetry();
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

    /**
     * Delete one file. A file that is already gone is fine. The commit follows in the next batch.
     * allowInbox is only for clearing inbox files once they have been processed (blueprint §4.4).
     */
    async remove(relPath, { allowInbox = false } = {}) {
      if (!status.ready) throw new Error('storage is not ready');
      checkPath(relPath, { allowInbox });
      await unlink(path.join(dir, relPath)).catch((err) => {
        if (err.code !== 'ENOENT') throw err;
      });
      dirty.add(relPath);
      update({});
      schedule();
    },

    /** Move one file within the clone. inbox/ may be the source (a processed capture), never the target. */
    async move(fromPath, toPath) {
      if (!status.ready) throw new Error('storage is not ready');
      checkPath(fromPath, { allowInbox: true });
      checkPath(toPath);
      const target = path.join(dir, toPath);
      await mkdir(path.dirname(target), { recursive: true });
      await rename(path.join(dir, fromPath), target);
      dirty.add(fromPath);
      dirty.add(toPath);
      update({});
      schedule();
    },

    /** Pull now (and push anything already committed), without committing. Never rejects. */
    async sync() {
      if (!status.ready) return { pulled: 0, pushed: false, error: 'storage is not ready' };
      return lock.run(async () => {
        try {
          const result = await syncLocked();
          if (result.error) update({ ok: false, detail: result.error });
          else update({ ok: true, detail: 'up to date' });
          return result;
        } catch (err) {
          update({ ok: false, detail: `sync failed: ${err.message}` });
          return { pulled: 0, pushed: false, error: err.message };
        }
      });
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
