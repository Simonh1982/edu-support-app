// Parent page: sign-in and pass handling only (WP-012). It never wakes the Codespace,
// because nothing here needs the server until phase 1; this saves Codespace hours.
import { config } from "../config.js";
import {
  checkNewPass,
  clearPass,
  loadPass,
  loginUrl,
  readFragment,
  savePass,
  signInMessage,
  usableStorage,
  workerRequest,
} from "../shared/auth.js";

const ROLE = "parent";

const PASS_CHECK_MESSAGES = Object.freeze({
  ok: "Sign-in confirmed.",
  offline: "Couldn't check your sign-in just now. Please try again later.",
});

function setText(element, text) {
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
    passStatus: byId("pass-status"),
    signOut: byId("sign-out"),
  };
  if (Object.values(els).some((el) => !el)) return;

  const local = usableStorage(() => window.localStorage);
  const session = usableStorage(() => window.sessionStorage);
  let checkId = 0;

  function showSignIn(code, { focus = false } = {}) {
    checkId += 1; // ignore any pass check still in flight
    els.home.hidden = true;
    els.signIn.hidden = false;
    els.form.querySelector("button[type=submit]")?.removeAttribute("disabled");
    setText(els.signInStatus, code ? signInMessage(code) : "");
    if (focus) els.signInHeading.focus();
  }

  // The Worker checks the pass on every request; /status is the lightest call it has.
  // It only reads the Codespace's state and never starts it.
  async function confirmPass(pass) {
    const id = ++checkId;
    setText(els.passStatus, "");
    const result = await workerRequest({ workerUrl: config.workerUrl, path: "status", token: pass.token });
    if (id !== checkId) return;
    if (result.kind === "auth") {
      clearPass({ role: ROLE, local, session });
      showSignIn("revoked", { focus: true });
    } else if (result.kind === "not-configured") {
      setText(els.passStatus, signInMessage("not-configured"));
    } else {
      setText(els.passStatus, result.kind === "ok" ? PASS_CHECK_MESSAGES.ok : PASS_CHECK_MESSAGES.offline);
    }
  }

  function showHome(pass) {
    els.signIn.hidden = true;
    els.home.hidden = false;
    els.sharedNote.hidden = !pass.payload.shared;
    confirmPass(pass).catch((err) => {
      console.error("[pass] unexpected error:", err?.message ?? String(err));
      setText(els.passStatus, PASS_CHECK_MESSAGES.offline);
    });
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

  els.signOut.addEventListener("click", () => {
    clearPass({ role: ROLE, local, session });
    showSignIn("signed-out", { focus: true });
  });

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

if (typeof document !== "undefined") init();
