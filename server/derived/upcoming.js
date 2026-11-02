// The Upcoming groupings (blueprint §2.1: calculated values live in server/derived/; build spec A.7).
// The rules themselves are in web/shared/upcoming.js, so the page can work them out from the snapshot
// while the tutor wakes. This file re-exports them, so server code always uses the same rules.
export {
  UK_TIME_ZONE,
  STAGE_LABELS,
  GROUPS,
  GROUP_LABELS,
  SOON_DAYS,
  ukToday,
  validDate,
  addDays,
  daysBetween,
  dueText,
  stageLabel,
  upcomingItem,
  fromTask,
  fromSnapshot,
  groupUpcoming,
  groupTasks,
} from '../../web/shared/upcoming.js';
