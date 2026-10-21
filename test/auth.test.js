import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import {
  PASS_TTL_OWN_S, PASS_TTL_SHARED_S, PASS_BLOCK_START, PASS_BLOCK_END, AUTH_MESSAGES,
  passB64urlEncode, passB64urlDecode, parseAllowedAccounts, passSettings, mintPass, verifyPass,
  passFromHeader, canReadItem, createAuth, extractPassBlock,
} from '../server/auth.js';

// Invented accounts and key; nothing real.
const KEY = 'test-only-signing-key-0123456789-abcdefghijklmnop';
const ACCOUNTS = JSON.stringify({ 'Example-Parent': 'parent', 'example-learner': 'learner' });
const ENV = { PASS_SIGNING_KEY: KEY, PASS_VERSION: '1', ALLOWED_ACCOUNTS: ACCOUNTS };
const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;

function settingsFrom(overrides = {}) {
  const { settings, errors } = passSettings({ ...ENV, ...overrides });
  assert.deepEqual(errors, []);
  return settings;
}

function quietLog() {
  const lines = [];
  const add = (...args) => lines.push(args.join(' '));
  return { lines, log: { info: add, warn: add, error: add, log: add } };
}

function decodeClaims(token) {
  return JSON.parse(new TextDecoder().decode(passB64urlDecode(token.split('.')[0])));
}

async function forge(claims, secret = KEY) {
  const body = passB64urlEncode(new TextEncoder().encode(JSON.stringify(claims)));
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

test('own-device pass round trip: 30 days, learner role, not shared', async () => {
  const settings = settingsFrom();
  const token = await mintPass({ login: 'example-learner', settings, now: NOW });
  const result = await verifyPass(token, settings, { now: NOW + 1000 });
  assert.equal(result.ok, true);
  assert.equal(result.pass.role, 'learner');
  assert.equal(result.pass.sub, 'example-learner');
  assert.equal(result.pass.ver, 1);
  assert.equal(result.pass.shared, false);
  assert.equal(result.pass.exp - result.pass.iat, PASS_TTL_OWN_S);
  assert.ok(Object.isFrozen(result.pass));
});

test('shared-computer pass lasts 4 hours, and only shared === true counts', async () => {
  const settings = settingsFrom();
  const shared = await mintPass({ login: 'example-learner', shared: true, settings, now: NOW });
  const claims = decodeClaims(shared);
  assert.equal(claims.shared, true);
  assert.equal(claims.exp - claims.iat, PASS_TTL_SHARED_S);
  const notShared = decodeClaims(await mintPass({ login: 'example-learner', shared: '1', settings, now: NOW }));
  assert.equal(notShared.shared, false);
  const atExpiry = await verifyPass(shared, settings, { now: NOW + PASS_TTL_SHARED_S * 1000 });
  assert.deepEqual(atExpiry, { ok: false, reason: 'expired' });
});

test('pass format is standard HMAC-SHA256 over the base64url body', async () => {
  const settings = settingsFrom();
  const token = await mintPass({ login: 'Example-Parent', settings, now: NOW });
  const [body, sig] = token.split('.');
  assert.equal(sig, createHmac('sha256', KEY).update(body).digest('base64url'));
  assert.deepEqual(Object.keys(decodeClaims(token)), ['sub', 'role', 'ver', 'iat', 'exp', 'shared']);
});

test('expired pass is rejected; one second before expiry is accepted', async () => {
  const settings = settingsFrom();
  const token = await mintPass({ login: 'example-learner', settings, now: NOW });
  const expiry = NOW + PASS_TTL_OWN_S * 1000;
  assert.equal((await verifyPass(token, settings, { now: expiry - 1000 })).ok, true);
  assert.deepEqual(await verifyPass(token, settings, { now: expiry }), { ok: false, reason: 'expired' });
  assert.deepEqual(await verifyPass(token, settings, { now: NOW + 31 * DAY_MS }), { ok: false, reason: 'expired' });
});

test('raising PASS_VERSION signs out existing passes', async () => {
  const token = await mintPass({ login: 'example-learner', settings: settingsFrom(), now: NOW });
  const raised = settingsFrom({ PASS_VERSION: '2' });
  assert.deepEqual(await verifyPass(token, raised, { now: NOW }), { ok: false, reason: 'version' });
});

test('removing an account or changing its role rejects its passes at once', async () => {
  const token = await mintPass({ login: 'example-learner', settings: settingsFrom(), now: NOW });
  const removed = settingsFrom({ ALLOWED_ACCOUNTS: JSON.stringify({ 'Example-Parent': 'parent' }) });
  assert.deepEqual(await verifyPass(token, removed, { now: NOW }), { ok: false, reason: 'account' });
  const changed = settingsFrom({
    ALLOWED_ACCOUNTS: JSON.stringify({ 'Example-Parent': 'parent', 'example-learner': 'parent' }),
  });
  assert.deepEqual(await verifyPass(token, changed, { now: NOW }), { ok: false, reason: 'account' });
});

test('logins match without regard to case, as GitHub logins do', async () => {
  const settings = settingsFrom();
  const token = await mintPass({ login: 'example-parent', settings, now: NOW });
  const result = await verifyPass(token, settings, { now: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.pass.role, 'parent');
});

test('minting refuses an account that is not allowed', async () => {
  await assert.rejects(mintPass({ login: 'someone-else', settings: settingsFrom(), now: NOW }), /not allowed/);
  await assert.rejects(mintPass({ login: 'example-learner', settings: null, now: NOW }), /settings/);
});

test('wrong key, tampered body and swapped signatures are rejected', async () => {
  const settings = settingsFrom();
  const token = await mintPass({ login: 'example-learner', settings, now: NOW });
  const otherKey = settingsFrom({ PASS_SIGNING_KEY: `${KEY}-different` });
  assert.deepEqual(await verifyPass(token, otherKey, { now: NOW }), { ok: false, reason: 'signature' });

  const [, sig] = token.split('.');
  const claims = { ...decodeClaims(token), role: 'parent' };
  const tampered = `${passB64urlEncode(new TextEncoder().encode(JSON.stringify(claims)))}.${sig}`;
  assert.deepEqual(await verifyPass(tampered, settings, { now: NOW }), { ok: false, reason: 'signature' });

  const parentToken = await mintPass({ login: 'Example-Parent', settings, now: NOW });
  const swapped = `${parentToken.split('.')[0]}.${sig}`;
  assert.deepEqual(await verifyPass(swapped, settings, { now: NOW }), { ok: false, reason: 'signature' });
});

test('malformed and missing passes are rejected without throwing', async () => {
  const settings = settingsFrom();
  const token = await mintPass({ login: 'example-learner', settings, now: NOW });
  assert.deepEqual(await verifyPass(undefined, settings, { now: NOW }), { ok: false, reason: 'missing' });
  assert.deepEqual(await verifyPass('', settings, { now: NOW }), { ok: false, reason: 'missing' });
  for (const bad of ['abc', 'a.b.c', `${token}.extra`, 'a!b.cd', `${token.split('.')[0]}.`, '.x',
    `${token.split('.')[0]}.AAAA`, 'x'.repeat(3000)]) {
    const result = await verifyPass(bad, settings, { now: NOW });
    assert.equal(result.ok, false, bad.slice(0, 40));
    assert.equal(result.reason, 'malformed', bad.slice(0, 40));
  }
});

test('correctly signed but invalid claims are rejected as malformed', async () => {
  const settings = settingsFrom();
  const iat = Math.floor(NOW / 1000);
  const good = { sub: 'example-learner', role: 'learner', ver: 1, iat, exp: iat + 60, shared: false };
  assert.equal((await verifyPass(await forge(good), settings, { now: NOW })).ok, true);
  const cases = [
    { ...good, role: 'admin' },
    { ...good, sub: 'bad login!' },
    { ...good, ver: '1' },
    { ...good, shared: 'no' },
    { ...good, exp: iat },
    { ...good, exp: iat + PASS_TTL_OWN_S + 1 },
    { ...good, shared: true, exp: iat + PASS_TTL_SHARED_S + 1 },
    { ...good, iat: iat + 3600, exp: iat + 7200 },
  ];
  for (const claims of cases) {
    assert.deepEqual(await verifyPass(await forge(claims), settings, { now: NOW }),
      { ok: false, reason: 'malformed' }, JSON.stringify(claims));
  }
  const notJson = `${passB64urlEncode(new TextEncoder().encode('not json'))}`;
  const notJsonToken = `${notJson}.${createHmac('sha256', KEY).update(notJson).digest('base64url')}`;
  assert.deepEqual(await verifyPass(notJsonToken, settings, { now: NOW }), { ok: false, reason: 'malformed' });
});

test('verifyPass without settings reports not-configured', async () => {
  assert.deepEqual(await verifyPass('a.b', null, { now: NOW }), { ok: false, reason: 'not-configured' });
});

test('passSettings reports each problem without echoing secret values or logins', () => {
  const { settings, errors } = passSettings({
    PASS_SIGNING_KEY: 'short-secret-value', PASS_VERSION: '0', ALLOWED_ACCOUNTS: '{"Example-Parent":"owner"}',
  });
  assert.equal(settings, null);
  assert.equal(errors.length, 3);
  const text = errors.join(' ');
  assert.match(text, /shorter than 32/);
  assert.match(text, /PASS_VERSION/);
  assert.match(text, /entry 1 has an unknown role/);
  assert.doesNotMatch(text, /short-secret-value|Example-Parent/);

  assert.deepEqual(passSettings({}).errors, [
    'PASS_SIGNING_KEY is not set',
    'PASS_VERSION must be a whole number of 1 or more',
    'ALLOWED_ACCOUNTS is not set',
  ]);
  for (const version of ['1.5', '-1', 'one', '01', '']) {
    assert.equal(passSettings({ ...ENV, PASS_VERSION: version }).settings, null, version);
  }
  assert.equal(passSettings({ ...ENV, PASS_VERSION: ' 3 ' }).settings.version, 3);
});

test('parseAllowedAccounts accepts JSON text or an object and fails closed', () => {
  const fromText = parseAllowedAccounts(ACCOUNTS);
  assert.equal(fromText.error, null);
  assert.equal(fromText.accounts['example-parent'], 'parent');
  assert.ok(Object.isFrozen(fromText.accounts));
  assert.equal(parseAllowedAccounts({ 'example-learner': 'learner' }).error, null);
  for (const bad of ['', 'not json', '[]', '{}', '"text"', '{"a b":"learner"}', '{"-start":"learner"}', null]) {
    const result = parseAllowedAccounts(bad);
    assert.equal(result.accounts, null, String(bad));
    assert.ok(result.error, String(bad));
  }
});

test('passFromHeader reads only a well-formed Bearer value', () => {
  assert.equal(passFromHeader('Bearer abc.def'), 'abc.def');
  assert.equal(passFromHeader('bearer   abc.def  '), 'abc.def');
  for (const bad of [undefined, '', 'abc.def', 'Basic abc', 'Bearer', 'Bearer a b', ['Bearer abc']]) {
    assert.equal(passFromHeader(bad), null, String(bad));
  }
});

test('the parent role cannot read unshared items', () => {
  for (const type of ['notebook', 'plan', 'draft']) {
    assert.equal(canReadItem('parent', type, { id: 'x' }), false, `${type} unshared`);
    assert.equal(canReadItem('parent', type, { id: 'x', sharedWithParent: null }), false);
    assert.equal(canReadItem('parent', type, { id: 'x', sharedWithParent: '' }), false);
    assert.equal(canReadItem('parent', type, { id: 'x', sharedWithParent: true }), false);
    assert.equal(canReadItem('parent', type, { id: 'x', sharedWithParent: '2026-10-21T18:00:00+01:00' }), true);
  }
  // Conversations, feedback and anything else are never parent-readable, even if flagged.
  for (const type of ['ai-turn', 'feedback', 'upload', 'task', 'unknown']) {
    assert.equal(canReadItem('parent', type, { sharedWithParent: '2026-10-21T18:00:00+01:00' }), false, type);
  }
  assert.equal(canReadItem('parent', 'notebook', undefined), false);
});

test('learner reads own items; unknown roles read nothing', () => {
  assert.equal(canReadItem('learner', 'draft', { id: 'x' }), true);
  assert.equal(canReadItem('admin', 'draft', { sharedWithParent: '2026-10-21' }), false);
  assert.equal(canReadItem(undefined, 'draft', { sharedWithParent: '2026-10-21' }), false);
});

test('createAuth: 503 when not configured, and logs no secret', async () => {
  const { lines, log } = quietLog();
  const auth = createAuth({ env: { PASS_SIGNING_KEY: 'tiny-secret' }, log, now: () => NOW });
  assert.equal(auth.ready, false);
  assert.equal(auth.errors.length, 3);
  const result = await auth.authenticate({ authorization: 'Bearer a.b' });
  assert.deepEqual(result, { ok: false, status: 503, error: AUTH_MESSAGES.notConfigured, reason: 'not-configured' });
  assert.doesNotMatch(lines.join('\n'), /tiny-secret/);
});

test('createAuth: 401 for missing or bad passes; token never logged or returned', async () => {
  const { lines, log } = quietLog();
  const auth = createAuth({ env: ENV, log, now: () => NOW });
  assert.equal(auth.ready, true);
  const missing = await auth.authenticate({});
  assert.deepEqual(missing, { ok: false, status: 401, error: AUTH_MESSAGES.signIn, reason: 'missing' });
  const token = await mintPass({ login: 'example-learner', settings: settingsFrom({ PASS_VERSION: '9' }), now: NOW });
  const old = await auth.authenticate({ authorization: `Bearer ${token}` });
  assert.equal(old.status, 401);
  assert.equal(old.reason, 'version');
  const all = `${lines.join('\n')}\n${JSON.stringify([missing, old])}`;
  assert.doesNotMatch(all, new RegExp(token.split('.')[1]));
  assert.doesNotMatch(all, new RegExp(KEY));
  assert.match(lines.join('\n'), /\[auth\] pass rejected: version/);
});

test('createAuth: accepts Node and Fetch-style headers, then checks roles', async () => {
  const { log } = quietLog();
  const auth = createAuth({ env: ENV, log, now: () => NOW });
  const token = await mintPass({ login: 'Example-Parent', settings: settingsFrom(), now: NOW });
  const viaNode = await auth.authenticate({ authorization: `Bearer ${token}` });
  const viaFetch = await auth.authenticate(new Headers({ Authorization: `Bearer ${token}` }));
  assert.equal(viaNode.ok, true);
  assert.equal(viaFetch.ok, true);
  assert.equal(viaNode.pass.role, 'parent');
  assert.deepEqual(auth.authorise(viaNode.pass, ['parent', 'learner']), { ok: true });
  assert.deepEqual(auth.authorise(viaNode.pass, ['learner']), { ok: false, status: 403, error: AUTH_MESSAGES.notAllowed });
  assert.equal(auth.authorise(null, ['learner']).status, 403);
  assert.equal(auth.canRead(viaNode.pass, 'draft', { id: 'd' }), false);
  assert.equal(auth.canRead(viaNode.pass, 'draft', { id: 'd', sharedWithParent: '2026-10-21' }), true);
});

test('pass block is self-contained and runs with Web APIs only (as in the Worker)', async () => {
  const source = await readFile(new URL('../server/auth.js', import.meta.url), 'utf8');
  const block = extractPassBlock(source);
  assert.ok(block, 'one start and one end marker line');
  assert.ok(block.length > 2000, 'block has content');
  assert.equal(extractPassBlock(`${source}\n${PASS_BLOCK_START}\n`), null, 'a second marker is refused');
  assert.doesNotMatch(block, /\b(import|export|require|process|Buffer|globalThis|module)\b/);

  const context = vm.createContext({ crypto: globalThis.crypto, TextEncoder, TextDecoder, btoa, atob });
  const api = vm.runInContext(`${block}\n;({ passSettings, mintPass, verifyPass, canReadItem })`, context);
  const { settings } = api.passSettings(ENV);
  const token = await api.mintPass({ login: 'example-learner', settings, now: NOW });
  const inBlock = await api.verifyPass(token, settings, { now: NOW });
  assert.equal(inBlock.ok, true);
  // A pass minted in the Worker copy must verify on the server copy, and vice versa.
  assert.equal((await verifyPass(token, settingsFrom(), { now: NOW })).ok, true);
  const serverToken = await mintPass({ login: 'Example-Parent', settings: settingsFrom(), now: NOW });
  assert.equal((await api.verifyPass(serverToken, settings, { now: NOW })).ok, true);
  assert.equal(api.canReadItem('parent', 'plan', {}), false);
});
