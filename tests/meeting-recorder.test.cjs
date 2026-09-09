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
