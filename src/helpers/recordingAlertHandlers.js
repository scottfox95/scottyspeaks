const { RecordingAlerts } = require("./recordingAlerts");
const debugLogger = require("./debugLogger");
const { i18nMain } = require("./i18nMain");

// Shared by the call and screen recorders. Raising an alert notifies, marks the
// tray, and keeps a banner on the page until the person acknowledges it.
function registerRecordingAlertHandlers({ ipcMain, Notification, windowManager, getTrayManager }) {
  const alerts = new RecordingAlerts({
    t: (key, options) => i18nMain.t(key, options),
    notify: (entry) => {
      debugLogger.warn(
        "Recording alert",
        { source: entry.source, reason: entry.reason },
        "recording"
      );
      if (!Notification?.isSupported?.()) return;
      const notification = new Notification({
        title: entry.title,
        body: entry.body,
        silent: entry.severity !== "error",
      });
      notification.on("click", () => {
        void getTrayManager?.()?.showControlPanelFromTray?.();
      });
      notification.show();
    },
    onChange: (state) => {
      getTrayManager?.()?.setRecordingAlert?.(state.hasError);
      const contents = windowManager?.controlPanelWindow?.webContents;
      if (contents && !contents.isDestroyed()) contents.send("recordingAlerts:change", state);
    },
  });
  const allowed = (event) =>
    windowManager?.controlPanelWindow?.webContents === event.sender &&
    event.senderFrame &&
    event.senderFrame === event.sender.mainFrame;
  ipcMain.handle("recordingAlerts:get", (event) =>
    allowed(event) ? { success: true, data: alerts.state() } : { success: false, error: "Denied" }
  );
  ipcMain.handle("recordingAlerts:acknowledge", (event, args) => {
    if (!allowed(event)) return { success: false, error: "Denied" };
    const key = args && typeof args.key === "string" ? args.key : null;
    return { success: true, data: alerts.acknowledge(key) };
  });
  return alerts;
}

module.exports = { registerRecordingAlertHandlers };
