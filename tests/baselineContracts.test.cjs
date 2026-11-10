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
  loaded._compile(output, filename);
  return loaded.exports;
}

const defaults = loadTypeScriptModule("src/stores/localFirstDefaults.ts");

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

test("a fresh install keeps local-first defaults and writes nothing but the marker", () => {
  const store = storage();
  defaults.migrateToLocalFirstDefaults(store);
  assert.deepEqual([...store.values.keys()], [defaults.LOCAL_FIRST_MIGRATION_KEY]);
  assert.equal(defaults.DEFAULT_POLISH_MODEL, "qwen3-4b-instruct-2507-q4_k_m");
  assert.equal(defaults.DEFAULT_POLISH_PROVIDER, "qwen");
  assert.equal(defaults.DEFAULT_PARAKEET_MODEL, "parakeet-tdt-0.6b-v3");
});

test("a working BYOK cloud setup that relied on the old default stays on the cloud", () => {
  const store = storage({ openaiApiKey: "sk-test", cloudTranscriptionMode: "byok" });
  defaults.migrateToLocalFirstDefaults(store);
  assert.equal(store.getItem("useLocalWhisper"), "false");
});

test("an install routed to the dead OpenWhispr cloud moves to local", () => {
  const implicit = storage({ cloudTranscriptionMode: "openwhispr" });
  defaults.migrateToLocalFirstDefaults(implicit);
  assert.equal(implicit.getItem("useLocalWhisper"), null); // new default: local

  const explicit = storage({ useLocalWhisper: "false", cloudTranscriptionMode: "openwhispr" });
  defaults.migrateToLocalFirstDefaults(explicit);
  assert.equal(explicit.getItem("useLocalWhisper"), "true");
});

test("an existing whisper.cpp user keeps whisper.cpp", () => {
  const store = storage({ useLocalWhisper: "true" });
  defaults.migrateToLocalFirstDefaults(store);
  assert.equal(store.getItem("localTranscriptionProvider"), "whisper");

  const parakeet = storage({ useLocalWhisper: "true", localTranscriptionProvider: "nvidia" });
  defaults.migrateToLocalFirstDefaults(parakeet);
  assert.equal(parakeet.getItem("localTranscriptionProvider"), "nvidia");
});

test("a chosen polish model keeps the provider it was chosen under", () => {
  const store = storage({ reasoningModel: "gpt-5-mini" });
  defaults.migrateToLocalFirstDefaults(store);
  assert.equal(store.getItem("reasoningProvider"), "openai");

  const explicit = storage({ reasoningModel: "claude-haiku-4-5", reasoningProvider: "anthropic" });
  defaults.migrateToLocalFirstDefaults(explicit);
  assert.equal(explicit.getItem("reasoningProvider"), "anthropic");
});

test("stale sign-in state is removed and the migration runs only once", () => {
  const store = storage({
    isSignedIn: "true",
    cloudReasoningMode: "openwhispr",
    cloudTranscriptionMode: "openwhispr",
  });
  defaults.migrateToLocalFirstDefaults(store);
  assert.equal(store.getItem("isSignedIn"), null);
  assert.equal(store.getItem("cloudReasoningMode"), null);
  assert.equal(store.getItem("cloudTranscriptionMode"), null);

  store.setItem("isSignedIn", "true");
  defaults.migrateToLocalFirstDefaults(store);
  assert.equal(store.getItem("isSignedIn"), "true"); // marker set: no second pass
});
