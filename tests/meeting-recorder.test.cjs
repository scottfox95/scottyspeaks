const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { MeetingStore } = require("../src/helpers/meetingStore");
const { MeetingRecorder } = require("../src/helpers/meetingRecorder");
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ss-capture-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new MeetingStore(root);
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => {
    queueMicrotask(() => child.emit("close", 0));
  };
  const recorder = new MeetingRecorder(store, { binary: "/fake", spawn: () => child });
  return { store, child, recorder };
}
test("capture is exclusive and stop persists finalized audio", async (t) => {
  const { store, child, recorder } = setup(t);
  const a = store.create();
  const starting = recorder.start(a.id);
  child.stdout.write('{"event":"started"}\n');
  await starting;
  assert.equal(recorder.status().id, a.id);
  await assert.rejects(recorder.start(store.create().id), /already/i);
  const stop = recorder.stop(a.id);
  child.stdout.write('{"event":"stopped","duration":2}\n');
  child.emit("close", 0);
  await stop;
  assert.equal(store.get(a.id).status, "recorded");
  assert.equal(store.get(a.id).recordedDuration, 2);
  assert.equal(recorder.status().id, null);
});
test("native failure rejects startup and preserves recoverable session", async (t) => {
  const { store, child, recorder } = setup(t);
  const a = store.create();
  store.update(a.id, {
    lastError: "Old provider failure",
    lastErrorCode: "openrouterAuth",
    lastErrorStatus: 401,
  });
  const starting = recorder.start(a.id);
  child.stdout.write('{"event":"error","message":"Screen recording permission denied"}\n');
  child.emit("close", 1);
  await assert.rejects(starting, /permission denied/);
  assert.equal(store.get(a.id).status, "interrupted");
  assert.equal(store.get(a.id).lastErrorCode, null);
  assert.equal(store.get(a.id).lastErrorStatus, null);
  assert.equal(recorder.status().id, null);
});

test("recovered and imported audio cannot resume with an unknown timeline", async (t) => {
  const { store, recorder } = setup(t);
  const a = store.create();
  store.update(a.id, {
    status: "interrupted",
    recordedDuration: 10,
    audio: [{ file: "take/system.caf", source: "system", offset: 10 }],
  });
  await assert.rejects(recorder.start(a.id), /new call/i);
  const b = store.create();
  store.update(b.id, {
    status: "recorded",
    audio: [{ file: "import.wav", source: "audio", offset: 0 }],
  });
  await assert.rejects(recorder.start(b.id), /new call/i);
  assert.equal(recorder.status().id, null);
});

test("queued calls reject recording without changing audio", async (t) => {
  const { store, recorder } = setup(t);
  const a = store.create();
  store.update(a.id, { status: "queued" });
  await assert.rejects(recorder.start(a.id), /transcription/);
  assert.deepEqual(store.get(a.id).audio, []);
});
test("native recording waits for speech and retains activity through actual close", async (t) => {
  const { store, child, recorder } = setup(t);
  const events = [];
  let ready;
  recorder.speech = {
    beginRecording: () => new Promise((r) => (ready = r)),
    endRecording: () => events.push("release"),
  };
  recorder.spawn = () => {
    events.push("spawn");
    return child;
  };
  const a = store.create();
  const start = recorder.start(a.id);
  assert.deepEqual(events, []);
  ready("lease");
  await new Promise(setImmediate);
  child.stdout.write('{"event":"started"}\n');
  await start;
  const stop = recorder.stop(a.id);
  child.emit("exit", 0);
  assert.deepEqual(events, ["spawn"]);
  child.emit("close", 0);
  await stop;
  assert.deepEqual(events, ["spawn", "release"]);
});
test("stop during speech acquisition prevents native spawn and releases late lease", async (t) => {
  const { store, recorder } = setup(t);
  let ready;
  const events = [];
  recorder.speech = {
    beginRecording: () => new Promise((r) => (ready = r)),
    endRecording: () => events.push("release"),
  };
  recorder.spawn = () => {
    events.push("spawn");
    throw Error("must not spawn");
  };
  const a = store.create();
  const start = recorder.start(a.id);
  const rejected = assert.rejects(start, /stopped|cancel/i);
  const stop = recorder.stop(a.id);
  ready("lease");
  await rejected;
  await stop;
  assert.deepEqual(events, ["release"]);
});
function levels(child, source, from, to, db) {
  for (let time = from; time < to; time += 0.5)
    child.stdout.write(JSON.stringify({ event: "level", source, t: time + 0.5, db }) + "\n");
}
test("recording stops itself after the configured silence once someone has spoken", async (t) => {
  const { store, child, recorder } = setup(t);
  const a = store.create();
  let stopRequested = false;
  child.stdin.on("data", (data) => {
    if (String(data).includes("stop")) {
      stopRequested = true;
      child.stdout.write('{"event":"stopped","duration":200}\n');
      queueMicrotask(() => child.emit("close", 0));
    }
  });
  const starting = recorder.start(a.id, { autoStopSeconds: 120 });
  child.stdout.write('{"event":"started"}\n');
  await starting;
  levels(child, "microphone", 0, 20, -52);
  levels(child, "microphone", 20, 60, -30);
  levels(child, "system", 0, 60, -120);
  levels(child, "microphone", 60, 170, -52);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopRequested, false, "two minutes have not passed since the last speech");
  levels(child, "microphone", 170, 185, -52);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(stopRequested, true);
  const item = store.get(a.id);
  assert.equal(item.status, "recorded");
  assert.equal(item.autoStopped, true);
  assert.equal(item.autoStopSeconds, 120);
});
test("auto-stop waits for the first speech, so a quiet lobby keeps recording", async (t) => {
  const { store, child, recorder } = setup(t);
  const a = store.create();
  let stopRequested = false;
  child.stdin.on("data", () => (stopRequested = true));
  const starting = recorder.start(a.id, { autoStopSeconds: 60 });
  child.stdout.write('{"event":"started"}\n');
  await starting;
  levels(child, "microphone", 0, 600, -52);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(stopRequested, false);
  assert.equal(recorder.status().lastSpeech, null);
  const stop = recorder.stop(a.id);
  child.emit("close", 0);
  await stop;
});
