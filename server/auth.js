// Pass verification and role checks (blueprint §6). The pass block below is shared with the
// Cloudflare Worker, which is one pasted file and can't import modules, so WP-011 copies the block
// verbatim into wake/worker.js. Edit the block in both places together.

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

export {
  PASS_ROLES, PASS_TTL_OWN_S, PASS_TTL_SHARED_S, PASS_MAX_LENGTH, PASS_MIN_KEY_LENGTH,
  PASS_CLOCK_SKEW_S, PARENT_READABLE_TYPES, passB64urlEncode, passB64urlDecode,
  parseAllowedAccounts, passSettings, roleFor, mintPass, verifyPass, passFromHeader, canReadItem,
};

export const PASS_BLOCK_START = '// ===== PASS BLOCK START';
export const PASS_BLOCK_END = '// ===== PASS BLOCK END =====';

// Returns the text between the marker lines, or null unless each marker starts exactly one line.
// WP-011's test uses this on wake/worker.js too, to check the two copies are identical.
export function extractPassBlock(source) {
  const lines = String(source).split('\n');
  const starts = lines.flatMap((line, i) => (line.startsWith(PASS_BLOCK_START) ? [i] : []));
  const ends = lines.flatMap((line, i) => (line.startsWith(PASS_BLOCK_END) ? [i] : []));
  if (starts.length !== 1 || ends.length !== 1 || ends[0] <= starts[0]) return null;
  return lines.slice(starts[0] + 1, ends[0]).join('\n');
}

export const AUTH_MESSAGES = Object.freeze({
  signIn: 'Please sign in again.',
  notAllowed: "You don't have access to this.",
  notConfigured: "Sign-in isn't set up on the server yet.",
});

function headerValue(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') return headers.get(name) ?? undefined;
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

// Reads PASS_SIGNING_KEY, PASS_VERSION and ALLOWED_ACCOUNTS once. Never logs their values.
export function createAuth({ env = process.env, log = console, now = () => Date.now() } = {}) {
  const { settings, errors } = passSettings(env);
  if (errors.length > 0) log.warn(`[auth] not ready: ${errors.join('; ')}`);

  async function authenticate(headers) {
    if (!settings) return { ok: false, status: 503, error: AUTH_MESSAGES.notConfigured, reason: 'not-configured' };
    const token = passFromHeader(headerValue(headers, 'authorization'));
    const result = await verifyPass(token, settings, { now: now() });
    if (!result.ok) {
      log.warn(`[auth] pass rejected: ${result.reason}`);
      return { ok: false, status: 401, error: AUTH_MESSAGES.signIn, reason: result.reason };
    }
    return { ok: true, pass: result.pass };
  }

  function authorise(pass, roles) {
    if (pass && Array.isArray(roles) && roles.includes(pass.role)) return { ok: true };
    return { ok: false, status: 403, error: AUTH_MESSAGES.notAllowed };
  }

  function canRead(pass, type, record) {
    return canReadItem(pass?.role, type, record);
  }

  return { ready: Boolean(settings), errors: [...errors], authenticate, authorise, canRead };
}
