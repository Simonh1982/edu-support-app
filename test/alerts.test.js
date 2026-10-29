// WP-015: alerts through repository_dispatch. Fake fetch only; invented repository and token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ALERT_EVENT_TYPE, ALERT_KINDS, ALERT_LEVELS, alertPayload, alertSettings, sendAlert, ukDate,
} from '../server/alerts.js';
import { DEFAULT_GAP_S, parseArgs, runCheck } from '../scripts/alert-check.js';

const REPO = 'example-owner/example-store';
const TOKEN = 'test-token-not-real-0123456789';
const SETTINGS = { repo: REPO, token: TOKEN };
const NOW = new Date(Date.UTC(2026, 9, 30, 12, 0, 0)); // 30 Oct 2026, 12:00 UTC = 12:00 GMT

function capture() {
  const lines = [];
  return { lines, log: { log: (m) => lines.push(m), error: (m) => lines.push(m) } };
}

function fakeFetch(respond) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return respond(calls.length);
  };
  return { fetchImpl, calls };
}

const noContent = () => new Response(null, { status: 204 });

// ---------- settings and payload ----------

test('alertSettings needs both secrets and an owner/name repository', () => {
  assert.deepEqual(alertSettings({ STORAGE_REPO: REPO, STORAGE_TOKEN: TOKEN }), SETTINGS);
  assert.ok(alertSettings({}).skip);
  assert.ok(alertSettings({ STORAGE_REPO: REPO }).skip);
  assert.ok(alertSettings({ STORAGE_REPO: 'not a repo', STORAGE_TOKEN: TOKEN }).skip);
  assert.ok(!JSON.stringify(alertSettings({ STORAGE_REPO: REPO })).includes(REPO), 'skip reason names no repository');
});

test('ukDate uses the UK calendar date, including just after midnight in summer time', () => {
  assert.equal(ukDate(NOW), '2026-10-30');
  // 23:30 UTC on 1 July is 00:30 BST on 2 July
  assert.equal(ukDate(new Date(Date.UTC(2026, 6, 1, 23, 30))), '2026-07-02');
});

test('alertPayload sends kind, level and date only, and refuses anything else', () => {
  assert.deepEqual(alertPayload({ kind: 'wellbeing', level: 3, now: NOW }), { payload: { kind: 'wellbeing', level: 3, date: '2026-10-30' } });
  assert.deepEqual(alertPayload({ kind: 'wellbeing', level: 2, now: NOW }), { payload: { kind: 'wellbeing', level: 2, date: '2026-10-30' } });
  assert.deepEqual(alertPayload({ kind: 'wake-failed', now: NOW }), { payload: { kind: 'wake-failed', date: '2026-10-30' } });
  for (const level of [0, 1, 4, '3', null, undefined]) {
    assert.ok(alertPayload({ kind: 'wellbeing', level, now: NOW }).error, `level ${level}`);
  }
  assert.ok(alertPayload({ kind: 'other', level: 3 }).error);
  assert.deepEqual(ALERT_KINDS, ['wellbeing', 'wake-failed']);
  assert.deepEqual(ALERT_LEVELS, [2, 3]);
});

// ---------- sending ----------

test('sendAlert posts the dispatch with the headers GitHub needs', async () => {
  const { fetchImpl, calls } = fakeFetch(noContent);
  const { lines, log } = capture();
  const result = await sendAlert({ kind: 'wellbeing', level: 3, settings: SETTINGS, fetchImpl, now: NOW, log });
  assert.deepEqual(result, { ok: true, status: 204 });
  assert.equal(calls.length, 1);
  const [{ url, init, body }] = calls;
  assert.equal(url, `https://api.github.com/repos/${REPO}/dispatches`);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(init.headers.Accept, 'application/vnd.github+json');
  assert.equal(init.headers['X-GitHub-Api-Version'], '2022-11-28');
  assert.ok(init.headers['User-Agent'], 'User-Agent is required by GitHub');
  assert.deepEqual(body, { event_type: ALERT_EVENT_TYPE, client_payload: { kind: 'wellbeing', level: 3, date: '2026-10-30' } });
  assert.equal(ALERT_EVENT_TYPE, 'app-alert', 'matches alert.yml: repository_dispatch types [app-alert]');
  assert.ok(lines.every((l) => !l.includes(TOKEN) && !l.includes(REPO)), 'log names no token or repository');
});

test('sendAlert reads the settings from the environment by default', async () => {
  const { fetchImpl, calls } = fakeFetch(noContent);
  const result = await sendAlert({
    kind: 'wellbeing', level: 2, env: { STORAGE_REPO: REPO, STORAGE_TOKEN: TOKEN }, fetchImpl, now: NOW, log: capture().log,
  });
  assert.equal(result.ok, true);
  assert.equal(calls[0].url, `https://api.github.com/repos/${REPO}/dispatches`);
});

test('sendAlert sends nothing without settings or with a bad payload', async () => {
  const { fetchImpl, calls } = fakeFetch(noContent);
  const log = capture().log;
  assert.equal((await sendAlert({ kind: 'wellbeing', level: 3, env: {}, fetchImpl, log })).ok, false);
  assert.equal((await sendAlert({ kind: 'wellbeing', level: 1, settings: SETTINGS, fetchImpl, log })).ok, false);
  assert.equal((await sendAlert({ kind: 'note', level: 3, settings: SETTINGS, fetchImpl, log })).ok, false);
  assert.equal(calls.length, 0);
});

test('a GitHub refusal is reported with the permissions it wanted, without the repository name or token', async () => {
  const { fetchImpl } = fakeFetch(() => new Response(JSON.stringify({ message: `Resource not accessible by personal access token for ${REPO} ${TOKEN}` }), {
    status: 403, headers: { 'Content-Type': 'application/json', 'x-accepted-github-permissions': 'contents=write' },
  }));
  const { lines, log } = capture();
  const result = await sendAlert({ kind: 'wellbeing', level: 3, settings: SETTINGS, fetchImpl, now: NOW, log });
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.equal(result.acceptedPermissions, 'contents=write');
  assert.match(result.error, /GitHub answered 403/);
  const shown = JSON.stringify(result) + lines.join('\n');
  assert.ok(!shown.includes(REPO), 'no repository name');
  assert.ok(!shown.includes(TOKEN), 'no token');
  assert.match(result.error, /<storage-repo>/);
});

test('permissions are shown only for 401, 403 and 404', async () => {
  const headers = { 'x-accepted-github-permissions': 'contents=write' };
  for (const [status, shown] of [[401, true], [404, true], [422, false], [500, false]]) {
    const { fetchImpl } = fakeFetch(() => new Response('{}', { status, headers }));
    const result = await sendAlert({ kind: 'wellbeing', level: 3, settings: SETTINGS, fetchImpl, now: NOW, log: capture().log });
    assert.equal(result.ok, false, String(status));
    assert.equal('acceptedPermissions' in result, shown, String(status));
  }
});

test('network failures and timeouts never throw', async () => {
  const network = await sendAlert({
    kind: 'wellbeing', level: 3, settings: SETTINGS, now: NOW, log: capture().log,
    fetchImpl: async () => { throw new TypeError(`fetch failed for ${REPO}`); },
  });
  assert.equal(network.ok, false);
  assert.equal(network.status, null);
  assert.ok(!network.error.includes(REPO));

  // AbortSignal.timeout's timer doesn't hold the event loop open (a real fetch would), so keep it open here.
  const keepAlive = setTimeout(() => {}, 5000);
  let slow;
  try {
    slow = await sendAlert({
      kind: 'wellbeing', level: 3, settings: SETTINGS, now: NOW, log: capture().log, timeoutMs: 20,
      fetchImpl: (url, init) => new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason));
      }),
    });
  } finally {
    clearTimeout(keepAlive);
  }
  assert.equal(slow.ok, false);
  assert.match(slow.error, /didn't answer/);
});

// ---------- check script ----------

function fakeSend(failOn = new Set()) {
  const calls = [];
  const send = async (args) => {
    calls.push(args);
    return failOn.has(calls.length) ? { ok: false, status: 403, error: 'GitHub answered 403', acceptedPermissions: 'contents=write' } : { ok: true, status: 204 };
  };
  return { send, calls };
}

test('alert:check sends level 3, then level 2 twice with the gap between them', async () => {
  const { send, calls } = fakeSend();
  const order = [];
  const sleeps = [];
  const wrapped = async (args) => { order.push(`send ${args.level}`); return send(args); };
  const result = await runCheck({
    settings: SETTINGS, send: wrapped, out: () => {},
    sleep: async (ms) => { order.push(`sleep ${ms}`); sleeps.push(ms); },
  });
  assert.equal(result.verdict, 'SENT');
  assert.deepEqual(order, ['send 3', 'send 2', `sleep ${DEFAULT_GAP_S * 1000}`, 'send 2']);
  assert.ok(calls.every((c) => c.kind === 'wellbeing' && c.settings === SETTINGS));
  assert.ok(result.lines.some((l) => /comment/.test(l)), 'tells Simon to look for the comment');
  assert.ok(result.lines.some((l) => /close the issues/.test(l)));
});

test('alert:check --only sends just one level, and a failure stops the second level-2 send', async () => {
  const three = fakeSend();
  const r3 = await runCheck({ settings: SETTINGS, only: 3, send: three.send, sleep: async () => {}, out: () => {} });
  assert.deepEqual(three.calls.map((c) => c.level), [3]);
  assert.equal(r3.verdict, 'SENT');

  const failing = fakeSend(new Set([1]));
  const r2 = await runCheck({ settings: SETTINGS, only: 2, send: failing.send, sleep: async () => assert.fail('no wait after a failure'), out: () => {} });
  assert.deepEqual(failing.calls.map((c) => c.level), [2]);
  assert.equal(r2.verdict, 'FAIL');
  assert.ok(r2.lines.some((l) => l.includes('token needs: contents=write')));
});

test('parseArgs accepts --only and --gap and refuses anything else', () => {
  assert.deepEqual(parseArgs([]), { only: null, gapS: DEFAULT_GAP_S });
  assert.deepEqual(parseArgs(['--only', '2', '--gap', '120']), { only: 2, gapS: 120 });
  assert.throws(() => parseArgs(['--only', '1']));
  assert.throws(() => parseArgs(['--gap', '5']));
  assert.throws(() => parseArgs(['--gap', 'soon']));
  assert.throws(() => parseArgs(['--wake']));
});

test('alert code hard-codes no repository or owner name', () => {
  for (const rel of ['../server/alerts.js', '../scripts/alert-check.js']) {
    const source = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
    assert.doesNotMatch(source, /edu-support-data/, rel);
    assert.doesNotMatch(source, /Simonh1982/i, rel);
  }
});
