// Intelligent routing (build spec §10): suggest the most likely work route from a task's stage, so the
// learner isn't asked to choose when the answer is obvious. He can always pick another route.
// Pure. The light model is asked only when there is no task to go on (server/domain/conversations.js).

export const WORK_ROUTES = Object.freeze(['research', 'plan', 'review']);
// A new or half-researched task → Understand and research it; planning → Plan my answer;
// a draft under way → Review my work. Finished tasks get no suggestion.
export const ROUTE_BY_STAGE = Object.freeze({
  'not-started': 'research',
  researching: 'research',
  planning: 'plan',
  drafting: 'review',
  reviewing: 'review',
});

/** The suggested route first, then the others in their usual order. */
export function routeOptions(route, all = WORK_ROUTES) {
  return all.includes(route) ? [route, ...all.filter((r) => r !== route)] : [...all];
}

export function routeFromTask(task) {
  const route = ROUTE_BY_STAGE[task?.stage] ?? null;
  return { route, options: routeOptions(route) };
}
