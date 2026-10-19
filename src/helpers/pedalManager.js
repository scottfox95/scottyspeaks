const { EventEmitter } = require("events");
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const debugLogger = require("./debugLogger");

/**
 * Elgato Stream Deck Pedal integration.
 *
 * Exposes the pedal's three footswitches as dictation controls, fully
 * independent of the keyboard hotkey (both work at the same time).
 *
 * Default mapping (left → right):
 *   switch 0: "toggle"  — tap once to start, tap again to stop
 *   switch 1: "hold"    — records only while held (push-to-talk)
 *   switch 2: "command" — hold and speak an instruction; the AI applies it
 *                          to the selected text (or your last dictation)
 *
 * Actions: "toggle" | "hold" | "command" | "off"
 *
 * Emits:
 *   "pedal-action"  { index, action, phase: "down" | "up" }
 *   "connected"     { model, serialNumber }
 *   "disconnected"
 */

const VALID_ACTIONS = new Set(["toggle", "hold", "command", "off"]);
const DEFAULT_CONFIG = {
  enabled: true,
  mappings: { 0: "toggle", 1: "hold", 2: "command" },
};
const SCAN_INTERVAL_MS = 4000;

class PedalManager extends EventEmitter {
  constructor() {
    super();
    this.deck = null;
    this.connected = false;
    this.deviceInfo = null;
    this.config = { ...DEFAULT_CONFIG, mappings: { ...DEFAULT_CONFIG.mappings } };
    this._scanTimer = null;
    this._lib = undefined;
    this._configPath = null;
    this._opening = false;
    this.blocked = false; // another app holds an exclusive lock on the pedal
    this.blockingApp = null;
    this.devicePresent = false; // pedal is plugged in, openable or not
  }

  _loadLib() {
    if (this._lib !== undefined) return this._lib;
    try {
      this._lib = require("@elgato-stream-deck/node");
    } catch (error) {
      debugLogger.warn(
        "Stream Deck library unavailable — pedal support disabled",
        { error: error.message },
        "pedal"
      );
      this._lib = null;
    }
    return this._lib;
  }

  init(userDataPath) {
    this._configPath = path.join(userDataPath, "pedal-config.json");
    this._loadConfig();
    if (!this._loadLib()) return;
    this._scan();
    this._scanTimer = setInterval(() => {
      if (!this.connected && this.config.enabled) this._scan();
    }, SCAN_INTERVAL_MS);
    this._scanTimer.unref?.();
  }

  _loadConfig() {
    try {
      const raw = JSON.parse(fs.readFileSync(this._configPath, "utf8"));
      if (typeof raw.enabled === "boolean") this.config.enabled = raw.enabled;
      if (raw.mappings && typeof raw.mappings === "object") {
        for (const key of [0, 1, 2]) {
          const action = raw.mappings[key];
          if (VALID_ACTIONS.has(action)) this.config.mappings[key] = action;
        }
      }
    } catch {
      // No config yet — defaults apply
    }
  }

  _saveConfig() {
    try {
      fs.writeFileSync(this._configPath, JSON.stringify(this.config, null, 2));
    } catch (error) {
      debugLogger.warn("Failed to persist pedal config", { error: error.message }, "pedal");
    }
  }

  /**
   * Names of apps that take an *exclusive* HID lock on the pedal. Elgato's
   * own software does this, which silently blocks us — reporting merely
   * "not connected" sends the user hunting for a hardware fault.
   */
  _findBlockingApp() {
    const candidates = [
      { process: "Elgato Stream Deck", name: "Elgato Stream Deck" },
      { process: "Stream Deck", name: "Stream Deck" },
    ];
    for (const candidate of candidates) {
      try {
        const result = spawnSync("pgrep", ["-f", `${candidate.process}.app/Contents/MacOS`], {
          encoding: "utf8",
        });
        if (result.status === 0 && result.stdout.trim()) return candidate.name;
      } catch {}
    }
    return null;
  }

  /** Asks the blocking app to quit so the pedal becomes available. */
  quitBlockingApp() {
    const app = this.blockingApp || this._findBlockingApp();
    if (!app) return { success: false, error: "no-blocking-app" };
    try {
      spawnSync("osascript", ["-e", `quit app "${app}"`], { timeout: 5000 });
      // Give it a moment to release the device, then try again
      setTimeout(() => this._scan(), 1200);
      return { success: true, app };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async _scan() {
    if (this.connected || this._opening || !this.config.enabled) return;
    const lib = this._loadLib();
    if (!lib) return;
    this._opening = true;
    const wasBlocked = this.blocked;
    try {
      const devices = await lib.listStreamDecks();
      const pedal = devices.find((d) => d.model === "pedal");
      if (!pedal) {
        this.blocked = false;
        this.blockingApp = null;
        this.devicePresent = false;
        return;
      }
      this.devicePresent = true;

      const deck = await lib.openStreamDeck(pedal.path);
      this.deck = deck;
      this.connected = true;
      this.deviceInfo = { model: pedal.model, serialNumber: pedal.serialNumber };

      deck.on("down", (control) => this._handleSwitch(control, "down"));
      deck.on("up", (control) => this._handleSwitch(control, "up"));
      deck.on("error", (error) => {
        debugLogger.info("Pedal disconnected", { error: String(error?.message || error) }, "pedal");
        this._teardown();
      });

      this.blocked = false;
      this.blockingApp = null;

      debugLogger.info("Stream Deck Pedal connected", this.deviceInfo, "pedal");
      this.emit("connected", this.deviceInfo);
    } catch (error) {
      const isExclusiveLock = /exclusive access|already open/i.test(error.message || "");
      if (isExclusiveLock) {
        this.blocked = true;
        this.blockingApp = this._findBlockingApp();
        if (!wasBlocked) {
          debugLogger.info(
            "Pedal is held by another app",
            { blockingApp: this.blockingApp, error: error.message },
            "pedal"
          );
          this.emit("disconnected");
        }
      } else {
        debugLogger.debug("Pedal scan failed", { error: error.message }, "pedal");
      }
    } finally {
      this._opening = false;
    }
  }

  _handleSwitch(control, phase) {
    const index = typeof control === "number" ? control : control?.index;
    if (index === undefined || index === null) return;
    const action = this.config.mappings[index] || "off";
    debugLogger.debug("Pedal switch", { index, action, phase }, "pedal");
    if (action === "off" || !this.config.enabled) return;
    this.emit("pedal-action", { index, action, phase });
  }

  _teardown() {
    if (this.deck) {
      try {
        this.deck.close();
      } catch {}
    }
    this.deck = null;
    this.connected = false;
    this.deviceInfo = null;
    this.emit("disconnected");
  }

  getStatus() {
    return {
      supported: !!this._loadLib(),
      connected: this.connected,
      device: this.deviceInfo,
      config: this.config,
      blocked: this.blocked,
      blockingApp: this.blockingApp,
      devicePresent: this.devicePresent,
    };
  }

  setConfig(partial = {}) {
    if (typeof partial.enabled === "boolean") {
      this.config.enabled = partial.enabled;
      if (!partial.enabled && this.connected) {
        this._teardown();
      } else if (partial.enabled && !this.connected) {
        this._scan();
      }
    }
    if (partial.mappings && typeof partial.mappings === "object") {
      for (const key of [0, 1, 2]) {
        const action = partial.mappings[key];
        if (VALID_ACTIONS.has(action)) this.config.mappings[key] = action;
      }
    }
    this._saveConfig();
    return this.getStatus();
  }

  destroy() {
    if (this._scanTimer) clearInterval(this._scanTimer);
    this._teardown();
    this.removeAllListeners();
  }
}

module.exports = PedalManager;
