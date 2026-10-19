const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function deferred() {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
}

function harness({ pendingMic, pendingSettings, recorderFailure = false } = {}) {
  const events = [];
  const errors = [];
  const intervals = new Map();
  const handlers = {};
  let intervalId = 0;
  let dispose;
  const track = {
    stop: () => events.push("tracks-stopped"),
    getSettings: () => ({}),
  };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const api = {
    speech: {
      beginRecording: async () => "speech",
      endRecording: async () => events.push("speech-released"),
    },
    captureRecordingTarget: async () => ({ token: "target" }),
    releaseRecordingTarget: async () => events.push("target-released"),
    reserveLocalInference: async () => "inference",
    releaseLocalInference: async () => events.push("inference-released"),
    getSttConfig: async () => null,
    onToggleDictation: (callback) => (handlers.toggle = callback),
    onStartDictation: (callback) => (handlers.start = callback),
    onStopDictation: (callback) => (handlers.stop = callback),
  };
  class AudioContext {
    constructor() {
      events.push("context-created");
    }
    createAnalyser() {
      return { getByteTimeDomainData: (data) => data.fill(140) };
    }
    createMediaStreamSource() {
      return { connect() {} };
    }
    async close() {
      events.push("context-closed");
    }
  }
  class MediaRecorder {
    constructor(input) {
      if (recorderFailure) throw new Error("Recorder unavailable");
      this.stream = input;
      this.state = "inactive";
      this.mimeType = "audio/webm";
    }
    start() {
      this.state = "recording";
      events.push("recording");
    }
    stop() {
      this.state = "inactive";
      void this.onstop?.();
    }
  }
  const sandbox = {
    module: { exports: {} },
    performance,
    Blob,
    setTimeout,
    clearTimeout,
    setInterval: (callback) => {
      intervals.set(++intervalId, callback);
      return intervalId;
    },
    clearInterval: (id) => intervals.delete(id),
    AudioContext,
    MediaRecorder,
    document: { querySelectorAll: () => [] },
    getSettings: () => ({ useLocalWhisper: true }),
    logger: new Proxy({}, { get: () => () => {} }),
    window: { electronAPI: api },
    navigator: {
      mediaDevices: {
        getUserMedia: async () => {
          events.push("microphone-requested");
          if (pendingMic) await pendingMic.promise;
          return stream;
        },
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync("src/helpers/recordingActivity.js", "utf8").replace(/export /g, "") +
      "\n" +
      fs
        .readFileSync("src/helpers/audioManager.js", "utf8")
        .replace(/^import[\s\S]*?;\n/gm, "")
        .replace("export default AudioManager;", "module.exports = AudioManager;"),
    sandbox
  );
  const audio = Object.create(sandbox.module.exports.prototype);
  Object.assign(audio, {
    context: "dictation",
    isRecording: false,
    isProcessing: false,
    streamingCleanupFns: [],
    snapshotCaptureSettings: async () => {
      events.push("settings-requested");
      if (pendingSettings) await pendingSettings.promise;
    },
    getAudioConstraints: async () => ({}),
    shouldUseStreaming: () => false,
    getStreamingProvider: () => ({ stop() {} }),
    processAudio: async () => events.push("transcribe"),
    onError: (error) => errors.push(error),
  });
  function mountHook() {
    Object.assign(sandbox, {
      createAudioManager: () => audio,
      useState: (initial) => [initial, () => {}],
      useRef: (current) => ({ current }),
      useCallback: (callback) => callback,
      useEffect: (callback) => (dispose = callback()),
      useTranslation: () => ({ t: (key) => key }),
      playStartCue: () => events.push("start-cue"),
      playStopCue: () => events.push("stop-cue"),
      getRecordingErrorTitle: (error) => error.title,
    });
    vm.runInContext(
      fs
        .readFileSync("src/hooks/useAudioRecording.js", "utf8")
        .replace(/^import.*;\n/gm, "")
        .replace("export const useAudioRecording", "const useAudioRecording")
        .replace("new AudioManager()", "createAudioManager()") +
        "\nmodule.exports = useAudioRecording;",
      sandbox
    );
    return sandbox.module.exports((error) => errors.push(error));
  }
  return { audio, events, errors, intervals, handlers, mountHook, dispose: () => dispose?.() };
}

async function waitFor(predicate) {
  for (let turn = 0; turn < 20; turn++) {
    if (predicate()) return;
    await new Promise(setImmediate);
  }
  assert.fail("Expected recording lifecycle event did not occur");
}

for (const stop of ["release", "toggle", "button"])
  test(`quick ${stop} during microphone startup cancels before recording and stops late tracks`, async () => {
    const pendingMic = deferred();
    const h = harness({ pendingMic });
    const hook = h.mountHook();
    const starting = hook.startRecording();
    await waitFor(() => h.events.includes("microphone-requested"));
    assert.equal(h.audio.getState().isRecordingStartInProgress, true);
    if (stop === "release") h.handlers.stop();
    else if (stop === "toggle") h.handlers.toggle();
    else await hook.toggleListening();
    pendingMic.resolve();
    assert.equal(await starting, false);
    assert.ok(!h.events.includes("recording"));
    assert.ok(!h.events.includes("start-cue"));
    assert.ok(!h.events.includes("transcribe"));
    assert.ok(h.events.includes("inference-released"));
    assert.ok(h.events.includes("target-released"));
    assert.ok(h.events.indexOf("tracks-stopped") < h.events.indexOf("speech-released"));
    assert.equal(h.audio.getState().isRecordingStartInProgress, false);
    assert.deepEqual(h.errors, []);
    assert.equal(await hook.startRecording(), true, "next press starts normally");
    h.audio.cancelRecording();
    assert.equal(h.intervals.size, 0);
  });

test("stop while capture settings are pending never opens the microphone", async () => {
  const pendingSettings = deferred();
  const h = harness({ pendingSettings });
  const starting = h.audio.startRecording();
  await waitFor(() => h.events.includes("settings-requested"));
  assert.equal(h.audio.stopRecording(), true);
  pendingSettings.resolve();
  assert.equal(await starting, false);
  assert.ok(!h.events.includes("microphone-requested"));
  assert.deepEqual(h.errors, []);
});

for (const action of ["cancelRecording", "stopRecording", "cleanup"])
  test(`${action} closes the silence AudioContext and clears its recurring timer`, async () => {
    const h = harness();
    assert.equal(await h.audio.startRecording(), true);
    assert.equal(h.intervals.size, 1);
    h.audio[action]();
    await new Promise(setImmediate);
    assert.equal(h.intervals.size, 0);
    assert.equal(h.events.filter((event) => event === "context-closed").length, 1);
    assert.equal(h.events.includes("transcribe"), action === "stopRecording");
  });

test("recorder setup failure cleans up a partially initialized silence detector", async () => {
  const h = harness({ recorderFailure: true });
  assert.equal(await h.audio.startRecording(), false);
  assert.equal(h.intervals.size, 0);
  assert.ok(h.events.includes("context-closed"));
  assert.ok(h.events.includes("tracks-stopped"));
  assert.equal(h.errors.length, 1);
});

test("an ignored second start does not close the active silence detector", async () => {
  const h = harness();
  assert.equal(await h.audio.startRecording(), true);
  assert.equal(await h.audio.startRecording(), false);
  assert.equal(h.intervals.size, 1);
  assert.ok(!h.events.includes("context-closed"));
  h.audio.cancelRecording();
});
