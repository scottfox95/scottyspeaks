const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { LocalSpeech } = require("./localSpeech");
const { trustedTargetSender } = require("./recordingTargetHandlers");
function createLocalSpeech(app) {
  const file = path.join(app.getPath("userData"), "local-speech.json");
  let config = {};
  try {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      if (fs.fstatSync(fd).size <= 4096) config = JSON.parse(fs.readFileSync(fd, "utf8"));
    } finally {
      fs.closeSync(fd);
    }
  } catch {}
  if (!config || typeof config !== "object" || Array.isArray(config)) config = {};
  return new LocalSpeech({
    config,
    persist: (value) => {
      const temp = file + "." + crypto.randomUUID();
      try {
        fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
        fs.renameSync(temp, file);
      } finally {
        try {
          fs.unlinkSync(temp);
        } catch {}
      }
    },
  });
}
function registerSpeechHandlers({ app, ipcMain, windowManager, manager }) {
  const watched = new WeakSet();
  const windows = () => [windowManager.mainWindow, windowManager.controlPanelWindow];
  const publish = (status) => {
    const overlay = windowManager.mainWindow;
    if ((status.speaking || status.starting) && overlay && !overlay.isDestroyed?.())
      overlay.showInactive?.();
    for (const win of windows())
      if (win && !win.isDestroyed?.() && win.webContents && !win.webContents.isDestroyed?.())
        win.webContents.send("speech:change", status);
  };
  manager.on("change", publish);
  function watch(sender) {
    if (watched.has(sender)) return;
    watched.add(sender);
    const release = () => {
      void manager.releaseOwner(sender.id).catch(() => {});
    };
    sender.on("destroyed", release);
    sender.on("render-process-gone", release);
    sender.on("did-frame-navigate", (_event, _url, _code, _description, isMainFrame) => {
      if (isMainFrame) release();
    });
  }
  const actions = {
    status: () => manager.status(),
    voices: () => manager.voices(),
    configure: (_event, patch) => manager.configure(patch),
    speak: (event, args) => {
      if (
        !args ||
        typeof args !== "object" ||
        Array.isArray(args) ||
        Object.keys(args).some((key) => key !== "text")
      )
        throw Error("invalid-speech-text");
      return manager.speak({ text: args.text, owner: event.sender.id, source: "user" });
    },
    stop: async () => {
      await manager.stop();
      return manager.status();
    },
    beginRecording: async (event, kind) => {
      if (!["dictation", "notes"].includes(kind)) throw Error("invalid-recording-owner");
      const token = await manager.beginRecording(event.sender.id, kind);
      if (!trustedTargetSender(event, windowManager)) {
        manager.endRecording(token, event.sender.id);
        throw Error("recording-cancelled");
      }
      return token;
    },
    endRecording: (event, token) => {
      if (typeof token !== "string" || token.length > 100) throw Error("invalid-recording-owner");
      manager.endRecording(token, event.sender.id);
    },
  };
  for (const [name, action] of Object.entries(actions))
    ipcMain.handle("speech:" + name, async (event, argument) => {
      if (!trustedTargetSender(event, windowManager)) throw Error("untrusted-sender");
      watch(event.sender);
      return action(event, argument);
    });
  app.on("before-quit", () => {
    void manager.stop().catch(() => {});
  });
  return manager;
}
module.exports = { createLocalSpeech, registerSpeechHandlers };
