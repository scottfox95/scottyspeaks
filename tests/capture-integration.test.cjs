const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { AudioEvidence } = require("../src/helpers/audioEvidence");
const { registerCaptureHandlers } = require("../src/helpers/captureHandlers");
function harness(t, managers = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ss2-capture-ipc-"));
  const app = new EventEmitter();
  app.getPath = () => root;
  const sender = new EventEmitter();
  sender.id = 1;
  const overlay = new EventEmitter();
  overlay.id = 2;
  const handlers = new Map();
  const media = new AudioEvidence();
  const result = registerCaptureHandlers({
    app,
    ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    windowManager: {
      controlPanelWindow: { webContents: sender },
      mainWindow: { webContents: overlay },
    },
    audioEvidence: media,
    cloudFetch: (...args) => global.fetch(...args),
    ...managers,
  });
  t.after(() => {
    app.emit("before-quit");
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    ...result,
    media,
    sender,
    overlay,
    call: (name, args, owner = sender) => handlers.get(`captures:${name}`)({ sender: owner }, args),
  };
}
const creation = () => ({
  audio: Uint8Array.from([1, 2, 3]).buffer,
  mimeType: "audio/webm",
  durationSeconds: 1,
  settings: { provider: "whisper", model: "tiny", apiKey: "never-save-me" },
});
test("capture IPC confines sender, operation ownership, startup interruption and explicit deletion", async (t) => {
  const h = harness(t);
  assert.equal((await h.call("create", creation(), { id: 88 })).success, false);
  const a = await h.call("create", creation(), h.overlay);
  assert.equal(a.success, true);
  assert.equal(a.data.settings.apiKey, undefined);
  assert.equal((await h.call("complete", { id: a.data.id, rawText: "wrong" })).success, false);
  assert.equal((await h.call("list", {}, h.overlay)).success, false);
  const completed = await h.call(
    "complete",
    { id: a.data.id, rawText: "raw", finalText: "Actual pasted", historyId: 7 },
    h.overlay
  );
  assert.equal(completed.data.finalText, "Actual pasted");
  assert.equal((await h.call("forHistory", { historyId: 7 })).data.id, a.data.id);
  const b = await h.call("create", creation(), h.overlay);
  h.overlay.emit("destroyed");
  assert.equal(h.store.get(b.data.id).status, "failed");
  assert.equal(h.store.get(a.data.id).status, "ready");
  assert.equal(
    (
      await h.call("retry", {
        id: a.data.id,
        provider: "openrouter",
        model: "microsoft/mai-transcribe-2",
      })
    ).success,
    false
  );
  h.store.deleteForHistory(7);
  assert.throws(() => h.store.get(a.data.id));
  assert.equal((await h.call("delete", { id: b.data.id })).success, true);
  assert.equal(h.store.list().length, 0);
});
test("retention changed while playback prepares removes newly built cache and never issues capability", async (t) => {
  const h = harness(t);
  const { data } = await h.call("create", creation());
  let resolve;
  h.media.prepare = () =>
    new Promise((r) => {
      resolve = r;
    });
  const pending = h.call("playback", { id: data.id });
  h.store.setRetentionDays(0);
  const file = path.join(h.store.directory(data.id), `playback-${"a".repeat(64)}.mp3`);
  fs.writeFileSync(file, "synthetic");
  resolve(file);
  assert.equal((await pending).success, false);
  assert.equal(fs.existsSync(file), false);
  assert.equal(h.media.tokens.size, 0);
});
function audioHarness() {
  const vm = require("node:vm");
  const source = fs
    .readFileSync(path.join(__dirname, "../src/helpers/audioManager.js"), "utf8")
    .replace(/^import[\s\S]*?;\n/gm, "")
    .replace("export default AudioManager;", "module.exports = AudioManager;");
  const mod = { exports: {} };
  let serial = 0;
  const events = [];
  const noop = () => {};
  vm.runInNewContext(source, {
    module: mod,
    performance,
    Blob,
    cleanupChoices: require("../src/services/polish/dictationCleanup.ts").cleanupChoices,
    getSettings: () => ({ useLocalWhisper: true, whisperModel: "tiny" }),
    logger: { debug: noop, info: noop, warn: noop, error: noop },
    window: {
      electronAPI: {
        captures: {
          create: async (args) => {
            const id = `capture-${++serial}`;
            events.push({ kind: "create", id, args });
            return { success: true, data: { id } };
          },
          complete: async (args) => {
            events.push({ kind: "complete", ...args });
            return { success: true };
          },
        },
      },
    },
  });
  const audio = Object.create(mod.exports.prototype);
  audio.context = "dictation";
  audio.isProcessing = true;
  audio.releaseLocalInference = async () => {};
  return { audio, events };
}
test("actual renderer pipeline captures only after silence, awaits final pasted/history result and retains failures", async () => {
  const { audio, events } = audioHarness();
  audio._peakRms = 0;
  await audio.processAudio(new Blob(["synthetic"], { type: "audio/webm" }));
  assert.equal(events.length, 0);
  audio.isProcessing = true;
  audio.processWithLocalWhisper = async (_, model, metadata) => {
    metadata.evidence.rawText = "raw untouched";
    return { success: true, text: "polished" };
  };
  audio.onTranscriptionComplete = async (result) => {
    await Promise.resolve();
    result.evidenceFinalText = "exact pasted snippet";
    result.historyId = 99;
  };
  await audio.processAudio(new Blob(["synthetic"], { type: "audio/webm" }));
  assert.equal(events[1].rawText, "raw untouched");
  assert.equal(events[1].finalText, "exact pasted snippet");
  assert.equal(events[1].historyId, 99);
  audio.isProcessing = true;
  audio.processWithLocalWhisper = async () => {
    throw Error("synthetic failure");
  };
  await audio.processAudio(new Blob(["synthetic"], { type: "audio/webm" }));
  assert.match(events[3].error, /failed/);
});
test("cancelled older pipeline cannot paste or finalize newer operation evidence", async () => {
  const { audio, events } = audioHarness();
  const finish = [];
  const delivered = [];
  audio.processWithLocalWhisper = (_, model, metadata) =>
    new Promise((resolve) =>
      finish.push(() => {
        metadata.evidence.rawText = `raw-${finish.length}`;
        resolve({ success: true, text: "text" });
      })
    );
  audio.onTranscriptionComplete = (result) => {
    delivered.push(result.captureId);
    result.evidenceFinalText = "new";
  };
  const first = audio.processAudio(new Blob(["first"], { type: "audio/webm" }));
  while (finish.length < 1) await new Promise(setImmediate);
  audio.cancelProcessing();
  audio.isProcessing = true;
  const second = audio.processAudio(new Blob(["second"], { type: "audio/webm" }));
  while (finish.length < 2) await new Promise(setImmediate);
  finish[0]();
  await first;
  assert.equal(audio.isProcessing, true);
  assert.equal(delivered.length, 0);
  finish[1]();
  await second;
  assert.deepEqual(delivered, ["capture-2"]);
  assert.match(
    events.find((e) => e.kind === "complete" && e.id === "capture-1").error,
    /cancelled/
  );
  assert.equal(events.find((e) => e.kind === "complete" && e.id === "capture-2").finalText, "new");
});
test("actual recording hook saves the exact snippet paste and raw STT with its history ID", async () => {
  const vm = require("node:vm");
  const source = fs.readFileSync(path.join(__dirname, "../src/hooks/useAudioRecording.js"), "utf8");
  const start =
    source.indexOf("onTranscriptionComplete: async (result) => {") +
    "onTranscriptionComplete: ".length;
  const end = source.indexOf("    });\n\n    audioManagerRef.current.setContext", start);
  const callback = source.slice(start, end).trim().replace(/,$/, "");
  const saved = [];
  const audio = {
    safePaste: async (text) => ({ success: true, text: `${text} ` }),
    saveTranscription: async (...args) => {
      saved.push(args);
      return { success: true, transcription: { id: 42 } };
    },
  };
  const fn = vm.runInNewContext(`(${callback})`, {
    commandModeRef: { current: false },
    audioManagerRef: { current: audio },
    setTranscript: () => {},
    performance,
    getSettings: () => ({}),
    logger: { info: () => {} },
    window: { electronAPI: { findSnippet: async () => ({ expansion: "Snippet expansion" }) } },
  });
  const result = { success: true, text: "keyword", rawText: "raw keyword", polished: true };
  await fn(result);
  assert.deepEqual(saved, [["Snippet expansion ", "raw keyword"]]);
  assert.equal(result.historyId, 42);
  assert.equal(result.evidenceFinalText, "Snippet expansion ");
});
test("synthetic local preview keeps original evidence and cancellation removes queued retry work", async (t) => {
  const { execFileSync } = require("node:child_process");
  let calls = 0;
  const h = harness(t, {
    whisperManager: {
      transcribeLocalWhisper: async (_, options) => {
        calls++;
        assert.equal(options.model, "tiny");
        return { success: true, text: "preview only" };
      },
    },
  });
  const wav = execFileSync(require("ffmpeg-static"), [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=0.2",
    "-f",
    "wav",
    "pipe:1",
  ]);
  const { data } = await h.call("create", { ...creation(), audio: wav, mimeType: "audio/wav" });
  await h.call("complete", {
    id: data.id,
    rawText: "original",
    finalText: "original final",
    historyId: 33,
  });
  const preview = await h.call("retry", { id: data.id, provider: "whisper", model: "tiny" });
  assert.equal(preview.success, true);
  assert.equal(preview.data.rawText, "preview only");
  assert.equal(h.store.get(data.id).finalText, "original final");
  assert.equal(
    (await h.call("acceptAttempt", { id: data.id, attemptId: preview.data.id })).data.acceptedText,
    "preview only"
  );
  assert.equal(h.store.get(data.id).finalText, "original final");
  const scheduler = require("../src/helpers/inferenceScheduler").inferenceScheduler;
  const release = scheduler.reserveForeground();
  t.after(release);
  const pending = h.call("retry", { id: data.id, provider: "whisper", model: "tiny" });
  for (let i = 0; i < 200 && !scheduler.status().queued.background; i++)
    await new Promise((r) => setTimeout(r, 5));
  assert.equal(scheduler.status().queued.background, 1);
  assert.equal((await h.call("retryStatus", { id: data.id })).data.stage, "queued");
  await h.call("cancelRetry", { id: data.id });
  assert.equal((await pending).success, false);
  release();
  assert.equal(calls, 1);
  assert.equal((await h.call("retryStatus", { id: data.id })).data.stage, "idle");
  assert.equal(h.store.get(data.id).attempts.length, 1);
  assert.ok(fs.existsSync(h.store.audioPath(data.id)));
  assert.deepEqual(
    fs.readdirSync(h.store.directory(data.id)).filter((name) => name.startsWith("retry-")),
    []
  );
});
test("cloud transcription retry uses the injected desktop network transport", async (t) => {
  const { execFileSync } = require("node:child_process");
  const original = global.fetch;
  global.fetch = () => {
    throw Error("Node fetch must not be used");
  };
  t.after(() => (global.fetch = original));
  let requests = 0;
  const h = harness(t, {
    readCloudKey: () => "synthetic-key",
    cloudFetch: async (url, options) => {
      requests++;
      assert.equal(url, "https://openrouter.ai/api/v1/audio/transcriptions");
      assert.equal(options.headers.Authorization, "Bearer synthetic-key");
      return {
        ok: true,
        json: async () => ({ text: "Proxy-aware retry", segments: [], words: [] }),
      };
    },
  });
  const wav = execFileSync(require("ffmpeg-static"), [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=0.2",
    "-f",
    "wav",
    "pipe:1",
  ]);
  const { data } = await h.call("create", { ...creation(), audio: wav, mimeType: "audio/wav" });
  await h.call("complete", { id: data.id, rawText: "original", finalText: "original" });
  const retry = await h.call("retry", {
    id: data.id,
    provider: "openrouter",
    model: "microsoft/mai-transcribe-2",
    allowCloud: true,
  });
  assert.equal(retry.success, true, retry.error);
  assert.equal(retry.data.rawText, "Proxy-aware retry");
  assert.equal(requests, 1);
});
test("cloud transcription retry fails closed when desktop networking is unavailable", async (t) => {
  const { execFileSync } = require("node:child_process");
  const original = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ text: "Unsafe fallback", segments: [], words: [] }),
  });
  t.after(() => (global.fetch = original));
  const h = harness(t, { readCloudKey: () => "synthetic-key", cloudFetch: null });
  const wav = execFileSync(require("ffmpeg-static"), [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=0.2",
    "-f",
    "wav",
    "pipe:1",
  ]);
  const { data } = await h.call("create", { ...creation(), audio: wav, mimeType: "audio/wav" });
  await h.call("complete", { id: data.id, rawText: "original", finalText: "original" });
  const retry = await h.call("retry", {
    id: data.id,
    provider: "openrouter",
    model: "microsoft/mai-transcribe-2",
    allowCloud: true,
  });
  assert.equal(retry.success, false);
  assert.match(retry.error, /desktop network transport is unavailable/i);
});
function deliveryCallback(audio, api, extras = {}) {
  const vm = require("node:vm");
  const source = fs.readFileSync(path.join(__dirname, "../src/hooks/useAudioRecording.js"), "utf8");
  const start =
    source.indexOf("onTranscriptionComplete: async (result) => {") +
    "onTranscriptionComplete: ".length;
  const end = source.indexOf("    });\n\n    audioManagerRef.current.setContext", start);
  const callback = source
    .slice(start, end)
    .trim()
    .replace(/,$/, "")
    .replace(
      'await import("../services/polish/voiceCommand")',
      "({ applyVoiceCommand: testApplyVoiceCommand })"
    );
  return vm.runInNewContext(`(${callback})`, {
    commandModeRef: { current: false },
    audioManagerRef: { current: audio },
    setTranscript: () => {},
    performance,
    getSettings: () => ({}),
    logger: { info: () => {} },
    toast: () => {},
    window: { electronAPI: api },
    testApplyVoiceCommand: extras.applyVoiceCommand,
    ...extras,
  });
}
test("cancel during actual snippet lookup prevents stale paste and history after a new operation", async () => {
  const { audio, events } = audioHarness();
  const pasted = [],
    saved = [];
  let resolveSnippet;
  audio.safePaste = async (text) => {
    pasted.push(text);
    return { text };
  };
  audio.saveTranscription = async (text) => {
    saved.push(text);
    return { success: true, transcription: { id: 90 } };
  };
  audio.processWithLocalWhisper = async (blob, _, metadata) => {
    const text = await blob.text();
    metadata.evidence.rawText = text;
    metadata.evidence.polished = true;
    return { success: true, text };
  };
  audio.onTranscriptionComplete = deliveryCallback(audio, {
    findSnippet: (text) =>
      text === "old"
        ? new Promise((r) => {
            resolveSnippet = r;
          })
        : Promise.resolve(null),
  });
  const old = audio.processAudio(new Blob(["old"], { type: "audio/webm" }));
  while (!resolveSnippet) await new Promise(setImmediate);
  audio.cancelProcessing();
  audio.isProcessing = true;
  await audio.processAudio(new Blob(["new"], { type: "audio/webm" }));
  resolveSnippet({ expansion: "stale snippet" });
  await old;
  assert.deepEqual(pasted, ["new"]);
  assert.deepEqual(saved, ["new"]);
  const completed = events.filter((event) => event.kind === "complete");
  assert.equal(completed.find((event) => event.id === "capture-2").historyId, 90);
  assert.match(completed.find((event) => event.id === "capture-1").error, /cancelled/);
  assert.equal(completed.find((event) => event.id === "capture-1").finalText, "");
});
test("voice-command reasoning resolution is guarded before replace or history side effects", async () => {
  const { audio } = audioHarness();
  let resolveCommand,
    cancelled = false;
  const writes = [];
  audio.safePaste = async () => writes.push("paste");
  audio.saveTranscription = async () => writes.push("history");
  const callback = deliveryCallback(
    audio,
    { replaceLastPaste: async () => writes.push("replace") },
    {
      commandModeRef: { current: true },
      applyVoiceCommand: () =>
        new Promise((resolve) => {
          resolveCommand = resolve;
        }),
    }
  );
  const pending = callback({
    success: true,
    text: "edit instruction",
    isCancelled: () => cancelled,
  });
  while (!resolveCommand) await new Promise(setImmediate);
  cancelled = true;
  resolveCommand({ ok: true, text: "edited", usedSelection: false });
  await pending;
  assert.deepEqual(writes, []);
});
test("turning retention Off aborts an active retry and removes its derived audio on settle", async (t) => {
  const { execFileSync } = require("node:child_process");
  let finishEngine;
  const h = harness(t, {
    whisperManager: {
      transcribeLocalWhisper: () =>
        new Promise((resolve) => {
          finishEngine = resolve;
        }),
    },
  });
  const wav = execFileSync(require("ffmpeg-static"), [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=0.2",
    "-f",
    "wav",
    "pipe:1",
  ]);
  const { data } = await h.call("create", { ...creation(), audio: wav, mimeType: "audio/wav" });
  const pending = h.call("retry", { id: data.id, provider: "whisper", model: "tiny" });
  while (!finishEngine) await new Promise((r) => setTimeout(r, 5));
  assert.ok(fs.readdirSync(h.store.directory(data.id)).some((name) => name.startsWith("retry-")));
  await h.call("setConfig", { retentionDays: 0 });
  assert.deepEqual(fs.readdirSync(h.store.directory(data.id)), ["capture.json"]);
  finishEngine({ success: true, text: "must not save" });
  assert.equal((await pending).success, false);
  assert.equal(h.store.get(data.id).attempts.length, 0);
  assert.deepEqual(fs.readdirSync(h.store.directory(data.id)), ["capture.json"]);
});
test("exact capture bypasses actual snippet and style delivery rewrites", async () => {
  const pasted = [], saved = [];
  const audio = { safePaste: async (text) => { pasted.push(text); return {text}; },
    saveTranscription: async (text,raw) => { saved.push({text,raw}); return {success:true,transcription:{id:17}}; } };
  const callback = deliveryCallback(audio, {
    findSnippet: async () => { throw Error('Exact mode must not look up snippets'); },
    getActiveStyleProfile: async () => { throw Error('Exact mode must not read current style'); },
  });
  const text = 'um gonna use foo_bar\n\nThe reason was';
  const result = {success:true,text,rawText:text,captureSnapshot:{cleanup:{exact:true},context:{styleRules:{formality:'formal',autoPunctuation:true,greeting:'Hello'}}}};
  await callback(result);
  assert.deepEqual(pasted,[text]); assert.deepEqual(saved,[{text,raw:text}]); assert.equal(result.historyId,17);
});
