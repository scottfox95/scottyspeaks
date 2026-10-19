const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");

function loadIpcHandlers() {
  const handlers = new Map();
  const listeners = new Map();
  const electron = {
    ipcMain: {
      handle: (name, handler) => handlers.set(name, handler),
      on: (name, handler) => listeners.set(name, handler),
    },
    app: { getVersion: () => "test", getPath: () => "/tmp" },
    shell: {},
    BrowserWindow: { getAllWindows: () => [] },
  };

  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "electron") return electron;
    if (request === "./i18nMain" && parent?.filename.endsWith("ipcHandlers.js")) {
      return { i18nMain: { t: (key) => key }, changeLanguage: () => {} };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  const filename = path.resolve(__dirname, "../src/helpers/ipcHandlers.js");
  delete require.cache[filename];
  let IPCHandlers;
  try {
    IPCHandlers = require(filename);
  } finally {
    Module._load = originalLoad;
  }

  return { IPCHandlers, handlers, listeners };
}

test("paste-text applies canonical dictionary spelling at the clipboard boundary", async () => {
  const { IPCHandlers, handlers } = loadIpcHandlers();
  const sender = { id: 1, mainFrame: {} };
  let pastedText;
  let monitoredText;
  const textEditMonitor = new EventEmitter();
  textEditMonitor.lastTargetPid = 42;
  textEditMonitor.startMonitoring = (text) => {
    monitoredText = text;
  };
  const instance = new IPCHandlers({
    environmentManager: {},
    databaseManager: { getDictionary: () => ["Aravo"] },
    clipboardManager: {
      pasteText: async (text) => {
        pastedText = text;
        return { success: true };
      },
    },
    whisperManager: {},
    parakeetManager: {},
    windowManager: { mainWindow: null, controlPanelWindow: { webContents: sender } },
    updateManager: {},
    windowsKeyManager: {},
    textEditMonitor,
  });

  const result = await handlers.get("paste-text")(
    { sender, senderFrame: sender.mainFrame },
    "I work at aravo, not aravon.",
    {}
  );

  assert.deepEqual(result, { success: true, text: "I work at Aravo, not aravon." });
  assert.equal(pastedText, "I work at Aravo, not aravon.");
  await new Promise((resolve) => setTimeout(resolve, 550));
  assert.equal(monitoredText, pastedText);
  instance._cleanupTextEditMonitor();
});

test("auto-learn casing upgrade can be undone without losing the prior spelling", async () => {
  const { IPCHandlers, handlers } = loadIpcHandlers();
  let dictionary = ["aravo", "Existing"];
  const textEditMonitor = new EventEmitter();
  const instance = new IPCHandlers({
    environmentManager: {},
    databaseManager: {
      getDictionary: () => [...dictionary],
      setDictionary: (words) => {
        dictionary = [...words];
        return { success: true };
      },
    },
    clipboardManager: {},
    whisperManager: {},
    parakeetManager: {},
    windowManager: { showDictationPanel: () => {} },
    updateManager: {},
    windowsKeyManager: {},
    textEditMonitor,
  });
  instance.broadcastToWindows = () => {};

  instance._autoLearnLatestData = {
    originalText: "I work at aravo",
    newFieldValue: "I work at Aravo",
  };
  instance._processCorrections();
  assert.deepEqual(dictionary, ["Aravo", "Existing"]);

  assert.deepEqual(await handlers.get("undo-learned-corrections")({}, ["Aravo"]), {
    success: true,
  });
  assert.deepEqual(dictionary, ["aravo", "Existing"]);
  instance._cleanupTextEditMonitor();
});

test("disabling auto-learn prevents a queued correction from changing the dictionary", () => {
  const { IPCHandlers, listeners } = loadIpcHandlers();
  let dictionary = ["aravo"];
  const textEditMonitor = new EventEmitter();
  const instance = new IPCHandlers({
    environmentManager: {},
    databaseManager: {
      getDictionary: () => [...dictionary],
      setDictionary: (words) => {
        dictionary = [...words];
        return { success: true };
      },
    },
    clipboardManager: {},
    whisperManager: {},
    parakeetManager: {},
    windowManager: { showDictationPanel: () => {} },
    updateManager: {},
    windowsKeyManager: {},
    textEditMonitor,
  });

  instance._autoLearnLatestData = {
    originalText: "I work at aravo",
    newFieldValue: "I work at Aravo",
  };
  listeners.get("auto-learn-changed")({}, false);
  instance._processCorrections();

  assert.deepEqual(dictionary, ["aravo"]);
  instance._cleanupTextEditMonitor();
});

test('disabling learning stops monitoring and discards edits observed while disabled',()=>{
 const {IPCHandlers,listeners}=loadIpcHandlers();let writes=0,stopped=0;const monitor=new EventEmitter();monitor.stopMonitoring=()=>stopped++;
 const instance=new IPCHandlers({environmentManager:{},databaseManager:{getDictionary:()=>[],setDictionary:()=>{writes++;return {success:true};}},clipboardManager:{},whisperManager:{},parakeetManager:{},windowManager:{showDictationPanel(){}},updateManager:{},textEditMonitor:monitor});
 listeners.get('auto-learn-changed')({},false);monitor.emit('text-edited',{originalText:'I work at aravo',newFieldValue:'I work at Aravo'});listeners.get('auto-learn-changed')({},true);instance._processCorrections();assert.equal(writes,0);assert.equal(stopped,1);instance._cleanupTextEditMonitor();
});
