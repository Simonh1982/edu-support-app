// Per-task tally (build spec §23.6; blueprint §7.7): how much task-specific content the tutor has
// written for one task, worked out from its saved AI turns each time and never stored. Once it
// reaches the setting, replies on that task are questions only. Pure.

// Settings TASK_TALLY_REPLIES and TASK_TALLY_CHARS (server/config.js); provisional, to tune after use.
export const DEFAULT_TALLY = Object.freeze({ replies: 10, chars: 8000 });

/** { replies, chars } over the tutor's task-specific replies for this task. Removed text counts nothing. */
export function taskTally(turns, taskId) {
  let replies = 0;
  let chars = 0;
  for (const t of Array.isArray(turns) ? turns : []) {
    if (!t || !taskId || t.taskId !== taskId || t.role !== 'conversation' || t.taskSpecific !== true) continue;
    if (t.textRemoved === true) continue;
    replies += 1;
    chars += typeof t.text?.value === 'string' ? t.text.value.length : 0;
  }
  return { replies, chars };
}

const limit = (value, fallback) => (Number.isInteger(value) && value > 0 ? value : fallback);

/** True once either count reaches its setting. */
export function overTally(tally, limits = DEFAULT_TALLY) {
  const replies = limit(limits?.replies, DEFAULT_TALLY.replies);
  const chars = limit(limits?.chars, DEFAULT_TALLY.chars);
  return (tally?.replies ?? 0) >= replies || (tally?.chars ?? 0) >= chars;
}
