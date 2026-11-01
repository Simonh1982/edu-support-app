// HTTP server: routing, CORS, body limits, /api/health, /api/item and the work routes. No framework.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadConfig, isAllowedOrigin } from './config.js';
import { startAi } from './ai/index.js';
import { redact } from './ai/copilot.js';
import { managePort } from './port.js';
import { startStorage } from './storage/index.js';
import { ukIso } from './storage/records.js';
import { passSettings, passFromHeader, verifyPass } from './auth.js';
import { itemResponse } from './storage/items.js';
import { loadImageLimits } from './ai/limits.js';
import { startCurriculum } from './curriculum.js';
import { matchApiRoute, handleApi } from './api.js';
import { createRateLimiter, createAiCeiling, passKey, RATE_LIMIT_MESSAGE } from './rate-limits.js';
import { startReader } from './reader.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Shared, mutable server state. Later modules (AI, storage, port) update their own section. */
export function createState(config, now = new Date()) {
  // UK time (Europe/London), like every other date the app shows or stores
  const startedAt = ukIso(now);
  const restsAt = ukIso(new Date(now.getTime() + config.idleTimeoutMin * 60_000));
  return {
    startedAt,
    restsAt,
    ai: { ready: false, roles: {}, errors: [] },
    storage: { ok: false, lastPush: null },
    port: { visibility: 'unknown', detail: 'not managed yet' },
  };
}

// server/port.js (proven, unchanged) records UTC; /api/health shows it in UK time
function ukTime(value) {
  if (typeof value !== 'string' || value === '') return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : ukIso(date);
}

export function healthBody(state) {
  const port = state.port && 'updatedAt' in state.port ? { ...state.port, updatedAt: ukTime(state.port.updatedAt) } : state.port;
  return {
    ok: true,
    ai: state.ai,
    storage: state.storage,
    startedAt: state.startedAt,
    restsAt: state.restsAt,
    port,
  };
}

/**
 * Read a JSON request body, enforcing a byte limit.
 * @returns {Promise<unknown>}
 */
export async function readJson(req, limit) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) throw new HttpError(413, 'Request body too large');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk);
  }
  if (size === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON');
  }
}

function applyCors(req, res, config) {
  const origin = req.headers.origin;
  res.setHeader('Vary', 'Origin');
  if (isAllowedOrigin(origin, config)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '600');
    return true;
  }
  return false;
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(text);
}

/**
 * Check the pass on a request (blueprint §5.3, §6). Returns { pass } or { status, body }.
 * The reason is safe to log and to return; the pass itself never is.
 */
export async function checkPass(req, authSettings, log = console) {
  if (!authSettings) return { status: 503, body: { error: "Sign-in isn't set up on the server." } };
  const result = await verifyPass(passFromHeader(req.headers.authorization), authSettings);
  if (!result.ok) {
    log.log(`[auth] pass rejected: ${result.reason}`);
    return { status: 401, body: { error: 'Please sign in again.', reason: result.reason } };
  }
  return { pass: result.pass };
}

/**
 * Build the request handler. Every route other than /api/health requires a pass.
 * authSettings: from passSettings(env), or null if sign-in isn't configured.
 * getStore: returns the storage store once it's ready, otherwise null.
 */
export function createHandler({
  config, state, log = console, authSettings = null, getStore = () => null, getCurriculum = () => null, rateLimiter = null,
}) {
  // one limiter per server: requests per pass per minute (blueprint §3.5)
  const limiter = rateLimiter ?? createRateLimiter({ limit: config.rateLimitPerMin ?? 120 });
  const overLimit = (res, pass) => {
    const result = limiter.take(passKey(pass));
    if (result.ok) return false;
    res.setHeader('Retry-After', String(result.retryAfterS));
    sendJson(res, 429, { error: RATE_LIMIT_MESSAGE });
    return true;
  };
  return async function handle(req, res) {
    try {
      const allowed = applyCors(req, res, config);
      const url = new URL(req.url, 'http://localhost');

      if (req.method === 'OPTIONS') {
        if (!allowed) return sendJson(res, 403, { error: 'Origin not allowed' });
        res.writeHead(204);
        return res.end();
      }

      if (url.pathname === '/api/health') {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
        return sendJson(res, 200, healthBody(state));
      }

      if (url.pathname === '/api/item') {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
        // the pass is checked first, so nothing about storage is revealed without one
        const auth = await checkPass(req, authSettings, log);
        if (!auth.pass) return sendJson(res, auth.status, auth.body);
        if (overLimit(res, auth.pass)) return undefined;
        const store = getStore();
        if (!store || !store.status().ready) return sendJson(res, 503, { error: "Saved items aren't available yet." });
        const result = await itemResponse({ store, pass: auth.pass, query: url.searchParams });
        return sendJson(res, result.status, result.body);
      }

      // work routes (WP-105): unknown paths stay 404 without a pass; known ones need a pass and the role
      const match = matchApiRoute(req.method, url.pathname);
      if (match?.status === 405) {
        res.setHeader('Allow', match.allow.join(', '));
        return sendJson(res, 405, { error: 'Method not allowed' });
      }
      if (match) {
        const auth = await checkPass(req, authSettings, log);
        if (!auth.pass) return sendJson(res, auth.status, auth.body);
        if (overLimit(res, auth.pass)) return undefined;
        const body = req.method === 'POST' || req.method === 'PATCH' ? await readJson(req, config.jsonBodyLimit) : null;
        const result = await handleApi({ match, pass: auth.pass, store: getStore(), body, query: url.searchParams, getCurriculum });
        return sendJson(res, result.status, result.body);
      }

      return sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      // log the route and message only: never bodies, headers or tokens
      log.error(`[http] ${req.method} ${req.url?.split('?')[0]} -> ${status}: ${err.message}`);
      if (!res.headersSent) sendJson(res, status, { error: status === 500 ? 'Internal error' : err.message });
      else res.end();
    }
  };
}

export function createServer(config, state = createState(config), log = console, options = {}) {
  const server = http.createServer(createHandler({ config, state, log, ...options }));
  server.requestTimeout = 120_000;
  return { server, state };
}

/**
 * Which processes started this one, e.g. "tail -n 40 -f … (812) ← sh -c bash scripts/start-server.sh (811)".
 * Logged at start-up so a duplicate start (EADDRINUSE) can be traced. Linux /proc only.
 */
export function processChain(pid, { depth = 4, read = (p) => readFileSync(p, 'utf8') } = {}) {
  const parts = [];
  let current = pid;
  for (let i = 0; i < depth && current > 1; i += 1) {
    let cmd;
    let stat;
    try {
      cmd = read(`/proc/${current}/cmdline`).split('\0').filter(Boolean).join(' ').replace(/\s+/g, ' ');
      stat = read(`/proc/${current}/stat`);
    } catch {
      break;
    }
    parts.push(`${redact(cmd).slice(0, 80) || '?'} (${current})`);
    // stat is "pid (comm) state ppid …"; comm may contain spaces, so read after the last ")"
    current = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
  }
  return parts.length ? parts.join(' ← ') : 'unknown';
}

async function main() {
  const config = loadConfig();
  let aiHandle = null;
  let portHandle = null;
  let storeHandle = null;
  // the light model's image limits, read once the AI has started (A-002); null until then
  let imageLimits = null;
  // curriculum outlines from the storage clone (WP-103); the work routes check topic IDs against it
  let curriculum = null;
  // set once the curriculum has been tried, so the reader never matches topics before it loads
  let curriculumLoaded = false;
  // reads photos waiting as `processing` (WP-106)
  let readerHandle = null;
  // daily AI request ceiling (blueprint §7.12); the AI routes call aiCeiling.take() from WP-111
  const aiCeiling = createAiCeiling({ limit: config.aiDailyCeiling });
  // setting names and problems only, never values (blueprint §12)
  const auth = passSettings(process.env);
  const { server, state } = createServer(config, undefined, console, {
    authSettings: auth.settings,
    getStore: () => storeHandle,
    getCurriculum: () => curriculum,
  });
  console.log(`[limits] ${config.rateLimitPerMin} requests a minute per pass; ${aiCeiling.status().limit} AI requests a day`);
  console.log(`${new Date().toISOString()} starting: pid ${process.pid}; started by: ${processChain(process.ppid)}`);
  if (!auth.settings) console.log(`[auth] off: ${auth.errors.join('; ')}`);
  // a closing terminal sends SIGHUP; the server must survive it (blueprint §3.2)
  process.on('SIGHUP', () => console.log(`${new Date().toISOString()} SIGHUP received: ignored`));
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      console.log(`${new Date().toISOString()} ${signal} received: stopping`);
      // free the port at once, so a replacement server can listen while Copilot shuts down
      server.close();
      portHandle?.stop();
      readerHandle?.stop();
      // stop the Copilot runtime and commit unsaved records locally (the next start pushes them),
      // but never let shutdown hang
      const stopping = aiHandle ? aiHandle.ai.stop() : Promise.resolve();
      const saving = storeHandle ? storeHandle.commitLocal() : Promise.resolve();
      Promise.race([Promise.all([stopping, saving]), new Promise((r) => setTimeout(r, 3000))])
        .finally(() => process.exit(0));
    });
  }
  // a second copy finding the port taken says so in one line instead of a stack trace
  server.on('error', (err) => {
    const why = err.code === 'EADDRINUSE'
      ? `port ${config.port} is already in use by another server, so this one (pid ${process.pid}) is exiting`
      : `server error: ${redact(err.message)}`;
    console.log(`${new Date().toISOString()} ${why}`);
    process.exit(1);
  });
  server.listen(config.port, config.host, () => {
    const { port } = server.address();
    console.log(`${new Date().toISOString()} listening on ${port}`);
    console.log(`Codespace: ${config.codespaceName || '(not in a Codespace)'}`);
    if (config.publicUrl) console.log(`Public address: ${config.publicUrl}`);
    // make the port Public now: Codespace restarts reset it to Private (blueprint §3.3)
    portHandle = managePort({ state, config, port });
    // reading needs storage, the curriculum and the real AI: the mock AI never reads real uploads
    readerHandle = startReader({
      getStore: () => storeHandle,
      getAi: () => aiHandle,
      getCurriculum: () => curriculum,
      isReady: () => Boolean(storeHandle && curriculumLoaded && aiHandle?.ai?.mode === 'copilot'),
      aiCeiling,
    });
    // storage also starts after listening, so /api/health can show its progress (storage.detail)
    startStorage({ state, config, getImageLimits: () => imageLimits }).then(async (store) => {
      storeHandle = store;
      // read once the clone is up to date; logs counts and file names only (never content)
      if (store) curriculum = await startCurriculum({ dir: store.dir });
      curriculumLoaded = true;
    });
    // AI starts after listening, so /api/health answers (ai.mode "starting") during the test
    startAi({ state }).then(async (handle) => {
      aiHandle = handle;
      imageLimits = await loadImageLimits(handle);
      const kb = imageLimits?.maxBytes ? `, up to ${Math.round(imageLimits.maxBytes / 1024)} KB per image` : '';
      console.log(`[inbox] image limits: ${imageLimits ? `${imageLimits.modelId}${kb}` : 'not available'}`);
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
