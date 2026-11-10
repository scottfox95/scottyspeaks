const { clipboard, systemPreferences } = require("electron");
const { spawn } = require("child_process");
const { killProcess } = require("../utils/process");
const path = require("path");
const fs = require("fs");
const debugLogger = require("./debugLogger");

const ACCESSIBILITY_CHECK_TTL_MS = 5000;

// Used only by the CGEvent/osascript paste below (pasteMacOS), which the live
// path no longer calls: dictation pastes through recordingTargets. Kept as the
// candidate fallback discussed in the 2026-11-09 review, section 6.
const PASTE_DELAYS = { darwin: 120 };
const RESTORE_DELAYS = { darwin: 450 };

class ClipboardManager {
  constructor() {
    this.accessibilityCache = { value: null, expiresAt: 0 };
    this.fastPastePath = null;
    this.fastPasteChecked = false;
  }

  _resolveNativeBinary(binaryName, platform, cacheKeyChecked, cacheKeyPath) {
    if (this[cacheKeyChecked]) {
      return this[cacheKeyPath];
    }
    this[cacheKeyChecked] = true;

    if (process.platform !== platform) {
      return null;
    }

    const candidates = new Set([
      path.join(__dirname, "..", "..", "resources", "bin", binaryName),
      path.join(__dirname, "..", "..", "resources", binaryName),
    ]);

    if (process.resourcesPath) {
      [
        path.join(process.resourcesPath, binaryName),
        path.join(process.resourcesPath, "bin", binaryName),
        path.join(process.resourcesPath, "resources", binaryName),
        path.join(process.resourcesPath, "resources", "bin", binaryName),
        path.join(process.resourcesPath, "app.asar.unpacked", "resources", binaryName),
        path.join(process.resourcesPath, "app.asar.unpacked", "resources", "bin", binaryName),
      ].forEach((candidate) => candidates.add(candidate));
    }

    for (const candidate of candidates) {
      try {
        const stats = fs.statSync(candidate);
        if (stats.isFile()) {
          try {
            fs.accessSync(candidate, fs.constants.X_OK);
          } catch {
            fs.chmodSync(candidate, 0o755);
          }
          this[cacheKeyPath] = candidate;
          return candidate;
        }
      } catch {
        continue;
      }
    }

    return null;
  }

  resolveFastPasteBinary() {
    return this._resolveNativeBinary(
      "macos-fast-paste",
      "darwin",
      "fastPasteChecked",
      "fastPastePath"
    );
  }

  safeLog(...args) {
    if (process.env.NODE_ENV === "development") {
      try {
        console.log(...args);
      } catch (error) {
        // Silently ignore EPIPE errors in logging
        if (error.code !== "EPIPE") {
          process.stderr.write(`Log error: ${error.message}\n`);
        }
      }
    }
  }

  async pasteText(text, options = {}) {
    if (process.platform === "darwin") {
      const started = Date.now();
      const result = this.recordingTargets
        ? await this.recordingTargets.paste(options.targetToken, options.webContents?.id, text)
        : { success: false, reason: "helper-unavailable" };
      const outcome = result.success
        ? { ...result, manualCopy: false }
        : // The helper never posts ⌘V after a refusal, so the transcript can't
          // also land in another field. Leave it on the clipboard for a manual ⌘V.
          { ...result, manualCopy: true, onClipboard: this.leaveOnClipboard(text) };
      this.recordPasteOutcome({
        ...outcome,
        source: options.source,
        ms: Date.now() - started,
        chars: text.length,
      });
      return outcome;
    }
    // SS2 is macOS-only; other platforms never had a working helper here.
    return {
      success: false,
      manualCopy: true,
      reason: "unsupported-platform",
      onClipboard: this.leaveOnClipboard(text),
    };
  }

  recordPasteOutcome(outcome) {
    try {
      const entry = this.pasteOutcomes?.record(outcome);
      if (entry && !entry.ok)
        debugLogger.warn(
          "Paste refused",
          {
            app: entry.app,
            role: entry.role,
            reason: entry.reason,
            onClipboard: entry.onClipboard,
          },
          "clipboard"
        );
    } catch {}
  }

  /** Puts a transcript on the clipboard after a failed paste; true when written. */
  leaveOnClipboard(text) {
    if (typeof text !== "string" || !text) return false;
    try {
      clipboard.writeText(text);
      return true;
    } catch (error) {
      debugLogger.warn?.("Could not leave transcript on clipboard", { error: error?.message }, "clipboard");
      return false;
    }
  }

  async pasteMacOS(originalClipboard, options = {}) {
    const fastPasteBinary = this.resolveFastPasteBinary();
    const useFastPaste = !!fastPasteBinary;
    const pasteDelay = options.fromStreaming ? (useFastPaste ? 15 : 50) : PASTE_DELAYS.darwin;

    return new Promise((resolve, reject) => {
      setTimeout(() => {
        const pasteProcess = useFastPaste
          ? spawn(fastPasteBinary)
          : spawn("osascript", [
              "-e",
              'tell application "System Events" to key code 9 using command down',
            ]);

        let errorOutput = "";
        let hasTimedOut = false;

        pasteProcess.stderr.on("data", (data) => {
          errorOutput += data.toString();
        });

        pasteProcess.on("close", (code) => {
          if (hasTimedOut) return;
          clearTimeout(timeoutId);
          pasteProcess.removeAllListeners();

          if (code === 0) {
            this.safeLog(`Text pasted successfully via ${useFastPaste ? "CGEvent" : "osascript"}`);
            setTimeout(() => {
              clipboard.writeText(originalClipboard);
            }, RESTORE_DELAYS.darwin);
            resolve();
          } else if (useFastPaste) {
            this.safeLog(
              code === 2
                ? "CGEvent binary lacks accessibility trust, falling back to osascript"
                : `CGEvent paste failed (code ${code}), falling back to osascript`
            );
            this.fastPasteChecked = true;
            this.fastPastePath = null;
            this.pasteMacOSWithOsascript(originalClipboard).then(resolve).catch(reject);
          } else {
            this.accessibilityCache = { value: null, expiresAt: 0 };
            const errorMsg = `Paste failed (code ${code}). Text is copied to clipboard - please paste manually with Cmd+V.`;
            reject(new Error(errorMsg));
          }
        });

        pasteProcess.on("error", (error) => {
          if (hasTimedOut) return;
          clearTimeout(timeoutId);
          pasteProcess.removeAllListeners();

          if (useFastPaste) {
            this.safeLog("CGEvent paste error, falling back to osascript");
            this.fastPasteChecked = true;
            this.fastPastePath = null;
            this.pasteMacOSWithOsascript(originalClipboard).then(resolve).catch(reject);
          } else {
            const errorMsg = `Paste command failed: ${error.message}. Text is copied to clipboard - please paste manually with Cmd+V.`;
            reject(new Error(errorMsg));
          }
        });

        const timeoutId = setTimeout(() => {
          hasTimedOut = true;
          killProcess(pasteProcess, "SIGKILL");
          pasteProcess.removeAllListeners();
          const errorMsg =
            "Paste operation timed out. Text is copied to clipboard - please paste manually with Cmd+V.";
          reject(new Error(errorMsg));
        }, 3000);
      }, pasteDelay);
    });
  }

  async pasteMacOSWithOsascript(originalClipboard) {
    return new Promise((resolve, reject) => {
      const pasteProcess = spawn("osascript", [
        "-e",
        'tell application "System Events" to key code 9 using command down',
      ]);

      let hasTimedOut = false;

      pasteProcess.on("close", (code) => {
        if (hasTimedOut) return;
        clearTimeout(timeoutId);
        pasteProcess.removeAllListeners();

        if (code === 0) {
          this.safeLog("Text pasted successfully via osascript fallback");
          setTimeout(() => {
            clipboard.writeText(originalClipboard);
          }, RESTORE_DELAYS.darwin);
          resolve();
        } else {
          this.accessibilityCache = { value: null, expiresAt: 0 };
          const errorMsg = `Paste failed (code ${code}). Text is copied to clipboard - please paste manually with Cmd+V.`;
          reject(new Error(errorMsg));
        }
      });

      pasteProcess.on("error", (error) => {
        if (hasTimedOut) return;
        clearTimeout(timeoutId);
        pasteProcess.removeAllListeners();
        const errorMsg = `Paste command failed: ${error.message}. Text is copied to clipboard - please paste manually with Cmd+V.`;
        reject(new Error(errorMsg));
      });

      const timeoutId = setTimeout(() => {
        hasTimedOut = true;
        killProcess(pasteProcess, "SIGKILL");
        pasteProcess.removeAllListeners();
        reject(
          new Error(
            "Paste operation timed out. Text is copied to clipboard - please paste manually with Cmd+V."
          )
        );
      }, 3000);
    });
  }

  async checkAccessibilityPermissions() {
    if (process.platform !== "darwin") return true;

    const now = Date.now();
    if (now < this.accessibilityCache.expiresAt && this.accessibilityCache.value !== null) {
      return this.accessibilityCache.value;
    }

    const allowed = systemPreferences.isTrustedAccessibilityClient(false);
    this.accessibilityCache = {
      value: allowed,
      expiresAt: Date.now() + ACCESSIBILITY_CHECK_TTL_MS,
    };

    if (!allowed && !this._accessibilityDialogShown) {
      // Only interrupt with the blocking dialog once per app session; after
      // that the renderer's soft "press Cmd+V" toast carries the message.
      this._accessibilityDialogShown = true;
      this.showAccessibilityDialog("not allowed assistive access");
    }

    return allowed;
  }

  showAccessibilityDialog(testError) {
    const isStuckPermission =
      testError.includes("not allowed assistive access") ||
      testError.includes("(-1719)") ||
      testError.includes("(-25006)");

    let dialogMessage;
    if (isStuckPermission) {
      dialogMessage = `🔒 ScottySpeaks needs Accessibility permissions, but it looks like you may have OLD PERMISSIONS from a previous version.

❗ COMMON ISSUE: If you've rebuilt/reinstalled ScottySpeaks, the old permissions may be "stuck" and preventing new ones.

🔧 To fix this:
1. Open System Settings → Privacy & Security → Accessibility
2. Look for ANY old "ScottySpeaks" entries and REMOVE them (click the - button)
3. Also remove any entries that say "Electron" or have unclear names
4. Click the + button and manually add the NEW ScottySpeaks app
5. Make sure the checkbox is enabled
6. Restart ScottySpeaks

⚠️ This is especially common during development when rebuilding the app.

📝 Without this permission, text will only copy to clipboard (no automatic pasting).

Would you like to open System Settings now?`;
    } else {
      dialogMessage = `🔒 ScottySpeaks needs Accessibility permissions to paste text into other applications.

📋 Current status: Clipboard copy works, but pasting (Cmd+V simulation) fails.

🔧 To fix this:
1. Open System Settings (or System Preferences on older macOS)
2. Go to Privacy & Security → Accessibility
3. Click the lock icon and enter your password
4. Add ScottySpeaks to the list and check the box
5. Restart ScottySpeaks

⚠️ Without this permission, dictated text will only be copied to clipboard but won't paste automatically.

💡 In production builds, this permission is required for full functionality.

Would you like to open System Settings now?`;
    }

    const permissionDialog = spawn("osascript", [
      "-e",
      `display dialog "${dialogMessage}" buttons {"Cancel", "Open System Settings"} default button "Open System Settings"`,
    ]);

    permissionDialog.on("close", (dialogCode) => {
      if (dialogCode === 0) {
        this.openSystemSettings();
      }
    });

    permissionDialog.on("error", () => {});
  }

  openSystemSettings() {
    const settingsCommands = [
      ["open", ["x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"]],
      ["open", ["-b", "com.apple.systempreferences"]],
      ["open", ["/System/Library/PreferencePanes/Security.prefPane"]],
    ];

    let commandIndex = 0;
    const tryNextCommand = () => {
      if (commandIndex < settingsCommands.length) {
        const [cmd, args] = settingsCommands[commandIndex];
        const settingsProcess = spawn(cmd, args);

        settingsProcess.on("error", (error) => {
          commandIndex++;
          tryNextCommand();
        });

        settingsProcess.on("close", (settingsCode) => {
          if (settingsCode !== 0) {
            commandIndex++;
            tryNextCommand();
          }
        });
      } else {
        spawn("open", ["-a", "System Preferences"]).on("error", () => {
          spawn("open", ["-a", "System Settings"]).on("error", () => {});
        });
      }
    };

    tryNextCommand();
  }

  preWarmAccessibility() {
    if (process.platform !== "darwin") return;
    this.checkAccessibilityPermissions().catch(() => {});
    this.resolveFastPasteBinary();
  }

  // Replace only a verified previous paste in the recording's original field.
  // Mismatches retain the result for explicit manual Copy; never append blindly.
  async replaceLastPaste(newText, expectedText, options = {}) {
    if (process.platform !== "darwin" || !this.recordingTargets)
      return { success: false, replaced: false, manualCopy: true, reason: "helper-unavailable" };
    const result = await this.recordingTargets.paste(options.targetToken, options.webContents?.id, newText, expectedText);
    return { ...result, replaced: result.success, manualCopy: !result.success };
  }

  // Reading the explicitly selected AX text avoids modifying the clipboard at all.
  async captureSelection(token, owner) {
    return this.recordingTargets?.selection(token, owner) || { text: null, error: "helper-unavailable" };
  }

  async readClipboard() {
    return clipboard.readText();
  }

  async writeClipboard(text) {
    clipboard.writeText(text);
    return { success: true };
  }

  checkPasteTools() {
    if (process.platform === "darwin") {
      const fastPaste = this.resolveFastPasteBinary();
      return {
        platform: "darwin",
        available: true,
        method: fastPaste ? "cgevent" : "applescript",
        requiresPermission: true,
        tools: [],
      };
    }
    return {
      platform: process.platform,
      available: false,
      method: null,
      requiresPermission: false,
      tools: [],
    };
  }
}

module.exports = ClipboardManager;
