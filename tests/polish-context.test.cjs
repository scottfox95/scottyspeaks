const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");

function harness(overrides = {}) {
  const calls = [];
  const api = {
    captureRecordingTarget: async () => ({ token: "target", appName: "Original editor" }),
    getActiveStyleProfile: async () => ({ id: "style", name: "Personal", rules: "{}" }),
    getStyleExamples: async () => [],
    getFrontmostApp: async () => {
      calls.push("frontmost");
      return { name: "Later foreground app" };
    },
    ...overrides,
  };
  const exports = {};
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync("src/services/polish/polishContext.ts", "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    { exports, window: { electronAPI: api } }
  );
  const module = { exports: {} };
  vm.runInNewContext(
    fs
      .readFileSync("src/helpers/audioManager.js", "utf8")
      .replace(/^import[\s\S]*?;\n/gm, "")
      .replace('await import("../services/polish/polishContext")', "polishContext")
      .replace("export default AudioManager;", "module.exports = AudioManager;"),
    {
      module,
      polishContext: exports,
      window: { electronAPI: api },
      getSettings: () => ({ customDictionary: ["SS2"] }),
      getEffectiveReasoningModel: () => "local-model",
      getModelProvider: () => "local",
      cleanupChoices: () => ({ exact: false }),
    }
  );
  const manager = () =>
    Object.assign(Object.create(module.exports.prototype), { context: "dictation" });
  return { manager, calls, context: exports };
}

test("dictation reuses the captured destination and skips a second frontmost-app lookup", async () => {
  const h = harness();
  const audio = h.manager();
  const target = {};
  await audio.captureRecordingTarget(target);
  const snapshot = await audio.snapshotCaptureSettings(target);
  assert.equal(snapshot.context.appName, "Original editor");
  assert.equal(snapshot.context.styleName, "Personal");
  assert.deepEqual(h.calls, []);
});

test("a missing native target name retains the frontmost-app fallback", async () => {
  const h = harness({ captureRecordingTarget: async () => ({ token: null }) });
  const audio = h.manager();
  const target = {};
  await audio.captureRecordingTarget(target);
  const snapshot = await audio.snapshotCaptureSettings(target);
  assert.equal(snapshot.context.appName, "Later foreground app");
  assert.deepEqual(h.calls, ["frontmost"]);
});

test("concurrent captures retain their own destination with coalesced style refresh", async () => {
  const h = harness();
  const a = h.manager();
  const b = h.manager();
  const [first, second] = await Promise.all([
    a.snapshotCaptureSettings({ appName: "First editor" }),
    b.snapshotCaptureSettings({ appName: "Second editor" }),
  ]);
  assert.equal(first.context.appName, "First editor");
  assert.equal(second.context.appName, "Second editor");
  await h.context.refreshPolishContext({ appName: "Third editor" });
  assert.equal(first.context.appName, "First editor");
  assert.equal(second.context.appName, "Second editor");
  assert.deepEqual(h.calls, []);
});
