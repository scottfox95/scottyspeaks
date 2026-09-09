const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { EventEmitter } = require("node:events");
const { registerMeetingHandlers } = require("../src/helpers/meetingHandlers");
function wav(seconds) {
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
    b.writeInt16LE(Math.round(Math.sin((i * 2 * Math.PI * 440) / 16000) * 6000), 44 + i * 2);
  return b;
}
function setup(t, seconds = 1) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ss-meeting-integration-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = new EventEmitter();
  app.getPath = () => root;
  const handlers = new Map();
  const sender = { mainFrame: {} };
  let localCalls = 0;
  const service = registerMeetingHandlers({
    app,
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    dialog: {},
    shell: {},
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(value),
      decryptString: (value) => value.toString(),
    },
    systemPreferences: {},
    whisperManager: {},
    parakeetManager: {
      transcribeLocalParakeet: async (audio) => {
        localCalls++;
        assert.equal(audio.toString("ascii", 0, 4), "RIFF");
        return { success: true, text: "Synthetic local words" };
      },
    },
    databaseManager: { getDictionary: () => ["Aravo"] },
    windowManager: { controlPanelWindow: { webContents: sender } },
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
  assert.equal(result.transcriptionCache.version, 2);
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
