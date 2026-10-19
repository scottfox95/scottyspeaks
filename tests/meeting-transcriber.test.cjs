const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeTranscript, transcribeChunk } = require("../src/helpers/meetingTranscriber");
test("cloud timestamps are offset and speaker identities stay scoped to each chunk", () => {
  const r = normalizeTranscript(
    {
      text: "Hello",
      duration: 2,
      segments: [{ start: 0.5, end: 2, text: "Hello", speaker: 0 }],
      words: [{ start: 0.5, end: 1, word: "Hello", speaker: 0 }],
    },
    120,
    "chunk-2"
  );
  assert.equal(r.segments[0].start, 120.5);
  assert.equal(r.segments[0].speaker, "chunk-2:0");
  assert.equal(r.words[0].speaker, "chunk-2:0");
});
test("malformed and invented timestamps are rejected", () => {
  assert.throws(
    () =>
      normalizeTranscript({ text: "Hi", segments: [{ start: 10, end: 1, text: "Hi" }] }, 0, "a"),
    /timestamp/i
  );
  assert.throws(() => normalizeTranscript({ error: "failed" }, 0, "a"), /transcript/i);
});
test("local mode never calls the cloud transport", async () => {
  const r = await transcribeChunk({
    provider: "local",
    audio: Buffer.from("audio"),
    localTranscribe: async () => ({ success: true, text: "Local words" }),
    fetchImpl: () => {
      throw Error("Network forbidden");
    },
    offset: 30,
    source: "microphone",
    duration: 4,
  });
  assert.equal(r.segments[0].speaker, "microphone");
  assert.equal(r.segments[0].start, 30);
  assert.deepEqual(r.words, []);
  assert.equal(r.timed, undefined);
});
test("local word timings are offset into recording time and malformed words dropped", async () => {
  const r = await transcribeChunk({
    provider: "local",
    audio: Buffer.from("audio"),
    localTranscribe: async () => ({
      success: true,
      text: "Hi there",
      words: [
        { word: "Hi", start: 0.5, end: 0.8 },
        { word: "bad", start: "x", end: 1 },
        { word: "there", start: 1.0, end: 0.9 },
      ],
    }),
    offset: 120,
    source: "combined",
    duration: 4,
  });
  assert.equal(r.timed, true);
  assert.deepEqual(r.words, [
    { word: "Hi", start: 120.5, end: 120.8, speaker: "combined" },
    { word: "there", start: 121, end: 121, speaker: "combined" },
  ]);
});
test("cloud request uses structured speech endpoint, diarization, and secret only in auth header", async () => {
  let request;
  const r = await transcribeChunk({
    provider: "openrouter",
    audio: Buffer.from("audio"),
    apiKey: "test-key",
    offset: 0,
    chunkId: "a",
    duration: 4,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        json: async () => ({
          text: "Hi",
          segments: [{ start: 0, end: 1, text: "Hi", speaker: 0 }],
        }),
      };
    },
  });
  assert.equal(request.url, "https://openrouter.ai/api/v1/audio/transcriptions");
  const body = JSON.parse(request.options.body);
  assert.equal(body.model, "microsoft/mai-transcribe-2");
  assert.equal(body.provider.options.azure.diarization.enabled, true);
  assert.equal(body.response_format, "verbose_json");
  assert.equal(JSON.stringify(body).includes("test-key"), false);
  assert.equal(r.segments[0].text, "Hi");
});
test("cloud request caps Azure phrase hints at the provider limit without changing their order", async () => {
  let body;
  const keywords = Array.from({ length: 58 }, (_, index) => `dictionary-${index + 1}`);
  await transcribeChunk({
    provider: "openrouter",
    audio: Buffer.from("audio"),
    apiKey: "test-key",
    keywords,
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({ text: "Hi", segments: [] }),
      };
    },
  });
  assert.equal(body.provider.options.azure.phraseList.phrases.length, 50);
  assert.equal(body.provider.options.azure.phraseList.phrases[0], "dictionary-1");
  assert.equal(body.provider.options.azure.phraseList.phrases[49], "dictionary-50");
});
test("long recordings receive a duration-aware cloud request deadline", async (t) => {
  const originalTimeout = AbortSignal.timeout;
  const deadlines = [];
  AbortSignal.timeout = (milliseconds) => {
    deadlines.push(milliseconds);
    return new AbortController().signal;
  };
  t.after(() => (AbortSignal.timeout = originalTimeout));
  await transcribeChunk({
    provider: "openrouter",
    audio: Buffer.from("audio"),
    apiKey: "test-key",
    duration: 37 * 60,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ text: "Long call", segments: [] }),
    }),
  });
  assert.deepEqual(deadlines, [222_000]);
});
test("cloud HTTP errors retain a sanitized provider message without credentials", async () => {
  await assert.rejects(
    transcribeChunk({
      provider: "openrouter",
      audio: Buffer.from("a"),
      apiKey: "secret",
      fetchImpl: async () => ({
        ok: false,
        status: 400,
        text: async () =>
          JSON.stringify({
            error: { message: "Invalid phraseList: maximum 50 phrases; token secret" },
            ignored: "provider-internal-data",
          }),
      }),
    }),
    (error) => {
      assert.match(error.message, /400/);
      assert.match(error.message, /Invalid phraseList: maximum 50 phrases/);
      assert.equal(error.status, 400);
      assert.equal(error.providerDetail, "Invalid phraseList: maximum 50 phrases; token [redacted]");
      assert.equal(error.message.includes("secret"), false);
      assert.equal(error.message.includes("provider-internal-data"), false);
      return true;
    }
  );
});
test("cloud diagnostics redact newline-wrapped encoded audio", async () => {
  const encoded = Buffer.alloc(180, 7).toString("base64");
  const wrapped = encoded.match(/.{1,76}/g).join("\n");
  await assert.rejects(
    transcribeChunk({
      provider: "openrouter",
      audio: Buffer.from("a"),
      apiKey: "test-key",
      fetchImpl: async () => ({
        ok: false,
        status: 400,
        text: async () =>
          JSON.stringify({ error: { message: `Invalid audio data:audio/mp3;base64,${wrapped}` } }),
      }),
    }),
    (error) => {
      assert.match(error.providerDetail, /Invalid audio/);
      assert.match(error.providerDetail, /\[audio redacted\]/);
      assert.equal(error.providerDetail.includes(encoded.slice(0, 40)), false);
      assert.equal(error.providerDetail.includes("base64"), false);
      return true;
    }
  );
});
