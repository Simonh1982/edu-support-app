// npm run curriculum:check: loads the curriculum from the storage clone the way the server does
// and prints counts, unit-choice status and the FIELD NAMES it found. It never prints titles,
// outlines or any other content, so the output is safe to paste to the code-writing agent.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadCurriculum, topicExtract } from '../server/curriculum.js';
import { readCurriculumTool } from '../server/ai/read-tools.js';
import { DEFAULT_STORAGE_DIR } from '../server/storage/index.js';

const keysOf = (records) => [...new Set(records.flatMap((r) => Object.keys(r || {})))].sort().join(', ') || '(none)';

/** Report lines for a loaded curriculum. Structure only: counts, IDs of units, field names. */
export async function checkLines(curriculum) {
  const lines = [];
  const tool = readCurriculumTool({ getCurriculum: () => curriculum });
  for (const qual of curriculum.qualifications.values()) {
    const s = qual.status;
    const unlinked = qual.topics.filter((t) => !t.unitId).length;
    lines.push(`--- ${qual.id}`);
    lines.push(`    units ${qual.units.length} (mandatory ${s.mandatory.length}, optional ${s.optional.length}); topics ${qual.topics.length} (no unit link: ${unlinked}); aos ${qual.aos.length}; command words ${qual.commandWords.length}`);
    lines.push(`    choice complete: ${s.complete ? 'yes' : 'no'}; active units ${s.active.length} of ${qual.units.length}; current units marked: ${s.currentSet ? s.current.length : 'none'}`);
    lines.push(`    qualification fields: ${keysOf([qual.record])}`);
    lines.push(`    unit fields: ${keysOf(qual.units.map((u) => u.record))}`);
    lines.push(`    topic fields: ${keysOf(qual.topics.map((t) => t.record))}`);
    const first = qual.topics[0];
    if (first) {
      const extract = topicExtract(curriculum, first.id);
      const text = JSON.stringify(await tool.handler({ topicId: first.id }));
      lines.push(`    read_curriculum(first topic): ${extract ? 'ok' : 'FAIL'}, ${text.length} characters, ${extract?.assessmentObjectives.length ?? 0} aos, unit ${extract?.unit ? 'found' : 'none'}`);
    }
  }
  return lines;
}

async function main() {
  const dir = path.resolve(process.env.STORAGE_DIR || DEFAULT_STORAGE_DIR);
  const curriculum = await loadCurriculum({ dir });
  console.log(`Curriculum: ${curriculum.qualifications.size} qualifications, ${curriculum.topics.size} topics`);
  for (const line of await checkLines(curriculum)) console.log(line);
  console.log(`Problems: ${curriculum.errors.length}`);
  for (const line of curriculum.errors) console.log(`    ${line}`);
  const ok = curriculum.qualifications.size > 0 && curriculum.errors.length === 0;
  console.log(`Overall: ${ok ? 'PASS' : 'CHECK'}`);
  process.exitCode = ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
