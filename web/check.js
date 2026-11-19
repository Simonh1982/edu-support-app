// Learner page: "Check the details" for a read brief, and the paste and type forms (WP-108b; build
// spec §8, §8.1, §23.6, A-001). The logic is in shared/task-check.js and shared/api.js; this file only
// builds and reads the page. Brief text is only ever shown with textContent, never as HTML.
import { apiErrorMessage, waitForReading } from "./shared/api.js";
import { failureMessage, newClientId, uploadIdFor } from "./shared/capture.js";
import {
  ANCHOR_LABELS,
  CHECK_FIELDS,
  CHECK_MESSAGES,
  addChip,
  checkPlan,
  chipText,
  confirmationBody,
  correctionsOf,
  editChip,
  formatDeadline,
  initialChips,
  initialUndone,
  pasteBody,
  previewQuestion,
  readNotes,
  removeChip,
  textSegments,
} from "./shared/task-check.js";

function setText(element, text) {
  if (element.textContent !== text) element.textContent = text;
}

function make(doc, tag, { className, text, attrs } = {}) {
  const el = doc.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  for (const [key, value] of Object.entries(attrs ?? {})) el.setAttribute(key, value);
  return el;
}

function button(doc, text, { className = "secondary", label } = {}) {
  const el = make(doc, "button", { className, text, attrs: { type: "button" } });
  if (label) el.setAttribute("aria-label", label);
  return el;
}

const short = (text, max = 40) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * Wires up the "Type or paste it" form and the "Check the details" screen. Returns
 * { setTutor(state), open(uploadId), start(), stop() }, or null if the page doesn't have them.
 * WP-115c: with queuePaste(body) → { kind: "queued" } | { kind: "queue-error", message }, a task can be
 * typed or pasted while the tutor wakes; it waits in the edit queue on the device and is read later.
 */
export function createTaskEntry({ api, capture, onSignedOut, onTaskAdded, queuePaste = null, doc = document }) {
  const byId = (id) => doc.getElementById(id);
  const els = {
    capture: byId("capture"),
    capturesHeading: byId("captures-heading"),
    pasteOpen: byId("paste-open"),
    tutorNeeded: byId("tutor-needed"),
    entryStatus: byId("entry-status"),
    pasteForm: byId("paste-form"),
    pasteText: byId("paste-text"),
    pasteCancel: byId("paste-cancel"),
    pasteDeadline: byId("paste-deadline"),
    pasteDeadlineUk: byId("paste-deadline-uk"),
    check: byId("check-screen"),
    checkHeading: byId("check-heading"),
    checkStatus: byId("check-status"),
    checkForm: byId("check-form"),
    checkIntro: byId("check-intro"),
    checkAsk: byId("check-ask"),
    checkOther: byId("check-other"),
    checkMore: byId("check-more"),
    checkError: byId("check-error"),
    checkBack: byId("check-back"),
    deadlineUk: byId("check-deadline-uk"),
    corrections: byId("check-corrections"),
    correctionsList: byId("corrections-list"),
    chipsHeading: byId("chips-heading"),
    chipsList: byId("chips-list"),
    chipError: byId("chip-error"),
    chipType: byId("chip-type"),
    chipNew: byId("chip-new"),
    chipAdd: byId("chip-add"),
    readNote: byId("check-read-note"),
    readText: byId("check-read-text"),
  };
  if (Object.values(els).some((el) => !el)) return null;
  const field = (name) => ({ wrap: byId(`check-field-${name}`), input: byId(`check-${name}`), prompt: byId(`check-prompt-${name}`) });
  if (CHECK_FIELDS.some((name) => Object.values(field(name)).some((el) => !el))) return null;

  let ready = false;
  let active = false; // signed in (WP-110)
  let openId = 0; // the latest open(); older replies are ignored
  let current = null; // { view, undone, chips, questionEdited, editing }
  let chipCount = 0;
  let pendingPaste = null; // a retry of the same text reuses its client ID
  let busy = false;

  function signedOut(reason) {
    stop();
    onSignedOut?.(reason);
  }

  // ---------- type or paste it (WP-115c: one form) ----------
  function showForm() {
    els.pasteForm.hidden = false;
    els.pasteOpen.setAttribute("aria-expanded", "true");
    els.pasteText.focus();
  }

  function hideForm() {
    els.pasteForm.hidden = true;
    els.pasteOpen.setAttribute("aria-expanded", "false");
  }

  // While the tutor wakes, the text waits in the edit queue on this device (WP-110, WP-115c).
  const canSend = () => ready || (active && typeof queuePaste === "function");

  function setTutor(state) {
    ready = state === "ready" || state === "readyNoAi";
    els.pasteOpen.disabled = !canSend();
    els.tutorNeeded.hidden = ready;
    if (!canSend()) hideForm();
  }

  els.pasteOpen.addEventListener("click", () => (els.pasteForm.hidden ? showForm() : hideForm()));
  els.pasteCancel.addEventListener("click", () => {
    hideForm();
    els.pasteOpen.focus();
  });
  els.pasteDeadline.addEventListener("input", () => setText(els.pasteDeadlineUk, formatDeadline(els.pasteDeadline.value)));

  els.pasteForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy || !canSend()) return;
    const checked = pasteBody({ text: els.pasteText.value, deadline: els.pasteDeadline.value });
    if (checked.error) {
      setText(els.entryStatus, checked.error);
      (checked.field === "deadline" ? els.pasteDeadline : els.pasteText).focus();
      return;
    }
    if (pendingPaste?.text !== checked.text) pendingPaste = { text: checked.text, clientId: newClientId({ source: "paste" }) };
    const { clientId } = pendingPaste;
    const body = { clientId, text: checked.text, ...(checked.deadline ? { deadline: checked.deadline } : {}) };
    busy = true;
    setText(els.entryStatus, CHECK_MESSAGES.sending);
    const result = ready ? await api.pasteBrief(body) : await queuePaste(body);
    busy = false;
    if (result.kind === "auth") return signedOut(result.reason);
    if (result.kind !== "ok" && result.kind !== "queued") {
      setText(els.entryStatus, result.kind === "queue-error" ? result.message : apiErrorMessage(result));
      return;
    }
    pendingPaste = null;
    els.pasteForm.reset();
    setText(els.pasteDeadlineUk, "");
    hideForm();
    if (result.kind === "queued") {
      setText(els.entryStatus, CHECK_MESSAGES.pasteQueued);
      els.pasteOpen.focus();
      return;
    }
    setText(els.entryStatus, "");
    capture?.addPasted({ clientId });
    open(result.body?.upload?.id ?? uploadIdFor(clientId));
  });

  // ---------- the check screen ----------
  function showCheck() {
    els.capture.hidden = true;
    els.check.hidden = false;
    els.checkHeading.focus();
  }

  function closeCheck({ focus = true } = {}) {
    openId += 1;
    current = null;
    els.check.hidden = true;
    els.checkForm.hidden = true;
    els.capture.hidden = false;
    setText(els.checkStatus, "");
    setText(els.checkError, "");
    if (focus) els.capturesHeading.focus();
  }

  els.checkBack.addEventListener("click", () => closeCheck());

  const question = () => (current.questionEdited ? field("question").input.value.trim() : previewQuestion(current.view, current.undone));

  function setFieldValue(name, value) {
    field(name).input.value = value === null || value === undefined ? "" : String(value);
    if (name === "deadline") setText(els.deadlineUk, formatDeadline(field("deadline").input.value));
  }

  function renderCorrections(focusPosition = null) {
    const list = correctionsOf(current.view);
    els.corrections.hidden = list.length === 0;
    els.correctionsList.replaceChildren(...list.map((c) => {
      const undone = current.undone.has(c.position);
      const item = make(doc, "li", { className: "correction" });
      const what = make(doc, "span", { text: undone ? `Keeping “${c.original}”` : `${c.original} → ${c.corrected}` });
      const toggle = button(doc, undone ? `Use “${c.corrected}”` : "Undo", {
        label: undone ? `Change ${c.original} to ${c.corrected}` : `Undo: keep ${c.original}`,
      });
      toggle.dataset.position = String(c.position);
      toggle.addEventListener("click", () => {
        if (current.undone.has(c.position)) current.undone.delete(c.position);
        else current.undone.add(c.position);
        if (!current.questionEdited) setFieldValue("question", previewQuestion(current.view, current.undone));
        renderCorrections(c.position);
        renderChips();
        renderRead();
      });
      item.append(what, toggle);
      return item;
    }));
    if (focusPosition !== null) els.correctionsList.querySelector(`button[data-position="${focusPosition}"]`)?.focus();
  }

  function chipEditor(chip) {
    const item = make(doc, "li", { className: "chip" });
    const id = `chip-edit-${chip.key}`;
    const label = make(doc, "label", { text: ANCHOR_LABELS[chip.type], attrs: { for: id } });
    const box = make(doc, "textarea", { attrs: { id, rows: "3", maxlength: "1000" } });
    box.value = chipText(chip, question());
    const actions = make(doc, "div", { className: "chip-actions" });
    const save = button(doc, "Save", { className: "primary" });
    const cancel = button(doc, "Cancel");
    save.addEventListener("click", () => {
      const result = editChip(current.chips, chip.key, box.value);
      if (result.error) {
        setText(els.chipError, result.error);
        box.focus();
        return;
      }
      current.chips = result.chips;
      current.editing = null;
      renderChips(chip.key);
    });
    cancel.addEventListener("click", () => {
      current.editing = null;
      renderChips(chip.key);
    });
    actions.append(save, cancel);
    item.append(label, box, actions);
    return { item, box };
  }

  function renderChips(focusKey = null) {
    setText(els.chipError, "");
    let focusEl = null;
    els.chipsList.replaceChildren(...current.chips.map((chip) => {
      if (current.editing === chip.key) {
        const { item, box } = chipEditor(chip);
        focusEl = box;
        return item;
      }
      const text = chipText(chip, question());
      const item = make(doc, "li", { className: "chip" });
      const type = make(doc, "span", { className: "chip-type", text: ANCHOR_LABELS[chip.type] });
      const value = make(doc, "span", { className: "chip-text", text });
      const actions = make(doc, "div", { className: "chip-actions" });
      const edit = button(doc, "Edit", { label: `Edit ${ANCHOR_LABELS[chip.type]}: ${short(text)}` });
      const remove = button(doc, "Remove", { label: `Remove ${ANCHOR_LABELS[chip.type]}: ${short(text)}` });
      edit.addEventListener("click", () => {
        current.editing = chip.key;
        renderChips();
      });
      remove.addEventListener("click", () => {
        current.chips = removeChip(current.chips, chip.key);
        renderChips();
        els.chipsHeading.focus();
      });
      if (chip.key === focusKey) focusEl = edit;
      actions.append(edit, remove);
      item.append(type, value, actions);
      return item;
    }));
    if (current.chips.length === 0) els.chipsList.append(make(doc, "li", { className: "hint", text: "None yet." }));
    focusEl?.focus();
  }

  els.chipAdd.addEventListener("click", () => {
    if (!current) return;
    chipCount += 1;
    const result = addChip(current.chips, { type: els.chipType.value, value: els.chipNew.value }, `new-${chipCount}`);
    if (result.error) {
      setText(els.chipError, result.error);
      els.chipNew.focus();
      return;
    }
    current.chips = result.chips;
    els.chipNew.value = "";
    renderChips();
    setText(els.chipError, "");
    els.chipNew.focus();
  });

  function renderRead() {
    const { view } = current;
    const segments = textSegments(view.text, view.uncertain, correctionsOf(view), current.undone);
    els.readText.replaceChildren(...segments.map((s) => {
      if (s.kind === "plain") return doc.createTextNode(s.text);
      if (s.kind === "uncertain") {
        const mark = make(doc, "mark", { className: "unsure", text: s.text });
        mark.append(make(doc, "span", { className: "visually-hidden", text: " (unclear)" }));
        return mark;
      }
      return make(doc, "span", { className: s.undone ? "kept" : "corrected", text: s.text });
    }));
    const notes = readNotes(view.uncertain);
    if (view.truncated) notes.push("This was very long, so only the first part was read.");
    setText(els.readNote, notes.join(" "));
  }

  function fill(view) {
    current = { view, undone: initialUndone(view), chips: initialChips(view.proposal), questionEdited: false, editing: null };
    const plan = checkPlan(view, current.undone);
    for (const { field: name, prompt } of plan.ask) {
      const f = field(name);
      els.checkAsk.append(f.wrap);
      setText(f.prompt, prompt);
      f.prompt.hidden = false;
      f.wrap.classList.add("ask");
    }
    for (const name of plan.other) {
      const f = field(name);
      els.checkOther.append(f.wrap);
      setText(f.prompt, "");
      f.prompt.hidden = true;
      f.wrap.classList.remove("ask");
    }
    for (const name of CHECK_FIELDS) setFieldValue(name, plan.values[name]);
    setText(els.checkIntro, plan.ask.length ? CHECK_MESSAGES.someToCheck : CHECK_MESSAGES.allClear);
    els.checkMore.open = false;
    els.checkMore.hidden = plan.other.length === 0;
    setText(els.checkError, "");
    renderCorrections();
    renderChips();
    renderRead();
    els.checkForm.hidden = false;
    setText(els.checkStatus, "");
  }

  field("question").input.addEventListener("input", () => {
    if (!current) return;
    current.questionEdited = true;
    if (current.editing === null) renderChips();
  });
  field("deadline").input.addEventListener("input", () => setText(els.deadlineUk, formatDeadline(field("deadline").input.value)));

  /** Opens "Check the details" for an upload, waiting while it is still being read. */
  async function open(uploadId) {
    openId += 1;
    const mine = openId;
    current = null;
    els.checkForm.hidden = true;
    setText(els.checkError, "");
    setText(els.checkStatus, CHECK_MESSAGES.opening);
    showCheck();
    const result = await waitForReading({
      api,
      uploadId,
      stopped: () => mine !== openId,
      onWaiting: () => setText(els.checkStatus, CHECK_MESSAGES.reading),
    });
    if (mine !== openId || result.kind === "stopped") return;
    if (result.kind === "auth") return signedOut(result.reason);
    if (result.kind === "timeout") return setText(els.checkStatus, CHECK_MESSAGES.timeout);
    if (result.kind !== "ok") return setText(els.checkStatus, apiErrorMessage(result));
    const view = result.upload;
    if (view?.taskId) return setText(els.checkStatus, CHECK_MESSAGES.alreadyAdded);
    if (view?.status === "failed") return setText(els.checkStatus, failureMessage(view.failureReason));
    if (view?.contentKind !== "brief" || !view.proposal) return setText(els.checkStatus, CHECK_MESSAGES.notBrief);
    fill(view);
  }

  els.checkForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!current || busy) return;
    const values = Object.fromEntries(CHECK_FIELDS.map((name) => [name, field(name).input.value]));
    const built = confirmationBody({ values, chips: current.chips, undone: current.undone, questionEdited: current.questionEdited });
    if (built.errors) {
      const [first] = built.errors;
      setText(els.checkError, first.message);
      if (els.checkOther.contains(field(first.field).wrap)) els.checkMore.open = true;
      field(first.field).input.focus();
      return;
    }
    const mine = openId;
    const { id } = current.view;
    busy = true;
    setText(els.checkError, "");
    setText(els.checkStatus, CHECK_MESSAGES.saving);
    const result = await api.confirmUpload(id, built.body);
    busy = false;
    if (mine !== openId) return;
    if (result.kind === "auth") return signedOut(result.reason);
    // 409 with a taskId: it was already added (a double tap, or another device), which is fine
    const taskId = result.kind === "ok" ? result.body?.task?.id : result.status === 409 ? result.body?.taskId : null;
    if (!taskId) {
      setText(els.checkStatus, "");
      setText(els.checkError, apiErrorMessage(result));
      return;
    }
    capture?.markAdded(id, taskId);
    closeCheck();
    setText(els.entryStatus, CHECK_MESSAGES.added);
    onTaskAdded?.();
  });

  function start() {
    active = true;
    setTutor(ready ? "ready" : "waiting");
  }

  function stop() {
    active = false;
    if (!els.check.hidden) closeCheck({ focus: false });
    openId += 1;
    current = null;
    pendingPaste = null;
    busy = false;
    els.pasteForm.reset();
    setText(els.pasteDeadlineUk, "");
    setText(els.entryStatus, "");
    setTutor("waiting");
  }

  setTutor("waiting");
  return { setTutor, open, start, stop };
}
