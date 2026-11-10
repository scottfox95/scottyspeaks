// "Paste last dictation": a global hotkey that pastes the most recent
// dictation at the current focus. It is the one-keystroke recovery when a
// paste was refused, or when you spoke first and clicked into the field after.
//
// Default ⌃⌥V (Control+Option+V): free in macOS and in the common apps, and
// unlike ⌘⇧V it doesn't collide with "Paste and Match Style".
const DEFAULT_PASTE_LAST_HOTKEY = "Control+Alt+V";
const ENV_KEY = "PASTE_LAST_HOTKEY";

class PasteLastManager {
  constructor({
    globalShortcut,
    recordingTargets,
    clipboardManager,
    getLastText,
    getOwner,
    notify,
    env = process.env,
  }) {
    this.globalShortcut = globalShortcut;
    this.recordingTargets = recordingTargets;
    this.clipboardManager = clipboardManager;
    this.getLastText = getLastText;
    this.getOwner = getOwner;
    this.notify = notify || (() => {});
    this.env = env;
    this.registered = null;
    this.running = false;
  }

  getHotkey() {
    const value = this.env[ENV_KEY];
    if (value === undefined || value === "") return DEFAULT_PASTE_LAST_HOTKEY;
    return value === "off" ? "" : value;
  }

  /** Registers `hotkey` ("" disables). Returns { success, hotkey, error? }. */
  register(hotkey = this.getHotkey()) {
    if (this.registered) {
      try {
        this.globalShortcut.unregister(this.registered);
      } catch {}
      this.registered = null;
    }
    if (!hotkey) return { success: true, hotkey: "" };
    let ok = false;
    try {
      ok = this.globalShortcut.register(hotkey, () => void this.run());
    } catch {}
    if (!ok) return { success: false, hotkey, error: "unavailable" };
    this.registered = hotkey;
    return { success: true, hotkey };
  }

  set(hotkey) {
    const result = this.register(hotkey);
    if (result.success) this.env[ENV_KEY] = hotkey || "off";
    else this.register(this.getHotkey());
    return result;
  }

  async run() {
    if (this.running) return { success: false, reason: "paste-busy" };
    this.running = true;
    try {
      const text = await this.getLastText();
      if (typeof text !== "string" || !text.trim()) {
        this.notify({ ok: false, reason: "nothing-to-paste" });
        return { success: false, reason: "nothing-to-paste" };
      }
      const owner = this.getOwner();
      if (!this.recordingTargets || !owner) {
        const onClipboard = this.clipboardManager.leaveOnClipboard(text);
        this.notify({ ok: false, reason: "helper-unavailable", onClipboard });
        return { success: false, reason: "helper-unavailable", onClipboard };
      }
      const started = Date.now();
      const target = await this.recordingTargets.capture(owner);
      let result;
      if (!target.token) {
        result = { success: false, reason: target.reason || "unverifiable-target" };
      } else {
        result = await this.recordingTargets.paste(target.token, owner, text);
      }
      if (!result.success) result.onClipboard = this.clipboardManager.leaveOnClipboard(text);
      this.clipboardManager.recordPasteOutcome?.({
        ...result,
        appName: result.appName || target.appName,
        bundleId: result.bundleId || target.bundleId,
        role: result.role || target.role,
        source: "paste-last",
        ms: Date.now() - started,
        chars: text.length,
      });
      if (!result.success)
        this.notify({ ok: false, reason: result.reason, onClipboard: result.onClipboard });
      return result;
    } finally {
      this.running = false;
    }
  }

  dispose() {
    this.register("");
  }
}

module.exports = { PasteLastManager, DEFAULT_PASTE_LAST_HOTKEY, ENV_KEY };
