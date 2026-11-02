// Logic for the "Check the details" screen and the paste and type forms (WP-108b; build spec §8,
// §8.1, §23.6, §57, A-001). No DOM-only or Node-only APIs, so Node tests run it as the browser does.

// ---------- copies of server values ----------
// The front end can't import server code. test/task-check.test.js checks these against
// server/domain/tasks.js, server/ai/reading.js and server/domain/uploads.js.
export const TASK_KINDS = Object.freeze(["assignment", "homework", "assessment"]);
export const WORK_TYPES = Object.freeze(["essay", "worksheet", "project", "production", "other"]);
export const READ_ANCHOR_TYPES = Object.freeze(["question", "location", "text", "track"]);
export const TASK_LIMITS = Object.freeze({
  title: 120, subject: 40, questionText: 4000, anchorText: 1000, anchors: 20, marks: 1000, wordCount: 100000,
});
export const PASTE_MAX_CHARS = 20000;

// ---------- wording ----------
export const KIND_LABELS = Object.freeze({ assignment: "Assignment", homework: "Homework", assessment: "Assessment" });
export const WORK_TYPE_LABELS = Object.freeze({
  essay: "Essay", worksheet: "Worksheet", project: "Project", production: "Production", other: "Something else",
});
export const ANCHOR_LABELS = Object.freeze({
  question: "Question", location: "Place or case study", text: "Set text or extract", track: "Track",
});

// The fields the screen can change. Topics and qualification stay as matched (no topic list yet).
export const CHECK_FIELDS = Object.freeze(["title", "subject", "deadline", "question", "kind", "workType", "marks", "wordCount"]);

// Build spec §8: ask only about what's missing or uncertain, in plain words.
export const FIELD_PROMPTS = Object.freeze({
  title: { missing: "What should this task be called?", unsure: "Is this the right title?" },
  subject: { missing: "Which subject is this for?", unsure: "Is this the right subject?" },
  deadline: {
    missing: "I couldn't find a deadline. Do you know when it's due?",
    unsure: "I'm not sure I read the deadline right. Can you check it?",
  },
  question: {
    missing: "I couldn't find the question. Can you type or paste it?",
    unsure: "Some of the question was hard to read. Can you check it?",
  },
  kind: { missing: "Is this an assignment, homework or an assessment?", unsure: "Is this the right kind of task?" },
  workType: { missing: "What kind of work is it?", unsure: "Is this the right kind of work?" },
  marks: { missing: "How many marks is it worth, if it says?", unsure: "Can you check the marks?" },
  wordCount: { missing: "Is there a word count?", unsure: "Can you check the word count?" },
});

export const CHECK_MESSAGES = Object.freeze({
  opening: "Opening…",
  reading: "Reading… this usually takes under a minute.",
  timeout: "This is taking longer than usual. It'll show in your list once it's read, so check back in a minute.",
  notBrief: "This isn't a task brief, so there's nothing to add.",
  alreadyAdded: "This has already been added to your tasks.",
  allClear: "Everything looks clear. Have a quick look, then add it.",
  someToCheck: "Just check these:",
  saving: "Adding your task…",
  added: "Added to your tasks.",
  sending: "Sending…",
  needTitle: "Please give the task a title.",
  titleTooLong: `Please keep the title to ${TASK_LIMITS.title} characters.`,
  subjectTooLong: `Please keep the subject to ${TASK_LIMITS.subject} characters.`,
  badDate: "Please choose a date, or leave it blank.",
  badMarks: `Marks must be a whole number up to ${TASK_LIMITS.marks.toLocaleString("en-GB")}.`,
  badWordCount: `The word count must be a whole number up to ${TASK_LIMITS.wordCount.toLocaleString("en-GB")}.`,
  questionTooLong: `Please keep the question to ${TASK_LIMITS.questionText.toLocaleString("en-GB")} characters.`,
  pasteEmpty: "Paste the task or question first.",
  pasteTooLong: `That's too long to read in one go. Please paste up to ${PASTE_MAX_CHARS.toLocaleString("en-GB")} characters.`,
  chipEmpty: "Type something first.",
  chipTooLong: `Please keep it to ${TASK_LIMITS.anchorText.toLocaleString("en-GB")} characters.`,
  chipsFull: `A task can have up to ${TASK_LIMITS.anchors} of these.`,
});

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const tidy = (v) => String(v ?? "").replace(/\s+/g, " ").trim();

// ---------- corrections (copies of server/ai/reading.js, so the question shown is the one saved) ----------
const isLetter = (ch) => typeof ch === "string" && /[A-Za-z'’-]/.test(ch);

function wordAt(text, word, p) {
  return text.slice(p, p + word.length) === word && !isLetter(text[p - 1]) && !isLetter(text[p + word.length]);
}

export function locateWord(text, word, hint = null) {
  if (Number.isInteger(hint) && hint >= 0 && wordAt(text, word, hint)) return hint;
  let best = null;
  for (let p = text.indexOf(word); p !== -1; p = text.indexOf(word, p + 1)) {
    if (!wordAt(text, word, p)) continue;
    if (best === null) best = p;
    else if (Number.isInteger(hint) && Math.abs(p - hint) < Math.abs(best - hint)) best = p;
  }
  return best;
}

export function applyCorrections(text, corrections, { offset = 0 } = {}) {
  let out = text;
  const list = corrections.filter((c) => !c.undone).sort((a, b) => b.position - a.position);
  for (const c of list) {
    const p = c.position - offset;
    if (p < 0 || out.slice(p, p + c.original.length) !== c.original) continue;
    out = out.slice(0, p) + c.corrected + out.slice(p + c.original.length);
  }
  return out;
}

export function correctQuestion(question, text, corrections) {
  if (!question) return null;
  const offset = text.indexOf(question);
  if (offset >= 0) {
    const inside = corrections.filter((c) => c.position >= offset && c.position + c.original.length <= offset + question.length);
    return applyCorrections(question, inside, { offset });
  }
  let out = question;
  for (const c of corrections) {
    if (c.undone) continue;
    const p = locateWord(out, c.original);
    if (p !== null) out = out.slice(0, p) + c.corrected + out.slice(p + c.original.length);
  }
  return out;
}

/** The view's well-formed spelling corrections. */
export function correctionsOf(view) {
  const list = Array.isArray(view?.spellingCorrections) ? view.spellingCorrections : [];
  return list.filter((c) => isObject(c) && typeof c.original === "string" && typeof c.corrected === "string"
    && Number.isInteger(c.position));
}

/** Positions the learner has undone (A-001: one tap to undo). */
export function initialUndone(view) {
  return new Set(correctionsOf(view).filter((c) => c.undone === true).map((c) => c.position));
}

export function withUndone(corrections, undone) {
  return corrections.map((c) => ({ ...c, undone: undone.has(c.position) }));
}

/** The question as it will be saved: the brief's words with the corrections he kept. */
export function previewQuestion(view, undone = new Set()) {
  const verbatim = view?.proposal?.question?.verbatim;
  if (typeof verbatim !== "string" || verbatim === "") return "";
  const text = typeof view.text === "string" ? view.text : "";
  return correctQuestion(verbatim, text, withUndone(correctionsOf(view), undone)) ?? verbatim;
}

// ---------- what to ask ----------
const blank = (v) => v === null || v === undefined || v === "";

/**
 * Which fields to ask about (the reader's unsure fields plus missing essentials, from the server's
 * `ask` list) and which sit under "Other details". values are the draft task's values.
 */
export function checkPlan(view, undone = new Set()) {
  const asked = new Set((Array.isArray(view?.ask) ? view.ask : []).filter((f) => CHECK_FIELDS.includes(f)));
  const proposal = isObject(view?.proposal) ? view.proposal : {};
  const values = {};
  for (const field of CHECK_FIELDS) {
    values[field] = field === "question" ? previewQuestion(view, undone) : proposal[field] ?? null;
  }
  const ask = CHECK_FIELDS.filter((f) => asked.has(f)).map((field) => ({
    field,
    prompt: blank(values[field]) ? FIELD_PROMPTS[field].missing : FIELD_PROMPTS[field].unsure,
  }));
  return { ask, other: CHECK_FIELDS.filter((f) => !asked.has(f)), values };
}

// ---------- what was read ----------

/**
 * The read text cut into pieces for display: plain, uncertain (highlighted) and corrected words
 * (shown corrected, or as written once undone). Overlapping marks are skipped.
 */
export function textSegments(text, uncertain, corrections, undone = new Set()) {
  const source = typeof text === "string" ? text : "";
  const marks = [];
  for (const u of Array.isArray(uncertain) ? uncertain : []) {
    if (Number.isInteger(u?.start) && Number.isInteger(u?.end) && u.start >= 0 && u.end > u.start && u.end <= source.length) {
      marks.push({ start: u.start, end: u.end, kind: "uncertain" });
    }
  }
  for (const c of corrections) {
    const end = c.position + c.original.length;
    if (c.position >= 0 && source.slice(c.position, end) === c.original) {
      marks.push({ start: c.position, end, kind: "correction", c });
    }
  }
  marks.sort((a, b) => a.start - b.start || b.end - a.end);
  const out = [];
  let cursor = 0;
  for (const m of marks) {
    if (m.start < cursor) continue;
    if (m.start > cursor) out.push({ kind: "plain", text: source.slice(cursor, m.start) });
    if (m.kind === "uncertain") {
      out.push({ kind: "uncertain", text: source.slice(m.start, m.end) });
    } else {
      const isUndone = undone.has(m.c.position);
      out.push({
        kind: "correction", text: isUndone ? m.c.original : m.c.corrected, original: m.c.original,
        corrected: m.c.corrected, position: m.c.position, undone: isUndone,
      });
    }
    cursor = m.end;
  }
  if (cursor < source.length) out.push({ kind: "plain", text: source.slice(cursor) });
  return out;
}

/** Notes under the read text: unclear passages that couldn't be placed, and PDF pages with little text. */
export function readNotes(uncertain) {
  const list = Array.isArray(uncertain) ? uncertain : [];
  const pages = list.filter((u) => Number.isInteger(u?.page) && u.text === null).map((u) => u.page);
  const loose = list.filter((u) => typeof u?.text === "string" && u.text && !Number.isInteger(u.start)).map((u) => u.text);
  const placed = list.filter((u) => Number.isInteger(u?.start)).length;
  const notes = [];
  if (placed) notes.push(placed === 1 ? "1 unclear part is highlighted." : `${placed} unclear parts are highlighted.`);
  if (loose.length) notes.push(`I wasn't sure about: ${loose.map((t) => `“${t}”`).join(", ")}.`);
  if (pages.length) {
    const which = pages.length === 1 ? `Page ${pages[0]} has` : `Pages ${pages.join(", ")} have`;
    notes.push(`${which} very little text. It may be a picture, so check it against the original.`);
  }
  return notes;
}

// ---------- anchor chips (§23.6) ----------
const anchorValue = (a) => tidy(isObject(a?.text) ? a.text.value : a?.text).slice(0, TASK_LIMITS.anchorText);

/** Chips from the draft task's anchors. Draft chips keep the brief as their author until edited. */
export function initialChips(proposal) {
  const list = Array.isArray(proposal?.anchors) ? proposal.anchors : [];
  return list
    .filter((a) => READ_ANCHOR_TYPES.includes(a?.type) && anchorValue(a))
    .slice(0, TASK_LIMITS.anchors)
    .map((a, i) => ({
      key: `draft-${i}`, type: a.type, value: anchorValue(a),
      author: a?.text?.author === "learner" ? "learner" : "source", draft: true, edited: false,
    }));
}

/** What a chip shows. An unedited question chip follows the question as it will be saved. */
export function chipText(chip, question) {
  return chip.type === "question" && chip.draft && !chip.edited && question ? question : chip.value;
}

function chipValue(value) {
  const text = tidy(value);
  if (!text) return { error: CHECK_MESSAGES.chipEmpty };
  if (text.length > TASK_LIMITS.anchorText) return { error: CHECK_MESSAGES.chipTooLong };
  return { text };
}

export function editChip(chips, key, value) {
  const checked = chipValue(value);
  if (checked.error) return { error: checked.error };
  return { chips: chips.map((c) => (c.key === key ? { ...c, value: checked.text, edited: true } : c)) };
}

export function removeChip(chips, key) {
  return chips.filter((c) => c.key !== key);
}

export function addChip(chips, { type, value }, key) {
  if (!READ_ANCHOR_TYPES.includes(type)) return { error: CHECK_MESSAGES.chipEmpty };
  if (chips.length >= TASK_LIMITS.anchors) return { error: CHECK_MESSAGES.chipsFull };
  const checked = chipValue(value);
  if (checked.error) return { error: checked.error };
  return { chips: [...chips, { key, type, value: checked.text, author: "learner", draft: false, edited: false }] };
}

/** Chips as the confirm route takes them: his own words are his; untouched brief chips stay the source's. */
export function anchorsBody(chips) {
  return chips.map((c) => ({
    type: c.type,
    text: { value: c.value, author: c.draft && !c.edited ? c.author : "learner" },
  }));
}

// ---------- checking and building request bodies ----------
function realDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ""));
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

function wholeOrNull(value) {
  const text = String(value ?? "").trim();
  if (text === "") return null;
  return /^\d{1,7}$/.test(text) ? Number(text) : Number.NaN;
}

/** Problems with what's been typed, as [{ field, message }], in screen order. */
export function checkValues(values) {
  const errors = [];
  const title = tidy(values.title);
  if (!title) errors.push({ field: "title", message: CHECK_MESSAGES.needTitle });
  else if (title.length > TASK_LIMITS.title) errors.push({ field: "title", message: CHECK_MESSAGES.titleTooLong });
  if (tidy(values.subject).length > TASK_LIMITS.subject) errors.push({ field: "subject", message: CHECK_MESSAGES.subjectTooLong });
  if (!blank(values.deadline) && !realDate(values.deadline)) errors.push({ field: "deadline", message: CHECK_MESSAGES.badDate });
  if (String(values.question ?? "").trim().length > TASK_LIMITS.questionText) {
    errors.push({ field: "question", message: CHECK_MESSAGES.questionTooLong });
  }
  const marks = wholeOrNull(values.marks);
  if (marks !== null && !(marks <= TASK_LIMITS.marks)) errors.push({ field: "marks", message: CHECK_MESSAGES.badMarks });
  const words = wholeOrNull(values.wordCount);
  if (words !== null && !(words <= TASK_LIMITS.wordCount)) errors.push({ field: "wordCount", message: CHECK_MESSAGES.badWordCount });
  return errors;
}

/**
 * The body for POST /api/uploads/:id/confirm. The question is sent only if he edited it; otherwise
 * the server works it out from the corrections he kept. Returns { body } or { errors }.
 */
export function confirmationBody({ values, chips, undone = new Set(), questionEdited = false }) {
  const errors = checkValues(values);
  if (errors.length) return { errors };
  const body = {
    title: tidy(values.title),
    subject: tidy(values.subject) || null,
    deadline: values.deadline || null,
    kind: TASK_KINDS.includes(values.kind) ? values.kind : null,
    workType: WORK_TYPES.includes(values.workType) ? values.workType : null,
    marks: wholeOrNull(values.marks),
    wordCount: wholeOrNull(values.wordCount),
    anchors: anchorsBody(chips),
    undoneCorrections: [...undone].filter(Number.isInteger).sort((a, b) => a - b),
  };
  if (questionEdited) body.questionText = String(values.question ?? "").trim() || null;
  return { body };
}

/**
 * The body for POST /api/tasks from the "Type it in" form (§57: a typed task needs only a title
 * and a deadline). His question, if given, is his own words, so it also becomes a question chip.
 */
export function typedTaskBody({ title, deadline, question }) {
  const errors = checkValues({ title, deadline, question });
  if (errors.length) return { errors };
  const text = String(question ?? "").trim();
  return {
    body: {
      title: tidy(title),
      deadline: deadline || null,
      questionText: text || null,
      anchors: text ? [{ type: "question", text: text.slice(0, TASK_LIMITS.anchorText) }] : [],
    },
  };
}

/** Pasted text ready to send, or { error }. */
export function pasteCheck(value) {
  const text = String(value ?? "").replace(/\r\n?/g, "\n").trim();
  if (!text) return { error: CHECK_MESSAGES.pasteEmpty };
  if (text.length > PASTE_MAX_CHARS) return { error: CHECK_MESSAGES.pasteTooLong };
  return { text };
}

const DEADLINE_FORMAT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC", weekday: "long", day: "numeric", month: "long", year: "numeric",
});

/** "Saturday 7 November 2026" for a YYYY-MM-DD date. Dates are calendar days, so no clock change moves them. */
export function formatDeadline(value) {
  if (!realDate(value)) return "";
  const [y, m, d] = value.split("-").map(Number);
  // built from the parts, because browsers differ on the comma after the weekday
  const parts = Object.fromEntries(DEADLINE_FORMAT.formatToParts(new Date(Date.UTC(y, m - 1, d))).map((p) => [p.type, p.value]));
  return `${parts.weekday} ${parts.day} ${parts.month} ${parts.year}`;
}
