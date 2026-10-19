const test = require("node:test"),
  assert = require("node:assert/strict"),
  { EventEmitter } = require("node:events");
const { LocalSpeech } = require("../src/helpers/localSpeech");
const { registerSpeechHandlers } = require("../src/helpers/speechHandlers");
function setup() {
  let shown = 0;
  const handlers = {},
    app = new EventEmitter(),
    sender = new EventEmitter();
  sender.id = 1;
  sender.mainFrame = {};
  sender.send = () => {};
  const other = new EventEmitter();
  other.id = 2;
  other.mainFrame = {};
  other.send = () => {};
  const manager = new LocalSpeech({ platform: "linux" });
  registerSpeechHandlers({
    app,
    ipcMain: { handle: (k, v) => (handlers[k] = v) },
    windowManager: {
      mainWindow: { webContents: sender, showInactive: () => shown++ },
      controlPanelWindow: { webContents: other },
    },
    manager,
  });
  const event = { sender, senderFrame: sender.mainFrame };
  return { handlers, manager, sender, other, event, app, shown: () => shown };
}
test("speech IPC rejects unknown renderer/subframe and ownership spoofing", async () => {
  const { handlers, manager, event, other } = setup();
  await assert.rejects(
    handlers["speech:beginRecording"]({ ...event, senderFrame: {} }, "dictation"),
    /untrusted/
  );
  const token = await handlers["speech:beginRecording"](event, "dictation");
  await handlers["speech:endRecording"]({ sender: other, senderFrame: other.mainFrame }, token);
  assert.equal(manager.status().recording, true);
  await handlers["speech:endRecording"](event, token);
  assert.equal(manager.status().recording, false);
  await assert.rejects(
    handlers["speech:speak"](event, { text: "synthetic", source: "agent" }),
    /invalid/
  );
});
test("recording owner survives navigation start but ends on main-frame committed navigation or crash", async () => {
  const { handlers, manager, event, sender } = setup();
  await handlers["speech:beginRecording"](event, "notes");
  sender.emit("did-start-navigation");
  assert.equal(manager.status().recording, true);
  sender.emit("did-frame-navigate", {}, "file:///app", 200, "OK", false);
  assert.equal(manager.status().recording, true);
  sender.emit("did-frame-navigate", {}, "file:///app", 200, "OK", true);
  assert.equal(manager.status().recording, false);
  await handlers["speech:beginRecording"](event, "dictation");
  sender.emit("render-process-gone");
  assert.equal(manager.status().recording, false);
});

test("speech publication shows the overlay without activating it", () => {
  const h = setup();
  h.manager.starting = {};
  h.manager.changed();
  assert.equal(h.shown(), 1);
  h.manager.starting = null;
  h.manager.changed();
  assert.equal(h.shown(), 1);
});
test("corrupt persisted speech config falls back without blocking application startup", (t) => {
  const fs = require("fs"),
    os = require("os"),
    path = require("path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ss2-speech-config-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "local-speech.json"), "null");
  const { createLocalSpeech } = require("../src/helpers/speechHandlers");
  const speech = createLocalSpeech({ getPath: () => root });
  assert.equal(speech.config.agentEnabled, false);
  assert.equal(speech.config.rate, 180);
});
test("destroyed overlay cannot break speech status publication or other windows", () => {
  const app = new EventEmitter(),
    manager = new LocalSpeech({ platform: "linux" });
  let sent = 0;
  const windowManager = {
    mainWindow: {
      isDestroyed: () => true,
      showInactive: () => {
        throw Error("destroyed window");
      },
    },
    controlPanelWindow: { webContents: { send: () => sent++ } },
  };
  registerSpeechHandlers({ app, ipcMain: { handle() {} }, windowManager, manager });
  manager.starting = {};
  assert.doesNotThrow(() => manager.changed());
  assert.equal(sent, 1);
});
