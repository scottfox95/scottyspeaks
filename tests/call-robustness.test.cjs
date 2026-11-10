// Call and screen-recording robustness (Fable 5.2 review, section 2 R1-R8,
// D10 and the section 4 call transcription I/O note). Synthetic audio only.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { promisify } = require("node:util");
const { execFile } = require("node:child_process");
const { registerMeetingHandlers } = require("../src/helpers/meetingHandlers");
const { MeetingStore } = require("../src/helpers/meetingStore");
const { MeetingRecorder } = require("../src/helpers/meetingRecorder");
const { CaptureStore } = require("../src/helpers/captureStore");
const { AudioEvidence } = require("../src/helpers/audioEvidence");
const { transcribeChunk, audioDuration } = require("../src/helpers/meetingTranscriber");
const { inferenceScheduler } = require("../src/helpers/inferenceScheduler");
const { guardQuit } = require("../src/helpers/quitGuard");
const { describe: describeAlert } = require("../src/helpers/recordingAlerts");

const GB = 1024 ** 3;

function wav(seconds, amplitude = 6000) {
  const samples = Math.round(seconds * 16000);
  const b = Buffer.alloc(44 + samples * 2);
  b.write("RIFF");
  b.writeUInt32LE(b.length - 8, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++)
    b.writeInt16LE(Math.round(Math.sin((i * 2 * Math.PI * 440) / 16000) * amplitude), 44 + i * 2);
  return b;
}

function tempRoot(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function harness(t, { seconds = 1, local, callDiarizer, runTrim, beforeRegister } = {}) {
  const root = tempRoot(t, "ss-call-robust-");
  beforeRegister?.(root);
  const app = new EventEmitter();
  app.getPath = () => root;
  const handlers = new Map();
  const sender = { mainFrame: {} };
  let calls = 0;
  const service = registerMeetingHandlers({
    app,
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    dialog: {},
    shell: {},
    safeStorage: {},
    systemPreferences: {},
    whisperManager: {},
    parakeetManager: {
      transcribeLocalParakeet: async () =>
        local ? local(++calls) : { success: true, text: "Synthetic words" },
    },
    databaseManager: { getDictionary: () => [] },
    windowManager: { controlPanelWindow: { webContents: sender } },
    audioEvidence: new AudioEvidence(),
    ...(callDiarizer ? { callDiarizer } : {}),
    ...(runTrim ? { runTrim } : {}),
    cloudFetch: () => {
      throw new Error("Network forbidden");
    },
  });
  const meeting = service.store.create();
  const directory = service.store.directory(meeting.id);
  fs.writeFileSync(path.join(directory, "input.wav"), wav(seconds));
  service.store.update(meeting.id, { audio: [{ file: "input.wav", source: "system", offset: 0 }] });
  return {
    app,
    service,
    meeting,
    directory,
    invoke: async (name, args) => {
      const response = await handlers.get(`meetings:${name}`)(
        { sender, senderFrame: sender.mainFrame },
        args
      );
      if (!response.success) throw new Error(response.error);
      return response.data;
    },
  };
}

async function settled(store, id) {
  for (let i = 0; i < 1000; i++) {
    const item = store.get(id);
    if (!["transcribing", "queued"].includes(item.status)) return item;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("Transcription did not settle");
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => queueMicrotask(() => child.emit("close", 0));
  // A stop request finalizes like the native recorder does.
  child.stdin.on("data", (data) => {
    if (String(data).includes("stop")) {
      child.stdout.write('{"event":"stopped","duration":3}\n');
      queueMicrotask(() => child.emit("close", 0));
    }
  });
  return child;
}

// --- R1 ---------------------------------------------------------------

test("R1: a local chunk the engine reports as no audio counts as empty", async () => {
  for (const result of [
    { success: false, message: "No audio detected" },
    { success: false, message: "No audio detected", code: "noAudio" },
  ]) {
    const chunk = await transcribeChunk({ provider: "local", localTranscribe: async () => result });
    assert.deepEqual(chunk, { text: "", segments: [], words: [] });
  }
  await assert.rejects(
    transcribeChunk({
      provider: "local",
      localTranscribe: async () => ({ success: false, error: "Model crashed" }),
    }),
    /Model crashed/
  );
});

test("R1: a quiet chunk does not fail the rest of a local call transcript", async (t) => {
  // 130 s splits into two 120 s chunks; the second is room noise the engine
  // rejects as "no audio".
  const a = harness(t, {
    seconds: 130,
    local: (call) =>
      call === 1
        ? { success: true, text: "First part of the call" }
        : { success: false, message: "No audio detected", code: "noAudio" },
  });
  await a.invoke("transcribe", { id: a.meeting.id });
  const result = await settled(a.service.store, a.meeting.id);
  assert.equal(result.status, "ready", result.lastError);
  assert.equal(result.transcript, "First part of the call");
});

// --- R2 ---------------------------------------------------------------

test("R2: a failed call start leaves earlier audio playable and allows another take", async (t) => {
  const root = tempRoot(t, "ss-call-start-");
  const store = new MeetingStore(root);
  const a = store.create();
  fs.writeFileSync(path.join(store.directory(a.id), "input.wav"), wav(1));
  store.update(a.id, {
    status: "recorded",
    recordedDuration: 1,
    audio: [{ file: "input.wav", source: "system", offset: 0 }],
  });
  const children = [];
  const alerts = [];
  const recorder = new MeetingRecorder(store, {
    binary: "/fake",
    spawn: () => {
      const child = fakeChild();
      children.push(child);
      return child;
    },
    freeBytes: () => 100 * GB,
    onAlert: (alert) => alerts.push(alert),
  });
  const failing = recorder.start(a.id);
  children[0].stdout.write('{"event":"error","message":"Permission denied"}\n');
  children[0].emit("close", 1);
  await assert.rejects(failing, /Permission denied/);
  const after = store.get(a.id);
  assert.equal(after.status, "recorded");
  assert.deepEqual(after.audio, [{ file: "input.wav", source: "system", offset: 0 }]);
  assert.equal(after.recordedDuration, 1);
  assert.deepEqual(
    fs.readdirSync(store.directory(a.id)).filter((name) => name.startsWith("take-")),
    []
  );
  assert.equal(alerts.at(-1).reason, "startFailed");

  // A second take is not refused.
  const retry = recorder.start(a.id);
  children[1].stdout.write('{"event":"started"}\n');
  await retry;
  const take = fs.readdirSync(store.directory(a.id)).find((name) => name.startsWith("take-"));
  fs.writeFileSync(path.join(store.directory(a.id), take, "microphone.caf"), "synthetic");
  await recorder.stop(a.id, { requestedBy: "user" });
  const final = store.get(a.id);
  assert.equal(final.status, "recorded");
  // Only the track that was written is registered.
  assert.deepEqual(
    final.audio.map((entry) => entry.file),
    ["input.wav", `${take}/microphone.caf`]
  );
});

test("R2: playback, export inputs and trim skip registered files that were never written", async (t) => {
  const a = harness(t, { seconds: 4 });
  a.service.store.update(a.meeting.id, {
    status: "recorded",
    recordedDuration: 4,
    audio: [
      { file: "input.wav", source: "system", offset: 0 },
      { file: `take-${crypto.randomUUID()}/microphone.caf`, source: "microphone", offset: 0 },
    ],
  });
  const playback = await a.invoke("playback", { id: a.meeting.id });
  assert.match(playback.url, /^ss2-audio:\/\/playback\//);
  const trimmed = await a.invoke("trim", { id: a.meeting.id, end: 2 });
  assert.deepEqual(trimmed.audio, [{ file: "input.wav", source: "system", offset: 0 }]);
});

test("R2: launch recovery drops takes a crashed recorder never wrote", (t) => {
  const root = tempRoot(t, "ss-call-recover-");
  const store = new MeetingStore(root);
  const a = store.create();
  const take = `take-${crypto.randomUUID()}`;
  fs.mkdirSync(path.join(store.directory(a.id), take));
  fs.writeFileSync(path.join(store.directory(a.id), take, "microphone.caf"), "synthetic");
  store.update(a.id, {
    status: "recording",
    audio: [
      { file: `${take}/microphone.caf`, source: "microphone", offset: 0 },
      { file: `${take}/system.caf`, source: "system", offset: 0 },
    ],
  });
  const reopened = new MeetingStore(root).get(a.id);
  assert.equal(reopened.status, "interrupted");
  assert.deepEqual(
    reopened.audio.map((entry) => entry.source),
    ["microphone"]
  );
});

// --- R3 ---------------------------------------------------------------

for (const [label, content] of [
  ["zero-length", ""],
  ["truncated", '{"folders":[],"ids":["'],
  ["wrong shape", "[]"],
]) {
  test(`R3: a ${label} call index is moved aside and rebuilt instead of stopping launch`, (t) => {
    const root = tempRoot(t, "ss-call-index-");
    const first = new MeetingStore(root);
    const older = first.create();
    const newer = first.create();
    first.update(older.id, { createdAt: "2026-01-01T00:00:00.000Z" });
    fs.writeFileSync(path.join(root, "index.json"), content);
    const store = new MeetingStore(root);
    assert.deepEqual(store.index.ids, [newer.id, older.id]);
    assert.equal(store.index.config.provider, "local");
    assert.deepEqual(store.index.folders, []);
    assert.equal(store.get(older.id).id, older.id);
    const aside = fs.readdirSync(root).filter((name) => name.startsWith("index.json.corrupt-"));
    assert.equal(aside.length, 1);
    assert.equal(fs.readFileSync(path.join(root, aside[0]), "utf8"), content);
    // The rebuilt index is valid on the next launch.
    assert.deepEqual(new MeetingStore(root).index.ids, [newer.id, older.id]);
  });
}

test("R3: a zero-length dictation capture settings file falls back to defaults", (t) => {
  const root = tempRoot(t, "ss-capture-settings-");
  new CaptureStore(root);
  fs.writeFileSync(path.join(root, "settings.json"), "");
  const store = new CaptureStore(root);
  assert.equal(store.retentionDays, 7);
  assert.ok(fs.readdirSync(root).some((name) => name.startsWith("settings.json.corrupt-")));
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(root, "settings.json"), "utf8")).retentionDays,
    7
  );
});

test("R3/section 4: session files are written compactly", (t) => {
  const root = tempRoot(t, "ss-call-compact-");
  const store = new MeetingStore(root);
  const a = store.create();
  const raw = fs.readFileSync(path.join(store.directory(a.id), "session.json"), "utf8");
  assert.equal(raw.includes("\n"), false);
  assert.equal(JSON.parse(raw).id, a.id);
});

// --- R4 ---------------------------------------------------------------

function quitApp() {
  const app = new EventEmitter();
  app.quits = 0;
  app.exited = false;
  app.quit = () => {
    app.quits++;
    let prevented = false;
    app.emit("before-quit", { preventDefault: () => (prevented = true) });
    if (!prevented) app.exited = true;
  };
  return app;
}

test("R4: quitting with two recorders active waits for both to finish", async () => {
  const app = quitApp();
  const work = { call: true, screen: true };
  const finishers = {};
  for (const name of ["call", "screen"])
    guardQuit(app, {
      busy: () => work[name],
      drain: () =>
        new Promise((resolve) => {
          finishers[name] = () => {
            work[name] = false;
            resolve();
          };
        }),
    });
  app.quit();
  await new Promise((r) => setImmediate(r));
  assert.equal(app.exited, false);
  finishers.screen();
  await new Promise((r) => setImmediate(r));
  // The screen guard re-quit; the call is still finalizing, so it holds.
  assert.equal(app.exited, false);
  finishers.call();
  await new Promise((r) => setImmediate(r));
  assert.equal(app.exited, true);
});

test("R4: quitting during a mixdown waits for it, and a stuck drain cannot hang quit", async () => {
  const app = quitApp();
  let finalizing = true;
  guardQuit(app, { busy: () => finalizing, drain: () => new Promise(() => {}), maxWaitMs: 20 });
  app.quit();
  assert.equal(app.exited, false);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(app.exited, true);
  finalizing = false;
});

test("R4: the call handler holds quit until the recorder has finalized", async (t) => {
  const a = harness(t);
  let finish;
  const recorder = a.service.recorder;
  let active = a.meeting.id;
  recorder.status = () => ({ id: active });
  recorder.stop = () =>
    new Promise((resolve) => {
      finish = () => {
        active = null;
        resolve();
      };
    });
  let prevented = 0;
  a.app.quit = () => {};
  a.app.emit("before-quit", { preventDefault: () => prevented++ });
  a.app.emit("before-quit", { preventDefault: () => prevented++ });
  assert.equal(prevented, 2);
  await new Promise((r) => setImmediate(r));
  finish();
  await new Promise((r) => setTimeout(r, 300));
  a.app.emit("before-quit", { preventDefault: () => prevented++ });
  assert.equal(prevented, 2);
});

// --- R6 ---------------------------------------------------------------

test("R6: a call will not start with less than 2 GB free", async (t) => {
  const store = new MeetingStore(tempRoot(t, "ss-call-disk-"));
  const a = store.create();
  const recorder = new MeetingRecorder(store, {
    binary: "/fake",
    spawn: () => assert.fail("must not spawn"),
    freeBytes: () => 1.5 * GB,
  });
  await assert.rejects(recorder.start(a.id), (error) => error.code === "disk");
  assert.equal(store.get(a.id).status, "draft");
  assert.deepEqual(store.get(a.id).audio, []);
});

test("R6: a running call stops itself with an alert below 1 GB free", async (t) => {
  const store = new MeetingStore(tempRoot(t, "ss-call-disk-"));
  const a = store.create();
  let free = 100 * GB;
  const alerts = [];
  const child = fakeChild();
  const recorder = new MeetingRecorder(store, {
    binary: "/fake",
    spawn: () => child,
    freeBytes: () => free,
    diskCheckMs: 5,
    onAlert: (alert) => alerts.push(alert),
  });
  const starting = recorder.start(a.id);
  child.stdout.write('{"event":"started"}\n');
  await starting;
  free = 0.5 * GB;
  for (let i = 0; i < 100 && recorder.status().id; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(recorder.status().id, null);
  assert.equal(store.get(a.id).status, "recorded");
  assert.deepEqual(
    alerts.map((alert) => alert.reason),
    ["disk"]
  );
  assert.equal(describeAlert(alerts[0]).title, "Call recording stopped");
});

// --- R7 ---------------------------------------------------------------

test("R7: stale call scratch files are removed at launch; fresh ones and real audio stay", (t) => {
  let ids = {};
  const a = harness(t, {
    beforeRegister: (root) => {
      const store = new MeetingStore(path.join(root, "call-notes"));
      const call = store.create();
      const directory = store.directory(call.id);
      const take = path.join(directory, `take-${crypto.randomUUID()}`);
      fs.mkdirSync(take);
      const old = Date.now() / 1000 - 6 * 3600;
      const names = {
        work: path.join(directory, `work-${crypto.randomUUID()}`),
        trim: path.join(take, `trim-${crypto.randomUUID()}.caf`),
        playbackTmp: path.join(directory, `playback-${crypto.randomUUID()}.tmp.mp3`),
        fresh: path.join(directory, `work-${crypto.randomUUID()}`),
        cache: path.join(directory, `playback-${"b".repeat(64)}.mp3`),
        audio: path.join(take, "microphone.caf"),
      };
      fs.mkdirSync(names.work);
      fs.writeFileSync(path.join(names.work, "chunk-00000.wav"), "synthetic");
      fs.mkdirSync(names.fresh);
      for (const key of ["trim", "playbackTmp", "cache", "audio"])
        fs.writeFileSync(names[key], "synthetic");
      for (const key of ["work", "trim", "playbackTmp", "cache", "audio"])
        fs.utimesSync(names[key], old, old);
      ids = names;
    },
  });
  assert.ok(a.service.store);
  assert.equal(fs.existsSync(ids.work), false);
  assert.equal(fs.existsSync(ids.trim), false);
  assert.equal(fs.existsSync(ids.playbackTmp), false);
  assert.equal(fs.existsSync(ids.fresh), true);
  assert.equal(fs.existsSync(ids.cache), true);
  assert.equal(fs.existsSync(ids.audio), true);
});

test("R7: cleanup skips calls that have a running job", (t) => {
  const store = new MeetingStore(tempRoot(t, "ss-call-clean-"));
  const call = store.create();
  const work = path.join(store.directory(call.id), `work-${crypto.randomUUID()}`);
  fs.mkdirSync(work);
  assert.equal(store.cleanStaleWork({ olderThanMs: 0, busy: (id) => id === call.id }), 0);
  assert.equal(fs.existsSync(work), true);
  assert.equal(store.cleanStaleWork({ olderThanMs: 0, now: Date.now() + 1000 }), 1);
  assert.equal(fs.existsSync(work), false);
});

// --- R8 ---------------------------------------------------------------

test("R8: a trim that fails part-way changes no audio and keeps the cache valid", async (t) => {
  const run = promisify(execFile);
  let calls = 0;
  const a = harness(t, {
    seconds: 6,
    runTrim: async (...args) => {
      if (++calls === 2) throw new Error("ffmpeg failed on the second file");
      return run(...args);
    },
  });
  fs.writeFileSync(path.join(a.directory, "second.wav"), wav(6));
  const cache = { version: 3, signature: "kept", results: { "0:0": { text: "cached" } } };
  a.service.store.update(a.meeting.id, {
    status: "ready",
    recordedDuration: 6,
    audio: [
      { file: "input.wav", source: "system", offset: 0 },
      { file: "second.wav", source: "microphone", offset: 0 },
    ],
    transcriptionCache: cache,
    needsTranscription: false,
  });
  const before = fs.readFileSync(path.join(a.directory, "input.wav"));
  await assert.rejects(a.invoke("trim", { id: a.meeting.id, end: 3 }), /second file/);
  assert.ok(before.equals(fs.readFileSync(path.join(a.directory, "input.wav"))));
  const after = a.service.store.get(a.meeting.id);
  assert.deepEqual(after.transcriptionCache, cache);
  assert.equal(after.needsTranscription, false);
  assert.deepEqual(
    fs.readdirSync(a.directory).filter((name) => name.startsWith("trim-")),
    []
  );
  // A clean retry trims both files.
  calls = 10;
  const trimmed = await a.invoke("trim", { id: a.meeting.id, end: 3 });
  assert.equal(trimmed.transcriptionCache, null);
  for (const name of ["input.wav", "second.wav"])
    assert.ok(Math.abs((await audioDuration(path.join(a.directory, name))) - 3) < 0.2);
});

// --- D10 --------------------------------------------------------------

test("D10: dictation is not queued behind a slow call diarizer", async (t) => {
  let release;
  let started;
  const diarizing = new Promise((resolve) => (started = resolve));
  const words = [{ word: "Hello", start: 0.1, end: 0.4 }];
  const a = harness(t, {
    local: () => ({ success: true, text: "Hello", words }),
    callDiarizer: {
      isAvailable: () => true,
      diarize: () => {
        started();
        return new Promise((resolve) => {
          release = () =>
            resolve({
              probabilities: new Float32Array(100 * 8),
              frames: 100,
              speakers: 8,
              frameSeconds: 0.01,
            });
        });
      },
    },
  });
  await a.invoke("transcribe", { id: a.meeting.id });
  await diarizing;
  const dictation = await Promise.race([
    inferenceScheduler.run(async () => "dictated", { priority: "foreground" }),
    new Promise((resolve) => setTimeout(() => resolve("blocked"), 500)),
  ]);
  assert.equal(dictation, "dictated");
  release();
  assert.equal((await settled(a.service.store, a.meeting.id)).status, "ready");
});

// --- Section 4 --------------------------------------------------------

test("section 4: an uncontended local chunk writes its session file once", async (t) => {
  const a = harness(t, { seconds: 130 });
  const patches = [];
  const update = a.service.store.update.bind(a.service.store);
  a.service.store.update = (id, patch) => {
    patches.push(Object.keys(patch));
    return update(id, patch);
  };
  await a.invoke("transcribe", { id: a.meeting.id });
  assert.equal((await settled(a.service.store, a.meeting.id)).status, "ready");
  // job start, one checkpoint per chunk (2), final result
  assert.equal(patches.length, 4, JSON.stringify(patches));
  assert.equal(patches.filter((keys) => keys.includes("transcriptionCache")).length, 2);
});
