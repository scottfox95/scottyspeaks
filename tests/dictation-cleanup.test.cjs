const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");
const vm = require("node:vm");
function load(file) {
  const source = fs.readFileSync(require("node:path").resolve(__dirname, "..", file), "utf8");
  const exports = {};
  vm.runInNewContext(
    ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    { exports, require }
  );
  return exports;
}
const cleanup = () => load("src/services/polish/dictationCleanup.ts");
const options = {
  exact: false,
  removeFillers: true,
  resolveCorrections: true,
  preserveTechnical: true,
};
test("cleanup only removes hesitation sounds, preserves paragraphs and meaningful words", () => {
  const { applyDictationCleanup } = cleanup();
  assert.equal(
    applyDictationCleanup("Um, send the file.\n\nUh, keep the notes.", options),
    "send the file.\n\nkeep the notes."
  );
  for (const raw of [
    "I like the way it works. You know the account number.",
    "use getUserByID with SS2_API_KEY and foo_bar",
    "Can we ship this today?",
    "Do not delete the production database.",
    "The reason we paused was",
    "Ask Jamie and Scott about MAI-Transcribe-2.",
  ])
    assert.equal(applyDictationCleanup(raw, options), raw);
});
test("numeric correction requires explicit adjacent cue and preserves unrelated numbers", () => {
  const { applyDictationCleanup } = cleanup();
  const raw = "Set the limit to 15, sorry, 50. Keep 20 backups.";
  assert.equal(applyDictationCleanup(raw, options), "Set the limit to 50. Keep 20 backups.");
  assert.equal(applyDictationCleanup(raw, { ...options, resolveCorrections: false }), raw);
  assert.equal(
    applyDictationCleanup("15 is wrong; maybe 50 or 20.", options),
    "15 is wrong; maybe 50 or 20."
  );
});
test("exact wording overrides every cleanup choice", () => {
  const { applyDictationCleanup } = cleanup();
  const raw = "Um, set SS2_API_KEY to 15, sorry, 50.\n\nThe reason was";
  assert.equal(applyDictationCleanup(raw, { ...options, exact: true }), raw);
});
test("output guard protects disabled cleanup choices, technical identifiers, incomplete utterances and questions", () => {
  const { respectsCleanupChoices } = cleanup();
  assert.equal(
    respectsCleanupChoices("Um, use foo_bar", "Use fooBar.", { ...options, removeFillers: false }),
    false
  );
  assert.equal(
    respectsCleanupChoices(
      "The reason we paused was",
      "The reason we paused was unclear.",
      options
    ),
    false
  );
  assert.equal(
    respectsCleanupChoices("Can we ship this today?", "Yes, we can ship this today.", options),
    false
  );
  assert.equal(
    respectsCleanupChoices(
      "use getUserByID with SS2_API_KEY and foo_bar",
      "Use getUserByID with SS2_API_KEY and foo_bar.",
      options
    ),
    true
  );
});
function pipeline(settings = {}) {
  const cleanupModule = cleanup();
  const requests = [],
    states = [];
  const current = {
    customDictionary: [],
    useReasoningModel: true,
    reasoningProvider: "local",
    reasoningModel: "captured-model",
    ...settings,
  };
  const exports = {};
  const source = fs
    .readFileSync(require("node:path").resolve(__dirname, "../src/helpers/audioManager.js"), "utf8")
    .replace(/^import[\s\S]*?;\n/gm, "")
    .replace("export default AudioManager;", "exports.AudioManager = AudioManager;");
  const noop = () => {};
  vm.runInNewContext(source, {
    exports,
    ...cleanupModule,
    getSettings: () => current,
    getEffectiveReasoningModel: () => current.reasoningModel,
    isCloudReasoningMode: () => false,
    getModelProvider: () => current.reasoningProvider,
    getSystemPrompt: (_a, _d, _l, _t, _u, snap) => cleanupModule.cleanupInstructions(snap.cleanup),
    ReasoningService: {
      processText: async (text, model, _agent, config) => {
        requests.push({ text, model, config });
        return text;
      },
    },
    Blob,
    Event,
    performance,
    navigator: { onLine: true },
    withSessionRefresh: (fn) => fn(),
    getBaseLanguageCode: (lang) => lang,
    validateLanguageForModel: (lang) => lang,
    logger: new Proxy({}, { get: () => noop }),
    window: {
      dispatchEvent: () => {},
      localStorage: { getItem: () => null },
      electronAPI: {
        cloudStreamingUsage: async () => ({ success: true }),
        cloudTranscribe: async () => ({
          success: true,
          text: "Um, set the limit to 15, sorry, 50. Keep 20 backups.",
        }),
      },
    },
    localStorage: { getItem: () => null },
    setTimeout,
    clearTimeout,
  });
  const manager = Object.create(exports.AudioManager.prototype);
  manager.context = "dictation";
  manager.isReasoningAvailable = async () => true;
  manager.onStateChange = (state) => states.push(state);
  return { manager, current, requests, states };
}
test("actual pipeline applies short corrections before AI fast path and keeps evidence raw", async () => {
  const { manager } = pipeline({ dictationResolveCorrections: true });
  const evidence = {};
  assert.equal(await manager.processTranscription("15, sorry, 50.", "test", evidence), "50.");
  assert.equal(evidence.rawText, "15, sorry, 50.");
});
test("exact capture bypasses actual AI request including long utterances", async () => {
  const { manager, requests } = pipeline({ dictationExact: true });
  const raw = "Um, please keep every single word in this dictated question?";
  assert.equal(await manager.processTranscription(raw, "test", {}), raw);
  assert.equal(requests.length, 0);
});
test("actual model request uses captured model and independent cleanup contract despite later changes", async () => {
  const { manager, current, requests, states } = pipeline({
    dictationRemoveFillers: false,
    dictationResolveCorrections: false,
  });
  manager.captureSnapshot = {
    settings: { ...current },
    model: "captured-model",
    provider: "local",
    cleanup: cleanup().cleanupChoices(current),
    context: {
      styleName: "Technical",
      styleInstructions: "Preserve tone",
      examples: [],
      appName: "",
      aiPolishDisabled: false,
    },
  };
  current.reasoningModel = "changed-model";
  current.dictationRemoveFillers = true;
  await manager.processTranscription(
    "Um, please keep these exact technical words in this paragraph.",
    "test",
    {}
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0].model, "captured-model");
  assert.match(requests[0].config.systemPrompt, /Hesitation removal: disabled/);
  assert.ok(states.some((s) => s.pipelineStage === "refining"));
});
test("formatted and signed numbers never receive partial numeric corrections", () => {
  const { applyDictationCleanup } = cleanup();
  for (const raw of [
    "Set it to 1,500, sorry, 2,000.",
    "Set it to -15, sorry, -50.",
    "Set it to 15, sorry, 2,000.",
  ])
    assert.equal(applyDictationCleanup(raw, options), raw);
});
test("technical preservation keeps literal hesitation tokens in code and quoted identifiers", () => {
  const { applyDictationCleanup } = cleanup();
  for (const raw of [
    "const um = 1",
    "use `um` and `uh`",
    'The variable "um" is valid.',
    "um(foo_bar)",
  ])
    assert.equal(applyDictationCleanup(raw, options), raw);
});
test("actual cloud transcription uses the same correction baseline and exact bypass", async () => {
  const { manager, requests, current } = pipeline({
    reasoningProvider: "openwhispr",
    dictationResolveCorrections: true,
  });
  const evidence = {};
  let result = await manager.processWithOpenWhisprCloud(new Blob(["synthetic"]), { evidence });
  assert.equal(result.text, "set the limit to 50. Keep 20 backups.");
  assert.equal(evidence.rawText, "Um, set the limit to 15, sorry, 50. Keep 20 backups.");
  assert.equal(requests.length, 1);
  current.dictationExact = true;
  result = await manager.processWithOpenWhisprCloud(new Blob(["synthetic"]), { evidence: {} });
  assert.equal(result.text, "Um, set the limit to 15, sorry, 50. Keep 20 backups.");
  assert.equal(requests.length, 1);
});
test("AI guard rejects deletion of meaningful filler-like language", () => {
  const { respectsCleanupChoices } = cleanup();
  assert.equal(
    respectsCleanupChoices(
      "I like the way it works. You know the account number.",
      "The way it works. The account number.",
      options
    ),
    false
  );
});
test("exact wording keeps explicit named-agent commands available and ignores ordinary mentions", async () => {
  const { manager, requests, current } = pipeline({ dictationExact: true, agentName: "Scotty" });
  manager.captureSnapshot = {
    settings: { ...current },
    agentName: "Scotty",
    model: "captured-model",
    provider: "local",
    cleanup: cleanup().cleanupChoices(current),
    context: { styleName: "", styleInstructions: "", examples: [], appName: "" },
  };
  await manager.processTranscription("Hey Scotty, rewrite this as a friendly email.", "test", {});
  assert.equal(requests.length, 1);
  await manager.processTranscription("Ask Scotty and Jamie about the release.", "test", {});
  assert.equal(requests.length, 1);
});
test("actual AI validator rejects changes to code case and operators", async () => {
  const { manager } = pipeline();
  manager.shouldSkipPolish = () => false;
  for (const output of ["Const value = 1;", "const value += 1;", "const value == 1;"]) {
    manager.processWithReasoningModel = async () => output;
    assert.equal(
      await manager.processTranscription("const value = 1;", "synthetic", {}),
      "const value = 1;"
    );
  }
  assert.equal(
    cleanup().respectsCleanupChoices(
      "Um, example\nconst value = 1;",
      "Example\nconst value = 1;",
      options
    ),
    true
  );
});
test("both local wrappers retain successful empty cleanup while evidence keeps provider words", async () => {
  for (const wrapper of ["processWithLocalWhisper", "processWithLocalParakeet"]) {
    const { manager } = pipeline({ useReasoningModel: false });
    manager.transcribeLocal = async () => ({ success: true, text: "um" });
    const evidence = {};
    const result = await manager[wrapper](new Blob(["synthetic"]), "test-model", { evidence });
    assert.equal(result.success, true);
    assert.equal(result.text, "");
    assert.equal(evidence.rawText, "um");
  }
});
test("actual streaming stop retains intentionally empty cleanup without batch retranscription", async () => {
  for (const providerText of ["um", ""]) {
    const { manager } = pipeline({ useReasoningModel: false });
    let batchRequests = 0;
    const completed = [],
      captures = [];
    manager.isStreaming = true;
    manager.streamingFinalText = providerText;
    manager.recordingStartTime = Date.now() - 3000;
    manager.streamingFallbackChunks = ["synthetic"];
    manager.streamingFallbackRecorder = {
      state: "recording",
      mimeType: "audio/webm",
      stop() {
        this.onstop();
      },
    };
    manager.getStreamingProvider = () => ({
      stop: async () => ({ success: true, text: providerText }),
    });
    manager.cleanupStreamingListeners = () => {};
    manager.shouldUseStreaming = () => false;
    manager.processWithOpenWhisprCloud = async () => {
      batchRequests++;
      return { success: true, text: "", rawText: "um" };
    };
    manager.createEvidence = async () => "synthetic-capture";
    manager.finishEvidence = async (_id, value) => captures.push(value);
    manager.onTranscriptionComplete = async (result) => completed.push(result);
    assert.equal(await manager.stopStreamingRecording(), true);
    assert.equal(batchRequests, providerText ? 0 : 1);
    assert.equal(completed.length, 1);
    assert.equal(completed[0].text, "");
    assert.equal(captures[0].rawText, "um");
    assert.equal(captures[0].finalText, "");
  }
});
