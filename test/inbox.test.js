// Inbox processing on the server, the A-002 image check, the store's move/sync, and uploads in the
// snapshot. Invented captures only; no real git (a fake runGit stands in).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../server/storage/store.js';
import {
  processInbox, startInboxPoller, checkInboxMetadata, uploadRecord, inboxPaths, uploadIdFor, base64Bytes,
  inboxMetadata, INBOX_MAX_BYTES, INBOX_MAX_BASE64,
} from '../server/storage/inbox.js';
import { imageLimits, checkImage, loadImageLimits, IMAGE_TOO_LARGE_MESSAGE } from '../server/ai/limits.js';
import { buildSnapshot } from '../server/storage/snapshot.js';

const silent = { log() {}, error() {} };
const NOW = new Date('2026-11-02T18:04:11Z');
// The shape of an account model list, with the light model's limits as found in phase 0.
const MODEL_LIST = [{
  id: 'example-light-model',
  capabilities: {
    supports: { vision: true },
    limits: { vision: { max_prompt_image_size: 3_145_728, max_prompt_images: 5, supported_media_types: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] } },
  },
}];
const LIMITS = imageLimits(MODEL_LIST, 'example-light-model');

function fakeGit() {
  const calls = [];
  const runGit = async (args) => {
    calls.push(args.join(' '));
    return { code: 0, stdout: args[0] === 'rev-list' ? '0' : '', stderr: '' };
  };
  return { calls, runGit };
}

async function newStore() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'inbox-test-'));
  const dir = path.join(root, 'clone');
  await mkdir(path.join(dir, '.git'), { recursive: true });
  const git = fakeGit();
  const store = createStore({ dir, remoteUrl: 'https://github.com/example-owner/example-data.git', env: {}, runGit: git.runGit, batchMs: 60_000, log: silent, now: () => NOW });
  assert.equal(await store.init(), true);
  return { store, dir, root, git };
}

// What the Worker writes: the file, then its metadata.
async function workerCapture(dir, { clientId, mimeType = 'image/jpeg', bytes = 1000, source = 'camera', kind = 'own', withFile = true, withMeta = true, meta = {} }) {
  const paths = inboxPaths(clientId, mimeType);
  await mkdir(path.join(dir, 'inbox'), { recursive: true });
  if (withFile) await writeFile(path.join(dir, paths.file), Buffer.alloc(bytes, 7));
  if (withMeta) {
    const body = { ...inboxMetadata({ clientId, mimeType, bytes, source, kind, capturedAt: '2026-11-02T18:00:00+00:00', receivedAt: '2026-11-02T18:00:05+00:00', role: 'learner' }), ...meta };
    await writeFile(path.join(dir, paths.meta), JSON.stringify(body));
  }
  return paths;
}

async function events(dir) {
  const folder = path.join(dir, 'events');
  if (!existsSync(folder)) return [];
  const out = [];
  for (const name of await readdir(folder)) {
    out.push(...(await readFile(path.join(folder, name), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l)));
  }
  return out;
}

test('inbox block helpers: paths, upload IDs, base64 sizes and limits', () => {
  assert.deepEqual(inboxPaths('cap-abcdef12', 'image/jpeg'), { file: 'inbox/cap-abcdef12.jpg', meta: 'inbox/cap-abcdef12.json' });
  assert.equal(inboxPaths('cap-abcdef12', 'application/pdf').file, 'inbox/cap-abcdef12.pdf');
  assert.equal(inboxPaths('short', 'image/jpeg'), null, 'device IDs are at least 8 characters');
  assert.equal(inboxPaths('../escape1', 'image/jpeg'), null);
  assert.equal(inboxPaths('cap-abcdef12', 'text/html'), null);
  assert.equal(inboxPaths('cap-abcdef12', 'toString'), null);
  assert.equal(uploadIdFor('cap-abcdef12'), 'up_cap-abcdef12');
  assert.equal(base64Bytes('QUJD'), 3);
  assert.equal(base64Bytes('QUI='), 2);
  assert.equal(base64Bytes('QQ=='), 1);
  assert.equal(base64Bytes('QUJ'), null);
  assert.equal(base64Bytes(''), null);
  assert.equal(INBOX_MAX_BYTES, 8 * 1024 * 1024);
  assert.ok(INBOX_MAX_BASE64 >= (INBOX_MAX_BYTES / 3) * 4);
});

test('image limits come from the model list; the A-002 check refuses oversized and unsupported images', () => {
  assert.deepEqual(LIMITS, { modelId: 'example-light-model', vision: true, maxBytes: 3_145_728, mediaTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] });
  assert.equal(imageLimits(MODEL_LIST, 'not-there'), null);
  assert.equal(imageLimits(null, 'example-light-model'), null);
  assert.deepEqual(checkImage({ bytes: 700 * 1024, mimeType: 'image/jpeg' }, LIMITS), { ok: true, reason: null });
  assert.deepEqual(checkImage({ bytes: 3_145_729, mimeType: 'image/jpeg' }, LIMITS), { ok: false, reason: 'too-large' });
  assert.deepEqual(checkImage({ bytes: 100, mimeType: 'image/heic' }, LIMITS), { ok: false, reason: 'unsupported-type' });
  assert.deepEqual(checkImage({ bytes: 100, mimeType: 'image/jpeg' }, { ...LIMITS, vision: false }), { ok: false, reason: 'no-vision' });
  assert.deepEqual(checkImage({ bytes: 9e9, mimeType: 'image/jpeg' }, null), { ok: true, reason: null });
  assert.equal(IMAGE_TOO_LARGE_MESSAGE, 'This photo is too large to read. Please take it again.');
});

test('loadImageLimits reads the role model from the AI handle and never throws', async () => {
  const handle = { models: { light: 'example-light-model' }, ai: { listModels: async () => MODEL_LIST } };
  assert.equal((await loadImageLimits(handle)).maxBytes, 3_145_728);
  assert.equal(await loadImageLimits(null), null);
  assert.equal(await loadImageLimits({ models: { light: 'x' }, ai: { listModels: async () => { throw new Error('offline'); } } }), null);
});

test('store.move takes a file out of inbox/; remove needs allowInbox there; sync pulls without committing', async () => {
  const { store, dir, root, git } = await newStore();
  try {
    await mkdir(path.join(dir, 'inbox'), { recursive: true });
    await writeFile(path.join(dir, 'inbox', 'a-capture1.png'), 'x');
    await writeFile(path.join(dir, 'inbox', 'a-capture1.json'), '{}');
    await store.move('inbox/a-capture1.png', 'uploads/up_a-capture1.png');
    assert.ok(existsSync(path.join(dir, 'uploads', 'up_a-capture1.png')));
    assert.ok(!existsSync(path.join(dir, 'inbox', 'a-capture1.png')));
    await assert.rejects(store.move('notebook/x.json', 'inbox/x.json'), /Worker only/);
    await assert.rejects(store.remove('inbox/a-capture1.json'), /Worker only/);
    await store.remove('inbox/a-capture1.json', { allowInbox: true });
    assert.ok(!existsSync(path.join(dir, 'inbox', 'a-capture1.json')));
    assert.equal(store.status().pending, 3);
    git.calls.length = 0;
    const result = await store.sync();
    assert.equal(result.error, undefined);
    assert.ok(git.calls.some((c) => c.startsWith('pull --rebase')));
    assert.ok(!git.calls.some((c) => c.startsWith('commit') || c.startsWith('add')), 'sync never commits');
    assert.equal(store.status().ok, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('processInbox: a photo becomes an Upload waiting to be read; the inbox is emptied; the event has no content', async () => {
  const { store, dir, root } = await newStore();
  try {
    await workerCapture(dir, { clientId: 'cap-photo0001', mimeType: 'image/jpeg', bytes: 300 * 1024, kind: 'brief' });
    const summary = await processInbox({ store, getImageLimits: () => LIMITS, now: () => NOW, log: silent });
    assert.deepEqual(summary, { processed: 1, failed: 0, duplicates: 0, waiting: 0, skipped: 0 });
    assert.deepEqual(await store.list('inbox'), []);
    assert.deepEqual(await store.list('uploads'), ['up_cap-photo0001.jpg', 'up_cap-photo0001.json']);
    const record = await store.read('uploads/up_cap-photo0001.json');
    for (const field of ['id', 'createdAt', 'updatedAt', 'createdBy', 'schemaVersion']) assert.ok(field in record, field);
    assert.equal(record.id, 'up_cap-photo0001');
    assert.equal(record.createdAt, '2026-11-02T18:04:11+00:00', 'UK time');
    assert.equal(record.status, 'processing');
    assert.equal(record.sizeCheck, 'passed');
    assert.equal(record.origin, 'photo');
    assert.equal(record.contentKind, 'brief');
    assert.equal(record.file, 'uploads/up_cap-photo0001.jpg');
    assert.equal(record.extractedText, null);
    const [event] = (await events(dir)).filter((e) => e.type.startsWith('upload.'));
    assert.equal(event.type, 'upload.received');
    assert.deepEqual(Object.keys(event.payload).sort(), ['bytes', 'mimeType', 'source', 'uploadId']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('processInbox: a photo over the model limit is kept but marked failed (A-002)', async () => {
  const { store, dir, root } = await newStore();
  try {
    await workerCapture(dir, { clientId: 'cap-bigphoto1', mimeType: 'image/jpeg', bytes: 4 * 1024 * 1024 });
    const summary = await processInbox({ store, getImageLimits: () => LIMITS, now: () => NOW, log: silent });
    assert.equal(summary.failed, 1);
    const record = await store.read('uploads/up_cap-bigphoto1.json');
    assert.equal(record.status, 'failed');
    assert.equal(record.failureReason, 'too-large');
    assert.equal(record.sizeCheck, 'failed');
    const event = (await events(dir)).find((e) => e.type === 'upload.failed');
    assert.equal(event.payload.reason, 'too-large');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('processInbox is idempotent: a retry from the device never makes a second upload', async () => {
  const { store, dir, root } = await newStore();
  try {
    await workerCapture(dir, { clientId: 'cap-retry0001', mimeType: 'image/png', bytes: 2000 });
    await processInbox({ store, getImageLimits: () => LIMITS, now: () => NOW, log: silent });
    const first = await store.read('uploads/up_cap-retry0001.json');
    await workerCapture(dir, { clientId: 'cap-retry0001', mimeType: 'image/png', bytes: 2000 });
    const later = new Date(NOW.getTime() + 60_000);
    const summary = await processInbox({ store, getImageLimits: () => LIMITS, now: () => later, log: silent });
    assert.equal(summary.duplicates, 1);
    assert.equal(summary.processed, 0);
    assert.deepEqual(await store.list('inbox'), []);
    assert.deepEqual(await store.read('uploads/up_cap-retry0001.json'), first);
    assert.deepEqual(await store.list('uploads'), ['up_cap-retry0001.json', 'up_cap-retry0001.png']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('processInbox leaves half-written or invalid captures alone', async () => {
  const { store, dir, root } = await newStore();
  try {
    await workerCapture(dir, { clientId: 'cap-nofile01', withFile: false });
    await workerCapture(dir, { clientId: 'cap-nometa01', withMeta: false });
    await workerCapture(dir, { clientId: 'cap-badmeta1', meta: { clientId: 'cap-someone2' } });
    await workerCapture(dir, { clientId: 'cap-parent01', meta: { uploaderRole: 'parent' } });
    const summary = await processInbox({ store, getImageLimits: () => LIMITS, now: () => NOW, log: silent });
    assert.equal(summary.processed, 0);
    assert.equal(summary.skipped, 3);
    assert.deepEqual(await store.list('uploads'), []);
    assert.equal((await store.list('inbox')).length, 6);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('photos wait for the image limits just after start-up; PDFs and Word files do not need them', async () => {
  const { store, dir, root } = await newStore();
  try {
    await workerCapture(dir, { clientId: 'cap-waiting1', mimeType: 'image/jpeg' });
    await workerCapture(dir, { clientId: 'cap-adocument', mimeType: 'application/pdf', source: 'file' });
    const early = await processInbox({ store, getImageLimits: () => null, waitForLimits: true, now: () => NOW, log: silent });
    assert.equal(early.waiting, 1);
    assert.equal(early.processed, 1);
    const pdf = await store.read('uploads/up_cap-adocument.json');
    assert.equal(pdf.sizeCheck, 'not-checked');
    assert.equal(pdf.origin, 'file');
    // after the wait, a photo is taken in unchecked rather than left in the inbox for ever
    const late = await processInbox({ store, getImageLimits: () => null, waitForLimits: false, now: () => NOW, log: silent });
    assert.equal(late.processed, 1);
    assert.equal((await store.read('uploads/up_cap-waiting1.json')).sizeCheck, 'not-checked');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('processInbox finishes a capture whose file was moved before a crash', async () => {
  const { store, dir, root } = await newStore();
  try {
    await workerCapture(dir, { clientId: 'cap-crashed1', mimeType: 'image/jpeg', withFile: false });
    await mkdir(path.join(dir, 'uploads'), { recursive: true });
    await writeFile(path.join(dir, 'uploads', 'up_cap-crashed1.jpg'), 'x');
    const summary = await processInbox({ store, getImageLimits: () => LIMITS, now: () => NOW, log: silent });
    assert.equal(summary.processed, 1);
    assert.ok(await store.read('uploads/up_cap-crashed1.json'));
    assert.deepEqual(await store.list('inbox'), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('checkInboxMetadata and uploadRecord keep only known fields', () => {
  const meta = inboxMetadata({ clientId: 'cap-abcdef12', mimeType: 'image/webp', bytes: 10, source: 'nonsense', kind: 'nonsense', capturedAt: 'yesterday', receivedAt: '2026-11-02T18:00:00+00:00', role: 'learner' });
  assert.equal(meta.source, 'file');
  assert.equal(meta.kind, 'own', 'unclear counts as own writing (A-001)');
  assert.equal(meta.capturedAt, null);
  assert.ok(checkInboxMetadata(meta, 'cap-abcdef12').meta);
  assert.match(checkInboxMetadata({ ...meta, bytes: INBOX_MAX_BYTES + 1 }, 'cap-abcdef12').error, /size/);
  assert.match(checkInboxMetadata(null, 'cap-abcdef12').error, /object/);
  const record = uploadRecord({ meta: checkInboxMetadata(meta, 'cap-abcdef12').meta, sizeCheck: { state: 'passed', reason: null }, now: NOW });
  assert.equal(record.file, 'uploads/up_cap-abcdef12.webp');
  assert.equal(record.failureReason, null);
});

test('the poller processes at once without pulling, then pulls on a timer and backs off after a failed pull', async () => {
  const timers = [];
  let pulls = 0;
  let pullFails = false;
  const store = {
    sync: async () => { pulls += 1; return pullFails ? { error: 'pull failed: offline' } : { pulled: 0 }; },
    list: async () => [],
    read: async () => null,
  };
  const poller = startInboxPoller({
    store, log: silent, pollMs: 10_000, backoffMs: 60_000,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; }, clearTimer: () => {},
  });
  const first = await poller.first;
  assert.equal(first.ok, true);
  assert.equal(pulls, 0, 'storage has only just pulled at start-up');
  assert.equal(timers.at(-1).ms, 10_000);
  await timers.at(-1).fn();
  assert.equal(pulls, 1);
  assert.equal(timers.at(-1).ms, 10_000);
  pullFails = true;
  await timers.at(-1).fn();
  assert.equal(timers.at(-1).ms, 60_000);
  poller.stop();
});

test('snapshot lists uploads by a plain label and status only, never for the parent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'snap-upload-'));
  try {
    await mkdir(path.join(root, 'uploads'), { recursive: true });
    const record = {
      ...uploadRecord({ meta: inboxMetadata({ clientId: 'cap-snapshot1', mimeType: 'image/jpeg', bytes: 10, source: 'camera', kind: 'brief', receivedAt: null, role: 'learner' }), sizeCheck: { state: 'passed', reason: null }, now: NOW }),
      // as if phase 1 had read it, and as if someone had tried to share it
      extractedText: { value: 'INVENTED-SECRET-UPLOAD-TEXT', author: 'ai' },
      sharedWithParent: '2026-11-02T18:00:00+00:00',
    };
    await writeFile(path.join(root, 'uploads', 'up_cap-snapshot1.json'), JSON.stringify(record));
    await mkdir(path.join(root, 'inbox'), { recursive: true });
    await writeFile(path.join(root, 'inbox', 'cap-pending01.json'), '{}');
    const snapshot = await buildSnapshot({ dir: root, now: NOW });
    assert.deepEqual(snapshot.learner.recent, [
      { type: 'upload', id: 'up_cap-snapshot1', title: 'Photo', updatedAt: '2026-11-02T18:04:11+00:00', status: 'processing' },
    ]);
    assert.equal(snapshot.learner.inboxPending, 1);
    assert.deepEqual(snapshot.parent.shared, []);
    assert.doesNotMatch(JSON.stringify(snapshot), /INVENTED-SECRET-UPLOAD-TEXT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
