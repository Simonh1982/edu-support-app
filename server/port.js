// Makes the Codespace's forwarded port Public on every start (blueprint §3.3, proven).
// Ports reset to Private whenever the Codespace restarts, and a Private port answers browsers
// with a GitHub sign-in page instead of JSON.
import { execFile } from 'node:child_process';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redact } from './ai/copilot.js';

export const PORT_LOG = fileURLToPath(new URL('../.server/port.log', import.meta.url));
export const ATTEMPTS = 18;
export const DELAY_MS = 10_000;
const ATTEMPT_TIMEOUT_MS = 30_000;

/** gh arguments that make one port Public. */
export function visibilityArgs(port, codespaceName) {
  // VERIFY: gh 2.x syntax, proven in an earlier build: gh codespace ports visibility <port>:public -c <name>
  return ['codespace', 'ports', 'visibility', `${port}:public`, '-c', codespaceName];
}

/**
 * The environment for gh: only what it needs. GH_TOKEN takes priority over the Codespace's own
 * GITHUB_TOKEN, which can't change port visibility; leaving GITHUB_TOKEN out removes any doubt.
 */
export function ghEnv(token, env = process.env) {
  const out = { GH_TOKEN: token, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' };
  for (const key of ['PATH', 'HOME']) if (env[key]) out[key] = env[key];
  return out;
}

/** Run gh once. Never rejects: returns { code, stdout, stderr }; code 127 means gh is missing. */
export function runGh(args, { env, timeoutMs = ATTEMPT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    execFile('gh', args, { env, timeout: timeoutMs, maxBuffer: 64 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) });
      const code = err.code === 'ENOENT' ? 127 : typeof err.code === 'number' ? err.code : 1;
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr || err.message || '') });
    });
  });
}

/** A short, token-free error line from a gh result. */
export function shortError(result) {
  const text = redact(result.stderr || result.stdout || '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 200) : `exit ${result.code}`;
}

export async function appendPortLog(line, file = PORT_LOG) {
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${new Date().toISOString()} ${line}\n`);
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

/**
 * Make the port Public, retrying 18 times 10 seconds apart. Updates state.port as it goes, logs
 * the first failure and the result to .server/port.log, and never throws.
 * Returns { done: Promise<state.port>, stop() }.
 */
export function managePort({
  state, config, port, env = process.env, run = runGh, sleep = defaultSleep,
  writeLog = appendPortLog, log = console, attempts = ATTEMPTS, delayMs = DELAY_MS,
  now = () => new Date(),
}) {
  let stopped = false;
  const set = (visibility, detail, attemptsMade = 0) => {
    state.port = { visibility, detail, attempts: attemptsMade, updatedAt: now().toISOString() };
  };
  const record = async (line) => {
    log.log(`[port] ${line}`);
    try {
      await writeLog(line);
    } catch (err) {
      log.error(`[port] could not write port.log: ${err.message}`);
    }
  };

  const done = (async () => {
    if (!config.codespaceName) {
      set('n/a', 'not in a Codespace');
      return state.port;
    }
    // port 0 means a throwaway test server: never touch the real Codespace's ports for it
    if (!config.port) {
      set('n/a', 'test server (port 0)');
      return state.port;
    }
    const token = env.GH_PORTS_TOKEN;
    if (!token) {
      set('private', 'GH_PORTS_TOKEN is not set');
      await record('Private: GH_PORTS_TOKEN is not set');
      return state.port;
    }
    set('pending', 'making the port Public');
    let firstError = null;
    for (let i = 1; i <= attempts; i += 1) {
      if (stopped) return state.port;
      const result = await run(visibilityArgs(port, config.codespaceName), { env: ghEnv(token, env) });
      if (stopped) return state.port;
      if (result.code === 0) {
        set('public', `Public after ${i} attempt${i === 1 ? '' : 's'}`, i);
        await record(`Public (attempt ${i})`);
        return state.port;
      }
      const message = shortError(result);
      if (!firstError) {
        firstError = message;
        await record(`attempt ${i} failed: ${message}`);
      }
      if (result.code === 127) {
        set('private', 'gh is not installed: add the github-cli feature and rebuild', i);
        await record('Private: gh is not installed');
        return state.port;
      }
      set('pending', `attempt ${i} of ${attempts} failed: ${message}`, i);
      if (i < attempts) await sleep(delayMs);
    }
    set('private', `gave up after ${attempts} attempts: ${firstError}`, attempts);
    await record(`Private: gave up after ${attempts} attempts`);
    return state.port;
  })().catch((err) => {
    set('unknown', `port check failed: ${redact(err?.message)}`);
    return state.port;
  });

  return { done, stop() { stopped = true; } };
}
