// read_curriculum and read_notebook (WP-103). Invented records only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkCustomTools, wrapToolHandler } from '../server/ai/tools.js';
import {
  createReadTools, readCurriculumTool, readNotebookTool, notebookEntryForModel, readNotebookEntries,
  selectNotebookEntries, MAX_NOTEBOOK_ENTRIES, MAX_ENTRY_TEXT,
} from '../server/ai/read-tools.js';

const fakeCurriculum = () => {
  const qual = {
    id: 'demo', title: 'Invented Diploma', awardingBody: null, specificationCode: null,
    units: [{ id: 'demo-u1', code: 'U1', title: 'Unit', assessment: 'exam' }],
    aos: [{ id: 'AO1', record: { id: 'AO1', description: 'Knowledge' } }],
    commandWords: [],
    status: { active: ['demo-u1'], current: ['demo-u1'] },
  };
  const topic = { id: 'demo-u1-a', qualId: 'demo', unitId: 'demo-u1', title: 'T', record: { id: 'demo-u1-a', title: 'T' } };
  return { qualifications: new Map([['demo', qual]]), topics: new Map([[topic.id, topic]]), errors: [] };
};

const entry = (id, fields = {}) => ({ id, type: 'note', title: `Note ${id}`, text: { value: `Invented text ${id}`, author: 'learner' }, updatedAt: `2026-10-${10 + Number(id.slice(1))}T10:00:00+00:00`, ...fields });

test('both tools pass the custom-tool checks and their handlers never throw when wrapped', async () => {
  const tools = createReadTools({ getCurriculum: () => null, getStorageDir: () => null });
  assert.deepEqual(checkCustomTools(tools), ['read_curriculum', 'read_notebook']);
  const failing = { ...tools[0], handler: async () => { throw new Error('boom'); } };
  assert.equal(await wrapToolHandler(failing)({ topicId: 'x' }), 'Not available.');
});

test('read_curriculum returns the extract, and refuses bad or unknown IDs', async () => {
  const tool = readCurriculumTool({ getCurriculum: fakeCurriculum });
  const found = await tool.handler({ topicId: 'demo-u1-a' });
  assert.equal(found.unit.code, 'U1');
  assert.equal(found.assessmentObjectives[0].id, 'AO1');
  assert.deepEqual(await tool.handler({ topicId: '../etc/passwd' }), { error: 'Not a valid topic ID.' });
  assert.deepEqual(await tool.handler({}), { error: 'Not a valid topic ID.' });
  assert.deepEqual(await tool.handler({ topicId: 'demo-zz' }), { error: 'No topic with that ID.' });
  const notLoaded = readCurriculumTool({ getCurriculum: () => null });
  assert.match((await notLoaded.handler({ topicId: 'demo-u1-a' })).error, /isn't loaded/);
});

test('notebook entries keep their author, are capped, and deleted or invalid records are dropped', () => {
  const long = notebookEntryForModel({ id: 'n1', text: 'x'.repeat(MAX_ENTRY_TEXT + 50), author: 'ai', topicId: 'demo-u1-a' });
  assert.equal(long.text.author, 'ai');
  assert.equal(long.text.value.length, MAX_ENTRY_TEXT);
  assert.deepEqual(long.topicIds, ['demo-u1-a']);
  assert.equal(notebookEntryForModel({ id: 'n2', text: { value: 'a', author: 'someone' } }).text.author, 'unknown');
  assert.equal(notebookEntryForModel({ id: 'n3', deletedAt: '2026-10-01' }), null);
  assert.equal(notebookEntryForModel({ id: '../x' }), null);
});

test("another task's notes are never returned, and the model can only narrow the scope (§32.3)", () => {
  const entries = [
    entry('n1', { taskId: 't-current', topicIds: ['demo-a'] }),
    entry('n2', { taskId: 't-other', topicIds: ['demo-a'] }),
    entry('n3', { topicIds: ['demo-a'] }),
    entry('n4', { topicIds: ['demo-b'] }),
    entry('n5', { taskId: 't-current' }),
  ].map(notebookEntryForModel);
  const scope = { taskId: 't-current', topicIds: ['demo-a'] };
  assert.deepEqual(selectNotebookEntries(entries, scope).entries.map((e) => e.id), ['n5', 'n3', 'n1']);
  assert.deepEqual(selectNotebookEntries(entries, scope, { topicId: 'demo-a' }).entries.map((e) => e.id), ['n3', 'n1']);
  assert.deepEqual(selectNotebookEntries(entries, scope, { taskId: 't-current' }).entries.map((e) => e.id), ['n5', 'n1']);
  assert.equal(selectNotebookEntries(entries, scope, { taskId: 't-other' }).entries.length, 0);
  assert.equal(selectNotebookEntries(entries, scope, { topicId: 'demo-b' }).entries.length, 0);
  // no scope at all → nothing
  assert.equal(selectNotebookEntries(entries, {}).entries.length, 0);
  // topic-only scope (e.g. Learn something) never includes task-linked notes
  assert.deepEqual(selectNotebookEntries(entries, { topicIds: ['demo-a'] }).entries.map((e) => e.id), ['n3']);
});

test('at most MAX_NOTEBOOK_ENTRIES are returned, newest first', () => {
  const many = Array.from({ length: MAX_NOTEBOOK_ENTRIES + 5 }, (_, i) => notebookEntryForModel({
    id: `n${i}`, text: 'a', author: 'learner', topicIds: ['demo-a'], updatedAt: `2026-10-01T10:${String(i).padStart(2, '0')}:00+00:00`,
  }));
  const result = selectNotebookEntries(many, { topicIds: ['demo-a'] });
  assert.equal(result.entries.length, MAX_NOTEBOOK_ENTRIES);
  assert.equal(result.more, 5);
  assert.equal(result.entries[0].id, `n${MAX_NOTEBOOK_ENTRIES + 4}`);
});

test('read_notebook reads notebook/*.json from the storage clone and skips broken files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'notebook-'));
  try {
    await mkdir(path.join(root, 'notebook'));
    await writeFile(path.join(root, 'notebook', 'n1.json'), JSON.stringify(entry('n1', { topicIds: ['demo-a'] })));
    await writeFile(path.join(root, 'notebook', 'n2.json'), '{broken');
    await writeFile(path.join(root, 'notebook', 'notes.txt'), 'ignored');
    assert.equal((await readNotebookEntries(root)).length, 1);
    const tool = readNotebookTool({ getStorageDir: () => root, scope: { topicIds: ['demo-a'] } });
    const result = await tool.handler({});
    assert.equal(result.entries[0].text.value, 'Invented text n1');
    assert.deepEqual(await readNotebookEntries(path.join(root, 'missing')), []);
    const off = readNotebookTool({ getStorageDir: () => null });
    assert.match((await off.handler({})).error, /isn't available/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
