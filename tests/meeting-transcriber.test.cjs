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
test("cloud HTTP errors omit provider response bodies and credentials", async () => {
  await assert.rejects(
    transcribeChunk({
      provider: "openrouter",
      audio: Buffer.from("a"),
      apiKey: "secret",
      fetchImpl: async () => ({ ok: false, status: 401, text: async () => "secret" }),
    }),
    (error) => {
      assert.match(error.message, /401/);
      assert.equal(error.status, 401);
      assert.equal(error.message.includes("secret"), false);
      return true;
    }
  );
});
