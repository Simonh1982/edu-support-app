// Learner page: the home screen and its views (WP-110; build spec §3.2, §6, §6.1). Home shows the
// status line, "Recommended next", the three large actions and a smaller "More". Each action opens its
// own view with a Back button, so there is one decision at a time. Views are added to the browser's
// history, so the phone's own back gesture returns home too.
export const VIEWS = Object.freeze(["home", "work", "upcoming", "learn", "more"]);
const DEFAULT_HEADING = "Home";
const DEFAULT_TITLE = "Study";
const SIGNED_OUT_TITLE = "Sign in";

/**
 * Returns { show(view, options), back(), reset(), setRecommendation(rec), setAppName(name),
 * setQueueNote(text), current() }, or null if the page doesn't have the views.
 */
export function createHome({ doc = document, win = window, onRecommend, onShow } = {}) {
  const byId = (id) => doc.getElementById(id);
  const views = Object.fromEntries(VIEWS.map((name) => [name, byId(`view-${name}`)]));
  const openers = Object.fromEntries(VIEWS.filter((name) => name !== "home").map((name) => [name, byId(`go-${name}`)]));
  const els = {
    heading: byId("home-heading"),
    recommend: byId("recommend"),
    recommendText: byId("recommend-text"),
    recommendOpen: byId("recommend-open"),
    queueNote: byId("queue-note"),
  };
  if ([...Object.values(views), ...Object.values(openers), ...Object.values(els)].some((el) => !el)) return null;

  let current = "home";
  let lastOpened = null;
  let recommendedTask = null;
  const history = win?.history;

  function setText(element, text) {
    if (element.textContent !== text) element.textContent = text;
  }

  // Each view's first heading takes focus when it opens, so screen readers announce it.
  function focusTarget(name) {
    const target = views[name].querySelector("h2");
    if (target && !target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
    return target;
  }

  function show(name, { focus = true, push = true } = {}) {
    const next = VIEWS.includes(name) ? name : "home";
    const was = current;
    for (const [view, el] of Object.entries(views)) el.hidden = view !== next;
    current = next;
    if (next !== "home") lastOpened = next;
    if (push && next !== "home") {
      // home → view adds a history entry; view → view replaces it, so Back still goes home
      if (was === "home") history?.pushState?.({ eduView: next }, "");
      else history?.replaceState?.({ eduView: next }, "");
    }
    if (focus) {
      if (next === "home") (lastOpened ? openers[lastOpened] : els.heading).focus();
      else focusTarget(next)?.focus();
    }
    onShow?.(next);
  }

  function back() {
    if (history?.state?.eduView) history.back(); // popstate shows home
    else show("home");
  }

  for (const [name, button] of Object.entries(openers)) button.addEventListener("click", () => show(name));
  for (const button of doc.querySelectorAll("[data-back]")) button.addEventListener("click", back);
  win?.addEventListener?.("popstate", (event) => {
    if (byId("home-screen")?.hidden) return; // signed out: nothing to show
    show(event.state?.eduView ?? "home", { push: false });
  });

  els.recommendOpen.addEventListener("click", () => {
    const taskId = recommendedTask;
    show("upcoming");
    if (taskId) onRecommend?.(taskId);
  });

  function setRecommendation(rec) {
    recommendedTask = rec?.taskId ?? null;
    els.recommend.hidden = !rec;
    setText(els.recommendText, rec?.text ?? "");
  }

  function setAppName(name) {
    const text = typeof name === "string" && name.trim() !== "" ? name.trim() : null;
    setText(els.heading, text ?? DEFAULT_HEADING);
    doc.title = text ?? DEFAULT_TITLE;
  }

  function setQueueNote(text) {
    setText(els.queueNote, text ?? "");
    els.queueNote.hidden = !text;
  }

  /** Back to the home view with nothing shown (sign-in and sign-out). */
  function reset() {
    show("home", { focus: false, push: false });
    lastOpened = null;
    setRecommendation(null);
    setQueueNote("");
    setText(els.heading, DEFAULT_HEADING);
    doc.title = SIGNED_OUT_TITLE;
    if (history?.state?.eduView) history.replaceState?.(null, "");
  }

  return { show, back, reset, setRecommendation, setAppName, setQueueNote, current: () => current };
}
