// D23: cancelling during the AI pass keeps the dictation, and a polish that
// times out or is skipped aborts its llama-server request.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

function loadAudioManager() {
  const filename = path.resolve(__dirname, "..", "src/helpers/audioManager.js");
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { allowJs: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: filename,
  }).outputText;
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalLoad = Module._load;
  Module._load = (request, parent, isMain) => {
    if (parent?.filename === filename && request.startsWith("..")) {
      if (request.endsWith("dictationCleanup")) return require("../src/services/polish/dictationCleanup.ts");
      if (request.endsWith("ReasoningService")) return { __esModule: true, default: {} };
      if (request.endsWith("logger"))
        return { __esModule: true, default: new Proxy({}, { get: () => () => undefined }) };
      if (request.endsWith("settingsStore"))
        return {
          getEffectiveReasoningModel: () => "test-model",
          getSettings: () => ({ reasoningProvider: "local", useReasoningModel: true }),
          isCloudReasoningMode: () => false,
        };
      return new Proxy({}, { get: () => () => undefined });
    }
    return originalLoad(request, parent, isMain);
  };
  global.window = { addEventListener() {}, removeEventListener() {} };
  try {
    loaded._compile(output, filename);
  } finally {
    Module._load = originalLoad;
  }
  return loaded.exports.default;
}

const AudioManager = loadAudioManager();
const RAW = "so the plan for tomorrow is to send the draft to the whole team first thing";

function manager() {
  const m = Object.create(AudioManager.prototype);
  m.commandMode = false;
  m.lastPolishInfo = { polished: false, raw: "" };
  m.isReasoningAvailable = async () => true;
  m.processWithReasoningModel = () => new Promise(() => {}); // a stuck polish
  return m;
}

function trackCancels() {
  const calls = { count: 0 };
  global.window.electronAPI = {
    cancelLocalReasoning: async () => {
      calls.count++;
      return { success: true };
    },
  };
  return calls;
}

test("D23: cancel while refining delivers the unrefined text and aborts the request", async () => {
  const cancels = trackCancels();
  const m = manager();
  const delivered = m.processTranscription(RAW, "test");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(m.cancelProcessing(), true);
  const text = await delivered;
  assert.ok(text.length > 0, "the dictation is kept");
  assert.match(text.toLowerCase(), /send the draft to the whole team/);
  assert.equal(m.lastPolishInfo.polished, false);
  assert.equal(cancels.count, 1);
  assert.equal(m._skipPolish, null);
});

test("D23: a polish timeout aborts the llama-server request", async () => {
  const cancels = trackCancels();
  const m = manager();
  await assert.rejects(m._withTimeout(new Promise(() => {}), 20, "Polish"), /timed out/);
  assert.equal(cancels.count, 1);
  assert.equal(m._skipPolish, null, "nothing left to skip afterwards");
});

test("D23: a polish that finishes normally does not abort anything", async () => {
  const cancels = trackCancels();
  const m = manager();
  assert.equal(await m._withTimeout(Promise.resolve("done"), 1000, "Polish"), "done");
  assert.equal(cancels.count, 0);
  assert.equal(m.skipPolish(), false);
});
