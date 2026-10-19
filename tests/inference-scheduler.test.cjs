const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const modulePath = path.join(__dirname, "../src/helpers/inferenceScheduler.js");
function scheduler() {
  assert.ok(fs.existsSync(modulePath), "shared local inference scheduler must exist");
  return new (require(modulePath).InferenceScheduler)();
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
test("foreground overtakes queued chunks, serializes engines, and background resumes FIFO", async () => {
  const s = scheduler();
  const gate = deferred();
  const order = [];
  let active = 0;
  const job = (name, wait) =>
    s.run(
      async () => {
        assert.equal(++active, 1);
        order.push(name);
        await wait;
        active--;
        return name;
      },
      { priority: name.startsWith("f") ? "foreground" : "background" }
    );
  const a = job("b1", gate.promise);
  const b = job("b2");
  const c = job("b3");
  const f = job("f1");
  await tick();
  assert.deepEqual(order, ["b1"]);
  assert.equal(s.status().queued.background, 2);
  gate.resolve();
  assert.deepEqual(await Promise.all([a, b, c, f]), ["b1", "b2", "b3", "f1"]);
  assert.deepEqual(order, ["b1", "f1", "b2", "b3"]);
  assert.equal(s.status().active, 0);
});
test("synchronous failure and rejected promises release engine capacity", async () => {
  const s = scheduler();
  await assert.rejects(
    s.run(
      () => {
        throw Error("sync");
      },
      { priority: "foreground" }
    ),
    /sync/
  );
  await assert.rejects(
    s.run(() => Promise.reject(Error("async")), { priority: "background" }),
    /async/
  );
  assert.equal(await s.run(() => 42, { priority: "background" }), 42);
});
test("queued cancellation removes work immediately without running it", async () => {
  const s = scheduler();
  const release = s.reserveForeground();
  const c = new AbortController();
  let calls = 0;
  const pending = s.run(() => calls++, { priority: "background", signal: c.signal });
  const rejection = assert.rejects(pending, { name: "AbortError" });
  c.abort();
  await rejection;
  assert.equal(s.status().queued.background, 0);
  release();
  await tick();
  assert.equal(calls, 0);
  await assert.rejects(
    s.run(() => calls++, { priority: "foreground", signal: c.signal }),
    { name: "AbortError" }
  );
});
test("recording reservation allows foreground work and blocks subsequent background chunks until release", async () => {
  const s = scheduler();
  const release = s.reserveForeground();
  let background = false;
  const b = s.run(
    () => {
      background = true;
    },
    { priority: "background" }
  );
  assert.equal(await s.run(() => "dictation", { priority: "foreground" }), "dictation");
  assert.equal(background, false);
  assert.equal(s.status().foregroundReservations, 1);
  release();
  release();
  await b;
  assert.equal(s.status().foregroundReservations, 0);
});
test("active cancellation never overlaps another engine invocation", async () => {
  const s = scheduler();
  const c = new AbortController();
  const gate = deferred();
  let next = false;
  const a = s.run(() => gate.promise, { priority: "background", signal: c.signal });
  await tick();
  c.abort();
  const b = s.run(
    () => {
      next = true;
    },
    { priority: "foreground" }
  );
  await tick();
  assert.equal(next, false);
  gate.resolve();
  await Promise.all([a, b]);
});
test("falsy rejection reasons remain rejections", async () => {
  const s = scheduler();
  let rejected = false;
  await s
    .run(() => Promise.reject(null), { priority: "foreground" })
    .catch((reason) => {
      rejected = true;
      assert.equal(reason, null);
    });
  assert.equal(rejected, true);
});
function ipcHarness() {
  const vm = require("node:vm");
  const { EventEmitter } = require("node:events");
  const handlers = new Map();
  const sender = new EventEmitter();
  sender.isDestroyed = () => false;
  const noop = () => {};
  const stub = new Proxy(noop, { get: () => stub });
  const mod = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "../src/helpers/ipcHandlers.js"), "utf8"),
    {
      __dirname: path.dirname(modulePath),
      module: mod,
      exports: mod.exports,
      process,
      Buffer,
      URL,
      AbortController,
      setTimeout,
      clearTimeout,
      require: (name) =>
        name === "./inferenceScheduler"
          ? require(modulePath)
          : name === "crypto"
            ? require("node:crypto")
            : name === "electron"
              ? {
                  ipcMain: { handle: (name, fn) => handlers.set(name, fn), on: noop },
                  app: stub,
                  BrowserWindow: stub,
                }
              : stub,
    }
  );
  const calls = [];
  const instance = new mod.exports({
    windowManager: { mainWindow: { webContents: sender } },
    whisperManager: {
      transcribeLocalWhisper: async () => {
        calls.push("whisper");
        return { success: true, text: "synthetic" };
      },
    },
    parakeetManager: {
      transcribeLocalParakeet: async () => {
        calls.push("parakeet");
        return { success: true, text: "synthetic" };
      },
    },
  });
  return { handlers, sender, calls, instance };
}
test("actual dictation handlers share foreground lane and enforce recording reservation owner lifecycle", async () => {
  const h = ipcHarness();
  const s = require(modulePath).inferenceScheduler;
  const reserve = h.handlers.get("local-inference-reserve");
  assert.equal(typeof reserve, "function");
  assert.throws(() => reserve({ sender: {} }), /sender/i);
  const token = reserve({ sender: h.sender });
  assert.equal(s.status().foregroundReservations, 1);
  let background = false;
  const b = s.run(
    () => {
      background = true;
    },
    { priority: "background" }
  );
  for (const channel of ["transcribe-local-whisper", "transcribe-local-parakeet"]) {
    const result = await h.handlers.get(channel)(
      { sender: h.sender },
      Buffer.from("synthetic"),
      {}
    );
    assert.equal(result.success, true);
    assert.equal(background, false);
  }
  assert.deepEqual(h.calls, ["whisper", "parakeet"]);
  assert.throws(() => h.handlers.get("local-inference-release")({ sender: {} }, token), /sender/i);
  h.sender.emit("render-process-gone");
  await b;
  assert.equal(s.status().foregroundReservations, 0);
});
function audioHarness(getUserMedia) {
  const vm = require("node:vm");
  let reserves = 0;
  const released = [];
  const source = fs
    .readFileSync(path.join(__dirname, "../src/helpers/audioManager.js"), "utf8")
    .replace(/^import[\s\S]*?;\n/gm, "")
    .replace("export default AudioManager;", "module.exports = AudioManager;");
  const mod = { exports: {} };
  const noop = () => {};
  vm.runInNewContext(
    fs
      .readFileSync(require.resolve("../src/helpers/recordingActivity"), "utf8")
      .replace(/export /g, "") +
      "\n" +
      source,
    {
      module: mod,
      performance,
      document: { querySelectorAll: () => [] },
      Blob,
      setInterval,
      clearInterval,
      getSettings: () => ({ useLocalWhisper: true }),
      logger: { debug: noop, info: noop, warn: noop },
      window: {
        electronAPI: {
          speech: { beginRecording: async () => "speech", endRecording: async () => {} },
          reserveLocalInference: async () => {
            reserves++;
            return "token";
          },
          releaseLocalInference: async (token) => released.push(token),
        },
      },
      navigator: {
        mediaDevices: {
          getUserMedia:
            getUserMedia ||
            (async () => {
              throw Error("synthetic denied");
            }),
        },
      },
    }
  );
  const audio = Object.create(mod.exports.prototype);
  audio.getAudioConstraints = async () => ({});
  // Snapshot fidelity is covered by the cleanup renderer smoke; this fixture owns reservation lifecycle.
  audio.snapshotCaptureSettings = async () => {};
  return { audio, reserves: () => reserves, released };
}
test("actual recording failure, silence, and cancellation release foreground reservation", async () => {
  const h = audioHarness();
  assert.equal(await h.audio.startRecording(), false);
  assert.equal(h.reserves(), 1);
  assert.deepEqual(h.released, ["token"]);
  h.audio._localInferenceToken = "silence";
  h.audio._peakRms = 0;
  await h.audio.processAudio(new Blob());
  assert.ok(h.released.includes("silence"));
  h.audio._localInferenceToken = "cancel";
  h.audio.mediaRecorder = {
    state: "recording",
    stop() {
      this.onstop();
    },
  };
  h.audio.cancelRecording();
  await tick();
  assert.ok(h.released.includes("cancel"));
});
test("actual local meeting chunk waits on shared lane and queued job cancellation preserves audio", async (t) => {
  const { EventEmitter } = require("node:events");
  const os = require("node:os");
  const { registerMeetingHandlers } = require("../src/helpers/meetingHandlers");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ss-scheduler-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = new EventEmitter();
  app.getPath = () => root;
  const handlers = new Map();
  const sender = { mainFrame: {} };
  let calls = 0;
  const service = registerMeetingHandlers({
    app,
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    dialog: {},
    shell: {},
    safeStorage: {},
    systemPreferences: {},
    whisperManager: {},
    parakeetManager: {
      transcribeLocalParakeet: async () => {
        calls++;
        return { success: true, text: "synthetic" };
      },
    },
    databaseManager: { getDictionary: () => [] },
    windowManager: { controlPanelWindow: { webContents: sender } },
  });
  assert.equal(service.inferenceScheduler, require(modulePath).inferenceScheduler);
  const meeting = service.store.create();
  const audio = Buffer.alloc(32044);
  audio.write("RIFF");
  audio.writeUInt32LE(audio.length - 8, 4);
  audio.write("WAVEfmt ", 8);
  audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20);
  audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(16000, 24);
  audio.writeUInt32LE(32000, 28);
  audio.writeUInt16LE(2, 32);
  audio.writeUInt16LE(16, 34);
  audio.write("data", 36);
  audio.writeUInt32LE(32000, 40);
  for (let i = 0; i < 16000; i++)
    audio.writeInt16LE(Math.round(6000 * Math.sin(i * 0.1)), 44 + i * 2);
  const file = path.join(service.store.directory(meeting.id), "synthetic.wav");
  fs.writeFileSync(file, audio);
  service.store.update(meeting.id, {
    audio: [{ file: "synthetic.wav", source: "system", offset: 0 }],
  });
  const invoke = (name) =>
    handlers.get(`meetings:${name}`)({ sender, senderFrame: sender.mainFrame }, { id: meeting.id });
  const release = service.inferenceScheduler.reserveForeground();
  t.after(release);
  const oldFetch = global.fetch;
  global.fetch = () => {
    throw Error("Network forbidden");
  };
  t.after(() => {
    global.fetch = oldFetch;
  });
  await invoke("transcribe");
  for (let i = 0; i < 500 && service.inferenceScheduler.status().queued.background === 0; i++)
    await new Promise((r) => setTimeout(r, 10));
  assert.equal(service.inferenceScheduler.status().queued.background, 1);
  assert.equal(service.store.get(meeting.id).status, "queued");
  assert.equal((await invoke("delete")).success, false);
  // Even altered display metadata cannot bypass the authoritative job guard.
  service.store.update(meeting.id, { status: "interrupted" });
  assert.equal((await invoke("delete")).success, false);
  service.store.update(meeting.id, { status: "queued" });
  assert.equal(calls, 0);
  await invoke("cancelTranscription");
  for (
    let i = 0;
    i < 500 && ["transcribing", "queued"].includes(service.store.get(meeting.id).status);
    i++
  )
    await new Promise((r) => setTimeout(r, 10));
  assert.equal(service.store.get(meeting.id).status, "interrupted");
  assert.equal(calls, 0);
  assert.equal(service.inferenceScheduler.status().queued.background, 0);
  assert.ok(fs.existsSync(file));
  release();
  await invoke("transcribe");
  for (
    let i = 0;
    i < 500 && ["transcribing", "queued"].includes(service.store.get(meeting.id).status);
    i++
  )
    await new Promise((r) => setTimeout(r, 10));
  assert.equal(service.store.get(meeting.id).status, "ready");
  assert.equal(calls, 1);
});
test("cancel during microphone startup does not allow a second startup to share its reservation", async () => {
  const h = audioHarness();
  const gate = deferred();
  h.audio.getAudioConstraints = () => gate.promise;
  const first = h.audio.startRecording();
  await tick();
  h.audio.cancelRecording();
  const second = h.audio.startRecording();
  await tick();
  const count = h.reserves();
  gate.resolve({});
  await Promise.all([first, second]);
  assert.equal(count, 1);
});
test("actual Whisper and Parakeet IPC defer engine calls until shared active background finishes", async () => {
  const h = ipcHarness();
  const s = require(modulePath).inferenceScheduler;
  const stages = [];
  h.sender.send = (channel, data) => stages.push({ channel, data });
  for (const channel of ["transcribe-local-whisper", "transcribe-local-parakeet"]) {
    const gate = deferred();
    const active = s.run(() => gate.promise, { priority: "background" });
    const count = h.calls.length;
    const pending = h.handlers.get(channel)({ sender: h.sender }, Buffer.from("synthetic"), {
      requestId: channel,
    });
    await tick();
    assert.equal(h.calls.length, count);
    assert.equal(stages.length, count);
    assert.equal(s.status().queued.foreground, 1);
    gate.resolve();
    await active;
    assert.equal((await pending).success, true);
    assert.equal(stages.at(-1).channel, "local-transcription-started");
    assert.equal(stages.at(-1).data.requestId, channel);
  }
});
test("reservation release rejects stale token and navigation clears only main-frame owner", () => {
  const h = ipcHarness();
  const s = require(modulePath).inferenceScheduler;
  const reserve = () => h.handlers.get("local-inference-reserve")({ sender: h.sender });
  const release = (token) => h.handlers.get("local-inference-release")({ sender: h.sender }, token);
  const old = reserve();
  release(old);
  const next = reserve();
  release(old);
  assert.equal(s.status().foregroundReservations, 1);
  h.sender.emit("did-start-navigation", {}, "about:blank", false, false);
  assert.equal(s.status().foregroundReservations, 1);
  h.sender.emit("did-start-navigation", {}, "about:blank", false, true);
  assert.equal(s.status().foregroundReservations, 0);
  release(next);
});
test("disposing a manager during microphone acquisition cancels startup and stops late tracks", async () => {
  const gate = deferred();
  let stopped = 0;
  const h = audioHarness(() => gate.promise);
  const pending = h.audio.startRecording();
  await tick();
  h.audio.cleanup();
  const releasedAtCleanup = [...h.released];
  gate.resolve({ getTracks: () => [{ stop: () => stopped++ }], getAudioTracks: () => [] });
  assert.equal(await pending, false);
  assert.deepEqual(releasedAtCleanup, ["token"]);
  assert.equal(stopped, 1);
  assert.equal(h.audio.isRecording, undefined);
});
test("two manager lifetimes in one renderer retain distinct reservations until each finishes", () => {
  const h = ipcHarness();
  const s = require(modulePath).inferenceScheduler;
  const reserve = () => h.handlers.get("local-inference-reserve")({ sender: h.sender });
  const release = (token) => h.handlers.get("local-inference-release")({ sender: h.sender }, token);
  const oldManager = reserve();
  const newManager = reserve();
  try {
    assert.notEqual(oldManager, newManager);
    assert.equal(s.status().foregroundReservations, 2);
    release(oldManager);
    assert.equal(s.status().foregroundReservations, 1);
    release(oldManager);
    assert.equal(s.status().foregroundReservations, 1);
  } finally {
    h.sender.emit("destroyed");
  }
  assert.equal(s.status().foregroundReservations, 0);
});
