// Status polls (sidebar badges, window controls, recordings page) run every
// 1-1.5 s. Nobody sees their result while the window is hidden, and for some
// not while it's unfocused either, so those ticks are skipped and a fresh poll
// runs as soon as the window comes back.

/**
 * @param {{ whenUnfocused?: boolean }} [options]
 * @param {{ hidden?: boolean, hasFocus?: () => boolean } | undefined} [doc]
 */
export function isPollingPaused(options = {}, doc = typeof document === "undefined" ? undefined : document) {
  if (!doc) return false;
  if (doc.hidden) return true;
  return Boolean(options.whenUnfocused) && typeof doc.hasFocus === "function" && !doc.hasFocus();
}

/**
 * Runs `callback` every `intervalMs` while not paused, once immediately, and
 * again whenever the window becomes visible or focused. Returns a disposer.
 * @param {() => void} callback
 * @param {number} intervalMs
 * @param {{ whenUnfocused?: boolean }} [options]
 */
export function startGatedPolling(callback, intervalMs, options = {}) {
  callback();
  const tick = () => {
    if (!isPollingPaused(options)) callback();
  };
  const timer = setInterval(tick, intervalMs);
  const resume = () => tick();
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", resume);
  if (typeof window !== "undefined") window.addEventListener("focus", resume);
  return () => {
    clearInterval(timer);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", resume);
    if (typeof window !== "undefined") window.removeEventListener("focus", resume);
  };
}
