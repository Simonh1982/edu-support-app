import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import worker from '../wake/worker.js';
import { extractPassBlock, passSettings, verifyPass, mintPass, PASS_TTL_OWN_S, PASS_TTL_SHARED_S } from '../server/auth.js';
import { runCheck, normaliseWorkerUrl, expectedBackendUrl } from '../scripts/worker-check.js';

// Invented settings and accounts only.
const KEY = 'test-only-signing-key-0123456789-abcdefghijklmnop';
const ORIGIN = 'https://example.github.io';
const BASE = 'https://wake.example.workers.dev';
const ENV = Object.freeze({
  GITHUB_TOKEN: 'test-lifecycle-token-value',
  CODESPACE_NAME: 'example-codespace-abc123',
  ALLOWED_ORIGIN: ORIGIN,
  APP_URL: 'https://example.github.io/edu-support-app/',
  OAUTH_CLIENT_ID: 'test-client-id',
  OAUTH_CLIENT_SECRET: 'test-client-secret-value',
  PASS_SIGNING_KEY: KEY,
  PASS_VERSION: '1',
  ALLOWED_ACCOUNTS: JSON.stringify({ 'Example-Parent': 'parent', 'example-learner': 'learner' }),
});
const GITHUB_USER_TOKEN = 'test-oauth-user-token-value';
const SECRETS = [KEY, ENV.GITHUB_TOKEN, ENV.OAUTH_CLIENT_SECRET, GITHUB_USER_TOKEN];

const realFetch = globalThis.fetch;
const realNow = Date.now;
let calls;
let routes;
let logs;
const realConsole = { log: console.log, warn: console.warn, error: console.error };

function reply(status, body, headers = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

// Fake GitHub: routes are 'METHOD url' → (init) => Response. Unknown calls fail the test.
beforeEach(() => {
  calls = [];
  logs = [];
  routes = {};
  globalThis.fetch = async (input, init = {}) => {
    const method = init.method ?? 'GET';
    const key = `${method} ${String(input)}`;
    calls.push({ key, init });
    const route = routes[key];
    if (!route) throw new Error(`unexpected GitHub call: ${key}`);
    return route(init);
  };
  for (const name of ['log', 'warn', 'error']) console[name] = (...args) => logs.push(args.join(' '));
});

afterEach(() => {
  globalThis.fetch = realFetch;
  Date.now = realNow;
  Object.assign(console, realConsole);
});

function call(path, { method = 'GET', headers = {}, env = ENV, body } = {}) {
  return worker.fetch(new Request(`${BASE}${path}`, { method, headers, body }), env);
}

function settingsFrom(overrides = {}) {
  return passSettings({ ...ENV, ...overrides }).settings;
}

async function passFor(login, overrides = {}) {
  return mintPass({ login, settings: settingsFrom(overrides) });
}

function codespaceUrl(suffix = '') {
  return `https://api.github.com/user/codespaces/${ENV.CODESPACE_NAME}${suffix}`;
}

function githubSignIn(login) {
  routes['POST https://github.com/login/oauth/access_token'] = () => reply(200, { access_token: GITHUB_USER_TOKEN, token_type: 'bearer', scope: '' });
  routes['GET https://api.github.com/user'] = () => reply(200, { login, id: 1 });
}

async function startLogin(shared = '0') {
  const response = await call(`/auth/login?shared=${shared}`);
  assert.equal(response.status, 302);
  return new URL(response.headers.get('Location'));
}

async function finishLogin(state, code = 'test-code') {
  return call(`/auth/callback?code=${code}&state=${encodeURIComponent(state)}`);
}

function fragmentOf(response) {
  const location = response.headers.get('Location') ?? '';
  return { location, fragment: new URLSearchParams(location.split('#')[1] ?? '') };
}

function assertNoSecrets(text) {
  for (const secret of SECRETS) assert.ok(!text.includes(secret), 'a secret leaked');
}

test('worker carries an identical copy of the pass block and is a single self-contained file', async () => {
  const workerSource = await readFile(new URL('../wake/worker.js', import.meta.url), 'utf8');
  const authSource = await readFile(new URL('../server/auth.js', import.meta.url), 'utf8');
  const block = extractPassBlock(workerSource);
  assert.ok(block, 'one start and one end marker in wake/worker.js');
  assert.equal(block, extractPassBlock(authSource), 'pass blocks differ: change both copies together');
  assert.doesNotMatch(workerSource, /^\s*import\s/m);
  assert.doesNotMatch(workerSource, /\brequire\(|\bprocess\.|\bBuffer\./);
  assert.equal((workerSource.match(/^export\s/gm) ?? []).length, 1, 'only the default export');
  assert.match(workerSource, /^export default \{/m);
});

test('GET / lists missing setting names and problems, never values', async () => {
  const good = await (await call('/')).json();
  assert.deepEqual(good, { ok: true, service: 'edu-support-wake', missing: [], settingsErrors: [] });
  const response = await call('/', { env: { PASS_SIGNING_KEY: 'short-secret-value', ALLOWED_ORIGIN: ORIGIN } });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.ok, false);
  assert.ok(body.missing.includes('GITHUB_TOKEN'));
  assert.ok(body.missing.includes('OAUTH_CLIENT_SECRET'));
  assert.ok(!body.missing.includes('PASS_SIGNING_KEY'));
  assert.match(body.settingsErrors.join(' '), /shorter than 32/);
  assert.doesNotMatch(JSON.stringify(body), /short-secret-value/);
  assert.equal(calls.length, 0);
});

test('/auth/login redirects to GitHub with a signed state and no scopes', async () => {
  const target = await startLogin('0');
  assert.equal(target.origin + target.pathname, 'https://github.com/login/oauth/authorize');
  assert.equal(target.searchParams.get('client_id'), 'test-client-id');
  assert.equal(target.searchParams.get('redirect_uri'), `${BASE}/auth/callback`);
  assert.equal(target.searchParams.get('allow_signup'), 'false');
  assert.equal(target.searchParams.has('scope'), false);
  assert.match(target.searchParams.get('state'), /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal((await call('/auth/login?shared=2')).status, 400);
  assert.equal((await call('/auth/login', { method: 'POST' })).status, 405);
});

test('full own-device sign-in: learner pass in the fragment, 30 days, GitHub token not kept', async () => {
  githubSignIn('example-learner');
  const state = (await startLogin('0')).searchParams.get('state');
  const response = await finishLogin(state);
  const { location, fragment } = fragmentOf(response);
  assert.equal(response.status, 302);
  assert.ok(location.startsWith('https://example.github.io/edu-support-app/#pass='));
  const result = await verifyPass(fragment.get('pass'), settingsFrom());
  assert.equal(result.ok, true);
  assert.equal(result.pass.role, 'learner');
  assert.equal(result.pass.shared, false);
  assert.equal(result.pass.exp - result.pass.iat, PASS_TTL_OWN_S);

  const exchange = calls.find((c) => c.key.startsWith('POST https://github.com/login/oauth/access_token'));
  assert.equal(exchange.init.headers.Accept, 'application/json');
  assert.ok(exchange.init.headers['User-Agent']);
  assert.deepEqual(JSON.parse(exchange.init.body), {
    client_id: 'test-client-id', client_secret: ENV.OAUTH_CLIENT_SECRET, code: 'test-code', redirect_uri: `${BASE}/auth/callback`,
  });
  const user = calls.find((c) => c.key === 'GET https://api.github.com/user');
  assert.equal(user.init.headers.Authorization, `Bearer ${GITHUB_USER_TOKEN}`);
  assert.ok(user.init.headers['User-Agent']);
  assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
  assertNoSecrets(location + logs.join('\n'));
  assert.doesNotMatch(logs.join('\n'), /example-learner/);
});

test('shared-computer sign-in gives a 4-hour pass; the parent goes to the parent page', async () => {
  githubSignIn('example-parent');
  const state = (await startLogin('1')).searchParams.get('state');
  const response = await finishLogin(state);
  const { location, fragment } = fragmentOf(response);
  assert.ok(location.startsWith('https://example.github.io/edu-support-app/parent/#pass='));
  const result = await verifyPass(fragment.get('pass'), settingsFrom());
  assert.equal(result.pass.role, 'parent');
  assert.equal(result.pass.shared, true);
  assert.equal(result.pass.exp - result.pass.iat, PASS_TTL_SHARED_S);
});

test('an account not on the allowed list gets no pass', async () => {
  githubSignIn('someone-else');
  const state = (await startLogin()).searchParams.get('state');
  const { location, fragment } = fragmentOf(await finishLogin(state));
  assert.equal(fragment.get('error'), 'not-allowed');
  assert.doesNotMatch(location, /pass=/);
  assert.doesNotMatch(logs.join('\n'), /someone-else/);
});

test('callback refuses old, edited or missing state, and reports a cancelled sign-in', async () => {
  githubSignIn('example-learner');
  const start = realNow();
  Date.now = () => start;
  const state = (await startLogin()).searchParams.get('state');
  Date.now = () => start + 11 * 60 * 1000;
  assert.equal(fragmentOf(await finishLogin(state)).fragment.get('error'), 'expired');
  Date.now = () => start;
  const [body, sig] = state.split('.');
  const edited = `${body.slice(0, -2)}AA.${sig}`;
  assert.equal(fragmentOf(await finishLogin(edited)).fragment.get('error'), 'expired');
  assert.equal(fragmentOf(await call('/auth/callback?code=x')).fragment.get('error'), 'expired');
  // A pass is not a state, even though both are signed with the same key.
  const pass = await passFor('example-learner');
  assert.equal(fragmentOf(await finishLogin(pass)).fragment.get('error'), 'expired');
  assert.equal(fragmentOf(await call('/auth/callback?error=access_denied')).fragment.get('error'), 'cancelled');
  assert.equal(calls.length, 0, 'GitHub is not called for a bad state');
});

test('GitHub failures during sign-in send the app error=github, never a pass', async () => {
  const state = async () => (await startLogin()).searchParams.get('state');
  routes['POST https://github.com/login/oauth/access_token'] = () => reply(200, { error: 'bad_verification_code' });
  assert.equal(fragmentOf(await finishLogin(await state())).fragment.get('error'), 'github');
  githubSignIn('example-learner');
  routes['GET https://api.github.com/user'] = () => reply(500, { message: 'oops' });
  assert.equal(fragmentOf(await finishLogin(await state())).fragment.get('error'), 'github');
  routes['POST https://github.com/login/oauth/access_token'] = () => { throw new TypeError('network'); };
  assert.equal(fragmentOf(await finishLogin(await state())).fragment.get('error'), 'github');
  assert.match(logs.join('\n'), /bad_verification_code/);
  assertNoSecrets(logs.join('\n'));
});

test('sign-in not set up: redirect with error=not-configured, or 503 without APP_URL', async () => {
  const noKey = { ...ENV, PASS_SIGNING_KEY: '' };
  assert.equal(fragmentOf(await call('/auth/login', { env: noKey })).fragment.get('error'), 'not-configured');
  assert.equal(fragmentOf(await call('/auth/callback?code=x&state=y', { env: noKey })).fragment.get('error'), 'not-configured');
  const noApp = { ...ENV, PASS_SIGNING_KEY: '', APP_URL: '' };
  assert.equal((await call('/auth/login', { env: noApp })).status, 503);
});

test('/status and /wake need a valid pass; GitHub is not called otherwise', async () => {
  const none = await call('/status');
  assert.equal(none.status, 401);
  assert.deepEqual(await none.json(), { error: 'Please sign in again.', reason: 'missing' });
  const oldVersion = await passFor('example-learner', { PASS_VERSION: '9' });
  const old = await call('/wake', { method: 'POST', headers: { Authorization: `Bearer ${oldVersion}` } });
  assert.equal((await old.json()).reason, 'version');
  const learner = await passFor('example-learner');
  const removed = { ...ENV, ALLOWED_ACCOUNTS: JSON.stringify({ 'Example-Parent': 'parent' }) };
  const gone = await call('/status', { headers: { Authorization: `Bearer ${learner}` }, env: removed });
  assert.equal((await gone.json()).reason, 'account');
  const notSetUp = await call('/status', { env: { ...ENV, PASS_VERSION: '' } });
  assert.equal(notSetUp.status, 503);
  assert.equal(calls.length, 0);
  assert.doesNotMatch(logs.join('\n'), new RegExp(learner.split('.')[1]));
});

test('/status returns the Codespace state and backend address, with GitHub headers sent', async () => {
  routes[`GET ${codespaceUrl()}`] = () => reply(200, { name: ENV.CODESPACE_NAME, state: 'Shutdown' });
  const pass = await passFor('Example-Parent');
  const response = await call('/status', { headers: { Authorization: `Bearer ${pass}` } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { state: 'Shutdown', backendUrl: 'https://example-codespace-abc123-3000.app.github.dev' });
  const headers = calls[0].init.headers;
  assert.equal(headers.Authorization, `Bearer ${ENV.GITHUB_TOKEN}`);
  assert.equal(headers.Accept, 'application/vnd.github+json');
  assert.equal(headers['X-GitHub-Api-Version'], '2022-11-28');
  assert.ok(headers['User-Agent']);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
});

test('/wake: already awake starts nothing; asleep starts; 409 is not an error', async () => {
  const headers = { Authorization: `Bearer ${await passFor('example-learner')}` };
  routes[`GET ${codespaceUrl()}`] = () => reply(200, { state: 'Available' });
  let body = await (await call('/wake', { method: 'POST', headers })).json();
  assert.deepEqual(body, { state: 'Available', started: false, backendUrl: 'https://example-codespace-abc123-3000.app.github.dev' });
  assert.equal(calls.length, 1);

  routes[`GET ${codespaceUrl()}`] = () => reply(200, { state: 'Shutdown' });
  routes[`POST ${codespaceUrl('/start')}`] = () => reply(200, { state: 'Starting' });
  body = await (await call('/wake', { method: 'POST', headers })).json();
  assert.equal(body.started, true);
  assert.equal(body.state, 'Starting');

  routes[`POST ${codespaceUrl('/start')}`] = () => reply(409, { message: 'Conflict' });
  const conflict = await call('/wake', { method: 'POST', headers });
  assert.equal(conflict.status, 200);
  assert.deepEqual(await conflict.json(), { state: 'Shutdown', started: false, backendUrl: 'https://example-codespace-abc123-3000.app.github.dev' });
});

test('GitHub refusals become 502 with the accepted-permissions hint; network errors too', async () => {
  const headers = { Authorization: `Bearer ${await passFor('example-learner')}` };
  routes[`GET ${codespaceUrl()}`] = () => reply(403, { message: 'Resource not accessible' }, { 'x-accepted-github-permissions': 'codespaces=read' });
  let response = await call('/status', { headers });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), {
    error: 'GitHub refused the status request (403).', githubStatus: 403, acceptedPermissions: 'codespaces=read',
  });
  routes[`GET ${codespaceUrl()}`] = () => reply(200, { state: 'Shutdown' });
  routes[`POST ${codespaceUrl('/start')}`] = () => reply(503, { message: 'down' });
  response = await call('/wake', { method: 'POST', headers });
  const body = await response.json();
  assert.equal(response.status, 502);
  assert.equal(body.githubStatus, 503);
  assert.equal(body.acceptedPermissions, undefined);
  routes[`GET ${codespaceUrl()}`] = () => { throw new TypeError('network'); };
  response = await call('/status', { headers });
  assert.equal(response.status, 502);
  assertNoSecrets(logs.join('\n'));
});

test('waking is refused with 503 when the Codespace settings are missing or invalid', async () => {
  const headers = { Authorization: `Bearer ${await passFor('example-learner')}` };
  assert.equal((await call('/status', { headers, env: { ...ENV, GITHUB_TOKEN: '' } })).status, 503);
  assert.equal((await call('/status', { headers, env: { ...ENV, CODESPACE_NAME: 'bad/name' } })).status, 503);
  assert.equal(calls.length, 0);
});

test('CORS: only the app origin is echoed; other origins get 403; preflight answered', async () => {
  routes[`GET ${codespaceUrl()}`] = () => reply(200, { state: 'Available' });
  const pass = await passFor('example-learner');
  const allowed = await call('/status', { headers: { Origin: ORIGIN, Authorization: `Bearer ${pass}` } });
  assert.equal(allowed.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.equal(allowed.headers.get('Vary'), 'Origin');
  const unauth = await call('/status', { headers: { Origin: ORIGIN } });
  assert.equal(unauth.status, 401);
  assert.equal(unauth.headers.get('Access-Control-Allow-Origin'), ORIGIN, 'errors stay readable by the app');
  const other = await call('/status', { headers: { Origin: 'https://evil.example', Authorization: `Bearer ${pass}` } });
  assert.equal(other.status, 403);
  assert.equal(other.headers.get('Access-Control-Allow-Origin'), null);
  const pre = await call('/wake', { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' } });
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get('Access-Control-Allow-Headers'), /Authorization/);
  assert.match(pre.headers.get('Access-Control-Allow-Methods'), /POST/);
  assert.equal((await call('/wake', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } })).status, 403);
  const noOrigin = await call('/status', { headers: { Authorization: `Bearer ${pass}` } });
  assert.equal(noOrigin.status, 200);
  assert.equal(noOrigin.headers.get('Access-Control-Allow-Origin'), null);
  const noSetting = await call('/', { headers: { Origin: ORIGIN }, env: { ...ENV, ALLOWED_ORIGIN: '' } });
  assert.equal(noSetting.status, 403, 'fails closed without ALLOWED_ORIGIN');
});

test('wrong methods, unknown paths and oversized bodies get JSON errors', async () => {
  for (const [path, method, status] of [['/wake', 'GET', 405], ['/status', 'POST', 405], ['/', 'POST', 405], ['/nope', 'GET', 404]]) {
    const response = await call(path, { method });
    assert.equal(response.status, status, `${method} ${path}`);
    assert.ok((await response.json()).error);
  }
  const big = await call('/wake', { method: 'POST', body: 'x'.repeat(2048), headers: { 'Content-Length': '2048' } });
  assert.equal(big.status, 413);
});

test('worker-check helpers: address and backend address', () => {
  assert.equal(normaliseWorkerUrl(' https://wake.example.workers.dev/ '), 'https://wake.example.workers.dev');
  assert.equal(normaliseWorkerUrl('http://wake.example.workers.dev'), null);
  assert.equal(normaliseWorkerUrl('not an address'), null);
  assert.equal(expectedBackendUrl({ CODESPACE_NAME: 'abc', GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: 'app.github.dev' }), 'https://abc-3000.app.github.dev');
  assert.equal(expectedBackendUrl({}), null);
});

function workerAsFetch(workerEnv) {
  return (url, init = {}) => worker.fetch(new Request(url, init), workerEnv);
}

const CODESPACE_ENV = {
  ...ENV, GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: 'app.github.dev',
};

test('worker-check passes when the Worker and the Codespace share the same pass secrets', async () => {
  routes[`GET ${codespaceUrl()}`] = () => reply(200, { state: 'Available' });
  const lines = [];
  const ok = await runCheck({ workerUrl: BASE, env: CODESPACE_ENV, fetchImpl: workerAsFetch(ENV), out: (l) => lines.push(l) });
  assert.equal(ok, true, lines.join('\n'));
  assert.equal(lines.length, 5);
  assert.ok(lines.every((l) => /: OK/.test(l)), lines.join('\n'));
  const text = lines.join('\n');
  assertNoSecrets(text);
  assert.doesNotMatch(text, /example-learner|Example-Parent/i);
});

test('worker-check names the mismatched secret and the missing Worker settings', async () => {
  const lines = [];
  const ok = await runCheck({
    workerUrl: BASE, env: { ...CODESPACE_ENV, PASS_VERSION: '2' }, fetchImpl: workerAsFetch(ENV), out: (l) => lines.push(l),
  });
  assert.equal(ok, false);
  assert.match(lines.join('\n'), /PASS_VERSION is different/);
  const missing = [];
  const okMissing = await runCheck({
    workerUrl: BASE, env: CODESPACE_ENV, fetchImpl: workerAsFetch({ ...ENV, GITHUB_TOKEN: '' }), out: (l) => missing.push(l),
  });
  assert.equal(okMissing, false);
  assert.match(missing[0], /FAIL \(missing: GITHUB_TOKEN\)/);
});
