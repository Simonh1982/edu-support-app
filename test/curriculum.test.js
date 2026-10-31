// Curriculum loader (WP-103). Invented qualifications only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  parseRecords, optionalGroupUnitIds, unitStatus, loadCurriculum, listTopics, topicExtract,
  topicUnitState, startCurriculum,
} from '../server/curriculum.js';
import { checkLines } from '../scripts/curriculum-check.js';

const lines = (records) => `[\n${records.map((r) => JSON.stringify(r)).join(',\n')}\n]\n`;

async function writeQual(root, name, files) {
  const dir = path.join(root, 'curriculum', name);
  await mkdir(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    await writeFile(path.join(dir, file), typeof content === 'string' ? content : lines(content));
  }
}

// An invented unit-based qualification: two mandatory units and an either/or pair.
const demoUnits = [
  { id: 'demo-u1', code: 'U1', title: 'Invented mandatory unit', mandatory: true, assessment: 'exam' },
  { id: 'demo-u2', code: 'U2', title: 'Second mandatory unit', type: 'mandatory', assessment: 'coursework' },
  { id: 'demo-u3', code: 'U3', title: 'Option A' },
  { id: 'demo-u4', code: 'U4', title: 'Option B' },
];
const demoTopics = [
  { id: 'demo-u1-a', unitId: 'demo-u1', title: 'Topic one', kind: 'content', detailLevel: 'outline', aoIds: ['AO1'] },
  { id: 'demo-u2-a', unitId: 'demo-u2', title: 'Topic two', kind: 'learning-aim', detailLevel: 'outline' },
  { id: 'demo-u3-a', unitId: 'demo-u3', title: 'Option A topic', kind: 'content', detailLevel: 'outline' },
  { id: 'demo-u4-a', unitId: 'demo-u4', title: 'Option B topic', kind: 'content', detailLevel: 'outline', createdAt: '2026-10-30T10:00:00+00:00' },
];
const demoAos = [{ id: 'AO1', description: 'Knowledge' }, { id: 'AO2', description: 'Analysis' }];
const demoWords = [{ word: 'Evaluate', meaning: 'Weigh up and judge' }];

async function demoRoot(qualExtra = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'curric-'));
  await writeQual(root, 'demo', {
    'qualification.json': JSON.stringify({ id: 'demo', title: 'Invented Diploma', awardingBody: 'Example Board', optionalGroups: [{ units: ['demo-u3', 'demo-u4'], choose: 1 }], ...qualExtra }),
    'units.json': demoUnits,
    'topics.json': demoTopics,
    'aos.json': demoAos,
    'command-words.json': demoWords,
  });
  return root;
}

test('parseRecords reads arrays, single objects, wrappers and JSON Lines', () => {
  assert.equal(parseRecords('[{"id":"a"},{"id":"b"}]').length, 2);
  assert.deepEqual(parseRecords('{"id":"q","units":["x"]}'), [{ id: 'q', units: ['x'] }]);
  assert.equal(parseRecords('{"topics":[{"id":"a"}]}')[0].id, 'a');
  assert.equal(parseRecords('{"id":"a"}\n{"id":"b"}\n').length, 2);
  assert.deepEqual(parseRecords(''), []);
  assert.throws(() => parseRecords('{not json'), SyntaxError);
});

test('optionalGroupUnitIds handles objects and nested pairs', () => {
  assert.deepEqual([...optionalGroupUnitIds([{ units: ['a', 'b'] }, ['c', 'd']])].sort(), ['a', 'b', 'c', 'd']);
  assert.equal(optionalGroupUnitIds(undefined).size, 0);
});

test('an incomplete optional choice treats every unit as possible (A-005)', async () => {
  const root = await demoRoot();
  try {
    const c = await loadCurriculum({ dir: root });
    assert.deepEqual(c.errors, []);
    const s = c.qualifications.get('demo').status;
    assert.deepEqual(s.mandatory, ['demo-u1', 'demo-u2']);
    assert.deepEqual(s.optional, ['demo-u3', 'demo-u4']);
    assert.equal(s.complete, false);
    assert.equal(s.incomplete, true);
    assert.equal(s.active.length, 4);
    assert.equal(s.currentSet, false);
    assert.equal(listTopics(c).length, 4);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a complete choice keeps mandatory plus selected units; current units narrow further', async () => {
  const root = await demoRoot({ optionalChoiceComplete: true, selectedUnits: ['demo-u3'], currentUnits: ['demo-u2', 'demo-u4'] });
  try {
    const c = await loadCurriculum({ dir: root });
    const s = c.qualifications.get('demo').status;
    assert.deepEqual(s.active, ['demo-u1', 'demo-u2', 'demo-u3']);
    // demo-u4 wasn't selected, so marking it current has no effect
    assert.deepEqual(s.current, ['demo-u2']);
    assert.deepEqual(listTopics(c).map((t) => t.id), ['demo-u1-a', 'demo-u2-a', 'demo-u3-a']);
    assert.deepEqual(listTopics(c, { currentOnly: true }).map((t) => t.id), ['demo-u2-a']);
    assert.equal(topicUnitState(c, c.topics.get('demo-u4-a')).active, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('"complete" with optional units but nothing selected still counts as incomplete', () => {
  const qual = { record: { optionalChoiceComplete: true }, units: [{ id: 'a', kind: 'mandatory' }, { id: 'b', kind: 'optional' }] };
  assert.equal(unitStatus(qual).complete, false);
  const noChoice = { record: { optionalChoiceComplete: true }, units: [{ id: 'a', kind: 'mandatory' }] };
  assert.equal(unitStatus(noChoice).complete, true);
});

test('topicExtract gives the outline, unit, matching AOs and command words, without housekeeping', async () => {
  const root = await demoRoot();
  try {
    const c = await loadCurriculum({ dir: root });
    const one = topicExtract(c, 'demo-u1-a');
    assert.equal(one.qualification.title, 'Invented Diploma');
    assert.equal(one.unit.code, 'U1');
    assert.deepEqual(one.assessmentObjectives.map((a) => a.id), ['AO1']);
    assert.equal(one.commandWords[0].word, 'Evaluate');
    // no AO list on the topic → the qualification's AOs
    assert.equal(topicExtract(c, 'demo-u2-a').assessmentObjectives.length, 2);
    assert.equal('createdAt' in topicExtract(c, 'demo-u4-a').topic, false);
    assert.equal(topicExtract(c, 'nope'), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('broken files are reported by name and the rest still loads', async () => {
  const root = await demoRoot();
  try {
    await writeQual(root, 'other', { 'qualification.json': '{"id":"other"}', 'topics.json': '{broken' });
    await writeQual(root, 'third', {
      'qualification.json': '{"title":"Third"}',
      'topics.json': [{ id: 'demo-u1-a' }, { title: 'no id' }, { id: 'third-1', unitId: 'missing-unit' }],
    });
    await mkdir(path.join(root, 'curriculum', 'Bad Name'), { recursive: true });
    const c = await loadCurriculum({ dir: root });
    assert.deepEqual([...c.qualifications.keys()], ['demo', 'third']);
    const text = c.errors.join('\n');
    assert.match(text, /other\/topics\.json: not valid JSON/);
    assert.match(text, /third\/units\.json: missing/);
    assert.match(text, /record 2 has no valid id/);
    assert.match(text, /topic demo-u1-a is also in demo/);
    assert.match(text, /1 topics name a unit that isn't in units\.json/);
    assert.match(text, /Bad Name: folder name not allowed/);
    // a topic whose unit is unknown counts as always active
    assert.equal(topicUnitState(c, c.topics.get('third-1')).active, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a missing curriculum folder is an error, not a crash; startCurriculum logs counts only', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'curric-'));
  try {
    const c = await loadCurriculum({ dir: root });
    assert.deepEqual(c.errors, ['curriculum/: missing']);
    const logged = [];
    const log = { log: (m) => logged.push(m), error: (m) => logged.push(m) };
    const started = await startCurriculum({ dir: root, log });
    assert.equal(started.topics.size, 0);
    assert.match(logged[0], /\[curriculum\] loaded: 0 qualifications, 0 topics, 1 problem/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('curriculum:check prints structure and field names, never titles or outlines', async () => {
  const root = await demoRoot();
  try {
    const out = (await checkLines(await loadCurriculum({ dir: root }))).join('\n');
    assert.match(out, /--- demo/);
    assert.match(out, /topic fields: .*detailLevel/);
    assert.match(out, /read_curriculum\(first topic\): ok/);
    assert.doesNotMatch(out, /Invented Diploma|Topic one|Knowledge|Weigh up/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
