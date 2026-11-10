// Holds app quit until a recorder has finished writing its files.
//
// Every before-quit is checked against `busy()`, not a one-shot flag: when two
// recorders are active, the first to finish calls app.quit() again, and the
// second must still be able to hold the quit until it is done too. A screen
// recording's mixdown runs after its capture has stopped, so `busy()` covers
// that stage as well.
//
// `drain()` stops the work and resolves when it is finished. If it is still
// busy after `maxWaitMs`, the guard gives up so quitting can never hang forever.
const DEFAULT_MAX_WAIT_MS = 5 * 60 * 1000;

function guardQuit(app, { busy, drain, maxWaitMs = DEFAULT_MAX_WAIT_MS, onQuit } = {}) {
  let pending = null;
  let expired = false;
  const quit = onQuit || (() => app.quit());
  const handler = (event) => {
    if (expired) return;
    let isBusy = false;
    try {
      isBusy = !!busy();
    } catch {}
    if (!isBusy) return;
    event.preventDefault();
    if (pending) return;
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        expired = true;
        resolve();
      }, maxWaitMs);
      timer.unref?.();
    });
    pending = Promise.race([
      Promise.resolve()
        .then(drain)
        .catch(() => {}),
      timeout,
    ]).finally(() => {
      clearTimeout(timer);
      pending = null;
      quit();
    });
  };
  app.on("before-quit", handler);
  return handler;
}

// Resolves once `condition()` is false, checking every `intervalMs`.
function waitUntil(condition, intervalMs = 250) {
  return new Promise((resolve) => {
    const check = () => {
      let still = false;
      try {
        still = !!condition();
      } catch {}
      if (!still) resolve();
      else setTimeout(check, intervalMs).unref?.();
    };
    check();
  });
}

module.exports = { guardQuit, waitUntil, DEFAULT_MAX_WAIT_MS };
