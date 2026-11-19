// WP-116: Plan my answer (build spec §9.2, §23.6, Appendix A.4 "Plan"). One plan per task, at
// tasks/<taskId>/plan.json. Its sections hold only his own words; notebook entries are pinned to it
// as references, never inserted; gaps that need more research are his, or questions the AI asks
// after reading his plan (checked first, and never answers). His main point becomes the task's
// thesis anchor, because it is his own words. Events hold IDs and counts only, never text.
import { newRecord, updateRecord } from '../storage/records.js';
import { DomainError, bad, notFound, plainObject, onlyKeys, recordId, textField, flag } from './fields.js';
import { readTask, withTaskLock, addAnchor, updateAnchor, removeAnchor, TASK_LIMITS } from './tasks.js';
import { readEntry } from './notebook.js';
import { buildRequest, loadProfileSettings, clip } from '../ai/prompt.js';
import { parseJsonReply } from '../ai/json.js';
import { errorSummary } from '../ai/copilot.js';
import { liveCheck, askChecker, CHECK_FEATURE } from '../ai/check.js';
import { saveAiTurn } from './work.js';

// The §9.2 planning prompts, in order. The screen shows the question; the plan keeps his answer.
export const PLAN_SECTIONS = Object.freeze([
  Object.freeze({ key: 'mainPoint', label: 'What is your main point?' }),
  Object.freeze({ key: 'evidence', label: 'What evidence supports it?' }),
  Object.freeze({ key: 'otherView', label: 'Is there another view?' }),
  Object.freeze({ key: 'answersQuestion', label: 'How does this answer the question?' }),
  Object.freeze({ key: 'judgement', label: 'What judgement can you justify?' }),
]);
export const PLAN_KEYS = Object.freeze(PLAN_SECTIONS.map((s) => s.key));
export const PLAN_LIMITS = Object.freeze({ section: 3000, gaps: 12, gapText: 300, pins: 20, aiGaps: 3 });
export const GAPS_FEATURE = 'plan-gaps';
export const GAPS_TIMEOUT_MS = 60_000;
export const PLAN_MESSAGES = Object.freeze({
  notReady: "The tutor isn't ready yet. Your plan is saved; try again in a minute.",
  failed: "The tutor couldn't look at your plan just now. Please try again.",
  needPlan: 'Write something in your plan first, then ask what is missing.',
  tooClose: "I couldn't suggest gaps without getting too close to your answer. Look again at the question: what would you need to show?",
  noGaps: "Nothing obvious is missing. Check each point has evidence you could name.",
  gapsFull: `A plan can list up to ${PLAN_LIMITS.gaps} gaps. Tick off or remove some first.`,
  notInNotebook: 'That notebook entry is no longer there.',
});

// The tutor's job when he asks "What's missing?": questions about what to find out, nothing else.
export const GAPS_INSTRUCTION = [
  "Read the student's plan in <learner_draft> and the task. List up to three gaps that need more research",
  'or thought, each as one short question about what they still need to find out or decide (for example',
  '"What evidence shows how far the defences have worked?"). Never answer the questions, never suggest',
  'content, arguments, examples or a judgement, and never write sentences they could put in their plan.',
  'If nothing important is missing, give no gaps.',
].join('\n');
export const GAPS_CONTRACT = 'Reply with JSON only: {"gaps": ["question", "…"]}';

export const planPath = (taskId) => `tasks/${taskId}/plan.json`;
const links = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== null && v !== undefined));

export async function readPlan(store, taskId) {
  if (!recordId(taskId, 'taskId')) return null;
  const plan = await store.read(planPath(taskId));
  return plan && !plan.deletedAt ? plan : null;
}

async function requireTask(store, taskId) {
  const id = recordId(taskId, 'taskId', { required: true });
  const task = await readTask(store, id);
  if (!task || task.deletedAt) throw notFound('Task');
  return task;
}

function emptyPlan(taskId, now) {
  return newRecord('plan', {
    taskId,
    sections: Object.fromEntries(PLAN_KEYS.map((k) => [k, null])),
    pinned: [],
    gaps: [],
    sharedWithParent: null,
  }, { createdBy: 'learner', now });
}

/** The plan for the screen: its sections, pinned entries (as list views) and gaps. */
export async function planView(store, plan, taskId) {
  const p = plan ?? { taskId, sections: {}, pinned: [], gaps: [] };
  const pinned = [];
  for (const id of p.pinned ?? []) {
    const entry = await readEntry(store, id);
    if (entry) pinned.push({ id: entry.id, type: entry.type, title: entry.title ?? null, author: entry.text?.author ?? null, citation: entry.citation ?? null });
  }
  return {
    id: p.id ?? null,
    taskId: p.taskId ?? taskId,
    sections: Object.fromEntries(PLAN_KEYS.map((k) => [k, p.sections?.[k]?.value ?? ''])),
    pinned,
    gaps: (p.gaps ?? []).map((g) => ({ id: g.id, text: g.text?.value ?? '', author: g.text?.author ?? null, done: g.done === true })),
    updatedAt: p.updatedAt ?? null,
  };
}

/** His main point is his thesis: one thesis anchor on the task, kept in step with it (§23.6). */
async function syncThesis(store, taskId, mainPoint, { now }) {
  const task = await readTask(store, taskId);
  const thesis = (task?.anchors ?? []).find((a) => a.type === 'thesis' && a.text?.author === 'learner');
  const text = mainPoint ? clip(mainPoint, TASK_LIMITS.anchorText) : '';
  if (!text) {
    if (thesis) await removeAnchor(store, taskId, thesis.id, { now });
    return;
  }
  if (!thesis) await addAnchor(store, taskId, { type: 'thesis', text: { value: text, author: 'learner' } }, { now });
  else if (thesis.text?.value !== text) await updateAnchor(store, taskId, thesis.id, { text: { value: text, author: 'learner' } }, { now });
}

/**
 * Changes his plan. body: any of
 *   sections: { mainPoint?, evidence?, otherView?, answersQuestion?, judgement? } (his words; '' clears);
 *   pin: { entryId, pinned } (a notebook entry as a reference);
 *   addGap: text (a gap he noted); gap: { id, done?, remove? }.
 */
export async function updatePlan(store, taskId, body, { now = new Date() } = {}) {
  plainObject(body, 'plan');
  onlyKeys(body, ['sections', 'pin', 'addGap', 'gap'], 'plan');
  const task = await requireTask(store, taskId);
  let mainPointChanged = false;
  const result = await withTaskLock(`plan:${task.id}`, async () => {
    const current = (await readPlan(store, task.id)) ?? emptyPlan(task.id, now);
    const changes = {};
    if (body.sections !== undefined) {
      plainObject(body.sections, 'sections');
      onlyKeys(body.sections, PLAN_KEYS, 'sections');
      const sections = { ...current.sections };
      for (const key of Object.keys(body.sections)) {
        const value = body.sections[key];
        sections[key] = value === '' || value === null ? null
          : textField(value, key, { max: PLAN_LIMITS.section, authors: ['learner'], defaultAuthor: 'learner' });
      }
      mainPointChanged = (sections.mainPoint?.value ?? '') !== (current.sections?.mainPoint?.value ?? '');
      changes.sections = sections;
    }
    if (body.pin !== undefined) {
      plainObject(body.pin, 'pin');
      onlyKeys(body.pin, ['entryId', 'pinned'], 'pin');
      const entryId = recordId(body.pin.entryId, 'entryId', { required: true });
      const pinned = flag(body.pin.pinned, 'pinned', true);
      if (pinned && !(await readEntry(store, entryId))) throw new DomainError(404, PLAN_MESSAGES.notInNotebook);
      const was = current.pinned ?? [];
      changes.pinned = pinned ? [...new Set([...was, entryId])].slice(-PLAN_LIMITS.pins) : was.filter((id) => id !== entryId);
    }
    if (body.addGap !== undefined) {
      const text = textField(body.addGap, 'addGap', { max: PLAN_LIMITS.gapText, authors: ['learner'], defaultAuthor: 'learner', required: true });
      const gaps = current.gaps ?? [];
      if (gaps.length >= PLAN_LIMITS.gaps) throw bad(PLAN_MESSAGES.gapsFull);
      changes.gaps = [...gaps, newRecord('gap', { text, done: false }, { createdBy: 'learner', now })];
    }
    if (body.gap !== undefined) {
      plainObject(body.gap, 'gap');
      onlyKeys(body.gap, ['id', 'done', 'remove'], 'gap');
      const id = recordId(body.gap.id, 'gap id', { required: true });
      const gaps = changes.gaps ?? current.gaps ?? [];
      if (!gaps.some((g) => g.id === id)) throw notFound('Gap');
      changes.gaps = flag(body.gap.remove, 'remove', false)
        ? gaps.filter((g) => g.id !== id)
        : gaps.map((g) => (g.id === id ? updateRecord(g, { done: flag(body.gap.done, 'done', g.done === true) }, { now }) : g));
    }
    const next = updateRecord(current, changes, { now });
    await store.put(planPath(task.id), next);
    await store.logEvent('plan.updated', {
      createdBy: 'learner',
      links: { taskId: task.id },
      payload: {
        sections: PLAN_KEYS.filter((k) => next.sections?.[k]).length,
        pinned: (next.pinned ?? []).length,
        gaps: (next.gaps ?? []).length,
      },
    });
    return next;
  });
  if (mainPointChanged) await syncThesis(store, task.id, result.sections?.mainPoint?.value ?? '', { now });
  return planView(store, result, task.id);
}

/**
 * His first attempt in Plan my answer is his main point in one sentence (§21.1): it starts the plan
 * when the plan has no main point yet. Never overwrites what he has written in the plan.
 */
export async function mainPointFromAttempt(store, taskId, text, { now = new Date() } = {}) {
  if (!taskId || typeof text !== 'string' || !text.trim()) return false;
  const plan = await readPlan(store, taskId);
  if (plan?.sections?.mainPoint?.value) return false;
  await updatePlan(store, taskId, { sections: { mainPoint: clip(text.trim(), PLAN_LIMITS.section) } }, { now });
  return true;
}

/** The plan as text for the tutor, his words only, in his section order. */
export function planText(plan) {
  return PLAN_SECTIONS
    .map((s) => (plan?.sections?.[s.key]?.value ? `${s.label}\n${plan.sections[s.key].value}` : ''))
    .filter(Boolean).join('\n\n');
}

/** { gaps: [string] } from the tutor's reply, or null. Short questions only. */
export function parseGaps(text) {
  const raw = parseJsonReply(text);
  if (!raw || !Array.isArray(raw.gaps)) return null;
  return raw.gaps
    .filter((g) => typeof g === 'string' && g.trim())
    .map((g) => g.replace(/\s+/g, ' ').trim().slice(0, PLAN_LIMITS.gapText))
    .slice(0, PLAN_LIMITS.aiGaps);
}

/**
 * "What's missing?": the tutor reads his plan and the task, and lists up to three gaps as questions.
 * The questions pass the live check before they are saved (§23.5); if they fail twice, none are.
 * Returns { outcome: saved|none|too-close, message?, plan }.
 */
export async function findGaps(store, taskId, ctx = {}) {
  const task = await requireTask(store, taskId);
  const plan = await readPlan(store, task.id);
  const written = planText(plan);
  if (!written) throw new DomainError(409, PLAN_MESSAGES.needPlan);
  const handle = ctx.getAi?.() ?? null;
  if (!handle?.ai || !handle.models?.conversation) throw new DomainError(503, PLAN_MESSAGES.notReady);
  const log = ctx.log ?? console;
  const now = ctx.now ?? new Date();
  const settings = await loadProfileSettings({ storageDir: store.dir });
  const taskPart = { question: task.questionText?.value ?? '', anchors: (task.anchors ?? []).map((a) => ({ kind: a.type, text: a.text?.value ?? '' })) };
  const ask = async (extra = '') => {
    const took = ctx.aiCeiling ? ctx.aiCeiling.take() : { ok: true };
    if (!took.ok) throw new DomainError(429, took.message || PLAN_MESSAGES.failed);
    const { system, prompt } = await buildRequest({
      route: 'plan', settings, task: taskPart, draft: written,
      instruction: [GAPS_INSTRUCTION, extra].filter(Boolean).join('\n'), contract: GAPS_CONTRACT,
    });
    let reply;
    try {
      reply = await handle.ai.ask({ model: handle.models.conversation, system, prompt, timeoutMs: GAPS_TIMEOUT_MS });
    } catch (err) {
      log.error(`[plan] gaps call failed: ${errorSummary(err)}`);
      throw new DomainError(502, PLAN_MESSAGES.failed);
    }
    const gaps = parseGaps(reply.text);
    if (!gaps) throw new DomainError(502, PLAN_MESSAGES.failed);
    return { gaps, model: reply.model ?? handle.models.conversation, ms: reply.ms ?? 0 };
  };
  const first = await ask();
  let chosen = first;
  let checkResult = null;
  const checks = [];
  if (first.gaps.length) {
    let second = null;
    const checked = await liveCheck({
      answer: { reply: first.gaps.join('\n'), taskSpecific: true, model: first.model, ms: first.ms },
      route: 'plan',
      check: (reply) => askChecker({ ai: handle.ai, model: handle.models?.checker, task: taskPart, reply, writing: written, ceiling: ctx.aiCeiling, log }),
      regenerate: async () => {
        second = await ask('Important: an earlier list went too far. Ask only what they need to find out; give no content at all.');
        return { reply: second.gaps.join('\n'), taskSpecific: true, model: second.model, ms: second.ms };
      },
      log,
    });
    checkResult = checked.checkResult;
    checks.push(...checked.checks);
    if (checkResult === 'regenerated') chosen = second;
  }
  await saveAiTurn(store, {
    feature: GAPS_FEATURE, role: 'conversation', model: chosen.model, taskId: task.id, latencyMs: first.ms + (chosen === first ? 0 : chosen.ms),
    success: true, checkResult,
  }, { now });
  for (const c of checks) {
    if (c.model) await saveAiTurn(store, { feature: CHECK_FEATURE, role: 'checker', model: c.model, taskId: task.id, latencyMs: c.ms, success: c.leak !== null }, { now });
  }
  log.log(`[plan] gaps: ${checkResult === 'fallback' ? 'too close' : `${chosen.gaps.length} found`}`);
  if (checkResult === 'fallback') {
    await store.logEvent('plan.gaps', { createdBy: 'learner', links: { taskId: task.id }, payload: { outcome: 'too-close', count: 0 } });
    return { outcome: 'too-close', message: PLAN_MESSAGES.tooClose, plan: await planView(store, plan, task.id) };
  }
  if (!chosen.gaps.length) {
    await store.logEvent('plan.gaps', { createdBy: 'learner', links: { taskId: task.id }, payload: { outcome: 'none', count: 0 } });
    return { outcome: 'none', message: PLAN_MESSAGES.noGaps, plan: await planView(store, plan, task.id) };
  }
  const saved = await withTaskLock(`plan:${task.id}`, async () => {
    const current = (await readPlan(store, task.id)) ?? emptyPlan(task.id, now);
    // the AI's earlier open questions are replaced; his own gaps and ticked ones stay
    const kept = (current.gaps ?? []).filter((g) => g.text?.author !== 'ai' || g.done === true);
    const room = Math.max(0, PLAN_LIMITS.gaps - kept.length);
    const added = chosen.gaps.slice(0, room).map((g) => newRecord('gap', { text: { value: g, author: 'ai' }, done: false }, { createdBy: 'ai', now }));
    const next = updateRecord(current, { gaps: [...kept, ...added] }, { now });
    await store.put(planPath(task.id), next);
    return next;
  });
  await store.logEvent('plan.gaps', { createdBy: 'learner', links: links({ taskId: task.id }), payload: { outcome: 'saved', count: chosen.gaps.length } });
  return { outcome: 'saved', message: null, plan: await planView(store, saved, task.id) };
}

