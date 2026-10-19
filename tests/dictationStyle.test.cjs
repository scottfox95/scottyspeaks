const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

function loadTypeScriptModule(relativePath) {
  const filename = path.resolve(__dirname, "..", relativePath);
  const source = fs.readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filename,
  }).outputText;
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded.require = (request) =>
    request.endsWith("dictationCleanup")
      ? require("../src/services/polish/dictationCleanup.ts")
      : module.require(request);
  loaded._compile(output, filename);
  return loaded.exports;
}

const { applyStyleRules } = loadTypeScriptModule("src/services/StyleProcessor.ts");

function fillerRules() {
  return {
    removeFillers: true,
    capitalization: "none",
    autoPunctuation: false,
    formality: "none",
  };
}

test("filler removal preserves content uses of like and right", () => {
  assert.equal(
    applyStyleRules("I like the right option.", fillerRules()),
    "I like the right option."
  );
});

test("filler removal preserves the phrase kind of", () => {
  assert.equal(
    applyStyleRules("Use this kind of microphone.", fillerRules()),
    "Use this kind of microphone."
  );
});

test("filler removal preserves paragraph breaks", () => {
  assert.equal(
    applyStyleRules("First item\n\nSecond item", fillerRules()),
    "First item\n\nSecond item"
  );
});

test("hesitation removal does not concatenate surrounding words", () => {
  assert.equal(applyStyleRules("I um need this, uh, today.", fillerRules()), "I need this, today.");
});
test("exact wording overrides all style rules while technical guard protects identifiers", () => {
  const rules = {
    ...fillerRules(),
    formality: "formal",
    capitalization: "title",
    autoPunctuation: true,
    greeting: "Hello",
    signoff: "Thanks",
  };
  const raw = "um gonna use foo_bar\n\nThe reason was";
  assert.equal(
    applyStyleRules(raw, rules, {
      exact: true,
      removeFillers: true,
      resolveCorrections: true,
      preserveTechnical: true,
    }),
    raw
  );
  assert.equal(
    applyStyleRules(
      "use getUserByID",
      { ...fillerRules(), capitalization: "title" },
      { exact: false, removeFillers: false, resolveCorrections: false, preserveTechnical: true }
    ),
    "use getUserByID"
  );
});
test("technical style fallback preserves code syntax and case while cleaning surrounding prose", () => {
  const rules = { ...fillerRules(), capitalization: "sentence", autoPunctuation: true };
  const choices = {
    exact: false,
    removeFillers: true,
    resolveCorrections: false,
    preserveTechnical: true,
  };
  assert.equal(applyStyleRules("const value = 1;", rules, choices), "const value = 1;");
  assert.equal(
    applyStyleRules("Um, keep this\nconst value = 1;\nUh, next item", rules, choices),
    "Keep this\nconst value = 1;\nnext item."
  );
});
