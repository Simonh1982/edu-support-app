// Where items live in the storage repository, and the one rule for opening them (blueprint §4.3,
// §5.2, §6.3). The block between the ITEM BLOCK markers is copied verbatim into wake/worker.js, so
// the server and the Worker can never disagree. It uses only PASS_ROLES and PARENT_READABLE_TYPES
// from the pass block, and nothing else.
import { PASS_ROLES, PARENT_READABLE_TYPES, canReadItem } from '../auth.js';

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

// Built in two parts, so these lines don't count as a second copy of the markers.
export const ITEM_BLOCK_START = `// ===== ITEM BLOCK ${'START'}`;
export const ITEM_BLOCK_END = `// ===== ITEM BLOCK ${'END'} =====`;

/** The text between (and including) the ITEM BLOCK markers, or null unless there is exactly one block. */
export function extractItemBlock(source) {
  const start = source.indexOf(ITEM_BLOCK_START);
  const end = source.indexOf(ITEM_BLOCK_END);
  if (start < 0 || end < start) return null;
  if (source.indexOf(ITEM_BLOCK_START, start + 1) >= 0 || source.indexOf(ITEM_BLOCK_END, end + 1) >= 0) return null;
  return source.slice(start, end + ITEM_BLOCK_END.length);
}

/**
 * The server's GET /api/item answer for an already-verified pass.
 * Unshared and missing items get the same 404, so the parent can't tell whether an item exists.
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function itemResponse({ store, pass, query }) {
  const type = query.get('type');
  const { path, error } = itemPath(type, query.get('id'), query.get('task'));
  if (!path) return { status: 400, body: { error: `Bad item request: ${error}.` } };
  if (!itemTypeAllowed(pass.role, type)) return { status: 404, body: { error: 'Not found.' } };
  const record = await store.read(path);
  if (!record || !canReadItem(pass.role, type, record)) return { status: 404, body: { error: 'Not found.' } };
  return { status: 200, body: { type, item: record } };
}

export { SNAPSHOT_PATH, ITEM_ID_PATTERN, ITEM_TYPES, itemPath, itemTypeAllowed, snapshotSection };
