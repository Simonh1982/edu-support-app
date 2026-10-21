// Runs git for the storage clone. The token travels only in this process's environment
// (GIT_CONFIG_* variables), never in a command line, a remote URL or .git/config (blueprint §4.2.6).
import { execFile } from 'node:child_process';
import { redact } from '../ai/copilot.js';

export const IDENTITY = Object.freeze({ name: 'edu-support-app server', email: 'server@edu-support-app.invalid' });

/** Environment for git: isolated from the Codespace's own git settings and credential helper. */
export function gitEnv({ token, env = process.env, host = 'github.com' } = {}) {
  const out = {
    GIT_TERMINAL_PROMPT: '0',
    // VERIFY: GIT_CONFIG_GLOBAL needs git >= 2.32 and GIT_CONFIG_COUNT needs >= 2.31 (bookworm ships 2.39)
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null', // the Codespace's helper would offer its own token, which can't reach the storage repo
    GIT_AUTHOR_NAME: IDENTITY.name,
    GIT_AUTHOR_EMAIL: IDENTITY.email,
    GIT_COMMITTER_NAME: IDENTITY.name,
    GIT_COMMITTER_EMAIL: IDENTITY.email,
    LC_ALL: 'C',
  };
  for (const key of ['PATH', 'HOME']) if (env[key]) out[key] = env[key];
  if (token) {
    // the same header actions/checkout uses for HTTPS access with a token
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
    out.GIT_CONFIG_COUNT = '1';
    out.GIT_CONFIG_KEY_0 = `http.https://${host}/.extraheader`;
    out.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${basic}`;
  }
  return out;
}

/** Token-free, single-line text for logs and /api/health. */
export function cleanGitText(text, max = 300) {
  return redact(String(text ?? ''))
    .replace(/basic\s+[A-Za-z0-9+/=]{16,}/gi, 'basic [redacted]')
    .replace(/https:\/\/[^@\s/]+@/g, 'https://[redacted]@')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** Run git once. Never rejects: returns { code, stdout, stderr }; code 127 means git is missing. */
export function runGit(args, { cwd, env, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, env, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) });
      const code = err.code === 'ENOENT' ? 127 : typeof err.code === 'number' ? err.code : 1;
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr || err.message || '') });
    });
  });
}

/** One lock for every git operation: the server never runs two git commands at once (blueprint §4.2.5). */
export function createLock() {
  let tail = Promise.resolve();
  return {
    run(fn) {
      const result = tail.then(fn, fn);
      tail = result.then(() => {}, () => {});
      return result;
    },
  };
}
