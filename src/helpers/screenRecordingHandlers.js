const path = require("path");
const { ScreenRecorder } = require("./screenRecorder");
const { guardQuit, waitUntil } = require("./quitGuard");

const SCREEN_PRIVACY_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

function registerScreenRecordingHandlers({
  app,
  ipcMain,
  shell,
  systemPreferences,
  powerSaveBlocker,
  windowManager,
  recordingAlerts = null,
}) {
  const directory = path.join(app.getPath("videos"), "SS2 Screen Recordings");
  const binary = app.isPackaged
    ? path.join(process.resourcesPath, "bin", `screen-recorder-${process.arch}`)
    : path.join(__dirname, "../../resources/bin", `screen-recorder-${process.arch}`);
  const recorder = new ScreenRecorder({
    directory,
    binary,
    // Multi-hour recordings must survive the Mac's idle sleep.
    keepAwake: () => {
      const id = powerSaveBlocker.start("prevent-app-suspension");
      return () => powerSaveBlocker.stop(id);
    },
    onAlert: (alert) => recordingAlerts?.raise(alert),
  });
  const permission = () =>
    process.platform === "darwin" ? systemPreferences.getMediaAccessStatus("screen") : "granted";

  const methods = {
    status: () => recorder.status(),
    config: () => ({ available: recorder.available(), directory, permission: permission() }),
    sources: () => recorder.sources(),
    list: () => recorder.list(),
    start: async ({ source, systemAudio, microphone }) => {
      if (!recorder.available()) throw new Error("Screen recording requires macOS 15 or later");
      if (microphone && !(await systemPreferences.askForMediaAccess("microphone")))
        throw Object.assign(new Error("Microphone permission is required"), { code: "microphone" });
      return recorder.start({
        source: source && typeof source === "object" ? source : undefined,
        systemAudio: systemAudio !== false,
        microphone: microphone === true,
      });
    },
    stop: () => recorder.stop({ requestedBy: "user" }),
    open: async ({ name }) => {
      const error = await shell.openPath(recorder.resolve(name));
      if (error) throw new Error(error);
    },
    reveal: ({ name }) => shell.showItemInFolder(recorder.resolve(name)),
    openFolder: async () => {
      require("fs").mkdirSync(directory, { recursive: true });
      await shell.openPath(directory);
    },
    delete: ({ name }) => shell.trashItem(recorder.resolve(name)),
    openPermissionSettings: () => shell.openExternal(SCREEN_PRIVACY_URL),
  };
  for (const [name, method] of Object.entries(methods))
    ipcMain.handle(`screenRecordings:${name}`, async (event, args) => {
      try {
        if (
          windowManager?.controlPanelWindow?.webContents !== event.sender ||
          !event.senderFrame ||
          event.senderFrame !== event.sender.mainFrame
        )
          throw new Error("Screen recording is available only in the control panel");
        return { success: true, data: await method(args || {}) };
      } catch (error) {
        return {
          success: false,
          error: String(error.message || error).slice(0, 700),
          code: error.code || null,
        };
      }
    });

  // Quitting mid-recording, or during the mixdown after a stop, finalizes the
  // file first.
  guardQuit(app, {
    busy: () => {
      const status = recorder.status();
      return status.recording || status.finalizing;
    },
    drain: async () => {
      if (recorder.status().recording) await recorder.stop({ requestedBy: "user" }).catch(() => {});
      await waitUntil(() => {
        const status = recorder.status();
        return status.recording || status.finalizing;
      });
    },
  });
  return { recorder };
}

module.exports = { registerScreenRecordingHandlers };
