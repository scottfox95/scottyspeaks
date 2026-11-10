const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  vm = require("node:vm");
function harness({ local = false, context = "dictation" } = {}) {
  const events = [];
  let micResolve;
  let deferMic = false;
  const track = {
    stop: () => events.push("tracks-stopped"),
    getSettings: () => ({}),
    label: "Synthetic",
  };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  class Recorder {
    constructor(s) {
      this.stream = s;
      this.state = "inactive";
      this.mimeType = "audio/webm";
    }
    start() {
      this.state = "recording";
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
    withSessionRefresh: (fn) => fn(),
    setTimeout,
    clearTimeout,
    Event: class {},
    document: { querySelectorAll: () => [] },
    MediaRecorder: Recorder,
    getSettings: () => ({ useLocalWhisper: local }),
    logger: new Proxy({}, { get: () => () => {} }),
    window: {
      electronAPI: {
        speech: {
          beginRecording: async (kind) => {
            events.push("begin:" + kind);
            return "lease";
          },
          endRecording: async () => events.push("released"),
        },
        reserveLocalInference: async () => {
          events.push("inference");
          return "infer";
        },
      },
      dispatchEvent() {},
    },
    navigator: {
      mediaDevices: {
        getUserMedia: async () => {
          events.push("mic");
          if (deferMic) return new Promise((r) => (micResolve = r));
          return stream;
        },
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync("src/helpers/recordingActivity.js", "utf8").replace(/export /g, ""),
    sandbox
  );
  vm.runInContext(
    fs
      .readFileSync("src/helpers/audioManager.js", "utf8")
      .replace(/^import[\s\S]*?;\n/gm, "")
      .replace("export default AudioManager;", "module.exports=AudioManager;"),
    sandbox
  );
  const audio = Object.create(sandbox.module.exports.prototype);
  Object.assign(audio, {
    context,
    captureRecordingTarget: async () => {},
    releaseRecordingTarget: (target) => {
      if (target) target.released = true;
    },
    releaseLocalInference: async () => {},
    snapshotCaptureSettings: async () => {},
    processingSettings: () => ({ useLocalWhisper: local }),
    getAudioConstraints: async () => ({}),
    processAudio: async () => events.push("transcribe"),
  });
  return {
    audio,
    events,
    defer: () => (deferMic = true),
    resolve: () => micResolve(stream),
    ready: () => !!micResolve,
  };
}
for (const [local, context] of [
  [false, "dictation"],
  [true, "dictation"],
  [false, "notes"],
])
  test(`actual batch ${context} local=${local} stops tracks before transcription and releases speech`, async () => {
    const { audio, events } = harness({ local, context });
    assert.equal(await audio.startRecording(), true);
    assert.ok(events.indexOf("begin:" + context) < events.indexOf("mic"));
    audio.stopRecording();
    await new Promise(setImmediate);
    assert.ok(events.indexOf("tracks-stopped") < events.indexOf("transcribe"));
    assert.ok(events.indexOf("released") < events.indexOf("transcribe"));
  });
test("actual batch cancellation while mic is pending stops late tracks before release", async () => {
  const h = harness();
  h.defer();
  const pending = h.audio.startRecording();
  while (!h.ready()) await new Promise(setImmediate);
  h.audio.cancelRecording();
  assert.ok(!h.events.includes("released"));
  h.resolve();
  assert.equal(await pending, false);
  assert.ok(h.events.indexOf("tracks-stopped") < h.events.indexOf("released"));
});
