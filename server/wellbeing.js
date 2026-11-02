// Wellbeing levels 2–3 (build spec §32.1; blueprint §7.10). Only messages the learner types are rated,
// through the tutor's wellbeingLevel. At level 2 or 3 the conversation code drops his words, the reply
// and anything made from them before saving; this module then records a disclosure event (date and
// level only) and alerts the owner through server/alerts.js. The alert workflow keeps level 2 to one
// issue a day by adding later moments to it, so every moment is sent. Nothing here ever sees his words.
import { sendAlert as defaultSend } from './alerts.js';

export const DISCLOSURE_EVENT = 'wellbeing.disclosure';
// Shown on screen beside every level-3 reply, whatever the reply says. Also checked against the core
// skill file and against the copy in web/shared/conversation.js.
export const HELPLINES = Object.freeze([
  Object.freeze({ name: 'Childline', how: 'call 0800 1111', href: 'tel:08001111' }),
  Object.freeze({ name: 'Shout', how: 'text 85258', href: 'sms:85258' }),
  Object.freeze({ name: 'Samaritans', how: 'call 116 123', href: 'tel:116123' }),
  Object.freeze({ name: 'In immediate danger', how: 'call 999', href: 'tel:999' }),
]);

/** Levels 2 and 3: personal upset or possible risk. Their text is never saved and the owner is alerted. */
export function isDisclosure(level) {
  return Number.isInteger(level) && level >= 2 && level <= 3;
}

/** The disclosure event: date (the event's time) and level only. No links, so nothing ties it to his work. */
export async function recordDisclosure(store, level) {
  if (!isDisclosure(level)) return null;
  return store.logEvent(DISCLOSURE_EVENT, { createdBy: 'system', links: {}, payload: { level } });
}

/**
 * The owner's alerts. alert(level) starts the dispatch without waiting for GitHub, so his reply is never
 * held up; it never throws. settled() waits for alerts still on their way (for tests and shutdown).
 * send defaults to sendAlert, which reads STORAGE_REPO and STORAGE_TOKEN: only server/index.js main()
 * creates one, so tests never send real alerts.
 */
export function createWellbeing({ send = defaultSend, log = console } = {}) {
  const inFlight = new Set();
  function alert(level) {
    if (!isDisclosure(level)) return null;
    const pending = Promise.resolve()
      .then(() => send({ kind: 'wellbeing', level, log }))
      .catch((err) => {
        log.error?.(`[wellbeing] alert failed: ${err?.name ?? 'error'}`);
        return { ok: false, status: null, error: 'alert failed' };
      })
      .finally(() => inFlight.delete(pending));
    inFlight.add(pending);
    return pending;
  }
  return { alert, settled: () => Promise.all([...inFlight]) };
}

/**
 * After a level-2 or level-3 reply is saved without its text: the event, then the alert. Never throws,
 * because he must still see the reply. wellbeing: createWellbeing() result, or null (no alert, logged).
 */
export async function noteDisclosure(store, level, { wellbeing = null, log = console } = {}) {
  if (!isDisclosure(level)) return { recorded: false, alert: null };
  let recorded = false;
  try {
    recorded = Boolean(await recordDisclosure(store, level));
  } catch (err) {
    log.error?.(`[wellbeing] disclosure event not saved: ${err?.name ?? 'error'}`);
  }
  if (!wellbeing) {
    log.error?.('[wellbeing] alerts are not set up on this server, so no alert was sent');
    return { recorded, alert: null };
  }
  return { recorded, alert: wellbeing.alert(level) };
}
