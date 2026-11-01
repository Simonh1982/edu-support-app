// Per-pass rate limits and a daily AI request ceiling (blueprint §3.5, §7.12). Both are safety
// nets held in memory: a restart clears them, which is acceptable for one learner.
import { ukIso } from './storage/records.js';

export const RATE_WINDOW_MS = 60_000;
export const MAX_TRACKED_PASSES = 200;
export const RATE_LIMIT_MESSAGE = 'Too many requests. Please wait a moment and try again.';
export const AI_CEILING_MESSAGE = "The tutor has reached today's limit. Everything else still works, and the tutor is back tomorrow.";

/** A key for one pass (account + sign-in time). Never the token itself, and never logged. */
export function passKey(pass) {
  return `${String(pass?.sub ?? '').toLowerCase()}:${Number(pass?.iat) || 0}`;
}

/** Fixed one-minute windows per key. take(key) → { ok, remaining } or { ok: false, retryAfterS }. */
export function createRateLimiter({ limit, windowMs = RATE_WINDOW_MS, now = () => Date.now(), maxKeys = MAX_TRACKED_PASSES }) {
  const windows = new Map();
  function take(key) {
    const t = now();
    let w = windows.get(key);
    if (!w || t - w.start >= windowMs) {
      w = { start: t, count: 0 };
      windows.delete(key);
      windows.set(key, w);
      // oldest first, so a flood of new passes can't grow memory without limit
      if (windows.size > maxKeys) windows.delete(windows.keys().next().value);
    }
    if (w.count >= limit) return { ok: false, retryAfterS: Math.max(1, Math.ceil((w.start + windowMs - t) / 1000)) };
    w.count += 1;
    return { ok: true, remaining: limit - w.count };
  }
  return { take, size: () => windows.size };
}

/** Counts AI requests per UK day. WP-111 calls take() before each AI request. */
export function createAiCeiling({ limit, now = () => new Date() }) {
  let day = null;
  let used = 0;
  function roll() {
    const today = ukIso(now()).slice(0, 10);
    if (today !== day) { day = today; used = 0; }
  }
  return {
    take() {
      roll();
      if (used >= limit) return { ok: false, used, limit, message: AI_CEILING_MESSAGE };
      used += 1;
      return { ok: true, used, limit };
    },
    status() {
      roll();
      return { day, used, limit };
    },
  };
}
