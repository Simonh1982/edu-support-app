// Sign-in screen only (phase 0, step 1). Pass handling arrives in WP-012.
import { config } from "./config.js";

/**
 * Builds the Worker's sign-in address, or returns null if no Worker is configured.
 * @param {string} workerUrl
 * @param {boolean} shared  true on a shared computer (shorter pass, nothing saved)
 */
export function loginUrl(workerUrl, shared) {
  if (typeof workerUrl !== "string" || workerUrl.trim() === "") return null;
  const base = workerUrl.trim().replace(/\/+$/, "") + "/";
  const url = new URL("auth/login", base);
  if (shared) url.searchParams.set("shared", "1");
  return url.href;
}

function init() {
  const form = document.getElementById("sign-in-form");
  const shared = document.getElementById("shared-computer");
  const status = document.getElementById("sign-in-status");
  if (!form || !shared || !status) return;

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const target = loginUrl(config.workerUrl, shared.checked);
    if (!target) {
      status.textContent = "Sign-in isn't connected yet. Please try again later.";
      return;
    }
    form.querySelector("button[type=submit]")?.setAttribute("disabled", "");
    status.textContent = "Taking you to GitHub…";
    window.location.assign(target);
  });
}

// Guarded so tests can import loginUrl under Node without a DOM.
if (typeof document !== "undefined") init();
