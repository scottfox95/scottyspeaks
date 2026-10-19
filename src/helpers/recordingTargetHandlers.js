// Original-target capabilities belong to a live, top-level app renderer.
function trustedTargetSender(event, windowManager) {
  return (
    !!event?.sender &&
    !event.sender.isDestroyed?.() &&
    [windowManager.mainWindow?.webContents, windowManager.controlPanelWindow?.webContents].includes(
      event.sender
    ) &&
    (!event.senderFrame || event.senderFrame === event.sender.mainFrame)
  );
}
function registerRecordingTargetHandlers({ ipcMain, app, windowManager, manager }) {
  const watched = new WeakSet();
  ipcMain.handle("recording-target:capture", async (event) => {
    if (!trustedTargetSender(event, windowManager))
      return { available: false, token: null, reason: "untrusted-sender" };
    const sender = event.sender;
    if (!watched.has(sender)) {
      watched.add(sender);
      for (const name of ["destroyed", "render-process-gone", "did-start-navigation"])
        sender.on(name, () => manager.releaseOwner(sender.id));
    }
    const result = await manager.capture(sender.id);
    if (!trustedTargetSender(event, windowManager)) {
      manager.release(result.token, sender.id);
      return { available: false, token: null, reason: "owner-closed" };
    }
    return result;
  });
  ipcMain.handle("recording-target:release", (event, token) => {
    if (trustedTargetSender(event, windowManager) && typeof token === "string")
      manager.release(token, event.sender.id);
  });
  app.on("before-quit", () => manager.close());
}
module.exports = { trustedTargetSender, registerRecordingTargetHandlers };
