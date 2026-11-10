const crypto = require("crypto");

// Every recording stop or failure the person did not ask for ends up here. It
// is shown three ways so it can't be missed: a macOS notification, an error
// state on the menu-bar icon until acknowledged, and a banner on the page that
// stays until dismissed. Messages describe what happened; they never carry
// audio content, transcript text or secrets.
const MAX_ALERTS = 20;

// English text lives in src/locales/*/translation.json under recordingAlerts;
// the defaults here only keep the helper usable without i18n (tests).
const DEFAULTS = {
  autoStopWarning: [
    "Call recording stops soon",
    "No speech detected. Recording stops in {{seconds}} seconds. Open SS2 to keep recording.",
  ],
  autoStopped: [
    "Call recording stopped",
    "SS2 heard no speech for {{minutes}} minutes and stopped the recording. The audio is saved.",
  ],
  stalledCall: [
    "Call recording isn't saving",
    "The recording file stopped growing. Check SS2 now; you may need to start a new recording.",
  ],
  stalledScreen: [
    "Screen recording isn't saving",
    "The recording file stopped growing. Check SS2 now; you may need to start a new recording.",
  ],
  fellBack: [
    "Recording the whole screen instead",
    "The chosen window wasn't available, so SS2 is recording the display it was on.",
  ],
  limit: ["Call recording stopped", "The recording reached the 6-hour limit. The audio is saved."],
  disk: [
    "Screen recording stopped",
    "Less than 1 GB of disk space is left. The recording was saved.",
  ],
  diskCall: [
    "Call recording stopped",
    "Less than 1 GB of disk space is left. The audio recorded so far is saved.",
  ],
  startFailedCall: ["Call recording didn't start", "{{message}}"],
  startFailedScreen: ["Screen recording didn't start", "{{message}}"],
  failedCall: ["Call recording stopped unexpectedly", "{{message}}"],
  failedScreen: ["Screen recording stopped unexpectedly", "{{message}}"],
};

function interpolate(text, vars) {
  return text.replace(/\{\{(\w+)\}\}/g, (_, name) => String(vars[name] ?? ""));
}

function describe(alert, t) {
  const call = alert.source === "call";
  const suffix = call ? "Call" : "Screen";
  const key = ["stalled", "startFailed", "failed"].includes(alert.reason)
    ? `${alert.reason}${suffix}`
    : alert.reason === "disk" && call
      ? "diskCall"
      : DEFAULTS[alert.reason]
      ? alert.reason
      : `failed${suffix}`;
  const vars = {
    seconds: alert.seconds || 30,
    minutes: Math.max(1, Math.round((alert.seconds || 0) / 60)),
    message:
      alert.message ||
      (alert.reason === "startFailed"
        ? "The recorder exited before it started."
        : "The recorder exited. Anything captured so far is saved."),
  };
  const [title, body] = DEFAULTS[key];
  const translate = (part, fallback) =>
    t
      ? t(`recordingAlerts.${key}.${part}`, { ...vars, defaultValue: fallback })
      : interpolate(fallback, vars);
  return { title: translate("title", title), body: translate("body", body) };
}

class RecordingAlerts {
  constructor({ notify, onChange, now = Date.now, t = null } = {}) {
    this.t = t;
    this.notify = notify || (() => {});
    this.onChange = onChange || (() => {});
    this.now = now;
    this.alerts = [];
  }
  // Warnings and notices are informational; everything else is an error that
  // puts the tray into its error state.
  static severity(reason) {
    return reason === "autoStopWarning" || reason === "fellBack" ? "warning" : "error";
  }
  raise(alert) {
    const text = describe(alert, this.t);
    const entry = {
      key: crypto.randomUUID(),
      source: alert.source,
      id: alert.id || null,
      reason: alert.reason,
      severity: RecordingAlerts.severity(alert.reason),
      title: text.title,
      body: text.body,
      at: this.now(),
    };
    // One warning per recording at a time; a later warning replaces it.
    if (entry.reason === "autoStopWarning")
      this.alerts = this.alerts.filter(
        (item) => !(item.reason === "autoStopWarning" && item.source === entry.source)
      );
    // The auto-stop itself supersedes its warning.
    if (entry.source === "call" && entry.reason !== "autoStopWarning")
      this.alerts = this.alerts.filter((item) => item.reason !== "autoStopWarning");
    this.alerts = [entry, ...this.alerts].slice(0, MAX_ALERTS);
    try {
      this.notify(entry);
    } catch {}
    this.onChange(this.state());
    return entry;
  }
  // Clears warnings that no longer apply (speech resumed, "Keep recording").
  clearWarnings(source) {
    const before = this.alerts.length;
    this.alerts = this.alerts.filter(
      (item) => !(item.reason === "autoStopWarning" && (!source || item.source === source))
    );
    if (this.alerts.length !== before) this.onChange(this.state());
  }
  acknowledge(key) {
    this.alerts = key ? this.alerts.filter((item) => item.key !== key) : [];
    this.onChange(this.state());
    return this.state();
  }
  state() {
    return {
      alerts: this.alerts,
      hasError: this.alerts.some((item) => item.severity === "error"),
    };
  }
}

module.exports = { RecordingAlerts, describe };
