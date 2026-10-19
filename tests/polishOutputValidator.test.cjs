const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

function loadAudioManager() {
  const filename = path.resolve(__dirname, "..", "src/helpers/audioManager.js");
  const source = fs.readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      allowJs: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filename,
  }).outputText;
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));

  const originalLoad = Module._load;
  Module._load = (request, parent, isMain) => {
    if (parent?.filename === filename && request.startsWith("..")) {
      if (request.endsWith("dictationCleanup")) return require("../src/services/polish/dictationCleanup.ts");
      if (request.endsWith("ReasoningService")) {
        return { __esModule: true, default: {} };
      }
      if (request.endsWith("logger")) {
        return {
          __esModule: true,
          default: new Proxy({}, { get: () => () => undefined }),
        };
      }
      if (request.endsWith("settingsStore")) {
        return {
          getEffectiveReasoningModel: () => "test-model",
          getSettings: () => ({ reasoningProvider: "local", useReasoningModel: true }),
          isCloudReasoningMode: () => false,
        };
      }
      return new Proxy(
        {},
        {
          get: () => () => undefined,
        }
      );
    }
    return originalLoad(request, parent, isMain);
  };

  global.window = {
    addEventListener() {},
    removeEventListener() {},
  };
  try {
    loaded._compile(output, filename);
  } finally {
    Module._load = originalLoad;
  }
  return loaded.exports.default;
}

const AudioManager = loadAudioManager();
const validatePolishOutput = (input, output) =>
  AudioManager.prototype.validatePolishOutput.call({}, input, output);

test("rejects an invented ending when the raw utterance is truncated", () => {
  assert.equal(
    validatePolishOutput(
      "I think we should probably move the launch to",
      "I think we should probably move the launch to Friday."
    ),
    null
  );
});

test("rejects changed numbers, negation, and names", () => {
  const input = "Send Priya 42 records and do not charge $1,200.";

  assert.equal(
    validatePolishOutput(input, "Send Priya 24 records and do not charge $1,200."),
    null
  );
  assert.equal(validatePolishOutput(input, "Send Priya 42 records and charge $1,200."), null);
  assert.equal(validatePolishOutput(input, "Send Mia 42 records and do not charge $1,200."), null);
});

test("protects a name at the beginning of an utterance", () => {
  assert.equal(
    validatePolishOutput("Élodie will review the draft.", "Amélie will review the draft."),
    null
  );
});

test("accepts punctuation, capitalization, and paragraph formatting without content changes", () => {
  const input = "team update new paragraph Priya owns 42 records and we cannot ship today";
  const output = "Team update:\n\nPriya owns 42 records, and we cannot ship today.";

  assert.equal(validatePolishOutput(input, output), output);
});

test("accepts equivalent contraction formatting", () => {
  assert.equal(
    validatePolishOutput("We can't ship 12 units.", "We cannot ship 12 units."),
    "We cannot ship 12 units."
  );
});

test("cleans model wrappers while preserving multiline formatting", () => {
  assert.equal(
    validatePolishOutput("First item second item", "```text\nFirst item  \nSecond item  \n```"),
    "First item\nSecond item"
  );
});

test("falls back to the raw transcript when polished output is suspicious", async () => {
  const manager = Object.create(AudioManager.prototype);
  const input = "I think we should probably move the launch to";
  manager.commandMode = false;
  manager.lastPolishInfo = { polished: false, raw: "" };
  manager.isReasoningAvailable = async () => true;
  manager.processWithReasoningModel = async () => `${input} Friday.`;
  manager._withTimeout = (promise) => promise;

  assert.equal(await manager.processTranscription(input, "test"), input);
  assert.deepEqual(manager.lastPolishInfo, { polished: false, raw: input });
});
