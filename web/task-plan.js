// WP-116: the task panel's "Your plan for this task" part (build spec §9.2): the five planning
// prompts, each answered in his own words; notebook entries pinned beside the plan as references
// (never copied in, §29); and gaps to look into, his own or the tutor's questions from "What's
// missing?". Needs the tutor; nothing is kept on the device except what he is typing, in memory.
import { PLAN_SECTIONS, PLAN_SECTION_MAX, GAP_MAX, PLAN_TEXT, planChanges, checkGap } from "./shared/plan.js";
import { KIND_LABELS, notebookQuery } from "./shared/notebook.js";
import { make } from "./notebook-parts.js";

function setText(element, text) {
  if (element.textContent !== text) element.textContent = text;
}

function button(doc, text, { className = "secondary", action, label } = {}) {
  const b = make(doc, "button", { className, text, attrs: { type: "button" } });
  if (action) b.dataset.action = action;
  if (label) b.setAttribute("aria-label", label);
  return b;
}

/**
 * Returns { show(taskId, { open }), setTutor(ready), refresh(), clear() }, or null without the part.
 * failed(result) gives the panel's error wording (and signs out on "auth").
 */
export function createTaskPlan({ api, doc = document, failed = () => "" }) {
  const byId = (id) => doc.getElementById(id);
  const els = { box: byId("task-panel-plan"), body: byId("task-panel-plan-body"), status: byId("task-panel-plan-status") };
  if (Object.values(els).some((el) => !el)) return null;

  let ready = false;
  let taskId = null;
  let generation = 0;
  let plan = null; // the saved plan from the server
  let notes = []; // the task's notebook entries, for pinning
  let draft = {}; // what he has typed, by section key
  let gapDraft = "";
  let busy = false;
  let finding = false;

  const dirty = () => plan && PLAN_SECTIONS.some(({ key }) => (draft[key] ?? plan.sections[key] ?? "") !== (plan.sections[key] ?? ""));

  function render() {
    els.box.hidden = !taskId;
    if (!taskId) return;
    if (!plan) {
      els.body.replaceChildren(make(doc, "p", { className: "hint", text: ready ? "" : PLAN_TEXT.viewOnly }));
      return;
    }
    const parts = [make(doc, "p", { className: "hint", text: PLAN_TEXT.intro })];

    // the five prompts, his words only
    const form = make(doc, "form", { className: "plan-form", attrs: { novalidate: "" } });
    for (const { key, label } of PLAN_SECTIONS) {
      const id = `plan-${key}`;
      form.append(make(doc, "label", { text: label, attrs: { for: id } }));
      form.append(make(doc, "p", { className: "hint", text: PLAN_TEXT.hints[key], attrs: { id: `${id}-hint` } }));
      const area = make(doc, "textarea", { attrs: { id, rows: key === "mainPoint" ? "2" : "4", maxlength: String(PLAN_SECTION_MAX), "aria-describedby": `${id}-hint` } });
      area.value = draft[key] ?? plan.sections[key] ?? "";
      area.readOnly = !ready;
      area.addEventListener("input", () => {
        draft[key] = area.value;
        setText(els.status, dirty() ? PLAN_TEXT.unsaved : "");
      });
      form.append(area);
    }
    const row = make(doc, "div", { className: "actions" });
    const save = make(doc, "button", { className: "primary", text: busy ? PLAN_TEXT.saving : PLAN_TEXT.save, attrs: { type: "submit" } });
    save.dataset.action = "save-plan";
    save.disabled = busy || !ready;
    row.append(save);
    form.append(row);
    form.addEventListener("submit", (event) => {
      event?.preventDefault?.();
      return saveSections();
    });
    parts.push(form);

    // pinned references
    parts.push(make(doc, "h4", { text: PLAN_TEXT.pinnedHeading }));
    if (plan.pinned.length) {
      const list = make(doc, "ul", { className: "plan-pins" });
      for (const p of plan.pinned) {
        const li = make(doc, "li");
        li.append(make(doc, "p", { className: "source-kind", text: KIND_LABELS[p.type] ?? "" }));
        li.append(make(doc, "p", { text: p.title || KIND_LABELS[p.type] }));
        if (p.citation) li.append(make(doc, "p", { className: "hint", text: p.citation }));
        const b = button(doc, PLAN_TEXT.unpin, { action: "unpin", label: `${PLAN_TEXT.unpin}: ${p.title ?? ""}` });
        b.disabled = busy || !ready;
        b.addEventListener("click", () => send({ pin: { entryId: p.id, pinned: false } }));
        li.append(b);
        list.append(li);
      }
      parts.push(list);
    } else {
      parts.push(make(doc, "p", { className: "hint", text: PLAN_TEXT.pinnedNone }));
    }
    const pinnedIds = new Set(plan.pinned.map((p) => p.id));
    const canPin = notes.filter((n) => !pinnedIds.has(n.id));
    if (ready) {
      // shown openly: a folded section reads as a plain heading here (WP-115c live check)
      const pinBox = make(doc, "div", { className: "plan-pin-from" });
      pinBox.append(make(doc, "h4", { text: PLAN_TEXT.pinHeading }));
      if (canPin.length) {
        const list = make(doc, "ul", { className: "plan-pins" });
        for (const n of canPin) {
          const li = make(doc, "li");
          li.append(make(doc, "p", { className: "source-kind", text: KIND_LABELS[n.type] ?? "" }));
          li.append(make(doc, "p", { text: n.title || KIND_LABELS[n.type] }));
          const b = button(doc, PLAN_TEXT.pin, { action: "pin", label: `${PLAN_TEXT.pin}: ${n.title ?? ""}` });
          b.disabled = busy;
          b.addEventListener("click", () => send({ pin: { entryId: n.id, pinned: true } }));
          li.append(b);
          list.append(li);
        }
        pinBox.append(list);
      } else {
        pinBox.append(make(doc, "p", { className: "hint", text: PLAN_TEXT.pinNone }));
      }
      parts.push(pinBox);
    }

    // gaps
    parts.push(make(doc, "h4", { text: PLAN_TEXT.gapsHeading }));
    if (plan.gaps.length) {
      const list = make(doc, "ul", { className: "plan-gaps" });
      for (const g of plan.gaps) {
        const li = make(doc, "li", { className: g.done ? "gap-done" : "" });
        if (g.author === "ai") li.append(make(doc, "p", { className: "source-kind", text: PLAN_TEXT.fromTutor }));
        const id = `gap-${g.id}`;
        const tick = make(doc, "input", { attrs: { type: "checkbox", id } });
        tick.checked = g.done;
        tick.disabled = busy || !ready;
        tick.addEventListener("change", () => send({ gap: { id: g.id, done: tick.checked } }));
        const label = make(doc, "label", { className: "gap-label", text: g.text, attrs: { for: id } });
        const line = make(doc, "div", { className: "gap-line" });
        line.append(tick, label);
        li.append(line);
        const remove = button(doc, PLAN_TEXT.remove, { action: "remove-gap", label: `${PLAN_TEXT.remove}: ${g.text}` });
        remove.disabled = busy || !ready;
        remove.addEventListener("click", () => send({ gap: { id: g.id, remove: true } }));
        li.append(remove);
        list.append(li);
      }
      parts.push(list);
    } else {
      parts.push(make(doc, "p", { className: "hint", text: PLAN_TEXT.gapsNone }));
    }
    if (ready) {
      const add = make(doc, "form", { className: "gap-form", attrs: { novalidate: "" } });
      add.append(make(doc, "label", { text: PLAN_TEXT.gapLabel, attrs: { for: "plan-gap-new" } }));
      add.append(make(doc, "p", { className: "hint", text: PLAN_TEXT.gapHint, attrs: { id: "plan-gap-new-hint" } }));
      const input = make(doc, "input", { attrs: { id: "plan-gap-new", type: "text", maxlength: String(GAP_MAX), autocomplete: "off", "aria-describedby": "plan-gap-new-hint" } });
      input.value = gapDraft;
      input.addEventListener("input", () => { gapDraft = input.value; });
      add.append(input);
      const r = make(doc, "div", { className: "actions" });
      const b = make(doc, "button", { className: "secondary", text: PLAN_TEXT.addGap, attrs: { type: "submit" } });
      b.dataset.action = "add-gap";
      b.disabled = busy;
      r.append(b);
      add.append(r);
      add.addEventListener("submit", (event) => {
        event?.preventDefault?.();
        const checked = checkGap(input.value);
        if (checked.error) {
          setText(els.status, checked.error);
          return undefined;
        }
        return send({ addGap: checked.text }, () => { gapDraft = ""; });
      });
      parts.push(add);
      parts.push(make(doc, "p", { className: "hint", text: PLAN_TEXT.findHint }));
      const r2 = make(doc, "div", { className: "actions" });
      const find = button(doc, finding ? PLAN_TEXT.finding : PLAN_TEXT.findGaps, { action: "find-gaps" });
      find.disabled = busy || finding;
      find.addEventListener("click", findGaps);
      r2.append(find);
      parts.push(r2);
    }
    els.body.replaceChildren(...parts);
  }

  async function load() {
    const mine = ++generation;
    if (!taskId || !ready) {
      render();
      return;
    }
    const [p, n] = await Promise.all([api.getPlan(taskId), api.listNotebook(notebookQuery({ taskId }))]);
    if (mine !== generation) return;
    if (p.kind === "ok" && p.body?.plan) {
      plan = p.body.plan;
    } else {
      setText(els.status, failed(p) || PLAN_TEXT.failed);
    }
    notes = n.kind === "ok" && Array.isArray(n.body?.entries) ? n.body.entries : [];
    render();
  }

  async function send(body, after = () => {}) {
    if (busy || !ready || !taskId) return;
    busy = true;
    render();
    const result = await api.updatePlan(taskId, body);
    busy = false;
    if (result.kind === "ok" && result.body?.plan) {
      plan = result.body.plan;
      after();
      if (body.sections) {
        draft = {};
        setText(els.status, PLAN_TEXT.saved);
      }
    } else {
      setText(els.status, failed(result) || (typeof result.body?.error === "string" ? result.body.error : PLAN_TEXT.failed));
    }
    render();
  }

  function saveSections() {
    if (!plan) return undefined;
    const merged = Object.fromEntries(PLAN_SECTIONS.map(({ key }) => [key, draft[key] ?? plan.sections[key] ?? ""]));
    const changes = planChanges(merged, plan.sections);
    if (changes.error) {
      setText(els.status, changes.error);
      byId(`plan-${changes.field}`)?.focus();
      return undefined;
    }
    if (!Object.keys(changes.sections).length) {
      setText(els.status, PLAN_TEXT.saved);
      return undefined;
    }
    return send({ sections: changes.sections });
  }

  async function findGaps() {
    if (finding || busy || !ready || !taskId) return;
    // his latest words count: save first
    if (dirty()) await saveSections();
    finding = true;
    setText(els.status, PLAN_TEXT.finding);
    render();
    const result = await api.findGaps(taskId);
    finding = false;
    if (result.kind === "ok") {
      if (result.body?.plan) plan = result.body.plan;
      setText(els.status, result.body?.message ?? "");
    } else {
      setText(els.status, failed(result) || (typeof result.body?.error === "string" ? result.body.error : PLAN_TEXT.failed));
    }
    render();
  }

  // ---------- public ----------
  function show(id, { open = false } = {}) {
    taskId = typeof id === "string" ? id : null;
    plan = null;
    notes = [];
    draft = {};
    gapDraft = "";
    busy = false;
    finding = false;
    els.box.open = open;
    setText(els.status, "");
    return load();
  }

  function setTutor(isReady) {
    const was = ready;
    ready = isReady;
    if (ready && !was) return load();
    render();
    return undefined;
  }

  function clear() {
    generation += 1;
    taskId = null;
    plan = null;
    els.body.replaceChildren();
    els.box.hidden = true;
  }

  // refresh keeps what he is typing; it reloads the saved plan and the notes to pin
  return { show, setTutor, refresh: load, clear, open: () => { els.box.open = true; } };
}
