const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const { registerMeetingHandlers } = require("../src/helpers/meetingHandlers");
const { AudioEvidence } = require("../src/helpers/audioEvidence");
function wav(seconds, amplitudeAt = () => 6000) {
  const samples = seconds * 16000;
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
    b.writeInt16LE(
      Math.round(Math.sin((i * 2 * Math.PI * 440) / 16000) * amplitudeAt(i / 16000)),
      44 + i * 2
    );
  return b;
}
function setup(t, seconds = 1, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ss-meeting-integration-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  options.beforeRegister?.(root);
  const app = new EventEmitter();
  app.getPath = () => root;
  const handlers = new Map();
  const sender = { mainFrame: {} };
  let localCalls = 0;
  const service = registerMeetingHandlers({
    app,
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    dialog: options.dialog || {},
    shell: {},
    safeStorage:
      options.safeStorage ||
      {
        isEncryptionAvailable: () => true,
        encryptString: (value) => Buffer.from(value),
        decryptString: (value) => value.toString(),
      },
    systemPreferences: {},
    whisperManager: {},
    parakeetManager: {
      transcribeLocalParakeet: async (audio, request) => {
        localCalls++;
        assert.equal(audio.toString("ascii", 0, 4), "RIFF");
        assert.equal(request.wordTimings, true);
        options.inspectLocalAudio?.(audio);
        return {
          success: true,
          text: options.localText ? options.localText(localCalls) : "Synthetic local words",
          ...(options.localWords ? { words: options.localWords(localCalls) } : {}),
        };
      },
    },
    databaseManager: { getDictionary: () => ["Aravo"] },
    windowManager: { controlPanelWindow: { webContents: sender } },
    audioEvidence: new AudioEvidence(),
    ...(options.callDiarizer ? { callDiarizer: options.callDiarizer } : {}),
    cloudFetch: Object.hasOwn(options, "cloudFetch")
      ? options.cloudFetch
      : (...args) => global.fetch(...args),
  });
  const meeting = service.store.create();
  fs.writeFileSync(path.join(service.store.directory(meeting.id), "input.wav"), wav(seconds));
  service.store.update(meeting.id, { audio: [{ file: "input.wav", source: "system", offset: 0 }] });
  return {
    service,
    meeting,
    localCalls: () => localCalls,
    invoke: async (name, args) => {
      const response = await handlers.get(`meetings:${name}`)(
        { sender, senderFrame: sender.mainFrame },
        args
      );
      if (!response.success) throw Error(response.error);
      return response.data;
    },
  };
}

test("stored OpenRouter key is decrypted only once per app launch", (t) => {
  let decryptCalls = 0;
  const a = setup(t, 1, {
    beforeRegister: (root) => {
      const notesRoot = path.join(root, "call-notes");
      fs.mkdirSync(notesRoot, { recursive: true });
      fs.writeFileSync(path.join(notesRoot, "openrouter-key.enc"), Buffer.from("stored-key"));
    },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(value),
      decryptString: (value) => {
        decryptCalls++;
        return value.toString();
      },
    },
  });

  assert.equal(a.service.readCloudKey(), "stored-key");
  assert.equal(a.service.readCloudKey(), "stored-key");
  assert.equal(decryptCalls, 1);
});

test("failed OpenRouter key decryption is attempted only once per app launch", (t) => {
  let decryptCalls = 0;
  const a = setup(t, 1, {
    beforeRegister: (root) => {
      const notesRoot = path.join(root, "call-notes");
      fs.mkdirSync(notesRoot, { recursive: true });
      fs.writeFileSync(path.join(notesRoot, "openrouter-key.enc"), Buffer.from("stored-key"));
    },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(value),
      decryptString: () => {
        decryptCalls++;
        throw new Error("Keychain access denied");
      },
    },
  });

  assert.throws(() => a.service.readCloudKey(), /Keychain access denied/);
  assert.throws(() => a.service.readCloudKey(), /Keychain access denied/);
  assert.equal(decryptCalls, 1);
});

test("replacing or removing an OpenRouter key updates the in-memory key", async (t) => {
  let decryptCalls = 0;
  const a = setup(t, 1, {
    beforeRegister: (root) => {
      const notesRoot = path.join(root, "call-notes");
      fs.mkdirSync(notesRoot, { recursive: true });
      fs.writeFileSync(path.join(notesRoot, "openrouter-key.enc"), Buffer.from("stored-key"));
    },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(value),
      decryptString: (value) => {
        decryptCalls++;
        return value.toString();
      },
    },
  });

  assert.equal(a.service.readCloudKey(), "stored-key");
  await a.invoke("setConfig", { apiKey: "replacement-key" });
  assert.equal(a.service.readCloudKey(), "replacement-key");
  await a.invoke("setConfig", { apiKey: "" });
  assert.equal(a.service.readCloudKey(), "");
  assert.equal(decryptCalls, 1);
});
async function finished(store, id) {
  for (let i = 0; i < 400; i++) {
    const item = store.get(id);
    if (!["transcribing", "queued"].includes(item.status)) return item;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error("Transcription did not settle");
}
test("local meeting job prepares audio, persists transcript, and never contacts cloud", async (t) => {
  const a = setup(t);
  const original = global.fetch;
  global.fetch = () => {
    throw Error("Network forbidden");
  };
  t.after(() => (global.fetch = original));
  await a.invoke("transcribe", { id: a.meeting.id });
  const result = await finished(a.service.store, a.meeting.id);
  assert.equal(result.status, "ready", result.lastError);
  assert.equal(result.transcript, "Synthetic local words");
  assert.equal(a.localCalls(), 1);
});
test("local meeting job mixes synchronized microphone and call audio into one transcript", async (t) => {
  let mixedPeak = 0;
  const a = setup(t, 1, {
    inspectLocalAudio: (audio) => {
      const data = audio.indexOf("data", 12, "ascii");
      const start = data + 8;
      for (let index = start; data >= 0 && index + 1 < audio.length; index += 2)
        mixedPeak = Math.max(mixedPeak, Math.abs(audio.readInt16LE(index)));
    },
  });
  const directory = a.service.store.directory(a.meeting.id);
  fs.mkdirSync(path.join(directory, "take-one"));
  fs.writeFileSync(path.join(directory, "take-one/microphone.wav"), wav(1));
  fs.writeFileSync(path.join(directory, "take-one/system.wav"), wav(1));
  a.service.store.update(a.meeting.id, {
    audio: [
      { file: "take-one/microphone.wav", source: "microphone", offset: 0 },
      { file: "take-one/system.wav", source: "system", offset: 0 },
    ],
  });
  await a.invoke("transcribe", { id: a.meeting.id });
  const result = await finished(a.service.store, a.meeting.id);
  assert.equal(result.status, "ready", result.lastError);
  assert.equal(a.localCalls(), 1);
  assert.equal(result.transcript, "Synthetic local words");
  assert.deepEqual(
    result.segments.map((segment) => segment.speaker),
    ["combined"]
  );
  assert.ok(mixedPeak >= 5900 && mixedPeak <= 6100, `mixed peak ${mixedPeak}`);
});
// Fake diarizer output from [startSeconds, endSeconds, speaker] spans.
function fakeDiarization(seconds, spans) {
  const speakers = 8;
  const frames = seconds * 100;
  const probabilities = new Float32Array(frames * speakers);
  for (const [start, end, speaker] of spans)
    for (let frame = start * 100; frame < end * 100; frame++)
      probabilities[frame * speakers + speaker] = 0.9;
  return { probabilities, frames, speakers, frameSeconds: 0.01 };
}
function fakeDiarizer(result, calls = []) {
  return {
    calls,
    isAvailable: () => true,
    diarize: async (input, output, { signal }) => {
      calls.push({ input, output });
      assert.ok(signal instanceof AbortSignal);
      const audio = fs.readFileSync(input);
      assert.equal(audio.toString("ascii", 0, 4), "RIFF");
      assert.equal(audio.readUInt32LE(24), 16000);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}
const twoTurns = () => [
  { word: "Hello", start: 0.2, end: 0.6 },
  { word: "there.", start: 0.6, end: 1.2 },
  { word: "Hi", start: 3.4, end: 3.8 },
  { word: "back.", start: 3.8, end: 4.4 },
];
test("local job splits a timed transcript into diarized speaker paragraphs", async (t) => {
  const diarizer = fakeDiarizer(
    fakeDiarization(6, [
      [0, 3, 2],
      [3, 6, 5],
    ])
  );
  const a = setup(t, 6, {
    localText: () => "Hello there. Hi back.",
    localWords: twoTurns,
    callDiarizer: diarizer,
  });
  await a.invoke("transcribe", { id: a.meeting.id });
  const result = await finished(a.service.store, a.meeting.id);
  assert.equal(result.status, "ready", result.lastError);
  assert.equal(diarizer.calls.length, 1);
  assert.deepEqual(
    result.segments.map((s) => [s.speaker, s.text]),
    [
      ["part-0:2", "Hello there."],
      ["part-0:5", "Hi back."],
    ]
  );
  assert.equal(result.transcript, "Hello there.\n\nHi back.");
  assert.deepEqual(result.speakers, { "part-0:2": "", "part-0:5": "" });
  assert.deepEqual(
    result.words.map((w) => w.speaker),
    ["part-0:2", "part-0:2", "part-0:5", "part-0:5"]
  );
});
test("local job labels the speaker carried by the microphone track", async (t) => {
  const diarizer = fakeDiarizer(
    fakeDiarization(6, [
      [0, 3, 0],
      [3, 6, 1],
    ])
  );
  const a = setup(t, 6, {
    localText: () => "Hello there. Hi back.",
    localWords: twoTurns,
    callDiarizer: diarizer,
  });
  const directory = a.service.store.directory(a.meeting.id);
  fs.mkdirSync(path.join(directory, "take-one"));
  // The local talker fills the first half on the mic; the far side the second
  // half on the call track, bleeding into the mic 26dB down.
  fs.writeFileSync(
    path.join(directory, "take-one/microphone.wav"),
    wav(6, (time) => (time < 3 ? 6000 : 300))
  );
  fs.writeFileSync(
    path.join(directory, "take-one/system.wav"),
    wav(6, (time) => (time < 3 ? 0 : 6000))
  );
  a.service.store.update(a.meeting.id, {
    audio: [
      { file: "take-one/microphone.wav", source: "microphone", offset: 0 },
      { file: "take-one/system.wav", source: "system", offset: 0 },
    ],
  });
  await a.invoke("transcribe", { id: a.meeting.id });
  const result = await finished(a.service.store, a.meeting.id);
  assert.equal(result.status, "ready", result.lastError);
  assert.deepEqual(
    result.segments.map((s) => s.speaker),
    ["microphone", "part-0:1"]
  );
});
test("a failed diarization keeps the unattributed local transcript", async (t) => {
  const diarizer = fakeDiarizer(new Error("model load failed"));
  const a = setup(t, 6, {
    localText: () => "Hello there. Hi back.",
    localWords: twoTurns,
    callDiarizer: diarizer,
  });
  await a.invoke("transcribe", { id: a.meeting.id });
  const result = await finished(a.service.store, a.meeting.id);
  assert.equal(result.status, "ready", result.lastError);
  assert.equal(diarizer.calls.length, 1);
  assert.equal(result.transcript, "Hello there. Hi back.");
  assert.deepEqual(
    result.segments.map((s) => s.speaker),
    ["system"]
  );
});
test("local engines without word timings skip diarization", async (t) => {
  const diarizer = fakeDiarizer(fakeDiarization(1, [[0, 1, 0]]));
  const a = setup(t, 1, { callDiarizer: diarizer });
  await a.invoke("transcribe", { id: a.meeting.id });
  const result = await finished(a.service.store, a.meeting.id);
  assert.equal(result.status, "ready", result.lastError);
  assert.equal(diarizer.calls.length, 0);
  assert.equal(result.transcript, "Synthetic local words");
});
test("forced retranscription bypasses cached results and replaces the generated transcript", async (t) => {
  const a = setup(t, 1, { localText: (call) => `Local result ${call}` });
  await a.invoke("transcribe", { id: a.meeting.id });
  assert.equal((await finished(a.service.store, a.meeting.id)).transcript, "Local result 1");
  await a.invoke("transcribe", { id: a.meeting.id, force: true });
  const result = await finished(a.service.store, a.meeting.id);
  assert.equal(a.localCalls(), 2);
  assert.equal(result.transcript, "Local result 2");
});
test("confirmed retranscription replaces a manually edited transcript only after success", async (t) => {
  const a = setup(t, 1, { localText: () => "Fresh machine transcript" });
  a.service.store.save(a.meeting.id, { transcript: "Human edited transcript" }, 2);
  await a.invoke("transcribe", { id: a.meeting.id, force: true });
  const result = await finished(a.service.store, a.meeting.id);
  assert.equal(result.transcript, "Fresh machine transcript");
  assert.equal(result.transcriptEdited, false);
});
test("confirmed retranscription clears speaker names from the superseded transcript", async (t) => {
  const a = setup(t);
  await a.invoke("transcribe", { id: a.meeting.id });
  const first = await finished(a.service.store, a.meeting.id);
  a.service.store.save(a.meeting.id, { speakers: { system: "Old speaker name" } }, first.revision);
  await a.invoke("transcribe", { id: a.meeting.id, force: true });
  const result = await finished(a.service.store, a.meeting.id);
  assert.deepEqual(result.speakers, { system: "" });
});
test("local transcription invalidates version 2 caches from the separate-track layout", async (t) => {
  const a = setup(t, 1, { localText: (call) => `Local layout ${call}` });
  await a.invoke("transcribe", { id: a.meeting.id });
  const first = await finished(a.service.store, a.meeting.id);
  a.service.store.update(a.meeting.id, {
    status: "recorded",
    transcript: "",
    segments: [],
    needsTranscription: true,
    transcriptionCache: {
      ...first.transcriptionCache,
      version: 2,
      results: {
        "0:0": {
          text: "Stale microphone-only words",
          segments: [
            { text: "Stale microphone-only words", start: 0, end: 1, speaker: "microphone" },
          ],
          words: [],
        },
      },
    },
  });
  await a.invoke("transcribe", { id: a.meeting.id });
  const result = await finished(a.service.store, a.meeting.id);
  assert.equal(a.localCalls(), 2);
  assert.equal(result.transcript, "Local layout 2");
  assert.equal(result.transcriptionCache.version, 3);
});
test("audio export saves the selected retained track as a shareable MP3", async (t) => {
  const destination = path.join(os.tmpdir(), `ss-export-${crypto.randomUUID()}.mp3`);
  t.after(() => fs.rmSync(destination, { force: true }));
  const a = setup(t, 1, {
    dialog: {
      showSaveDialog: async () => ({ canceled: false, filePath: destination }),
    },
  });
  const result = await a.invoke("exportAudio", { id: a.meeting.id, source: "system" });
  assert.equal(result.path, destination);
  assert.ok(fs.statSync(destination).size > 100);
  assert.equal(fs.readFileSync(destination).toString("ascii", 0, 3), "ID3");
});
test("cloud meeting job preserves structured speakers and keeps credentials out of readable state", async (t) => {
  const a = setup(t);
  const original = global.fetch;
  let requests = 0;
  global.fetch = async (url, options) => {
    requests++;
    assert.equal(url, "https://openrouter.ai/api/v1/audio/transcriptions");
    assert.equal(options.headers.Authorization, "Bearer synthetic-key");
    assert.equal(JSON.parse(options.body).input_audio.format, "mp3");
    return {
      ok: true,
      json: async () => ({
        text: "Cloud words",
        segments: [{ start: 0, end: 0.8, text: "Cloud words", speaker: 0 }],
        words: [{ start: 0, end: 0.4, word: "Cloud", speaker: 0 }],
      }),
    };
  };
  t.after(() => (global.fetch = original));
  const cfg = await a.invoke("setConfig", { provider: "openrouter", apiKey: "synthetic-key" });
  assert.equal(JSON.stringify(cfg).includes("synthetic-key"), false);
  await a.invoke("transcribe", { id: a.meeting.id });
  const result = await finished(a.service.store, a.meeting.id);
  assert.equal(result.status, "ready", result.lastError);
  assert.equal(requests, 1);
  assert.equal(result.words[0].speaker, result.segments[0].speaker);
  assert.equal(JSON.stringify(result).includes("synthetic-key"), false);
});
test("cloud meeting transcription uses the injected desktop network transport", async (t) => {
  const original = global.fetch;
  global.fetch = () => {
    throw Error("Node fetch must not be used");
  };
  t.after(() => (global.fetch = original));
  let requests = 0;
  const a = setup(t, 1, {
    cloudFetch: async (url, options) => {
      requests++;
      assert.equal(url, "https://openrouter.ai/api/v1/audio/transcriptions");
      assert.equal(options.headers.Authorization, "Bearer synthetic-key");
      return {
        ok: true,
        json: async () => ({
          text: "Proxy-aware cloud words",
          segments: [{ start: 0, end: 0.8, text: "Proxy-aware cloud words", speaker: 0 }],
          words: [],
        }),
      };
    },
  });
  await a.invoke("setConfig", { provider: "openrouter", apiKey: "synthetic-key" });
  await a.invoke("transcribe", { id: a.meeting.id });
  const result = await finished(a.service.store, a.meeting.id);
  assert.equal(result.status, "ready", result.lastError);
  assert.equal(result.transcript, "Proxy-aware cloud words");
  assert.equal(requests, 1);
});
test("cloud meeting transcription fails closed when desktop networking is unavailable", async (t) => {
  const original = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ text: "Unsafe fallback", segments: [], words: [] }),
  });
  t.after(() => (global.fetch = original));
  const a = setup(t, 1, { cloudFetch: null });
  await a.invoke("setConfig", { provider: "openrouter", apiKey: "synthetic-key" });
  await assert.rejects(
    a.invoke("transcribe", { id: a.meeting.id }),
    /desktop network transport is unavailable/i
  );
  assert.equal(a.service.store.get(a.meeting.id).status, "draft");
});
for (const [status, message] of [
  [401, /OpenRouter rejected the API key/i],
  [402, /OpenRouter account needs credit/i],
]) {
  test(`cloud HTTP ${status} explains the account problem`, async (t) => {
    const a = setup(t);
    const original = global.fetch;
    global.fetch = async () => ({ ok: false, status });
    t.after(() => (global.fetch = original));
    await a.invoke("setConfig", { provider: "openrouter", apiKey: "synthetic-key" });
    await a.invoke("transcribe", { id: a.meeting.id });
    const result = await finished(a.service.store, a.meeting.id);
    assert.equal(result.status, "interrupted");
    assert.match(result.lastError, message);
    assert.equal(result.lastErrorCode, status === 401 ? "openrouterAuth" : "openrouterCredit");
  });
}
test("cloud provider diagnostics are retained in sanitized meeting state", async (t) => {
  const a = setup(t);
  const original = global.fetch;
  global.fetch = async () => ({
    ok: false,
    status: 400,
    text: async () =>
      JSON.stringify({ error: { message: "Invalid phraseList: maximum 50 phrases" } }),
  });
  t.after(() => (global.fetch = original));
  await a.invoke("setConfig", { provider: "openrouter", apiKey: "synthetic-key" });
  await a.invoke("transcribe", { id: a.meeting.id });
  const result = await finished(a.service.store, a.meeting.id);
  assert.equal(result.status, "interrupted");
  assert.equal(result.lastErrorDetail, "Invalid phraseList: maximum 50 phrases");
  assert.equal(JSON.stringify(result).includes("synthetic-key"), false);
});
test("an empty OpenRouter response explains that no usable transcript was returned", async (t) => {
  const a = setup(t);
  const original = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({}) });
  t.after(() => (global.fetch = original));
  await a.invoke("setConfig", { provider: "openrouter", apiKey: "synthetic-key" });
  await a.invoke("transcribe", { id: a.meeting.id });
  const result = await finished(a.service.store, a.meeting.id);
  assert.equal(result.status, "interrupted");
  assert.match(result.lastError, /OpenRouter returned no usable transcript/i);
  assert.equal(result.lastErrorCode, "openrouterEmpty");
});
test("a segments-only OpenRouter response reconstructs a usable transcript", async (t) => {
  const a = setup(t);
  const original = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      segments: [{ start: 0, end: 0.8, text: "Transcript from segments", speaker: 0 }],
    }),
  });
  t.after(() => (global.fetch = original));
  await a.invoke("setConfig", { provider: "openrouter", apiKey: "synthetic-key" });
  await a.invoke("transcribe", { id: a.meeting.id });
  const result = await finished(a.service.store, a.meeting.id);
  assert.equal(result.status, "ready", result.lastError);
  assert.equal(result.transcript, "Transcript from segments");
});
test("a whitespace-only cloud retry fails without replacing the prior transcript", async (t) => {
  const a = setup(t);
  a.service.store.update(a.meeting.id, {
    transcript: "Existing transcript",
    segments: [{ text: "Existing transcript", start: 0, end: 1, speaker: "system" }],
    speakers: { system: "Existing speaker" },
    status: "ready",
  });
  const original = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ text: "   ", segments: [] }) });
  t.after(() => (global.fetch = original));
  await a.invoke("setConfig", { provider: "openrouter", apiKey: "synthetic-key" });
  await a.invoke("transcribe", { id: a.meeting.id, force: true });
  const result = await finished(a.service.store, a.meeting.id);
  assert.equal(result.status, "interrupted");
  assert.equal(result.transcript, "Existing transcript");
  assert.deepEqual(result.speakers, { system: "Existing speaker" });
  assert.equal(result.lastErrorCode, "openrouterEmpty");
});
test("retranscription discards legacy split cache and stale speaker identities", async (t) => {
  const a = setup(t);
  const original = global.fetch;
  let requests = 0;
  global.fetch = async () => {
    requests++;
    return {
      ok: true,
      json: async () => ({
        text: requests === 1 ? "Old words" : "Fresh words",
        segments: [
          { start: 0, end: 0.8, text: requests === 1 ? "Old words" : "Fresh words", speaker: 0 },
        ],
        words: [],
      }),
    };
  };
  t.after(() => (global.fetch = original));
  await a.invoke("setConfig", { provider: "openrouter", apiKey: "synthetic-key" });
  await a.invoke("transcribe", { id: a.meeting.id });
  const first = await finished(a.service.store, a.meeting.id);
  const legacyCache = { ...first.transcriptionCache, split: { "0:0": true } };
  delete legacyCache.version;
  a.service.store.update(a.meeting.id, {
    needsTranscription: true,
    transcriptionCache: legacyCache,
    speakers: { ...first.speakers, "part-0-0-part0:7": "Stale voice" },
  });
  await a.invoke("transcribe", { id: a.meeting.id });
  const result = await finished(a.service.store, a.meeting.id);
  assert.equal(requests, 2);
  assert.equal(result.transcript, "Fresh words");
  assert.deepEqual(result.speakers, { "part-0-0:0": "" });
  assert.equal(result.transcriptionCache.version, 3);
});
test("long cloud timeout retries the whole recording without inventing chunk speakers", async (t) => {
  const a = setup(t, 121);
  const original = global.fetch;
  let requests = 0;
  const bodies = [];
  global.fetch = async (_url, options) => {
    requests++;
    bodies.push(JSON.parse(options.body));
    if (requests === 1) {
      const error = Error("timeout");
      error.name = "TimeoutError";
      throw error;
    }
    return {
      ok: true,
      json: async () => ({
        text: "Part words",
        segments: [{ start: 0, end: 0.5, text: "Part words", speaker: 0 }],
      }),
    };
  };
  t.after(() => (global.fetch = original));
  await a.invoke("setConfig", { provider: "openrouter", apiKey: "synthetic-key" });
  await a.invoke("transcribe", { id: a.meeting.id });
  const result = await finished(a.service.store, a.meeting.id);
  assert.equal(result.status, "ready", result.lastError);
  assert.equal(requests, 2);
  assert.equal(bodies[0].input_audio.data, bodies[1].input_audio.data);
  assert.equal(bodies[0].input_audio.format, "mp3");
  assert.deepEqual(bodies[0].provider.options.azure.diarization, { enabled: true });
  assert.deepEqual(bodies[1].provider.options.azure.diarization, { enabled: true });
  assert.equal(result.segments.length, 1);
  assert.equal(result.segments[0].speaker, "part-0-0:0");
});
for (const status of [501, 599]) {
  test(`cloud HTTP ${status} retries the complete request once`, async (t) => {
    const a = setup(t);
    const original = global.fetch;
    let requests = 0;
    global.fetch = async () => {
      requests++;
      if (requests === 1) return { ok: false, status };
      return {
        ok: true,
        json: async () => ({
          text: "Recovered words",
          segments: [{ start: 0, end: 0.5, text: "Recovered words", speaker: 0 }],
        }),
      };
    };
    t.after(() => (global.fetch = original));
    await a.invoke("setConfig", { provider: "openrouter", apiKey: "synthetic-key" });
    await a.invoke("transcribe", { id: a.meeting.id });
    const result = await finished(a.service.store, a.meeting.id);
    assert.equal(result.status, "ready", result.lastError);
    assert.equal(requests, 2);
    assert.equal(result.transcript, "Recovered words");
  });
}
test("a rejected long cloud request fails safely instead of fragmenting diarization", async (t) => {
  const a = setup(t, 121);
  const original = global.fetch;
  let requests = 0;
  global.fetch = async () => {
    requests++;
    return { ok: false, status: 413 };
  };
  t.after(() => (global.fetch = original));
  await a.invoke("setConfig", { provider: "openrouter", apiKey: "synthetic-key" });
  await a.invoke("transcribe", { id: a.meeting.id });
  const result = await finished(a.service.store, a.meeting.id);
  assert.equal(result.status, "interrupted");
  assert.equal(requests, 1);
  assert.deepEqual(result.segments, []);
  assert.match(result.lastError, /413/);
  assert.equal(
    fs.existsSync(path.join(a.service.store.directory(a.meeting.id), "input.wav")),
    true
  );
  global.fetch = async () => {
    requests++;
    return {
      ok: true,
      json: async () => ({
        text: "Recovered whole call",
        segments: [{ start: 0, end: 0.5, text: "Recovered whole call", speaker: 0 }],
      }),
    };
  };
  await a.invoke("transcribe", { id: a.meeting.id });
  const recovered = await finished(a.service.store, a.meeting.id);
  assert.equal(recovered.status, "ready", recovered.lastError);
  assert.equal(requests, 2);
  assert.equal(recovered.segments.length, 1);
  assert.equal(recovered.transcript, "Recovered whole call");
});

for (const editTiming of ["before", "during"]) {
  test(`recognition preserves transcript saved ${editTiming} the job and original machine evidence`, async (t) => {
    const a = setup(t);
    const id = a.meeting.id;
    a.service.store.update(id, { needsTranscription: true });
    const save = (transcript) =>
      a.invoke("save", {
        id,
        patch: { transcript },
        revision: a.service.store.get(id).revision,
      });
    if (editTiming === "before") await save("Human correction before job");
    const original = global.fetch;
    t.after(() => (global.fetch = original));
    let release, started;
    const pending = new Promise((resolve) => (release = resolve));
    const entered = new Promise((resolve) => (started = resolve));
    global.fetch = async () => {
      started();
      await pending;
      return {
        ok: true,
        json: async () => ({
          text: "Machine evidence",
          segments: [{ start: 0, end: 0.8, text: "Machine evidence", speaker: 0 }],
          words: [{ start: 0, end: 0.4, word: "Machine", speaker: 0 }],
        }),
      };
    };
    await a.invoke("setConfig", { provider: "openrouter", apiKey: "synthetic-key" });
    await a.invoke("transcribe", { id });
    await entered;
    try {
      if (editTiming === "during") await save("Human correction during job");
    } finally {
      release();
    }
    const result = await finished(a.service.store, id);
    assert.equal(result.status, "ready", result.lastError);
    assert.equal(result.transcript, `Human correction ${editTiming} job`);
    assert.equal(result.transcriptEdited, true);
    assert.equal(result.needsTranscription, false);
    assert.equal(result.segments[0].text, "Machine evidence");
    assert.equal(result.words[0].word, "Machine");
    assert.equal(fs.existsSync(path.join(a.service.store.directory(id), "input.wav")), true);
  });
}
function shapedWav(seconds, amplitudeAt) {
  const samples = seconds * 16000;
  const b = wav(0);
  const out = Buffer.alloc(44 + samples * 2);
  b.copy(out, 0, 0, 44);
  out.writeUInt32LE(out.length - 8, 4);
  out.writeUInt32LE(samples * 2, 40);
  let seed = 7;
  for (let i = 0; i < samples; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const noise = (seed / 0x7fffffff - 0.5) * 2;
    const tone = Math.sin((i * 2 * Math.PI * 220) / 16000);
    const amplitude = amplitudeAt(i / 16000);
    out.writeInt16LE(
      Math.round(amplitude > 100 ? tone * amplitude : noise * amplitude),
      44 + i * 2
    );
  }
  return out;
}
test("a silent cloud chunk does not discard the parts of the call that were transcribed", async (t) => {
  const a = setup(t);
  const directory = a.service.store.directory(a.meeting.id);
  for (const take of ["take-a", "take-b"]) {
    fs.mkdirSync(path.join(directory, take));
    fs.writeFileSync(path.join(directory, take, "microphone.wav"), wav(1));
  }
  a.service.store.update(a.meeting.id, {
    audio: [
      { file: "take-a/microphone.wav", source: "microphone", offset: 0 },
      { file: "take-b/microphone.wav", source: "microphone", offset: 1 },
    ],
  });
  const original = global.fetch;
  let requests = 0;
  global.fetch = async () => {
    requests++;
    return requests === 1
      ? {
          ok: true,
          json: async () => ({
            text: "Bye guys",
            segments: [{ start: 0, end: 0.5, text: "Bye guys" }],
          }),
        }
      : { ok: true, json: async () => ({ text: "" }) };
  };
  t.after(() => (global.fetch = original));
  await a.invoke("setConfig", { provider: "openrouter", apiKey: "synthetic-key" });
  await a.invoke("transcribe", { id: a.meeting.id });
  const result = await finished(a.service.store, a.meeting.id);
  assert.equal(result.status, "ready", result.lastError);
  assert.equal(requests, 2);
  assert.equal(result.transcript, "Bye guys");
});
test("a call whose every cloud chunk is empty still reports no usable transcript and retries cleanly", async (t) => {
  const a = setup(t);
  const directory = a.service.store.directory(a.meeting.id);
  for (const take of ["take-a", "take-b"]) {
    fs.mkdirSync(path.join(directory, take));
    fs.writeFileSync(path.join(directory, take, "microphone.wav"), wav(1));
  }
  a.service.store.update(a.meeting.id, {
    audio: [
      { file: "take-a/microphone.wav", source: "microphone", offset: 0 },
      { file: "take-b/microphone.wav", source: "microphone", offset: 1 },
    ],
  });
  const original = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ text: "" }) });
  t.after(() => (global.fetch = original));
  await a.invoke("setConfig", { provider: "openrouter", apiKey: "synthetic-key" });
  await a.invoke("transcribe", { id: a.meeting.id });
  const result = await finished(a.service.store, a.meeting.id);
  assert.equal(result.lastErrorCode, "openrouterEmpty");
  assert.deepEqual(result.transcriptionCache.results, {});
});
test("speech analysis suggests trimming where the conversation went quiet", async (t) => {
  const a = setup(t);
  const directory = a.service.store.directory(a.meeting.id);
  // 30s room noise, 40s of talking, then 180s of room noise.
  fs.writeFileSync(
    path.join(directory, "input.wav"),
    shapedWav(250, (time) => (time >= 30 && time < 70 ? 8000 : 300))
  );
  const analysis = await a.invoke("analyzeSpeech", { id: a.meeting.id });
  assert.ok(Math.abs(analysis.duration - 250) < 1, String(analysis.duration));
  assert.equal(analysis.segments.length, 1);
  assert.ok(analysis.segments[0].start >= 25 && analysis.segments[0].start <= 35);
  assert.ok(Math.abs(analysis.segments[0].end - 70) <= 1);
  assert.equal(analysis.suggestions.length, 1);
  assert.ok(Math.abs(analysis.suggestions[0].end - 75) <= 1);
  assert.equal(analysis.suggestions[0].resumesAt, null);
});
test("trimming shortens saved audio, drops later takes, and invalidates cached transcription", async (t) => {
  const a = setup(t, 10);
  const directory = a.service.store.directory(a.meeting.id);
  fs.mkdirSync(path.join(directory, "take-late"));
  fs.writeFileSync(path.join(directory, "take-late", "microphone.wav"), wav(2));
  fs.writeFileSync(path.join(directory, `playback-${"a".repeat(64)}.mp3`), "stale");
  a.service.store.update(a.meeting.id, {
    audio: [
      { file: "input.wav", source: "system", offset: 0 },
      { file: "take-late/microphone.wav", source: "microphone", offset: 10 },
    ],
    recordedDuration: 12,
    status: "interrupted",
    lastError: "OpenRouter returned no usable transcript.",
    lastErrorCode: "openrouterEmpty",
    transcriptionCache: { version: 3, signature: "x", results: { "0:0": { text: "old" } } },
  });
  await assert.rejects(a.invoke("trim", { id: a.meeting.id, end: 0 }), /Invalid trim point/);
  const result = await a.invoke("trim", { id: a.meeting.id, end: 4 });
  assert.deepEqual(result.audio, [{ file: "input.wav", source: "system", offset: 0 }]);
  assert.equal(result.recordedDuration, 4);
  assert.equal(result.transcriptionCache, null);
  assert.equal(result.needsTranscription, true);
  assert.equal(result.lastErrorCode, null);
  assert.equal(fs.existsSync(path.join(directory, "take-late")), false);
  assert.equal(fs.existsSync(path.join(directory, `playback-${"a".repeat(64)}.mp3`)), false);
  const { audioDuration } = require("../src/helpers/meetingTranscriber");
  assert.ok(Math.abs((await audioDuration(path.join(directory, "input.wav"))) - 4) < 0.2);
  await a.invoke("transcribe", { id: a.meeting.id });
  assert.equal((await finished(a.service.store, a.meeting.id)).status, "ready");
});
test("auto-stop is a validated call setting that defaults to two minutes", async (t) => {
  const a = setup(t);
  assert.equal((await a.invoke("getConfig")).autoStopMinutes, 2);
  assert.equal((await a.invoke("setConfig", { autoStopMinutes: 0 })).autoStopMinutes, 0);
  await assert.rejects(a.invoke("setConfig", { autoStopMinutes: 3 }), /auto-stop/);
});
