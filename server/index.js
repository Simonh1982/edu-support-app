// HTTP server: routing, CORS, body limits and /api/health. No framework.
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { loadConfig, isAllowedOrigin } from './config.js';
import { startAi } from './ai/index.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Shared, mutable server state. Later modules (AI, storage, port) update their own section. */
export function createState(config, now = new Date()) {
  const startedAt = now.toISOString();
  const restsAt = new Date(now.getTime() + config.idleTimeoutMin * 60_000).toISOString();
  return {
    startedAt,
    restsAt,
    ai: { ready: false, roles: {}, errors: [] },
    storage: { ok: false, lastPush: null },
    port: { visibility: 'unknown', detail: 'not managed yet' },
  };
}

export function healthBody(state) {
  return {
    ok: true,
    ai: state.ai,
    storage: state.storage,
    startedAt: state.startedAt,
    restsAt: state.restsAt,
    port: state.port,
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
 * Build the request handler. Every route other than /api/health will require a pass (WP-010).
 */
export function createHandler({ config, state, log = console }) {
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

export function createServer(config, state = createState(config), log = console) {
  const server = http.createServer(createHandler({ config, state, log }));
  server.requestTimeout = 120_000;
  return { server, state };
}

async function main() {
  const config = loadConfig();
  let aiHandle = null;
  // a closing terminal sends SIGHUP; the server must survive it (blueprint §3.2)
  process.on('SIGHUP', () => console.log(`${new Date().toISOString()} SIGHUP received: ignored`));
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      console.log(`${new Date().toISOString()} ${signal} received: stopping`);
      // stop the Copilot runtime cleanly, but never let shutdown hang
      const stopping = aiHandle ? aiHandle.ai.stop() : Promise.resolve();
      Promise.race([stopping, new Promise((r) => setTimeout(r, 3000))]).finally(() => process.exit(0));
    });
  }
  const { server, state } = createServer(config);
  server.listen(config.port, config.host, () => {
    const { port } = server.address();
    console.log(`${new Date().toISOString()} listening on ${port}`);
    console.log(`Codespace: ${config.codespaceName || '(not in a Codespace)'}`);
    if (config.publicUrl) console.log(`Public address: ${config.publicUrl}`);
    // AI starts after listening, so /api/health answers (ai.mode "starting") during the test
    startAi({ state }).then((handle) => { aiHandle = handle; });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
