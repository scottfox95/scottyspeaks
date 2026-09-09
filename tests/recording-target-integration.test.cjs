const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
function harness(overrides = {}) {
  const events = [],
    released = [];
  let serial = 0;
  const api = {
    speech: { beginRecording: async () => "speech", endRecording: async () => {} },
    captureRecordingTarget: async () => {
      events.push("target");
      return { token: `target-${++serial}` };
    },
    releaseRecordingTarget: async (token) => released.push(token),
    ...overrides,
  };
  const module = { exports: {} };
  const source = fs
    .readFileSync(require.resolve("../src/helpers/audioManager"), "utf8")
    .replace(/^import[\s\S]*?;\n/gm, "")
    .replace("export default AudioManager;", "module.exports = AudioManager;");
  vm.runInNewContext(fs.readFileSync(require.resolve("../src/helpers/recordingActivity"), "utf8").replace(/export /g, "") + "\n" + source, {
    module,
    performance,
    document: { querySelectorAll: () => [] },
    Blob,
    setTimeout,
    clearTimeout,
    getSettings: () => ({ useLocalWhisper: true, whisperModel: "tiny" }),
    getBaseLanguageCode: () => "en",
    withSessionRefresh: (fn) => fn(),
    logger: new Proxy({}, { get: () => () => {} }),
    window: { electronAPI: api, dispatchEvent() {} },
    Event: class {},
    navigator: {
      mediaDevices: {
        getUserMedia: async () => {
          events.push("microphone");
          throw new Error("synthetic mic failure");
        },
      },
    },
  });
  const audio = Object.create(module.exports.prototype);
  Object.assign(audio, {
    context: "dictation",
    releaseLocalInference: async () => {},
    snapshotCaptureSettings: async () => {
      events.push("settings");
      audio.captureSnapshot = { settings: { useLocalWhisper: false }, cleanup: { exact: true } };
    },
    getAudioConstraints: async () => ({}),
    createEvidence: async () => "capture",
    finishEvidence: async () => {},
  });
  return { audio, api, events, released };
}
test("batch start captures original target before settings and microphone; failure releases it", async () => {
  const { audio, events, released } = harness();
  assert.equal(await audio.startRecording(), false);
  assert.deepEqual(events, ["target", "settings", "microphone"]);
  assert.deepEqual(released, ["target-1"]);
});
test("cancel or unmount during target acquisition releases late token before settings/audio", async () => {
  for (const action of ["cancelRecording", "cleanup"]) {
    let ready;
    const { audio, events, released } = harness({
      captureRecordingTarget: () =>
        new Promise((r) => {
          ready = r;
        }),
    });
    const pending = audio.startRecording();
    audio[action]();
    ready({ token: "late" });
    assert.equal(await pending, false);
    assert.deepEqual(released, ["late"]);
    assert.deepEqual(events, []);
  }
});
test("old batch cancellation cannot release or paste using a newer operation target", async () => {
  const { audio, released } = harness();
  const waiting = [],
    delivered = [];
  audio.captureSnapshot = { settings: { useLocalWhisper: true }, cleanup: { exact: true } };
  audio.isProcessing = true;
  audio._recordingTarget = { token: "old", released: false };
  audio.processWithLocalWhisper = () => new Promise((r) => waiting.push(r));
  audio.onTranscriptionComplete = async (result) => delivered.push(result.targetToken);
  const old = audio.processAudio(new Blob(["synthetic"]));
  while (waiting.length < 1) await new Promise(setImmediate);
  audio.cancelProcessing();
  audio._recordingTarget = { token: "new", released: false };
  audio.isProcessing = true;
  const fresh = audio.processAudio(new Blob(["synthetic"]));
  while (waiting.length < 2) await new Promise(setImmediate);
  waiting[0]({ success: true, text: "old" });
  await old;
  assert.deepEqual(released, ["old"]);
  assert.deepEqual(delivered, []);
  waiting[1]({ success: true, text: "new" });
  await fresh;
  assert.deepEqual(delivered, ["new"]);
  assert.deepEqual(released, ["old", "new"]);
});
test("safePaste retains declined canonical text without remembering it as an actual paste", async () => {
  const { audio } = harness({
    pasteText: async () => ({ success: false, text: "canonical", manualCopy: true }),
  });
  audio.lastPastedText = "previous real paste";
  const errors = [];
  audio.onError = (error) => errors.push(error.code);
  const result = await audio.safePaste("synthetic", { targetToken: "declined" });
  assert.equal(result.text, "canonical");
  assert.equal(result.success, false);
  assert.equal(audio.lastPastedText, "previous real paste");
  assert.deepEqual(errors, ["PASTE_FAILED"]);
});
test("streaming start captures target first and microphone failure releases it", async () => {
  const { audio, events, released } = harness();
  audio.cleanupStreaming = async () => {};
  assert.equal(await audio.startStreamingRecording(), false);
  assert.deepEqual(events, ["target", "settings", "microphone"]);
  assert.deepEqual(released, ["target-1"]);
});
test("streaming completion carries its recording token and releases after delivery", async () => {
  const { audio, released } = harness();
  const delivered = [];
  audio._recordingTarget = { token: "stream", released: false };
  Object.assign(audio, {
    isStreaming: true,
    streamingFinalText: "synthetic",
    recordingStartTime: Date.now(),
    getStreamingProvider: () => ({ stop: async () => ({ success: true, text: "synthetic" }) }),
    cleanupStreamingListeners: () => {},
    shouldUseStreaming: () => false,
    processTranscription: async (text) => text,
    onTranscriptionComplete: async (result) => {
      assert.deepEqual(released, []);
      delivered.push(result.targetToken);
    },
  });
  await audio.stopStreamingRecording();
  assert.deepEqual(delivered, ["stream"]);
  assert.deepEqual(released, ["stream"]);
});
test("streaming cancellation releases target and never delivers a transcription", async () => {
  const { audio, released } = harness();
  let deliveries = 0;
  Object.assign(audio, {
    _recordingTarget: { token: "cancel", released: false },
    isStreaming: true,
    cleanupStreaming: async () => {},
    getStreamingProvider: () => ({ stop: async () => ({ text: "do not deliver" }) }),
    onTranscriptionComplete: () => deliveries++,
  });
  await audio.cancelStreamingRecording();
  assert.equal(audio.isStreaming, false);
  assert.equal(deliveries, 0);
  assert.deepEqual(released, ["cancel"]);
});
function delivery(audio, api = {}, extras = {}) {
  const source = fs.readFileSync(require.resolve("../src/hooks/useAudioRecording"), "utf8");
  const start =
    source.indexOf("onTranscriptionComplete: async (result) => {") +
    "onTranscriptionComplete: ".length;
  const end = source.indexOf("    });\n\n    audioManagerRef.current.setContext", start);
  const callback = source
    .slice(start, end)
    .trim()
    .replace(/,$/, "")
    .replace('await import("../services/polish/voiceCommand")', "({applyVoiceCommand: command})");
  return vm.runInNewContext(`(${callback})`, {
    audioManagerRef: { current: audio },
    commandModeRef: { current: false },
    window: { electronAPI: api },
    getSettings: () => ({}),
    performance,
    setTranscript() {},
    toast() {},
    t: (key) => key,
    logger: { info() {} },
    ...extras,
  });
}
test("manual delivery saves canonical history and recoverable evidence with exact operation token", async () => {
  const saved = [],
    passed = [];
  const audio = {
    safePaste: async (text, options) => {
      passed.push(options);
      return { success: false, text: "canonical", manualCopy: true };
    },
    saveTranscription: async (...args) => {
      saved.push(args);
      return { success: true, transcription: { id: 88 } };
    },
  };
  const result = {
    success: true,
    text: "raw",
    rawText: "raw evidence",
    targetToken: "operation",
    captureSnapshot: { cleanup: { exact: true } },
  };
  await delivery(audio)(result);
  assert.equal(passed[0].targetToken, "operation");
  assert.equal(passed[0].exact, true);
  assert.deepEqual(saved, [["canonical", "raw evidence"]]);
  assert.equal(result.historyId, 88);
  assert.equal(result.evidenceFinalText, "canonical");
  assert.match(result.evidenceError, /manual copy/);
});
test("declined voice replacement keeps transformed history without falsely remembering a paste", async () => {
  const saved = [],
    replacements = [];
  const audio = {
    lastPastedText: "last real paste",
    saveTranscription: async (...args) => {
      saved.push(args);
      return { success: true, transcription: { id: 9 } };
    },
  };
  const result = {
    success: true,
    text: "make concise",
    rawText: "raw instruction",
    targetToken: "command-target",
  };
  const fn = delivery(
    audio,
    {
      replaceLastPaste: async (...args) => {
        replacements.push(args);
        return { replaced: false, manualCopy: true };
      },
    },
    {
      commandModeRef: { current: true },
      command: async (_instruction, _last, token) => {
        assert.equal(token, "command-target");
        return { ok: true, text: "transformed", usedSelection: false, target: "last real paste" };
      },
    }
  );
  await fn(result);
  assert.equal(replacements[0][2].targetToken, "command-target");
  assert.equal(audio.lastPastedText, "last real paste");
  assert.deepEqual(saved, [["transformed", "raw instruction"]]);
  assert.match(result.evidenceError, /manual copy/);
});
