// Learner page: sign-in, pass handling, waking the tutor (WP-012), capture (WP-014b), the
// learner's accessibility settings (WP-017), pasting, typing and checking tasks (WP-108b), "Coming up"
// (WP-109), the home screen, the saved view and the edit queue (WP-110), and getting help with a
// task in a conversation, with the coloured tutor status panel (WP-111b).
import { config } from "./config.js";
import {
  checkNewPass,
  clearPass,
  loadPass,
  loginUrl,
  readFragment,
  savePass,
  signInMessage,
  usableStorage,
} from "./shared/auth.js";
import { createWaker, tutorPanel, WAKE_MESSAGES } from "./shared/wake.js";
import { createCaptureScreen } from "./capture.js";
import { createTaskEntry } from "./check.js";
import { createUpcoming } from "./upcoming.js";
import { createHome } from "./home.js";
import { createConversation } from "./conversation.js";
import { openDeviceStore } from "./device-store.js";
import { createApi } from "./shared/api.js";
import { createAccessibility } from "./shared/accessibility.js";
import { OFFLINE_MESSAGES, createOffline, memoryKeyValue, queueNote, signOutMessage } from "./shared/offline.js";
import { recommendNext } from "./shared/recommend.js";
import { ukToday } from "./shared/upcoming.js";

// Kept as an export of this file so existing tests and callers still work.
export { loginUrl };

const ROLE = "learner";
const RETRY_STATES = new Set(["timeout", "worker", "wakeFailed", "notConfigured"]);
const READY_STATES = new Set(["ready", "readyNoAi"]);

function setText(element, text) {
  // Only change the text when it differs, so screen readers don't repeat the same message.
  if (element.textContent !== text) element.textContent = text;
}

function init() {
  const byId = (id) => document.getElementById(id);
  const els = {
    signIn: byId("sign-in-screen"),
    signInHeading: byId("sign-in-heading"),
    form: byId("sign-in-form"),
    shared: byId("shared-computer"),
    signInStatus: byId("sign-in-status"),
    home: byId("home-screen"),
    homeHeading: byId("home-heading"),
    sharedNote: byId("shared-note"),
    wakeStatus: byId("wake-status"),
    retry: byId("wake-retry"),
    signOut: byId("sign-out"),
    signOutDialog: byId("sign-out-dialog"),
    signOutText: byId("sign-out-text"),
    signOutConfirm: byId("sign-out-confirm"),
    signOutCancel: byId("sign-out-cancel"),
    morePhotos: byId("more-photos"),
    capturesHeading: byId("captures-heading"),
  };
  if (Object.values(els).some((el) => !el)) return;

  const local = usableStorage(() => window.localStorage);
  const session = usableStorage(() => window.sessionStorage);
  let waker = null;
  // the pass and the tutor's address, for the calls that go straight to the tutor (WP-108b)
  let token = null;
  let backendUrl = null;
  let taskEntry = null;
  let upcoming = null;
  let sharedComputer = false;
  // WP-111b: the conversation, the entries "Coming up" last showed, and the tutor's latest state
  let conversation = null;
  let latestItems = [];
  let tutorState = "waiting";

  // Text size, spacing, theme and contrast from the snapshot (blueprint §10.6). Read through the
  // Worker, so they apply while the tutor is still waking.
  const accessibility = createAccessibility({
    workerUrl: config.workerUrl,
    root: document.documentElement,
    local,
  });

  // WP-110: the saved view and the edit queue. IndexedDB on own devices; memory only on a shared
  // computer (blueprint §10.3).
  const offline = createOffline();
  const home = createHome({
    onRecommend: (taskId) => upcoming?.focusTask(taskId),
    onShow: (view) => {
      if (view === "work") conversation?.refreshTasks();
    },
  });
  offline.onChange((count) => home?.setQueueNote(queueNote(count, { shared: sharedComputer })));

  // Captures go to the Worker's inbox, so they work while the tutor is still waking (blueprint §4.4).
  // A pass the Worker or tutor rejects (account removed, or every device signed out) also forgets
  // anything saved on this device; a pass that has simply expired keeps it for the next sign-in.
  const signedOut = (reason) => {
    clearPass({ role: ROLE, local, session });
    showSignIn("revoked", { focus: true, forget: reason !== "expired" });
  };
  const capture = createCaptureScreen({
    workerUrl: config.workerUrl,
    onSignedOut: signedOut,
    onCheck: (uploadId) => taskEntry?.open(uploadId),
  });

  // Pasting and "Check the details" need the tutor itself, so they wait until it answers.
  const api = createApi({ getBackendUrl: () => backendUrl, getToken: () => token });
  // "Coming up" (WP-109): the saved copy and the snapshot while the tutor wakes, the tutor once it answers
  upcoming = createUpcoming({
    workerUrl: config.workerUrl,
    api,
    offline,
    onSignedOut: signedOut,
    onList: ({ items, appName }) => {
      latestItems = items;
      conversation?.refreshTasks();
      home?.setRecommendation(recommendNext(items, { today: ukToday() }));
      if (appName !== undefined) home?.setAppName(appName);
    },
  });

  // A typed task made while the tutor wakes waits in the edit queue (WP-110).
  async function queueTask(body) {
    const added = await offline.add({ type: "add", body });
    return added.ok ? { kind: "queued", message: OFFLINE_MESSAGES.taskQueued } : { kind: "queue-error", message: added.error };
  }
  taskEntry = createTaskEntry({ api, capture, onSignedOut: signedOut, onTaskAdded: () => upcoming?.refresh(), queueTask });

  // WP-111b: "Get help with a task" and the conversation. A call that can't reach the tutor wakes it
  // again, and the conversation carries on from the saved turns once it answers (blueprint §9.2).
  conversation = createConversation({
    api,
    home,
    getTasks: () => latestItems,
    onSignedOut: signedOut,
    onUnreachable: wakeAgain,
  });

  function wakeAgain() {
    if (!READY_STATES.has(tutorState)) return;
    const pass = loadPass({ role: ROLE, local, session });
    if (pass?.token) startWaking(pass);
  }

  function setTutor(state) {
    tutorState = state;
    conversation?.setTutor(state);
    capture?.setTutor(state);
    taskEntry?.setTutor(state);
    upcoming?.setTutor(state);
  }

  function stopWaking() {
    waker?.stop();
    waker = null;
  }

  // forget: also empty the saved view and the queue (sign-out). Otherwise (an expired pass) they stay
  // on this device and are used after the next sign-in.
  function showSignIn(code, { focus = false, forget = false } = {}) {
    stopWaking();
    capture?.stop();
    taskEntry?.stop();
    upcoming?.stop();
    conversation?.stop();
    latestItems = [];
    els.wakeStatus.removeAttribute("data-tutor");
    setTutor("waiting");
    token = null;
    backendUrl = null;
    accessibility.stop();
    if (forget) {
      offline.clear().catch((err) => console.error("[offline] could not clear:", err?.name ?? "Error"));
    } else {
      offline.stop();
    }
    home?.reset();
    if (els.signOutDialog.open) els.signOutDialog.close();
    els.home.hidden = true;
    els.signIn.hidden = false;
    els.form.querySelector("button[type=submit]")?.removeAttribute("disabled");
    setText(els.signInStatus, code ? signInMessage(code) : "");
    if (focus) els.signInHeading.focus();
  }

  function startWaking(pass) {
    stopWaking();
    setTutor("waiting");
    els.retry.hidden = true;
    const current = createWaker({
      workerUrl: config.workerUrl,
      token: pass.token,
      onUpdate: ({ state, message }) => {
        setText(els.wakeStatus, message);
        // red, amber or green, always with the words (WP-111b)
        els.wakeStatus.dataset.tutor = tutorPanel(state);
      },
    });
    waker = current;
    current
      .run()
      .then((result) => {
        if (waker !== current) return;
        if (result.state === "signedOut") {
          signedOut(result.reason);
        } else if (RETRY_STATES.has(result.state)) {
          els.retry.hidden = false;
        } else if (READY_STATES.has(result.state)) {
          backendUrl = result.backendUrl ?? null;
          // "Coming up" sends anything queued, then loads the tutor's list
          setTutor(result.state);
          // The server rebuilds the snapshot when it starts, so read the settings again.
          accessibility.refresh().catch((err) => {
            console.error("[settings] could not refresh:", err?.message ?? String(err));
          });
        }
      })
      .catch((err) => {
        console.error("[wake] unexpected error:", err?.message ?? String(err));
        setText(els.wakeStatus, WAKE_MESSAGES.wakeFailed);
        els.wakeStatus.dataset.tutor = tutorPanel("wakeFailed");
        els.retry.hidden = false;
      });
  }

  function showHome(pass, { focus = false } = {}) {
    sharedComputer = pass.payload.shared === true;
    els.signIn.hidden = true;
    els.home.hidden = false;
    els.sharedNote.hidden = !sharedComputer;
    home?.reset();
    home?.setAppName(null);
    if (focus) els.homeHeading.focus();
    accessibility.start({ token: pass.token, shared: pass.payload.shared }).catch((err) => {
      console.error("[settings] could not load:", err?.message ?? String(err));
    });
    // Nothing is saved in the browser on a shared computer, so its queue lives in memory only.
    const store = sharedComputer ? memoryKeyValue() : openDeviceStore() ?? memoryKeyValue();
    offline.start({ store, shared: sharedComputer });
    token = pass.token;
    startWaking(pass);
    capture?.start(pass.token);
    taskEntry?.start();
    upcoming?.start(pass.token);
    conversation?.start();
  }

  els.form.addEventListener("submit", (event) => {
    event.preventDefault();
    const target = loginUrl(config.workerUrl, els.shared.checked);
    if (!target) {
      setText(els.signInStatus, signInMessage("not-configured"));
      return;
    }
    els.form.querySelector("button[type=submit]")?.setAttribute("disabled", "");
    setText(els.signInStatus, "Taking you to GitHub…");
    window.location.assign(target);
  });

  els.retry.addEventListener("click", () => {
    const pass = loadPass({ role: ROLE, local, session });
    if (pass?.token) startWaking(pass);
    else showSignIn(pass?.expired ? "pass-expired" : undefined, { focus: true });
  });

  function signOutNow() {
    clearPass({ role: ROLE, local, session });
    showSignIn("signed-out", { focus: true, forget: true });
  }

  // Changes still waiting would be lost, so ask first, in an in-page dialog (blueprint §10.6).
  els.signOut.addEventListener("click", () => {
    const waiting = offline.count();
    if (waiting > 0 && typeof els.signOutDialog.showModal === "function") {
      setText(els.signOutText, signOutMessage(waiting));
      els.signOutDialog.showModal();
      els.signOutCancel.focus();
      return;
    }
    signOutNow();
  });
  els.signOutConfirm.addEventListener("click", () => {
    els.signOutDialog.close();
    signOutNow();
  });
  els.signOutCancel.addEventListener("click", () => {
    els.signOutDialog.close();
    els.signOut.focus();
  });

  els.morePhotos.addEventListener("click", () => {
    home?.show("work");
    els.capturesHeading.focus();
  });

  // Coming back from sign-in: take the pass (or error) out of the address bar straight away.
  const fragment = readFragment(window.location.hash);
  if (fragment) {
    history.replaceState(null, "", window.location.pathname + window.location.search);
    if (fragment.error) return showSignIn(fragment.error);
    const checked = checkNewPass(fragment.pass, ROLE);
    if (checked.error) return showSignIn(checked.error);
    savePass({ token: fragment.pass, payload: checked.payload, local, session });
  }

  const pass = loadPass({ role: ROLE, local, session });
  if (pass?.token) showHome(pass);
  else showSignIn(pass?.expired ? "pass-expired" : undefined);
}

// Guarded so tests can import this file under Node without a DOM.
if (typeof document !== "undefined") init();
