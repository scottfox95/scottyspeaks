const { app, globalShortcut, BrowserWindow, dialog, ipcMain, session, systemPreferences } = require("electron");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.exit(0);
}

const isLiveWindow = (window) => window && !window.isDestroyed();

// Ensure macOS menus use the proper casing for the app name
if (process.platform === "darwin" && app.getName() !== "ScottySpeaks") {
  app.setName("ScottySpeaks");
}

// Add global error handling for uncaught exceptions
process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
  if (error.code === "EPIPE") {
    return;
  }
  console.error("Error stack:", error.stack);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

// Import helper module classes (but don't instantiate yet - wait for app.whenReady())
const EnvironmentManager = require("./src/helpers/environment");
const WindowManager = require("./src/helpers/windowManager");
const DatabaseManager = require("./src/helpers/database");
const ClipboardManager = require("./src/helpers/clipboard");
const WhisperManager = require("./src/helpers/whisper");
const ParakeetManager = require("./src/helpers/parakeet");
const TrayManager = require("./src/helpers/tray");
const IPCHandlers = require("./src/helpers/ipcHandlers");
const UpdateManager = require("./src/updater");
const GlobeKeyManager = require("./src/helpers/globeKeyManager");
const DevServerManager = require("./src/helpers/devServerManager");
const TextEditMonitor = require("./src/helpers/textEditMonitor");
const { i18nMain, changeLanguage } = require("./src/helpers/i18nMain");

// Manager instances - initialized after app.whenReady()
let debugLogger = null;
let environmentManager = null;
let windowManager = null;
let hotkeyManager = null;
let databaseManager = null;
let clipboardManager = null;
let whisperManager = null;
let parakeetManager = null;
let trayManager = null;
let updateManager = null;
let globeKeyManager = null;
let textEditMonitor = null;
let ipcHandlers = null;
let globeKeyAlertShown = false;

// Set up PATH for production builds to find system tools (whisper.cpp, ffmpeg)
function setupProductionPath() {
  if (process.env.NODE_ENV !== "development") {
    const commonPaths = [
      "/usr/local/bin",
      "/opt/homebrew/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ];

    const currentPath = process.env.PATH || "";
    const pathsToAdd = commonPaths.filter((p) => !currentPath.includes(p));

    if (pathsToAdd.length > 0) {
      process.env.PATH = `${currentPath}:${pathsToAdd.join(":")}`;
    }
  }
}

// Phase 1: Initialize managers + IPC handlers before window content loads
function initializeCoreManagers() {
  setupProductionPath();

  debugLogger = require("./src/helpers/debugLogger");
  debugLogger.ensureFileLogging();

  environmentManager = new EnvironmentManager();
  const uiLanguage = environmentManager.getUiLanguage();
  process.env.UI_LANGUAGE = uiLanguage;
  changeLanguage(uiLanguage);
  debugLogger.refreshLogLevel();

  windowManager = new WindowManager();
  hotkeyManager = windowManager.hotkeyManager;
  databaseManager = new DatabaseManager();
  clipboardManager = new ClipboardManager();
  whisperManager = new WhisperManager();
  parakeetManager = new ParakeetManager();
  updateManager = new UpdateManager();
  textEditMonitor = new TextEditMonitor();
  windowManager.textEditMonitor = textEditMonitor;

  // IPC handlers must be registered before window content loads
  ipcHandlers = new IPCHandlers({
    environmentManager,
    databaseManager,
    clipboardManager,
    whisperManager,
    parakeetManager,
    windowManager,
    updateManager,
    windowsKeyManager: null,
    textEditMonitor,
    whisperCudaManager: null,
    getTrayManager: () => trayManager,
  });
}

// Phase 2: Non-critical setup after windows are visible
function initializeDeferredManagers() {
  clipboardManager.preWarmAccessibility();
  trayManager = new TrayManager();
  globeKeyManager = new GlobeKeyManager();

  globeKeyManager.on("error", (error) => {
    if (globeKeyAlertShown) {
      return;
    }
    globeKeyAlertShown = true;

    const detailLines = [
      error?.message || i18nMain.t("startup.globeHotkey.details.unknown"),
      i18nMain.t("startup.globeHotkey.details.fallback"),
    ];

    if (process.env.NODE_ENV === "development") {
      detailLines.push(i18nMain.t("startup.globeHotkey.details.devHint"));
    } else {
      detailLines.push(i18nMain.t("startup.globeHotkey.details.reinstallHint"));
    }

    dialog.showMessageBox({
      type: "warning",
      title: i18nMain.t("startup.globeHotkey.title"),
      message: i18nMain.t("startup.globeHotkey.message"),
      detail: detailLines.join("\n\n"),
    });
  });
}

// Main application startup
async function startApp() {
  // Request microphone permission on macOS (must be done from main process)
  if (process.platform === "darwin") {
    const micAccess = await systemPreferences.askForMediaAccess("microphone");
    console.log("[ScottySpeaks] Microphone access:", micAccess ? "granted" : "denied");
  }

  // Phase 1: Core managers + IPC handlers before windows
  initializeCoreManagers();

  windowManager.setActivationModeCache(environmentManager.getActivationMode());
  windowManager.setFloatingIconAutoHide(environmentManager.getFloatingIconAutoHide());

  ipcMain.on("activation-mode-changed", (_event, mode) => {
    windowManager.setActivationModeCache(mode);
    environmentManager.saveActivationMode(mode);
  });

  ipcMain.on("floating-icon-auto-hide-changed", (_event, enabled) => {
    windowManager.setFloatingIconAutoHide(enabled);
    environmentManager.saveFloatingIconAutoHide(enabled);
    if (windowManager.mainWindow && !windowManager.mainWindow.isDestroyed()) {
      windowManager.mainWindow.webContents.send("floating-icon-auto-hide-changed", enabled);
    }
  });

  app.setActivationPolicy("regular");

  // In development, wait for Vite dev server to be ready
  if (process.env.NODE_ENV === "development") {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  // Create windows FIRST so the user sees UI as soon as possible
  await windowManager.createMainWindow();
  await windowManager.createControlPanelWindow();

  // Phase 2: Initialize remaining managers after windows are visible
  initializeDeferredManagers();

  // Non-blocking server pre-warming
  const whisperSettings = {
    localTranscriptionProvider: process.env.LOCAL_TRANSCRIPTION_PROVIDER || "",
    whisperModel: process.env.LOCAL_WHISPER_MODEL,
    useCuda: false,
  };
  whisperManager.initializeAtStartup(whisperSettings).catch((err) => {
    debugLogger.debug("Whisper startup init error (non-fatal)", { error: err.message });
  });

  const parakeetSettings = {
    localTranscriptionProvider: process.env.LOCAL_TRANSCRIPTION_PROVIDER || "",
    parakeetModel: process.env.PARAKEET_MODEL,
  };
  parakeetManager.initializeAtStartup(parakeetSettings).catch((err) => {
    debugLogger.debug("Parakeet startup init error (non-fatal)", { error: err.message });
  });

  if (process.env.REASONING_PROVIDER === "local" && process.env.LOCAL_REASONING_MODEL) {
    const modelManager = require("./src/helpers/modelManagerBridge").default;
    modelManager.prewarmServer(process.env.LOCAL_REASONING_MODEL).catch((err) => {
      debugLogger.debug("llama-server pre-warm error (non-fatal)", { error: err.message });
    });
  }

  trayManager.setWindows(windowManager.mainWindow, windowManager.controlPanelWindow);
  trayManager.setWindowManager(windowManager);
  trayManager.setCreateControlPanelCallback(() => windowManager.createControlPanelWindow());
  await trayManager.createTray();

  updateManager.setWindows(windowManager.mainWindow, windowManager.controlPanelWindow);
  updateManager.checkForUpdatesOnStartup();

  // macOS Globe/Fn key handling
  const { isGlobeLikeHotkey } = require("./src/helpers/hotkeyManager");
  let globeKeyDownTime = 0;
  let globeKeyIsRecording = false;
  let globeLastStopTime = 0;
  let globeLastTapTime = 0; // For double-tap detection
  let globeHandsFree = false; // Hands-free mode active
  const MIN_HOLD_DURATION_MS = 150;
  const POST_STOP_COOLDOWN_MS = 300;
  const DOUBLE_TAP_THRESHOLD_MS = 400;

  const setHandsFree = (active) => {
    globeHandsFree = active;
    if (isLiveWindow(windowManager.mainWindow)) {
      windowManager.mainWindow.webContents.send("hands-free-changed", active);
    }
  };

  globeKeyManager.on("globe-down", async () => {
    const currentHotkey = hotkeyManager.getCurrentHotkey && hotkeyManager.getCurrentHotkey();
    const mainWindowLive = isLiveWindow(windowManager.mainWindow);
    debugLogger?.debug("[Globe] globe-down received", {
      currentHotkey,
      mainWindowLive,
      activationMode: mainWindowLive ? windowManager.getActivationMode() : "n/a",
      handsFree: globeHandsFree,
    });

    // Forward to control panel for hotkey capture
    if (isLiveWindow(windowManager.controlPanelWindow)) {
      windowManager.controlPanelWindow.webContents.send("globe-key-pressed");
    }

    // Handle dictation if Globe/Fn is the current hotkey
    if (isGlobeLikeHotkey(currentHotkey)) {
      if (mainWindowLive) {
        if (textEditMonitor) textEditMonitor.captureTargetPid();
        const activationMode = windowManager.getActivationMode();
        if (activationMode === "push") {
          const now = Date.now();

          // If hands-free is active, this tap stops it
          if (globeHandsFree) {
            debugLogger?.debug("[Globe] Stopping hands-free dictation");
            setHandsFree(false);
            windowManager.mainWindow.webContents.send("toggle-dictation");
            globeLastStopTime = now;
            globeLastTapTime = 0;
            return;
          }

          if (now - globeLastStopTime < POST_STOP_COOLDOWN_MS) {
            debugLogger?.debug("[Globe] Ignored — cooldown active");
            return;
          }

          // Double-tap detection: if two taps within threshold, enter hands-free
          if (now - globeLastTapTime < DOUBLE_TAP_THRESHOLD_MS) {
            debugLogger?.debug("[Globe] Double-tap detected — entering hands-free mode");
            globeLastTapTime = 0;
            setHandsFree(true);
            windowManager.showDictationPanel();
            windowManager.mainWindow.webContents.send("toggle-dictation");
            return;
          }

          globeLastTapTime = now;
          windowManager.showDictationPanel();
          const pressTime = now;
          globeKeyDownTime = pressTime;
          globeKeyIsRecording = false;
          setTimeout(async () => {
            if (globeKeyDownTime === pressTime && !globeKeyIsRecording) {
              globeKeyIsRecording = true;
              debugLogger?.debug("[Globe] Starting dictation (push hold)");
              windowManager.sendStartDictation();
            }
          }, MIN_HOLD_DURATION_MS);
        } else {
          windowManager.showDictationPanel();
          windowManager.mainWindow.webContents.send("toggle-dictation");
        }
      } else {
        debugLogger?.debug("[Globe] Ignored — mainWindow not live");
      }
    } else {
      debugLogger?.debug("[Globe] Ignored — hotkey is not GLOBE", { currentHotkey });
    }
  });

  globeKeyManager.on("globe-up", async () => {
    debugLogger?.debug("[Globe] globe-up received", { wasRecording: globeKeyIsRecording, handsFree: globeHandsFree });

    // Forward to control panel for hotkey capture (Fn key released)
    if (isLiveWindow(windowManager.controlPanelWindow)) {
      windowManager.controlPanelWindow.webContents.send("globe-key-released");
    }

    if (hotkeyManager.getCurrentHotkey && isGlobeLikeHotkey(hotkeyManager.getCurrentHotkey())) {
      const activationMode = windowManager.getActivationMode();
      if (activationMode === "push") {
        // In hands-free mode, ignore key release (recording continues)
        if (globeHandsFree) {
          globeKeyDownTime = 0;
          return;
        }
        globeKeyDownTime = 0;
        globeLastStopTime = Date.now();
        if (globeKeyIsRecording) {
          globeKeyIsRecording = false;
          debugLogger?.debug("[Globe] Stopping dictation (push release)");
          windowManager.sendStopDictation();
        }
      }
    }

    // Fn release also stops compound push-to-talk for Fn+F-key hotkeys
    windowManager.handleMacPushModifierUp("fn");
  });

  globeKeyManager.on("modifier-up", (modifier) => {
    if (windowManager?.handleMacPushModifierUp) {
      windowManager.handleMacPushModifierUp(modifier);
    }
  });

  // Right-side single modifier handling (e.g., RightOption as hotkey)
  let rightModDownTime = 0;
  let rightModIsRecording = false;
  let rightModLastStopTime = 0;
  let rightModLastTapTime = 0;
  let rightModHandsFree = false;

  const setRightModHandsFree = (active) => {
    rightModHandsFree = active;
    if (isLiveWindow(windowManager.mainWindow)) {
      windowManager.mainWindow.webContents.send("hands-free-changed", active);
    }
  };

  globeKeyManager.on("right-modifier-down", async (modifier) => {
    const currentHotkey = hotkeyManager.getCurrentHotkey && hotkeyManager.getCurrentHotkey();
    if (currentHotkey !== modifier) return;
    if (!isLiveWindow(windowManager.mainWindow)) return;

    const activationMode = windowManager.getActivationMode();
    if (textEditMonitor) textEditMonitor.captureTargetPid();
    if (activationMode === "push") {
      const now = Date.now();

      // If hands-free is active, this tap stops it
      if (rightModHandsFree) {
        setRightModHandsFree(false);
        windowManager.mainWindow.webContents.send("toggle-dictation");
        rightModLastStopTime = now;
        rightModLastTapTime = 0;
        return;
      }

      if (now - rightModLastStopTime < POST_STOP_COOLDOWN_MS) return;

      // Double-tap detection
      if (now - rightModLastTapTime < DOUBLE_TAP_THRESHOLD_MS) {
        rightModLastTapTime = 0;
        setRightModHandsFree(true);
        windowManager.showDictationPanel();
        windowManager.mainWindow.webContents.send("toggle-dictation");
        return;
      }

      rightModLastTapTime = now;
      windowManager.showDictationPanel();
      const pressTime = now;
      rightModDownTime = pressTime;
      rightModIsRecording = false;
      setTimeout(() => {
        if (rightModDownTime === pressTime && !rightModIsRecording) {
          rightModIsRecording = true;
          windowManager.sendStartDictation();
        }
      }, MIN_HOLD_DURATION_MS);
    } else {
      windowManager.showDictationPanel();
      windowManager.mainWindow.webContents.send("toggle-dictation");
    }
  });

  globeKeyManager.on("right-modifier-up", async (modifier) => {
    const currentHotkey = hotkeyManager.getCurrentHotkey && hotkeyManager.getCurrentHotkey();

    if (currentHotkey === modifier) {
      if (!isLiveWindow(windowManager.mainWindow)) return;

      const activationMode = windowManager.getActivationMode();
      if (activationMode === "push") {
        // In hands-free mode, ignore key release
        if (rightModHandsFree) {
          rightModDownTime = 0;
          return;
        }
        rightModDownTime = 0;
        rightModLastStopTime = Date.now();
        if (rightModIsRecording) {
          rightModIsRecording = false;
          windowManager.sendStopDictation();
        } else {
          windowManager.hideDictationPanel();
        }
      }
    }

    const rightModToBase = {
      RightCommand: "command",
      RightOption: "option",
      RightControl: "control",
      RightShift: "shift",
    };
    const baseMod = rightModToBase[modifier];
    if (baseMod && windowManager?.handleMacPushModifierUp) {
      windowManager.handleMacPushModifierUp(baseMod);
    }
  });

  // Mouse button as secondary trigger (works alongside keyboard hotkey)
  // Stored separately as MOUSE_BUTTON env var (button number, or empty to disable)
  let mouseButtonNumber = parseInt(process.env.MOUSE_BUTTON, 10);
  if (isNaN(mouseButtonNumber)) mouseButtonNumber = -1;

  let mouseDownTime = 0;
  let mouseIsRecording = false;
  let mouseLastStopTime = 0;
  let mouseLastTapTime = 0;
  let mouseHandsFree = false;

  const setMouseHandsFree = (active) => {
    mouseHandsFree = active;
    if (isLiveWindow(windowManager.mainWindow)) {
      windowManager.mainWindow.webContents.send("hands-free-changed", active);
    }
  };

  // IPC to save/load mouse button setting
  ipcMain.handle("get-mouse-button", () => mouseButtonNumber);
  ipcMain.handle("set-mouse-button", async (_event, button) => {
    mouseButtonNumber = typeof button === "number" && button >= 0 ? button : -1;
    process.env.MOUSE_BUTTON = mouseButtonNumber >= 0 ? String(mouseButtonNumber) : "";
    // Tell native listener to suppress this button's OS events
    globeKeyManager.setMouseButtonSuppress(mouseButtonNumber);
    // Reset state when changing
    mouseDownTime = 0;
    mouseIsRecording = false;
    mouseLastStopTime = 0;
    mouseLastTapTime = 0;
    mouseHandsFree = false;
    // Persist to .env
    try {
      const EnvironmentManager = require("./src/helpers/environment");
      const envManager = new EnvironmentManager();
      await envManager.saveAllKeysToEnvFile();
    } catch (err) {
      debugLogger?.warn("[MouseButton] Failed to persist to .env:", err.message);
    }
    return { success: true, button: mouseButtonNumber };
  });

  globeKeyManager.on("mouse-button-down", async (button) => {
    // Forward to control panel for mouse button capture UI (always, regardless of setting)
    if (isLiveWindow(windowManager.controlPanelWindow)) {
      windowManager.controlPanelWindow.webContents.send("mouse-button-pressed", button);
    }

    // Check if this button matches the configured secondary trigger
    if (mouseButtonNumber < 0 || button !== mouseButtonNumber) return;
    if (!isLiveWindow(windowManager.mainWindow)) return;

    const activationMode = windowManager.getActivationMode();
    if (textEditMonitor) textEditMonitor.captureTargetPid();
    if (activationMode === "push") {
      const now = Date.now();

      if (mouseHandsFree) {
        setMouseHandsFree(false);
        windowManager.mainWindow.webContents.send("toggle-dictation");
        mouseLastStopTime = now;
        mouseLastTapTime = 0;
        return;
      }

      if (now - mouseLastStopTime < POST_STOP_COOLDOWN_MS) return;

      if (now - mouseLastTapTime < DOUBLE_TAP_THRESHOLD_MS) {
        mouseLastTapTime = 0;
        setMouseHandsFree(true);
        windowManager.showDictationPanel();
        windowManager.mainWindow.webContents.send("toggle-dictation");
        return;
      }

      mouseLastTapTime = now;
      windowManager.showDictationPanel();
      const pressTime = now;
      mouseDownTime = pressTime;
      mouseIsRecording = false;
      setTimeout(() => {
        if (mouseDownTime === pressTime && !mouseIsRecording) {
          mouseIsRecording = true;
          windowManager.sendStartDictation();
        }
      }, MIN_HOLD_DURATION_MS);
    } else {
      windowManager.showDictationPanel();
      windowManager.mainWindow.webContents.send("toggle-dictation");
    }
  });

  globeKeyManager.on("mouse-button-up", async (button) => {
    if (mouseButtonNumber < 0 || button !== mouseButtonNumber) return;
    if (!isLiveWindow(windowManager.mainWindow)) return;

    const activationMode = windowManager.getActivationMode();
    if (activationMode === "push") {
      if (mouseHandsFree) {
        mouseDownTime = 0;
        return;
      }
      mouseDownTime = 0;
      mouseLastStopTime = Date.now();
      if (mouseIsRecording) {
        mouseIsRecording = false;
        windowManager.sendStopDictation();
      } else {
        windowManager.hideDictationPanel();
      }
    }
  });

  globeKeyManager.start();

  // Tell native listener which mouse button to suppress on startup
  if (mouseButtonNumber >= 0) {
    // Small delay to ensure process is spawned and stdin is ready
    setTimeout(() => {
      globeKeyManager.setMouseButtonSuppress(mouseButtonNumber);
    }, 500);
  }

  // Reset native key state when hotkey changes
  ipcMain.on("hotkey-changed", (_event, _newHotkey) => {
    globeKeyDownTime = 0;
    globeKeyIsRecording = false;
    globeLastStopTime = 0;
    globeLastTapTime = 0;
    globeHandsFree = false;
    rightModDownTime = 0;
    rightModIsRecording = false;
    rightModLastStopTime = 0;
    rightModLastTapTime = 0;
    rightModHandsFree = false;
    mouseDownTime = 0;
    mouseIsRecording = false;
    mouseLastStopTime = 0;
    mouseLastTapTime = 0;
    mouseHandsFree = false;
  });
}

// Listen for usage limit reached from dictation overlay, forward to control panel
ipcMain.on("limit-reached", (_event, data) => {
  if (isLiveWindow(windowManager?.controlPanelWindow)) {
    windowManager.controlPanelWindow.webContents.send("limit-reached", data);
  }
});

// App event handlers
if (gotSingleInstanceLock) {
  app.on("second-instance", async (_event, _commandLine) => {
    await app.whenReady();
    if (!windowManager) {
      return;
    }

    if (isLiveWindow(windowManager.controlPanelWindow)) {
      if (windowManager.controlPanelWindow.isMinimized()) {
        windowManager.controlPanelWindow.restore();
      }
      windowManager.controlPanelWindow.show();
      windowManager.controlPanelWindow.focus();
      if (windowManager.controlPanelWindow.webContents.isCrashed()) {
        windowManager.loadControlPanel();
      }
    } else {
      windowManager.createControlPanelWindow();
    }

    if (isLiveWindow(windowManager.mainWindow)) {
      windowManager.enforceMainWindowOnTop();
    } else {
      windowManager.createMainWindow();
    }
  });

  app
    .whenReady()
    .then(() => {
      startApp().catch((error) => {
        console.error("Failed to start app:", error);
        dialog.showErrorBox(
          i18nMain.t("startup.error.title"),
          i18nMain.t("startup.error.message", { error: error.message })
        );
        app.exit(1);
      });
    });

  app.on("window-all-closed", () => {
    // Don't quit on macOS when all windows are closed
    // The app should stay in the dock/menu bar
  });

  app.on("browser-window-focus", (event, window) => {
    if (windowManager && isLiveWindow(windowManager.mainWindow)) {
      if (window === windowManager.mainWindow) {
        windowManager.enforceMainWindowOnTop();
      }
    }
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      if (windowManager) {
        windowManager.createMainWindow();
        windowManager.createControlPanelWindow();
      }
    } else {
      if (windowManager && isLiveWindow(windowManager.controlPanelWindow)) {
        if (process.platform === "darwin" && app.dock) {
          app.dock.show();
        }
        if (windowManager.controlPanelWindow.isMinimized()) {
          windowManager.controlPanelWindow.restore();
        }
        windowManager.controlPanelWindow.show();
        windowManager.controlPanelWindow.focus();
      } else if (windowManager) {
        windowManager.createControlPanelWindow();
      }

      if (windowManager && isLiveWindow(windowManager.mainWindow)) {
        windowManager.enforceMainWindowOnTop();
      }
    }
  });

  app.on("will-quit", () => {
    if (hotkeyManager) {
      hotkeyManager.unregisterAll();
    } else {
      globalShortcut.unregisterAll();
    }
    if (globeKeyManager) {
      globeKeyManager.stop();
    }
    if (ipcHandlers) {
      ipcHandlers._cleanupTextEditMonitor();
    }
    if (textEditMonitor) {
      textEditMonitor.stopMonitoring();
    }
    if (updateManager) {
      updateManager.cleanup();
    }
    if (whisperManager) {
      whisperManager.stopServer().catch(() => {});
    }
    if (parakeetManager) {
      parakeetManager.stopServer().catch(() => {});
    }
    const modelManager = require("./src/helpers/modelManagerBridge").default;
    modelManager.stopServer().catch(() => {});
  });
}
