// WP-132a (A-013 §6): what the "+" menu adds to a chat. A photo, file or pasted task is sent as now
// (photos and files to the Worker inbox, pasted text to the paste route), read by the tutor, then
// shown as a "Check the details" card in the chat; confirming it creates the task and links the chat
// to it. "Add a source" is a short card for the chat's task. Cards live on the page only: the task,
// its upload and the source are what the server keeps. Built with textContent only.
import { CAPTURE_MESSAGES, failureMessage, newClientId, prepareCapture, sendCapture, uploadIdFor } from "./shared/capture.js";
import {
  ANCHOR_LABELS, CHECK_MESSAGES, checkPlan, chipText, confirmationBody, formatDeadline, initialChips, initialUndone, pasteBody,
} from "./shared/task-check.js";
import { apiErrorMessage } from "./shared/api.js";
import { make } from "./side-menu.js";

export const CARD_TEXT = Object.freeze({
  pasted: "Pasted task",
  photo: "Photo of a task",
  file: "File",
  sending: "Sending…",
  arriving: "Sent. The tutor will read it in a moment…",
  reading: CHECK_MESSAGES.reading,
  waitingTutor: "Sent. It'll be read once the tutor's ready.",
  slow: "This is taking longer than usual. It'll be in Photos & files once it's read.",
  checkHeading: "Check the details",
  checkIntro: "I read this from what you sent. Change anything that's wrong, then add it.",
  title: "Title",
  due: "When is it due?",
  dueHint: "Leave it blank if you don't know yet.",
  question: "The question",
  details: "Key details",
  add: "Add to my tasks",
  adding: "Adding…",
  added: (title) => `Added to your tasks: “${title}”.`,
  already: CHECK_MESSAGES.alreadyAdded,
  notBrief: CHECK_MESSAGES.notBrief,
  sourceHeading: "Add a source you found yourself",
  sourceTitle: "Title",
  sourceAuthor: "Author or publisher, if you know it",
  sourceLink: "Link, if it has one",
  sourceAdd: "Add this source",
  sourceAdded: (title) => `Source added: “${title}”. It's on the task's page.`,
  needTitle: "Please give it a title.",
  cancel: "Cancel",
  sendFailed: "Couldn't send it. Check your connection, then add it again.",
  prompt: "Added. What do you think the question is asking you to do? Have a go in a sentence, however rough.",
});

const POLL_MS = 3000;
const POLL_LIMIT_MS = 4 * 60_000;
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
let nextKey = 0;

/**
 * api: the tutor's calls; getToken(): the pass; isReady(): the tutor answers; onChange(): redraw;
 * onAdded(task): a task was confirmed. Returns { addPaste, addFiles, addSource, list, render, clear }.
 */
export function createChatCards({
  doc = document, api, workerUrl, getToken, isReady = () => true, resizeImage, onChange = () => {}, onAdded = () => {},
  sleep = defaultSleep, now = () => Date.now(),
}) {
  let cards = [];
  let generation = 0;
  const change = () => onChange();

  function newCard(fields) {
    // at: when it was added, so the chat shows cards and messages in the order they happened
    const card = { key: `card-${(nextKey += 1)}`, at: now(), state: "sending", message: "", ...fields };
    cards.push(card);
    change();
    return card;
  }

  /** Follows an upload until it is read: 404 while it travels from the inbox; "processing" while read. */
  async function follow(card) {
    const mine = generation;
    const started = now();
    for (;;) {
      if (mine !== generation) return;
      if (now() - started > POLL_LIMIT_MS) { card.state = "note"; card.message = CARD_TEXT.slow; change(); return; }
      if (!isReady()) {
        card.state = "note"; card.message = CARD_TEXT.waitingTutor; change();
        await sleep(POLL_MS);
        continue;
      }
      const r = await api.openUpload(card.uploadId);
      if (mine !== generation) return;
      if (r.kind === "ok" && r.body?.upload) {
        const view = r.body.upload;
        if (view.status === "processing") {
          card.state = "note"; card.message = CARD_TEXT.reading; change();
        } else if (view.taskId) {
          card.state = "note"; card.message = CARD_TEXT.already; change(); return;
        } else if (view.status === "failed") {
          card.state = "note"; card.message = failureMessage(view.failureReason); change(); return;
        } else if (view.contentKind !== "brief" || !view.proposal) {
          card.state = "note"; card.message = CARD_TEXT.notBrief; change(); return;
        } else {
          const plan = checkPlan(view, initialUndone(view));
          card.view = view;
          card.values = { title: plan.values.title ?? "", deadline: plan.values.deadline ?? "", question: plan.values.question ?? "" };
          card.state = "check";
          change();
          return;
        }
      } else if (r.kind === "http" && r.status === 404) {
        card.state = "note"; card.message = CARD_TEXT.arriving; change();
      } else if (r.kind === "auth") {
        card.state = "note"; card.message = apiErrorMessage(r); change(); return;
      }
      await sleep(POLL_MS);
    }
  }

  // ---------- adding ----------
  async function addPaste(text, deadline) {
    const checked = pasteBody({ text, deadline });
    if (checked.error) return { error: checked.error, field: checked.field };
    const clientId = newClientId({ source: "paste" });
    const card = newCard({ kind: "task", label: CARD_TEXT.pasted, excerpt: checked.text.slice(0, 280) });
    const r = await api.pasteBrief({ clientId, text: checked.text, deadline: checked.deadline });
    if (r.kind !== "ok") { card.state = "note"; card.message = apiErrorMessage(r); change(); return { ok: false }; }
    card.uploadId = r.body?.upload?.id ?? uploadIdFor(clientId);
    follow(card);
    return { ok: true };
  }

  async function addFiles(files, source) {
    for (const file of Array.from(files ?? [])) {
      const clientId = newClientId({ source });
      const card = newCard({ kind: "task", label: source === "file" ? CARD_TEXT.file : CARD_TEXT.photo, excerpt: file?.name ?? "" });
      let prepared;
      try { prepared = await prepareCapture({ file, resizeImage }); } catch { prepared = { error: "unreadable" }; }
      if (prepared?.error) { card.state = "note"; card.message = CAPTURE_MESSAGES[prepared.error] ?? CAPTURE_MESSAGES.unreadable; change(); continue; }
      const sent = await sendCapture({
        workerUrl, token: getToken(), clientId, mimeType: prepared.mimeType, source, contentKind: "brief",
        capturedAt: new Date(now()).toISOString(), base64: prepared.base64,
      });
      if (sent.kind !== "ok") { card.state = "note"; card.message = sent.kind === "tooBig" ? CAPTURE_MESSAGES.tooBig : sent.kind === "auth" ? apiErrorMessage(sent) : CARD_TEXT.sendFailed; change(); continue; }
      card.uploadId = uploadIdFor(clientId);
      follow(card);
    }
  }

  function addSource(taskId) {
    return newCard({ kind: "source", taskId, state: "form", values: { title: "", author: "", url: "" } });
  }

  // ---------- confirming ----------
  async function addTask(card) {
    if (card.state !== "check") return;
    const plan = checkPlan(card.view, initialUndone(card.view));
    const values = { ...plan.values, title: card.values.title, deadline: card.values.deadline || null, question: card.values.question };
    const built = confirmationBody({
      values, chips: initialChips(card.view.proposal), undone: initialUndone(card.view), questionEdited: card.values.question !== (plan.values.question ?? ""),
    });
    if (built.errors) { card.message = built.errors[0].message; change(); return; }
    card.state = "adding"; card.message = ""; change();
    const r = await api.confirmUpload(card.uploadId, built.body);
    const taskId = r.kind === "ok" ? r.body?.task?.id : r.status === 409 ? r.body?.taskId : null;
    if (!taskId) { card.state = "check"; card.message = apiErrorMessage(r); change(); return; }
    card.state = "done";
    card.message = CARD_TEXT.added(card.values.title);
    change();
    onAdded({ id: taskId, title: card.values.title, stage: r.body?.task?.stage ?? "not-started" });
  }

  async function saveSource(card) {
    const title = card.values.title.replace(/\s+/g, " ").trim();
    if (!title) { card.message = CARD_TEXT.needTitle; change(); return; }
    card.state = "adding"; change();
    const body = { title, taskId: card.taskId };
    if (card.values.author.trim()) body.author = card.values.author.trim();
    if (card.values.url.trim()) body.url = card.values.url.trim();
    const r = await api.addOwnSource(body);
    if (r.kind !== "ok") { card.state = "form"; card.message = apiErrorMessage(r); change(); return; }
    card.state = "done";
    card.message = CARD_TEXT.sourceAdded(title);
    change();
  }

  // ---------- drawing ----------
  function field(card, name, label, { type = "text", hint = null, area = false } = {}) {
    const id = `${card.key}-${name}`;
    const parts = [make(doc, "label", { text: label, attrs: { for: id } })];
    if (hint) parts.push(make(doc, "p", { className: "hint", text: hint, attrs: { id: `${id}-hint` } }));
    const input = make(doc, area ? "textarea" : "input", { attrs: { id, ...(area ? { rows: "3" } : { type }), ...(hint ? { "aria-describedby": `${id}-hint` } : {}) } });
    input.value = card.values[name] ?? "";
    input.addEventListener("input", () => { card.values[name] = input.value; });
    parts.push(input);
    if (type === "date") {
      const uk = make(doc, "p", { className: "hint", text: formatDeadline(input.value) });
      input.addEventListener("input", () => { uk.textContent = formatDeadline(input.value); });
      parts.push(uk);
    }
    return parts;
  }

  function render(card) {
    const li = make(doc, "li", { className: "message chat-card", attrs: { id: card.key, tabindex: "-1" } });
    if (card.kind === "task") {
      const you = make(doc, "div", { className: "message-you" });
      const p = make(doc, "p");
      p.append(make(doc, "span", { className: "card-label", text: card.label }));
      if (card.excerpt) p.append(make(doc, "span", { className: "card-excerpt", text: card.excerpt }));
      you.append(p);
      li.append(you);
    }
    const box = make(doc, "div", { className: "card" });
    if (card.state === "sending") box.append(make(doc, "p", { className: "hint", text: CARD_TEXT.sending }));
    else if (card.state === "note" || card.state === "done") box.append(make(doc, "p", { className: card.state === "done" ? "card-done" : "hint", text: card.message }));
    else if (card.kind === "task") {
      const form = make(doc, "form", { className: "card-form", attrs: { novalidate: "", "aria-labelledby": `${card.key}-h` } });
      form.append(make(doc, "h3", { text: CARD_TEXT.checkHeading, attrs: { id: `${card.key}-h` } }), make(doc, "p", { className: "hint", text: CARD_TEXT.checkIntro }));
      form.append(...field(card, "title", CARD_TEXT.title));
      form.append(...field(card, "deadline", CARD_TEXT.due, { type: "date", hint: CARD_TEXT.dueHint }));
      form.append(...field(card, "question", CARD_TEXT.question, { area: true }));
      const chips = initialChips(card.view?.proposal).filter((c) => c.type !== "question");
      if (chips.length) {
        form.append(make(doc, "p", { className: "card-sub", text: CARD_TEXT.details }));
        const ul = make(doc, "ul", { className: "card-details" });
        for (const c of chips) ul.append(make(doc, "li", { text: `${ANCHOR_LABELS[c.type] ?? c.type}: ${chipText(c, card.values.question)}` }));
        form.append(ul);
      }
      const add = make(doc, "button", { className: "primary", text: card.state === "adding" ? CARD_TEXT.adding : CARD_TEXT.add, attrs: { type: "submit" } });
      add.disabled = card.state === "adding";
      const row = make(doc, "div", { className: "dialog-actions" });
      row.append(add);
      form.append(row);
      if (card.message) form.append(make(doc, "p", { className: "card-error", text: card.message, attrs: { role: "alert" } }));
      form.addEventListener("submit", (e) => { e?.preventDefault?.(); return addTask(card); });
      box.append(form);
    } else {
      const form = make(doc, "form", { className: "card-form", attrs: { novalidate: "", "aria-labelledby": `${card.key}-h` } });
      form.append(make(doc, "h3", { text: CARD_TEXT.sourceHeading, attrs: { id: `${card.key}-h` } }));
      form.append(...field(card, "title", CARD_TEXT.sourceTitle), ...field(card, "author", CARD_TEXT.sourceAuthor), ...field(card, "url", CARD_TEXT.sourceLink, { type: "url" }));
      const add = make(doc, "button", { className: "primary", text: card.state === "adding" ? CARD_TEXT.adding : CARD_TEXT.sourceAdd, attrs: { type: "submit" } });
      add.disabled = card.state === "adding";
      const cancel = make(doc, "button", { className: "secondary", text: CARD_TEXT.cancel, attrs: { type: "button" } });
      cancel.addEventListener("click", () => { cards = cards.filter((c) => c !== card); change(); });
      const row = make(doc, "div", { className: "dialog-actions" });
      row.append(add, cancel);
      form.append(row);
      if (card.message) form.append(make(doc, "p", { className: "card-error", text: card.message, attrs: { role: "alert" } }));
      form.addEventListener("submit", (e) => { e?.preventDefault?.(); return saveSource(card); });
      box.append(form);
    }
    li.append(box);
    return li;
  }

  return {
    addPaste, addFiles, addSource,
    list: () => cards,
    render,
    clear() { generation += 1; cards = []; },
  };
}
