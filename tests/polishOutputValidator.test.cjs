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

const explain = (input, output) => AudioManager.prototype.explainPolishOutput.call({}, input, output);

test("sentence openers are not names: dropping 'So' or 'But' is ordinary cleanup", () => {
  const input = "So I think the draft is solid. But the middle section needs work.";
  const output = "I think the draft is solid, but the middle section needs work.";
  assert.equal(validatePolishOutput(input, output), output);
});

test("names mid-sentence and at the start stay protected", () => {
  assert.equal(explain("Send it to Priya today.", "Send it to Mia today.").reason, "names");
  assert.equal(explain("Élodie will review the draft.", "Amélie will review the draft.").reason, "names");
});

test("spoken numbers may become digits; digits the speaker gave may not change", () => {
  const input = "Can I offset ten ninety nine income with losses in the market";
  const output = "Can I offset 1099 income with losses in the market?";
  assert.equal(validatePolishOutput(input, output), output);
  assert.equal(explain("Offer 625 for the unit.", "Offer $625 for the unit.").text, "Offer $625 for the unit.");
  assert.equal(explain("Offer 625 for the unit.", "Offer 600 for the unit.").reason, "numbers");
});

test("negation may change form but not count", () => {
  const input = "Does this not mean the whole unit will need to be replaced?";
  assert.equal(explain(input, "Doesn't this mean the whole unit will need to be replaced?").reason, "");
  assert.equal(explain(input, "This means the whole unit will need to be replaced.").reason, "negation");
});

test("rewording the speaker's content is rejected (cleanup, not ghost-writing)", () => {
  const input =
    "This looks good to me, but I'm wondering how to make it really click with Georgie before we send it.";
  assert.equal(
    explain(input, "This looks good to me. Should we polish it for Georgie before sending?").reason,
    "rewrote"
  );
});

test("switching who is speaking is rejected", () => {
  const input = "Check my Tenenbaum email for an update from Adam.";
  assert.equal(explain(input, "Check your Tenenbaum email for an update from Adam.").reason, "pronouns");
  assert.equal(explain(input, "Check my Tenenbaum email for an update from Adam.").reason, "");
});
