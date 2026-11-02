// WP-109: Today / Coming soon / Later, worked out on the device in UK dates; stage and deadline
// changes; the page and API pieces. Invented data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as shared from "../web/shared/upcoming.js";
import * as derived from "../server/derived/upcoming.js";
import { STAGES, FINISHED_STAGES, TASK_KINDS } from "../server/domain/tasks.js";
import { createApi } from "../web/shared/api.js";

const {
  ukToday, validDate, addDays, daysBetween, dueText, stageLabel, longDateText, upcomingItem, fromTask,
  fromSnapshot, groupUpcoming, groupTasks, updateBody, movedOffMessage, UPCOMING_MESSAGES, SOON_DAYS,
} = shared;

const WEB = fileURLToPath(new URL("../web/", import.meta.url));
// Monday 2 November 2026
const TODAY = "2026-11-02";
const item = (taskId, deadline, extra = {}) => ({ taskId, title: `Invented ${taskId}`, subject: "Imaginary studies", deadline, stage: "planning", kind: "homework", ...extra });

test("copies of the task stages and kinds match server/domain/tasks.js", () => {
  assert.deepEqual([...shared.STAGES], [...STAGES]);
  assert.deepEqual([...shared.FINISHED_STAGES], [...FINISHED_STAGES]);
  assert.deepEqual([...shared.TASK_KINDS], [...TASK_KINDS]);
  for (const stage of STAGES) assert.ok(shared.STAGE_LABELS[stage], stage);
  assert.equal(shared.STAGE_LABELS.submitted, "Handed in");
});

test("server/derived/upcoming.js uses exactly the same rules", () => {
  for (const name of ["ukToday", "groupUpcoming", "groupTasks", "fromTask", "fromSnapshot", "dueText"]) {
    assert.equal(derived[name], shared[name], name);
  }
  assert.equal(derived.SOON_DAYS, 7);
});

test("ukToday is the UK date, in summer time and winter time", () => {
  assert.equal(ukToday(new Date("2026-06-30T23:30:00Z")), "2026-07-01", "BST: 00:30 the next day");
  assert.equal(ukToday(new Date("2026-12-31T23:30:00Z")), "2026-12-31", "GMT");
  assert.equal(ukToday(new Date("2026-10-24T23:30:00Z")), "2026-10-25", "the night the clocks go back");
  assert.equal(ukToday(new Date("2026-10-25T23:30:00Z")), "2026-10-25");
});

test("validDate, addDays and daysBetween work on plain dates", () => {
  assert.equal(validDate("2026-11-20"), "2026-11-20");
  assert.equal(validDate("2026-11-20T10:00:00+00:00"), "2026-11-20", "date-times keep their date");
  for (const bad of ["2026-02-30", "2026-13-01", "20-11-2026", "soon", "", null, 7, "2026-11-201"]) assert.equal(validDate(bad), null, String(bad));
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2026-03-28", 2), "2026-03-30", "across the clocks going forward");
  assert.equal(daysBetween(TODAY, "2026-11-09"), 7);
  assert.equal(daysBetween(TODAY, "2026-10-30"), -3);
});

test("dueText says when, in plain words", () => {
  assert.equal(dueText("2026-11-02", TODAY), "Due today");
  assert.equal(dueText("2026-11-03", TODAY), "Due tomorrow");
  assert.equal(dueText("2026-11-06", TODAY), "Due Friday");
  assert.equal(dueText("2026-11-09", TODAY), "Due Mon 9 Nov", "a week away: the date, so it isn't mistaken for today");
  assert.equal(dueText("2026-11-01", TODAY), "Was due yesterday");
  assert.equal(dueText("2026-10-29", TODAY), "Was due Thursday");
  assert.equal(dueText("2026-10-20", TODAY), "Was due Tue 20 Oct");
  assert.equal(dueText(null, TODAY), "No deadline yet");
  assert.equal(longDateText("2026-11-20"), "Friday 20 November 2026");
  assert.equal(longDateText(""), "");
});

test("groups: overdue and today in Today; next 7 days and no deadline in Coming soon; the rest in Later", () => {
  const groups = groupUpcoming([
    item("later", "2026-11-10"),
    item("nodate-a", null),
    item("week", "2026-11-09"),
    item("today", TODAY),
    item("overdue", "2026-10-28"),
    item("tomorrow", "2026-11-03"),
    item("nodate-b", "not a date"),
    item("handed-in", "2026-11-04", { stage: "submitted" }),
    item("done", null, { stage: "done" }),
  ], { today: TODAY });
  assert.deepEqual(groups.today.map((t) => t.taskId), ["overdue", "today"]);
  assert.deepEqual(groups.soon.map((t) => t.taskId), ["tomorrow", "week", "nodate-a", "nodate-b"]);
  assert.deepEqual(groups.later.map((t) => t.taskId), ["later"]);
  assert.equal(groups.count, 7, "handed in and done tasks leave the list");
  assert.equal(groups.date, TODAY);
  const [overdue, today] = groups.today;
  assert.equal(overdue.overdue, true);
  assert.equal(overdue.due, "Was due Wednesday");
  assert.equal(today.overdue, false);
  const noDate = groups.soon[2];
  assert.equal(noDate.noDeadline, true);
  assert.equal(noDate.due, UPCOMING_MESSAGES.noDeadline);
  assert.equal(groups.soon[0].stageLabel, "Planning");
  assert.equal(SOON_DAYS, 7);
  assert.equal("index" in groups.soon[0], false);
});

test("the same tasks fall into new groups as the days pass (nothing stored)", () => {
  const list = [item("a", "2026-11-12")];
  assert.equal(groupUpcoming(list, { today: TODAY }).later.length, 1);
  assert.equal(groupUpcoming(list, { today: "2026-11-05" }).soon.length, 1);
  assert.equal(groupUpcoming(list, { today: "2026-11-12" }).today.length, 1);
  assert.equal(groupUpcoming(list, { today: "2026-11-13" }).today[0].overdue, true);
});

test("fifteen tasks across four subjects all appear, soonest first in each group", () => {
  const subjects = ["Subject A", "Subject B", "Subject C", "Subject D"];
  const list = Array.from({ length: 15 }, (_, i) => item(`t${i}`, i % 5 === 4 ? null : addDays(TODAY, i - 2), { subject: subjects[i % 4] }));
  const groups = groupUpcoming(list, { today: TODAY });
  assert.equal(groups.count, 15);
  for (const name of ["today", "soon", "later"]) {
    const dated = groups[name].filter((t) => t.deadline).map((t) => t.deadline);
    assert.deepEqual(dated, [...dated].sort(), name);
  }
});

test("entries are checked: only the list fields, never question text or anchors", () => {
  const task = {
    id: "t_20261102-abc", title: "  Invented   essay ", subject: "Imaginary studies", deadline: "2026-11-06",
    stage: "drafting", kind: "assessment", questionText: { value: "QUESTION-TEXT-HIDDEN", author: "source" },
    anchors: [{ text: { value: "ANCHOR-TEXT-HIDDEN", author: "source" } }],
  };
  const entry = fromTask(task);
  assert.deepEqual(entry, { taskId: "t_20261102-abc", title: "Invented essay", subject: "Imaginary studies", deadline: "2026-11-06", stage: "drafting", kind: "assessment" });
  assert.equal(JSON.stringify(groupTasks([task], { today: TODAY })).includes("HIDDEN"), false);
  assert.equal(upcomingItem({ taskId: "../x", title: "x" }), null);
  assert.equal(upcomingItem(null), null);
  assert.deepEqual(upcomingItem({ taskId: "t1", stage: "not started", kind: "chore", title: 5 }),
    { taskId: "t1", title: "Task", subject: null, deadline: null, stage: "not-started", kind: null });
  assert.equal(stageLabel("made-up"), "Not started");
});

test("fromSnapshot reads the learner section or a whole snapshot", () => {
  const upcoming = [item("t1", "2026-11-06"), { taskId: "bad id" }];
  assert.deepEqual(fromSnapshot({ upcoming }).map((t) => t.taskId), ["t1"]);
  assert.deepEqual(fromSnapshot({ learner: { upcoming } }).map((t) => t.taskId), ["t1"]);
  assert.deepEqual(fromSnapshot({}), []);
  assert.deepEqual(fromSnapshot(null), []);
});

test("updateBody sends only what changed; handing in leaves the list; bad dates are refused", () => {
  const entry = item("t1", "2026-11-06");
  assert.deepEqual(updateBody(entry, { stage: "planning", deadline: "2026-11-06" }), { unchanged: true });
  assert.deepEqual(updateBody(entry, { stage: "drafting", deadline: "2026-11-06" }), { body: { stage: "drafting" }, leaves: false });
  assert.deepEqual(updateBody(entry, { stage: "submitted", deadline: "2026-11-06" }), { body: { stage: "submitted" }, leaves: true });
  assert.deepEqual(updateBody(entry, { stage: "done" }).leaves, true);
  assert.deepEqual(updateBody(entry, { deadline: "" }), { body: { deadline: null }, leaves: false });
  assert.deepEqual(updateBody(item("t2", null), { deadline: "2026-11-20" }), { body: { deadline: "2026-11-20" }, leaves: false });
  assert.deepEqual(updateBody(item("t2", null), { deadline: "  " }), { unchanged: true });
  assert.equal(updateBody(entry, { deadline: "2026-02-30" }).field, "deadline");
  assert.equal(updateBody(entry, { stage: "napping" }).field, "stage");
  assert.equal(movedOffMessage("Invented essay", "submitted"), "“Invented essay” is handed in, so it's off this list.");
  assert.equal(movedOffMessage("Invented essay", "done"), "“Invented essay” is done, so it's off this list.");
});

test("createApi: openTasks and updateTask call the work routes with the pass", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body, auth: init.headers.Authorization });
    return new Response(JSON.stringify({ tasks: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const api = createApi({ getBackendUrl: () => "https://example-3000.app.github.dev", getToken: () => "test-pass", fetchImpl });
  assert.equal((await api.openTasks()).kind, "ok");
  await api.updateTask("t_1", { stage: "done" });
  assert.deepEqual(calls[0], { url: "https://example-3000.app.github.dev/api/tasks?open=1", method: "GET", body: undefined, auth: "Bearer test-pass" });
  assert.deepEqual(calls[1], { url: "https://example-3000.app.github.dev/api/tasks/t_1", method: "PATCH", body: '{"stage":"done"}', auth: "Bearer test-pass" });
});

test("web/shared/upcoming.js uses no DOM-only or Node-only APIs and imports nothing", () => {
  const source = readFileSync(join(WEB, "shared", "upcoming.js"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(source, /\b(document|window|localStorage|sessionStorage|indexedDB|navigator|process|Buffer|require)\b/);
  assert.doesNotMatch(source, /^\s*import\b/m);
});

test("the page has the Coming up section, and the page code stores nothing in the browser", () => {
  const html = readFileSync(join(WEB, "index.html"), "utf8");
  assert.match(html, /<section id="upcoming"[^>]*aria-labelledby="upcoming-heading"/);
  assert.match(html, /<h2 id="upcoming-heading" tabindex="-1">Coming up<\/h2>/);
  assert.match(html, /id="upcoming-status" class="status" role="status" aria-live="polite"/);
  assert.match(html, /<button type="button" id="upcoming-undo" class="secondary" hidden>Undo<\/button>/);
  const page = readFileSync(join(WEB, "upcoming.js"), "utf8");
  assert.doesNotMatch(page, /localStorage|sessionStorage|indexedDB|innerHTML/);
  const app = readFileSync(join(WEB, "app.js"), "utf8");
  assert.match(app, /from "\.\/upcoming\.js"/);
  assert.match(app, /upcoming\?\.stop\(\)/);
  assert.match(app, /onTaskAdded:/);
  const check = readFileSync(join(WEB, "check.js"), "utf8");
  assert.equal((check.match(/onTaskAdded\?\.\(\)/g) ?? []).length, 2, "after a typed task and after a confirmed one");
});
