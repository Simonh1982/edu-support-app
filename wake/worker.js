// Cloudflare Worker for edu-support-app (blueprint §5 and §6): GitHub sign-in, passes, and the
// Codespace's status and wake, and the snapshot and items from the storage repository (WP-013).
// This whole file is pasted into the Cloudflare dashboard, so it imports nothing. Later packages add
// /inbox (WP-014) and the weekly wake (WP-016). Never log a pass, a token, an account name or the
// storage repository's name.

// ===== PASS BLOCK START (Web Crypto only; copied verbatim into wake/worker.js) =====
const PASS_ROLES = Object.freeze(['learner', 'parent']);
const PASS_TTL_OWN_S = 30 * 24 * 60 * 60;
const PASS_TTL_SHARED_S = 4 * 60 * 60;
const PASS_MAX_LENGTH = 2048;
const PASS_MIN_KEY_LENGTH = 32;
const PASS_CLOCK_SKEW_S = 300;
// Records that carry sharedWithParent (build spec Appendix A.3). Anything else is never parent-readable.
const PARENT_READABLE_TYPES = Object.freeze(['notebook', 'plan', 'draft']);
const PASS_LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

function passB64urlEncode(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function passB64urlDecode(text) {
  if (typeof text !== 'string' || text === '' || !/^[A-Za-z0-9_-]+$/.test(text)) return null;
  if (text.length % 4 === 1) return null;
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function parseAllowedAccounts(raw) {
  const fail = (error) => ({ accounts: null, error });
  let value = raw;
  if (typeof value === 'string') {
    if (value.trim() === '') return fail('ALLOWED_ACCOUNTS is not set');
    try {
      value = JSON.parse(value);
    } catch {
      return fail('ALLOWED_ACCOUNTS is not valid JSON');
    }
  }
  if (value === undefined || value === null) return fail('ALLOWED_ACCOUNTS is not set');
  if (typeof value !== 'object' || Array.isArray(value)) {
    return fail('ALLOWED_ACCOUNTS must be a JSON object of login to role');
  }
  const entries = Object.entries(value);
  if (entries.length === 0) return fail('ALLOWED_ACCOUNTS has no accounts');
  const accounts = Object.create(null);
  // Errors name the entry number, never the login, so logs stay free of account names.
  for (let i = 0; i < entries.length; i += 1) {
    const [login, role] = entries[i];
    if (!PASS_LOGIN_PATTERN.test(login)) return fail(`ALLOWED_ACCOUNTS entry ${i + 1} is not a valid GitHub login`);
    if (!PASS_ROLES.includes(role)) return fail(`ALLOWED_ACCOUNTS entry ${i + 1} has an unknown role`);
    accounts[login.toLowerCase()] = role;
  }
  return { accounts: Object.freeze(accounts), error: null };
}

function passSettings(env) {
  const errors = [];
  const secret = typeof env?.PASS_SIGNING_KEY === 'string' ? env.PASS_SIGNING_KEY.trim() : '';
  if (!secret) errors.push('PASS_SIGNING_KEY is not set');
  else if (secret.length < PASS_MIN_KEY_LENGTH) {
    errors.push(`PASS_SIGNING_KEY is shorter than ${PASS_MIN_KEY_LENGTH} characters`);
  }
  const rawVersion = String(env?.PASS_VERSION ?? '').trim();
  const version = /^[1-9][0-9]{0,8}$/.test(rawVersion) ? Number(rawVersion) : null;
  if (version === null) errors.push('PASS_VERSION must be a whole number of 1 or more');
  const { accounts, error } = parseAllowedAccounts(env?.ALLOWED_ACCOUNTS);
  if (error) errors.push(error);
  if (errors.length > 0) return { settings: null, errors };
  return { settings: Object.freeze({ secret, version, accounts }), errors };
}

function roleFor(accounts, login) {
  if (!accounts || typeof login !== 'string') return null;
  return accounts[login.toLowerCase()] ?? null;
}

function passHmacKey(secret) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function mintPass({ login, shared = false, settings, now = Date.now() }) {
  if (!settings) throw new Error('pass settings are missing');
  const role = roleFor(settings.accounts, login);
  if (!role) throw new Error('account not allowed');
  const isShared = shared === true;
  const iat = Math.floor(Number(now) / 1000);
  const claims = {
    sub: login,
    role,
    ver: settings.version,
    iat,
    exp: iat + (isShared ? PASS_TTL_SHARED_S : PASS_TTL_OWN_S),
    shared: isShared,
  };
  const body = passB64urlEncode(new TextEncoder().encode(JSON.stringify(claims)));
  const key = await passHmacKey(settings.secret);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  return `${body}.${passB64urlEncode(signature)}`;
}

function passClaimsValid(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return false;
  if (typeof c.sub !== 'string' || !PASS_LOGIN_PATTERN.test(c.sub)) return false;
  if (!PASS_ROLES.includes(c.role)) return false;
  if (!Number.isInteger(c.ver) || !Number.isInteger(c.iat) || !Number.isInteger(c.exp)) return false;
  if (typeof c.shared !== 'boolean') return false;
  if (c.exp <= c.iat) return false;
  return c.exp - c.iat <= (c.shared ? PASS_TTL_SHARED_S : PASS_TTL_OWN_S);
}

// Returns { ok: true, pass } or { ok: false, reason }. Reasons are safe to log; the token never is.
async function verifyPass(token, settings, { now = Date.now() } = {}) {
  const fail = (reason) => ({ ok: false, reason });
  if (!settings) return fail('not-configured');
  if (typeof token !== 'string' || token === '') return fail('missing');
  if (token.length > PASS_MAX_LENGTH) return fail('malformed');
  const parts = token.split('.');
  if (parts.length !== 2) return fail('malformed');
  const signature = passB64urlDecode(parts[1]);
  if (!signature || signature.length !== 32) return fail('malformed');
  const key = await passHmacKey(settings.secret);
  const valid = await crypto.subtle.verify('HMAC', key, signature, new TextEncoder().encode(parts[0]));
  if (!valid) return fail('signature');
  const bodyBytes = passB64urlDecode(parts[0]);
  if (!bodyBytes) return fail('malformed');
  let claims;
  try {
    claims = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bodyBytes));
  } catch {
    return fail('malformed');
  }
  if (!passClaimsValid(claims)) return fail('malformed');
  const nowS = Math.floor(Number(now) / 1000);
  if (claims.iat > nowS + PASS_CLOCK_SKEW_S) return fail('malformed');
  if (claims.exp <= nowS) return fail('expired');
  if (claims.ver !== settings.version) return fail('version');
  // Checked on every request, so removing an account or changing its role takes effect at once.
  if (roleFor(settings.accounts, claims.sub) !== claims.role) return fail('account');
  const pass = Object.freeze({
    sub: claims.sub, role: claims.role, ver: claims.ver,
    iat: claims.iat, exp: claims.exp, shared: claims.shared,
  });
  return { ok: true, pass };
}

function passFromHeader(value) {
  const match = /^Bearer[ \t]+([A-Za-z0-9_.-]+)[ \t]*$/i.exec(typeof value === 'string' ? value : '');
  return match ? match[1] : null;
}

// Same rule on the server and in the Worker: the parent sees only items the learner has shared.
function canReadItem(role, type, record) {
  if (role === 'learner') return true;
  if (role !== 'parent') return false;
  if (!PARENT_READABLE_TYPES.includes(type)) return false;
  const shared = record?.sharedWithParent;
  return typeof shared === 'string' && shared.trim() !== '';
}
// ===== PASS BLOCK END =====

// ===== ITEM BLOCK START (no imports; copied verbatim into wake/worker.js) =====
const SNAPSHOT_PATH = 'index/snapshot.json';
// Item and task IDs become file and folder names, so they are kept to safe characters.
const ITEM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
// Item types and whether they sit inside a task folder (blueprint §2.2). Types inside a task need ?task=.
const ITEM_TYPES = Object.freeze({
  notebook: Object.freeze({ inTask: false }),
  source: Object.freeze({ inTask: false }),
  task: Object.freeze({ inTask: false }),
  plan: Object.freeze({ inTask: true }),
  draft: Object.freeze({ inTask: true }),
  feedback: Object.freeze({ inTask: true }),
});

// Returns { path, error }. A plan has one file per task, so its id is checked but not used in the path.
function itemPath(type, id, task) {
  const fail = (error) => ({ path: null, error });
  if (typeof type !== 'string' || !Object.hasOwn(ITEM_TYPES, type)) return fail('unknown type');
  if (typeof id !== 'string' || !ITEM_ID_PATTERN.test(id)) return fail('invalid id');
  const inTask = ITEM_TYPES[type].inTask;
  const hasTask = task !== undefined && task !== null && task !== '';
  if (inTask && (typeof task !== 'string' || !ITEM_ID_PATTERN.test(task))) return fail('invalid task');
  if (!inTask && hasTask) return fail('task is not used for this type');
  const paths = {
    notebook: () => `notebook/${id}.json`,
    source: () => `sources/${id}.json`,
    task: () => `tasks/${id}/task.json`,
    plan: () => `tasks/${task}/plan.json`,
    draft: () => `tasks/${task}/drafts/${id}.json`,
    feedback: () => `tasks/${task}/feedback/${id}.json`,
  };
  return { path: paths[type](), error: null };
}

// Checked before any file is read, so the parent never causes a read of a type it can't open.
function itemTypeAllowed(role, type) {
  if (role === 'learner') return true;
  return role === 'parent' && PARENT_READABLE_TYPES.includes(type);
}

// The caller's own section of the snapshot only (blueprint §4.3), or null if it is missing.
function snapshotSection(snapshot, role) {
  if (!snapshot || typeof snapshot !== 'object' || !PASS_ROLES.includes(role)) return null;
  const section = snapshot[role];
  if (!section || typeof section !== 'object' || Array.isArray(section)) return null;
  const generatedAt = typeof snapshot.generatedAt === 'string' ? snapshot.generatedAt : null;
  return { generatedAt, ...section };
}
// ===== ITEM BLOCK END =====

const WORKER_NAME = 'edu-support-wake';
const GITHUB_API = 'https://api.github.com';
const GITHUB_OAUTH = 'https://github.com/login/oauth';
const BACKEND_DOMAIN = 'app.github.dev';
const BACKEND_PORT = 3000;
const OAUTH_STATE_TTL_S = 10 * 60;
const MAX_SMALL_BODY = 1024;
const CODESPACE_NAME_PATTERN = /^[A-Za-z0-9-]{1,100}$/;
// Every setting the Worker uses (blueprint §5.1).
const REQUIRED_SETTINGS = Object.freeze([
  'GITHUB_TOKEN', 'CODESPACE_NAME', 'ALLOWED_ORIGIN', 'APP_URL', 'OAUTH_CLIENT_ID',
  'OAUTH_CLIENT_SECRET', 'PASS_SIGNING_KEY', 'PASS_VERSION', 'ALLOWED_ACCOUNTS',
  'STORAGE_TOKEN', 'STORAGE_REPO',
]);
const MESSAGES = Object.freeze({
  signIn: 'Please sign in again.',
  signInNotSetUp: "Sign-in isn't set up yet.",
  wakeNotSetUp: "Waking isn't set up yet.",
  origin: 'This address is not allowed.',
  notFound: 'Not found.',
  method: 'That method is not allowed here.',
  tooLarge: 'The request is too large.',
  noGitHub: "Couldn't reach GitHub. Please try again.",
  unexpected: 'Something went wrong. Please try again.',
  storageNotSetUp: "Saved items aren't set up yet.",
  noSnapshot: "There's no snapshot yet. It appears after the tutor has run once.",
  badStoredFile: "A saved file couldn't be read.",
  itemNotFound: 'That item was not found.',
});

function setting(env, name) {
  const value = env?.[name];
  return value === undefined || value === null ? '' : String(value).trim();
}

function missingSettings(env) {
  return REQUIRED_SETTINGS.filter((name) => setting(env, name) === '');
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

function redirect(location) {
  return new Response(null, {
    status: 302,
    headers: { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
  });
}

// ---- CORS: echo the origin only when it is the app's own (blueprint §5.3) ----
function originRejected(request, env) {
  const origin = request.headers.get('Origin');
  return origin !== null && origin !== setting(env, 'ALLOWED_ORIGIN');
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const allowed = setting(env, 'ALLOWED_ORIGIN');
  if (origin !== null && allowed !== '' && origin === allowed) {
    return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
  }
  return { Vary: 'Origin' };
}

function preflight() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Max-Age': '600',
      'Cache-Control': 'no-store',
    },
  });
}

// ---- Where the app lives; the parent role goes to the parent page ----
function appUrl(env, role) {
  let base;
  try {
    base = new URL(setting(env, 'APP_URL'));
  } catch {
    return null;
  }
  if (base.protocol !== 'https:') return null;
  base.search = '';
  base.hash = '';
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  return role === 'parent' ? new URL('parent/', base).href : base.href;
}

// The pass and any error travel in the fragment, which browsers never send to a server.
function appRedirect(env, role, fragment) {
  const url = appUrl(env, role);
  if (!url) return json(503, { error: MESSAGES.signInNotSetUp });
  return redirect(`${url}#${fragment}`);
}

// ---- Signed OAuth state: timestamp, shared flag and a nonce; no storage needed ----
const STATE_PREFIX = 'oauth-state.';

function randomToken(bytes = 12) {
  return passB64urlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function signState(payload, secret) {
  const body = passB64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await passHmacKey(secret);
  // The prefix stops a state from ever verifying as a pass, and a pass as a state.
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(STATE_PREFIX + body));
  return `${body}.${passB64urlEncode(new Uint8Array(signature))}`;
}

async function readState(state, secret, now) {
  if (typeof state !== 'string' || state === '' || state.length > 512) return null;
  const parts = state.split('.');
  if (parts.length !== 2) return null;
  const signature = passB64urlDecode(parts[1]);
  if (!signature || signature.length !== 32) return null;
  const key = await passHmacKey(secret);
  const valid = await crypto.subtle.verify('HMAC', key, signature, new TextEncoder().encode(STATE_PREFIX + parts[0]));
  if (!valid) return null;
  const bytes = passB64urlDecode(parts[0]);
  if (!bytes) return null;
  let payload;
  try {
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  if (!payload || !Number.isInteger(payload.ts) || typeof payload.shared !== 'boolean') return null;
  if (payload.ts > now + PASS_CLOCK_SKEW_S || now - payload.ts > OAUTH_STATE_TTL_S) return null;
  return payload;
}

function callbackUrl(url) {
  return `${url.origin}/auth/callback`;
}

function safeCode(value) {
  return typeof value === 'string' && /^[a-z_]{1,40}$/.test(value) ? value : 'unknown';
}

function githubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': WORKER_NAME,
  };
}

// ---- Sign-in (blueprint §6.1): no scopes; GitHub's token is used once and never kept ----
async function handleLogin(env, url) {
  const shared = url.searchParams.get('shared') ?? '0';
  if (shared !== '0' && shared !== '1') return json(400, { error: 'shared must be 0 or 1.' });
  const { settings } = passSettings(env);
  if (!settings || setting(env, 'OAUTH_CLIENT_ID') === '') return appRedirect(env, null, 'error=not-configured');
  const state = await signState({ ts: nowSeconds(), shared: shared === '1', nonce: randomToken() }, settings.secret);
  // VERIFY: GitHub OAuth authorize parameters (client_id, redirect_uri, state, allow_signup; no scope = no scopes).
  const target = new URL(`${GITHUB_OAUTH}/authorize`);
  target.searchParams.set('client_id', setting(env, 'OAUTH_CLIENT_ID'));
  target.searchParams.set('redirect_uri', callbackUrl(url));
  target.searchParams.set('state', state);
  target.searchParams.set('allow_signup', 'false');
  return redirect(target.href);
}

async function githubLogin(env, code, redirectUri) {
  try {
    // VERIFY: token exchange returns JSON { access_token } or { error } when sent Accept: application/json.
    const tokenResponse = await fetch(`${GITHUB_OAUTH}/access_token`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': WORKER_NAME },
      body: JSON.stringify({
        client_id: setting(env, 'OAUTH_CLIENT_ID'),
        client_secret: setting(env, 'OAUTH_CLIENT_SECRET'),
        code,
        redirect_uri: redirectUri,
      }),
    });
    if (!tokenResponse.ok) {
      console.warn(`[auth] token exchange failed: ${tokenResponse.status}`);
      return null;
    }
    const data = await tokenResponse.json().catch(() => null);
    const token = typeof data?.access_token === 'string' ? data.access_token : '';
    if (!token) {
      console.warn(`[auth] token exchange refused: ${safeCode(data?.error)}`);
      return null;
    }
    const userResponse = await fetch(`${GITHUB_API}/user`, { headers: githubHeaders(token) });
    if (!userResponse.ok) {
      console.warn(`[auth] reading the GitHub account failed: ${userResponse.status}`);
      return null;
    }
    const user = await userResponse.json().catch(() => null);
    return typeof user?.login === 'string' && PASS_LOGIN_PATTERN.test(user.login) ? user.login : null;
  } catch (err) {
    console.warn(`[auth] GitHub sign-in failed: ${err?.name ?? 'error'}`);
    return null;
  }
}

async function handleCallback(env, url) {
  const { settings } = passSettings(env);
  if (!settings || setting(env, 'OAUTH_CLIENT_ID') === '' || setting(env, 'OAUTH_CLIENT_SECRET') === '') {
    return appRedirect(env, null, 'error=not-configured');
  }
  if (url.searchParams.has('error')) return appRedirect(env, null, 'error=cancelled');
  const state = await readState(url.searchParams.get('state'), settings.secret, nowSeconds());
  if (!state) return appRedirect(env, null, 'error=expired');
  const code = url.searchParams.get('code') ?? '';
  if (code === '' || code.length > 256) return appRedirect(env, null, 'error=github');
  const login = await githubLogin(env, code, callbackUrl(url));
  if (!login) return appRedirect(env, null, 'error=github');
  const role = roleFor(settings.accounts, login);
  if (!role) {
    console.warn('[auth] sign-in refused: account not on the allowed list');
    return appRedirect(env, null, 'error=not-allowed');
  }
  const pass = await mintPass({ login, shared: state.shared, settings });
  console.log(`[auth] signed in: ${role}${state.shared ? ' (shared computer)' : ''}`);
  return appRedirect(env, role, `pass=${pass}`);
}

// ---- Pass check on every API request (blueprint §5.3) ----
async function requirePass(request, env) {
  const { settings } = passSettings(env);
  if (!settings) return { response: json(503, { error: MESSAGES.signInNotSetUp }) };
  const token = passFromHeader(request.headers.get('Authorization'));
  const result = await verifyPass(token, settings);
  if (!result.ok) {
    console.warn(`[auth] pass rejected: ${result.reason}`);
    return { response: json(401, { error: MESSAGES.signIn, reason: result.reason }) };
  }
  return { pass: result.pass };
}

// ---- Codespace status and wake (blueprint §5.2, §9.1) ----
function codespaceReady(env) {
  return setting(env, 'GITHUB_TOKEN') !== '' && CODESPACE_NAME_PATTERN.test(setting(env, 'CODESPACE_NAME'));
}

function codespaceUrl(env, suffix = '') {
  return `${GITHUB_API}/user/codespaces/${encodeURIComponent(setting(env, 'CODESPACE_NAME'))}${suffix}`;
}

function backendUrl(env) {
  return `https://${setting(env, 'CODESPACE_NAME')}-${BACKEND_PORT}.${BACKEND_DOMAIN}`;
}

async function githubCall(env, suffix, method = 'GET') {
  try {
    // VERIFY: GET /user/codespaces/{name} and POST /user/codespaces/{name}/start accept a fine-grained
    // token limited to the app repository (Codespaces: read; Codespaces lifecycle admin: read and write).
    return await fetch(codespaceUrl(env, suffix), { method, headers: githubHeaders(setting(env, 'GITHUB_TOKEN')) });
  } catch (err) {
    console.warn(`[codespace] GitHub unreachable: ${err?.name ?? 'error'}`);
    return null;
  }
}

function githubFailure(response, what) {
  if (!response) return json(502, { error: MESSAGES.noGitHub });
  console.warn(`[codespace] ${what} failed: ${response.status}`);
  const body = { error: `GitHub refused the ${what} request (${response.status}).`, githubStatus: response.status };
  if (response.status >= 500) body.error = `GitHub isn't answering the ${what} request (${response.status}).`;
  if ([401, 403, 404].includes(response.status)) {
    const accepted = response.headers.get('x-accepted-github-permissions');
    if (accepted) body.acceptedPermissions = accepted.slice(0, 200);
  }
  return json(502, body);
}

async function codespaceState(env) {
  const response = await githubCall(env, '');
  if (!response || !response.ok) return { response: githubFailure(response, 'status') };
  const data = await response.json().catch(() => null);
  return { state: typeof data?.state === 'string' ? data.state : 'Unknown' };
}

async function handleStatus(env) {
  const current = await codespaceState(env);
  if (current.response) return current.response;
  return json(200, { state: current.state, backendUrl: backendUrl(env) });
}

async function handleWake(env) {
  const current = await codespaceState(env);
  if (current.response) return current.response;
  if (current.state === 'Available' || current.state === 'Starting') {
    return json(200, { state: current.state, started: false, backendUrl: backendUrl(env) });
  }
  const response = await githubCall(env, '/start', 'POST');
  // 409 means a start is already under way: normal, not an error (blueprint §14).
  if (response && (response.status === 409 || response.status === 304)) {
    return json(200, { state: current.state, started: false, backendUrl: backendUrl(env) });
  }
  if (!response || !response.ok) return githubFailure(response, 'wake');
  const data = await response.json().catch(() => null);
  const state = typeof data?.state === 'string' ? data.state : 'Starting';
  console.log(`[codespace] wake requested (was ${current.state})`);
  return json(200, { state, started: true, backendUrl: backendUrl(env) });
}

// ---- Snapshot and items from the storage repository (blueprint §4.3, §5.2) ----
// The storage token is separate from the lifecycle token, and the repository's name is never logged.
const STORAGE_REPO_PATTERN = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

function storageReady(env) {
  return setting(env, 'STORAGE_TOKEN') !== '' && STORAGE_REPO_PATTERN.test(setting(env, 'STORAGE_REPO'));
}

function storageFailure(response, what) {
  console.warn(`[storage] ${what} read failed: ${response.status}`);
  const body = { error: `GitHub refused the ${what} request (${response.status}).`, githubStatus: response.status };
  if (response.status >= 500) body.error = `GitHub isn't answering the ${what} request (${response.status}).`;
  if ([401, 403].includes(response.status)) {
    const accepted = response.headers.get('x-accepted-github-permissions');
    if (accepted) body.acceptedPermissions = accepted.slice(0, 200);
  }
  return json(502, body);
}

// Returns { data } for a JSON file, { missing: true } for 404, or { response } for any other problem.
async function storageRead(env, relPath, what) {
  const encoded = relPath.split('/').map(encodeURIComponent).join('/');
  const url = `${GITHUB_API}/repos/${setting(env, 'STORAGE_REPO')}/contents/${encoded}`;
  let response;
  try {
    // VERIFY: the contents API returns the file itself (not base64 JSON) with Accept: application/vnd.github.raw,
    // for files of any size up to 100 MB, using a fine-grained token with Contents: read on the storage repository.
    response = await fetch(url, {
      headers: { ...githubHeaders(setting(env, 'STORAGE_TOKEN')), Accept: 'application/vnd.github.raw' },
    });
  } catch (err) {
    console.warn(`[storage] GitHub unreachable: ${err?.name ?? 'error'}`);
    return { response: json(502, { error: MESSAGES.noGitHub }) };
  }
  if (response.status === 404) return { missing: true };
  if (!response.ok) return { response: storageFailure(response, what) };
  try {
    return { data: JSON.parse(await response.text()) };
  } catch {
    console.warn(`[storage] ${what} file is not valid JSON`);
    return { response: json(502, { error: MESSAGES.badStoredFile }) };
  }
}

async function handleSnapshot(env, pass) {
  const result = await storageRead(env, SNAPSHOT_PATH, 'snapshot');
  if (result.response) return result.response;
  if (result.missing) return json(404, { error: MESSAGES.noSnapshot });
  const section = snapshotSection(result.data, pass.role);
  if (!section) return json(502, { error: MESSAGES.badStoredFile });
  return json(200, section);
}

// Unshared and missing items get the same 404, so the parent can't tell whether an item exists.
async function handleItem(env, pass, url) {
  const type = url.searchParams.get('type');
  const { path, error } = itemPath(type, url.searchParams.get('id'), url.searchParams.get('task'));
  if (!path) return json(400, { error: `Bad item request: ${error}.` });
  if (!itemTypeAllowed(pass.role, type)) return json(404, { error: MESSAGES.itemNotFound });
  const result = await storageRead(env, path, 'item');
  if (result.response) return result.response;
  if (result.missing || !canReadItem(pass.role, type, result.data)) return json(404, { error: MESSAGES.itemNotFound });
  return json(200, { type, item: result.data });
}

// ---- Routing ----
async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method;

  // Sign-in pages are browser navigations, not fetch calls, so the origin check doesn't apply.
  if (path === '/auth/login') return method === 'GET' ? handleLogin(env, url) : json(405, { error: MESSAGES.method });
  if (path === '/auth/callback') return method === 'GET' ? handleCallback(env, url) : json(405, { error: MESSAGES.method });

  if (originRejected(request, env)) return json(403, { error: MESSAGES.origin });
  if (method === 'OPTIONS') return preflight();

  if (path === '/') {
    if (method !== 'GET') return json(405, { error: MESSAGES.method });
    // Setting names and problems only, never values, so the owner can check the set-up in a browser.
    const missing = missingSettings(env);
    const { errors } = passSettings(env);
    return json(200, { ok: missing.length === 0 && errors.length === 0, service: WORKER_NAME, missing, settingsErrors: errors });
  }

  if (path === '/status' || path === '/wake') {
    const expected = path === '/status' ? 'GET' : 'POST';
    if (method !== expected) return json(405, { error: MESSAGES.method });
    if (Number(request.headers.get('Content-Length') ?? 0) > MAX_SMALL_BODY) return json(413, { error: MESSAGES.tooLarge });
    const auth = await requirePass(request, env);
    if (auth.response) return auth.response;
    if (!codespaceReady(env)) return json(503, { error: MESSAGES.wakeNotSetUp });
    return path === '/status' ? handleStatus(env) : handleWake(env);
  }

  if (path === '/snapshot' || path === '/item') {
    if (method !== 'GET') return json(405, { error: MESSAGES.method });
    const auth = await requirePass(request, env);
    if (auth.response) return auth.response;
    if (!storageReady(env)) return json(503, { error: MESSAGES.storageNotSetUp });
    return path === '/snapshot' ? handleSnapshot(env, auth.pass) : handleItem(env, auth.pass, url);
  }

  return json(404, { error: MESSAGES.notFound });
}

export default {
  async fetch(request, env) {
    const settings = env ?? {};
    let response;
    try {
      response = await handle(request, settings);
    } catch (err) {
      console.error(`[worker] unexpected error: ${err?.name ?? 'error'}`);
      response = json(500, { error: MESSAGES.unexpected });
    }
    for (const [name, value] of Object.entries(corsHeaders(request, settings))) response.headers.set(name, value);
    return response;
  },
};
