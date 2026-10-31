// Curriculum loader (build spec Appendix A.2 and §6 / A-005; blueprint §2.2). Reads
// curriculum/<qual>/ from the storage clone once at start-up. Read-only: unit selection is
// written by WP-120. Field names are read leniently (several spellings), because the files were
// written by hand per qualification; `npm run curriculum:check` reports what it finds.
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

export const CURRICULUM_DIR = 'curriculum';
export const CURRICULUM_FILES = Object.freeze({
  qualification: 'qualification.json',
  units: 'units.json',
  topics: 'topics.json',
  aos: 'aos.json',
  commandWords: 'command-words.json',
});
export const QUAL_DIR_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
// IDs are lowercase, from the qualification and the specification's numbering (e.g. geo-2b-3)
export const TOPIC_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/;
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_COMMAND_WORDS = 30;

const HOUSEKEEPING = new Set(['createdAt', 'updatedAt', 'createdBy', 'schemaVersion', 'sourceFile', 'sources']);
const UNIT_LINK_KEYS = ['unitId', 'unit', 'unitRef', 'componentId', 'component'];
const AO_LINK_KEYS = ['aoIds', 'aos', 'assessmentObjectives', 'aoRefs'];
const OPTIONAL_WORDS = new Set(['optional', 'option', 'elective']);
const MANDATORY_WORDS = new Set(['mandatory', 'compulsory', 'required', 'core']);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function firstOf(record, keys) {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null && record[key] !== '') return record[key];
  }
  return undefined;
}

const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** A list of non-empty strings from a string, an array of strings, or anything else (→ []). */
export function stringList(value) {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  if (!Array.isArray(value)) return [];
  return value.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim());
}

function recordsFrom(value) {
  if (Array.isArray(value)) return value.filter(isObject);
  if (!isObject(value)) return [];
  // a wrapper object such as { "topics": [ … ] }, but never a record that has its own id
  if (!('id' in value)) {
    for (const key of ['records', 'items', 'units', 'topics', 'aos', 'assessmentObjectives', 'commandWords', 'qualifications']) {
      if (Array.isArray(value[key])) return value[key].filter(isObject);
    }
  }
  return [value];
}

/** Records from a file's text: a JSON array, one JSON object, a wrapper object, or JSON Lines. */
export function parseRecords(source) {
  const trimmed = String(source ?? '').replace(/^\uFEFF/, '').trim();
  if (!trimmed) return [];
  try {
    return recordsFrom(JSON.parse(trimmed));
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
  }
  const out = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const one = line.trim().replace(/,$/, '');
    if (!one || one === '[' || one === ']') continue;
    out.push(...recordsFrom(JSON.parse(one)));
  }
  return out;
}

/** Unit IDs named anywhere in optionalGroups (either/or pairs), whatever shape the groups take. */
export function optionalGroupUnitIds(groups) {
  const ids = new Set();
  const visit = (g, depth) => {
    if (depth > 4) return;
    if (typeof g === 'string' && depth > 0) ids.add(g.trim());
    else if (Array.isArray(g)) g.forEach((x) => visit(x, depth + 1));
    else if (isObject(g)) {
      for (const key of ['units', 'unitIds', 'options', 'choices', 'pair']) {
        if (Array.isArray(g[key])) visit(g[key], depth + 1);
      }
    }
  };
  visit(groups, 0);
  return ids;
}

function unitKind(record, id, groupIds) {
  if (record.optional === true || record.mandatory === false || record.required === false) return 'optional';
  if (record.mandatory === true || record.required === true || record.optional === false) return 'mandatory';
  for (const key of ['type', 'status', 'kind', 'category']) {
    const word = typeof record[key] === 'string' ? record[key].toLowerCase() : '';
    if (OPTIONAL_WORDS.has(word)) return 'optional';
    if (MANDATORY_WORDS.has(word)) return 'mandatory';
  }
  return groupIds.has(id) ? 'optional' : 'mandatory';
}

/**
 * Which units count, from the qualification's own fields (A-005; build spec §6).
 * Complete choice → mandatory units plus selected optional units. Incomplete choice → every
 * unit is possible. Current units narrow that further; none marked → all active units.
 */
export function unitStatus(qual) {
  const record = qual.record || {};
  const allIds = qual.units.map((u) => u.id);
  const known = new Set(allIds);
  const mandatory = qual.units.filter((u) => u.kind === 'mandatory').map((u) => u.id);
  const optional = qual.units.filter((u) => u.kind === 'optional').map((u) => u.id);
  const selected = stringList(record.selectedUnits).filter((id) => known.has(id));
  const complete = record.optionalChoiceComplete === true && (optional.length === 0 || selected.length > 0);
  const activeSet = complete ? new Set([...mandatory, ...selected]) : new Set(allIds);
  const active = allIds.filter((id) => activeSet.has(id));
  const marked = stringList(record.currentUnits).filter((id) => activeSet.has(id));
  return {
    complete,
    incomplete: !complete && optional.length > 0,
    mandatory,
    optional,
    selected,
    active,
    current: marked.length ? allIds.filter((id) => marked.includes(id)) : active,
    currentSet: marked.length > 0,
  };
}

function cleanRecord(record) {
  const out = {};
  for (const [key, value] of Object.entries(record)) if (!HOUSEKEEPING.has(key)) out[key] = value;
  return out;
}

async function readRecords(file, label, errors) {
  let buf;
  try {
    buf = await readFile(file);
  } catch (err) {
    errors.push(`${label}: ${err.code === 'ENOENT' ? 'missing' : 'unreadable'}`);
    return null;
  }
  if (buf.length > MAX_FILE_BYTES) {
    errors.push(`${label}: larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`);
    return null;
  }
  try {
    return parseRecords(buf.toString('utf8'));
  } catch {
    errors.push(`${label}: not valid JSON`);
    return null;
  }
}

/** Load one qualification folder. Returns { qual, errors }; qual is null if it can't be used. */
export async function loadQualification(root, name) {
  const errors = [];
  const dir = path.join(root, name);
  const label = (file) => `${CURRICULUM_DIR}/${name}/${file}`;
  const read = (key) => readRecords(path.join(dir, CURRICULUM_FILES[key]), label(CURRICULUM_FILES[key]), errors);

  const qualRecords = await read('qualification');
  const topicRecords = await read('topics');
  if (!qualRecords?.length || !topicRecords) {
    if (qualRecords && !qualRecords.length) errors.push(`${label(CURRICULUM_FILES.qualification)}: no record`);
    return { qual: null, errors };
  }
  const record = qualRecords[0];
  const groupIds = optionalGroupUnitIds(record.optionalGroups);

  const units = [];
  for (const [i, u] of ((await read('units')) || []).entries()) {
    const id = text(firstOf(u, ['id', 'code']));
    if (!id) { errors.push(`${label(CURRICULUM_FILES.units)}: record ${i + 1} has no id`); continue; }
    units.push({
      id,
      code: text(u.code) ?? id,
      title: text(firstOf(u, ['title', 'name'])),
      assessment: text(firstOf(u, ['assessment', 'assessed', 'assessmentType', 'assessmentMode'])),
      kind: unitKind(u, id, groupIds),
      record: u,
    });
  }
  const unitIds = new Set(units.map((u) => u.id));

  const topics = [];
  const seen = new Set();
  let unlinked = 0;
  for (const [i, t] of topicRecords.entries()) {
    const id = text(t.id);
    if (!id || !TOPIC_ID_PATTERN.test(id)) { errors.push(`${label(CURRICULUM_FILES.topics)}: record ${i + 1} has no valid id`); continue; }
    if (seen.has(id)) { errors.push(`${label(CURRICULUM_FILES.topics)}: topic ${id} is listed twice`); continue; }
    seen.add(id);
    const unitId = text(firstOf(t, UNIT_LINK_KEYS));
    if (unitId && !unitIds.has(unitId)) unlinked += 1;
    topics.push({
      id,
      qualId: name,
      unitId: unitId && unitIds.has(unitId) ? unitId : null,
      title: text(firstOf(t, ['title', 'name'])),
      kind: text(t.kind),
      record: t,
    });
  }
  if (unlinked) errors.push(`${label(CURRICULUM_FILES.topics)}: ${unlinked} topics name a unit that isn't in units.json`);

  const aos = ((await read('aos')) || [])
    .map((a) => ({ id: text(firstOf(a, ['id', 'code'])), record: a }))
    .filter((a) => a.id);
  const commandWords = ((await read('commandWords')) || [])
    .map((c) => ({
      word: text(firstOf(c, ['word', 'term', 'commandWord', 'id'])),
      meaning: text(firstOf(c, ['meaning', 'definition', 'description'])),
    }))
    .filter((c) => c.word);

  const qual = {
    id: name,
    title: text(firstOf(record, ['title', 'name'])) ?? name,
    awardingBody: text(firstOf(record, ['awardingBody', 'board', 'awarding_body'])),
    specificationCode: text(firstOf(record, ['specificationCode', 'specCode', 'code'])),
    record,
    units,
    topics,
    aos,
    commandWords,
  };
  qual.status = unitStatus(qual);
  return { qual, errors };
}

/**
 * Load every curriculum/<qual>/ folder under the storage clone.
 * Returns { qualifications: Map, topics: Map(topicId → topic), errors: string[] }.
 * Errors name files and topic IDs only. Never throws for missing or broken files.
 */
export async function loadCurriculum({ dir }) {
  const root = path.join(dir, CURRICULUM_DIR);
  const result = { qualifications: new Map(), topics: new Map(), errors: [] };
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    result.errors.push(`${CURRICULUM_DIR}/: ${err.code === 'ENOENT' ? 'missing' : 'unreadable'}`);
    return result;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    if (!QUAL_DIR_PATTERN.test(entry.name)) {
      result.errors.push(`${CURRICULUM_DIR}/${entry.name}: folder name not allowed`);
      continue;
    }
    const { qual, errors } = await loadQualification(root, entry.name);
    result.errors.push(...errors);
    if (!qual) continue;
    result.qualifications.set(qual.id, qual);
    for (const topic of qual.topics) {
      const other = result.topics.get(topic.id);
      // IDs are the shared key across all records, so a clash keeps the first and reports it
      if (other) { result.errors.push(`${CURRICULUM_DIR}/${qual.id}/topics.json: topic ${topic.id} is also in ${other.qualId}`); continue; }
      result.topics.set(topic.id, topic);
    }
  }
  return result;
}

/** Whether a topic's unit counts (active) and is current. Topics with no unit always count. */
export function topicUnitState(curriculum, topic) {
  const qual = curriculum?.qualifications?.get(topic?.qualId);
  if (!qual) return { active: false, current: false };
  if (!topic.unitId) return { active: true, current: true };
  return { active: qual.status.active.includes(topic.unitId), current: qual.status.current.includes(topic.unitId) };
}

/**
 * Topics for matching (WP-106) and Learn something: { id, qualId, unitId, title, kind }.
 * activeOnly (default) applies the unit choice; currentOnly narrows to current units.
 */
export function listTopics(curriculum, { qualId = null, activeOnly = true, currentOnly = false } = {}) {
  const out = [];
  for (const topic of curriculum?.topics?.values() ?? []) {
    if (qualId && topic.qualId !== qualId) continue;
    const state = topicUnitState(curriculum, topic);
    if ((activeOnly && !state.active) || (currentOnly && !state.current)) continue;
    out.push({ id: topic.id, qualId: topic.qualId, unitId: topic.unitId, title: topic.title, kind: topic.kind });
  }
  return out;
}

/** The curriculum extract for one topic (blueprint §7.3 item 3), or null if it isn't known. */
export function topicExtract(curriculum, topicId) {
  const topic = curriculum?.topics?.get(topicId);
  if (!topic) return null;
  const qual = curriculum.qualifications.get(topic.qualId);
  const unit = qual.units.find((u) => u.id === topic.unitId) || null;
  const aoIds = new Set(stringList(firstOf(topic.record, AO_LINK_KEYS)));
  // a topic that names no assessment objectives gets the qualification's (there are only a few)
  const aos = aoIds.size ? qual.aos.filter((a) => aoIds.has(a.id)) : qual.aos;
  return {
    qualification: { id: qual.id, title: qual.title, awardingBody: qual.awardingBody, specificationCode: qual.specificationCode },
    unit: unit ? { id: unit.id, code: unit.code, title: unit.title, assessment: unit.assessment } : null,
    topic: cleanRecord(topic.record),
    assessmentObjectives: aos.map((a) => cleanRecord(a.record)),
    commandWords: qual.commandWords.slice(0, MAX_COMMAND_WORDS),
  };
}

/** Load at start-up and log counts and problems (file names and IDs only). Never throws. */
export async function startCurriculum({ dir, log = console } = {}) {
  try {
    const curriculum = await loadCurriculum({ dir });
    const problems = curriculum.errors.length ? `, ${curriculum.errors.length} problem(s)` : '';
    log.log(`[curriculum] loaded: ${curriculum.qualifications.size} qualifications, ${curriculum.topics.size} topics${problems}`);
    for (const line of curriculum.errors.slice(0, 10)) log.log(`[curriculum] ${line}`);
    return curriculum;
  } catch (err) {
    log.error(`[curriculum] could not load: ${err?.name ?? 'Error'}`);
    return null;
  }
}
