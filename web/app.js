// Learner page: sign-in, pass handling, waking the tutor (WP-012) and capture (WP-014b).
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
import { createWaker, WAKE_MESSAGES } from "./shared/wake.js";
import { createCaptureScreen } from "./capture.js";

// Kept as an export of this file so existing tests and callers still work.
export { loginUrl };

const ROLE = "learner";
const RETRY_STATES = new Set(["timeout", "worker", "wakeFailed", "notConfigured"]);

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
  };
  if (Object.values(els).some((el) => !el)) return;

  const local = usableStorage(() => window.localStorage);
  const session = usableStorage(() => window.sessionStorage);
  let waker = null;

  // Captures go to the Worker's inbox, so they work while the tutor is still waking (blueprint §4.4).
  const capture = createCaptureScreen({
    workerUrl: config.workerUrl,
    onSignedOut: () => {
      clearPass({ role: ROLE, local, session });
      showSignIn("revoked", { focus: true });
    },
  });

  function stopWaking() {
    waker?.stop();
    waker = null;
  }

  function showSignIn(code, { focus = false } = {}) {
    stopWaking();
    capture?.stop();
    els.home.hidden = true;
    els.signIn.hidden = false;
    els.form.querySelector("button[type=submit]")?.removeAttribute("disabled");
    setText(els.signInStatus, code ? signInMessage(code) : "");
    if (focus) els.signInHeading.focus();
  }

  function startWaking(pass) {
    stopWaking();
    els.retry.hidden = true;
    const current = createWaker({
      workerUrl: config.workerUrl,
      token: pass.token,
      onUpdate: ({ message }) => setText(els.wakeStatus, message),
    });
    waker = current;
    current
      .run()
      .then((result) => {
        if (waker !== current) return;
        if (result.state === "signedOut") {
          clearPass({ role: ROLE, local, session });
          showSignIn("revoked", { focus: true });
        } else if (RETRY_STATES.has(result.state)) {
          els.retry.hidden = false;
        }
      })
      .catch((err) => {
        console.error("[wake] unexpected error:", err?.message ?? String(err));
        setText(els.wakeStatus, WAKE_MESSAGES.wakeFailed);
        els.retry.hidden = false;
      });
  }

  function showHome(pass, { focus = false } = {}) {
    els.signIn.hidden = true;
    els.home.hidden = false;
    els.sharedNote.hidden = !pass.payload.shared;
    if (focus) els.homeHeading.focus();
    startWaking(pass);
    capture?.start(pass.token);
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

  els.signOut.addEventListener("click", () => {
    clearPass({ role: ROLE, local, session });
    showSignIn("signed-out", { focus: true });
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
