const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { MeetingStore, parseTranscript } = require("../src/helpers/meetingStore");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ss-meetings-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, store: new MeetingStore(path.join(root, "data")) };
}
test("drafts survive restart and stale saves cannot replace newer notes", (t) => {
  const { root, store } = fixture(t);
  const a = store.create();
  const b = store.save(a.id, { title: "Review", notes: "Keep this" }, a.revision);
  assert.throws(() => store.save(a.id, { notes: "stale" }, a.revision), /conflict/i);
  assert.equal(new MeetingStore(path.join(root, "data")).get(a.id).notes, "Keep this");
  assert.equal(b.revision, 2);
});
test("filing keeps existing files and detects external edits", (t) => {
  const { root, store } = fixture(t);
  const dir = path.join(root, "project");
  fs.mkdirSync(dir);
  const pin = store.pinFolder(dir);
  const a = store.create();
  store.save(a.id, { title: "Review", notes: "My notes" }, a.revision);
  const first = store.file(a.id, pin.id);
  assert.match(fs.readFileSync(first.path, "utf8"), /My notes/);
  const second = store.create();
  store.save(second.id, { title: "Review" }, second.revision);
  assert.notEqual(store.file(second.id, pin.id).path, first.path);
  fs.writeFileSync(first.path, "Outside edit");
  assert.throws(() => store.file(a.id, pin.id), /outside/i);
  assert.equal(fs.readFileSync(first.path, "utf8"), "Outside edit");
});
test("IDs and unregistered destination paths are rejected", (t) => {
  const { store } = fixture(t);
  assert.throws(() => store.get("../secret"), /invalid/i);
  const a = store.create();
  assert.throws(() => store.file(a.id, "/tmp"), /folder/i);
});
test("recording drafts become interrupted after restart", (t) => {
  const { root, store } = fixture(t);
  const a = store.create();
  store.update(a.id, { status: "recording" });
  assert.equal(new MeetingStore(path.join(root, "data")).get(a.id).status, "interrupted");
});
test("legacy split-diarization calls become eligible for safe retranscription after restart", (t) => {
  const { root, store } = fixture(t);
  const a = store.create();
  store.update(a.id, {
    status: "ready",
    transcript: "Existing transcript",
    needsTranscription: false,
    transcriptionCache: {
      signature: "legacy",
      split: { "0:0": true },
      results: { "0:0/part0": { text: "Existing transcript", segments: [], words: [] } },
    },
  });
  const recovered = new MeetingStore(path.join(root, "data")).get(a.id);
  assert.equal(recovered.status, "ready");
  assert.equal(recovered.transcript, "Existing transcript");
  assert.equal(recovered.needsTranscription, true);
});
test("restart recovers active status and split-diarization eligibility together", (t) => {
  const { root, store } = fixture(t);
  const a = store.create();
  store.update(a.id, {
    status: "transcribing",
    transcript: "Existing transcript",
    needsTranscription: false,
    transcriptionCache: { signature: "legacy", split: { "0:0": true }, results: {} },
  });
  const recovered = new MeetingStore(path.join(root, "data")).get(a.id);
  assert.equal(recovered.status, "interrupted");
  assert.equal(recovered.needsTranscription, true);
});
test("WebVTT import preserves speaker and absolute timestamps", () => {
  const result = parseTranscript(
    "WEBVTT\n\n00:00:01.200 --> 00:00:03.000\n<v Morgan>We should ship Friday.</v>\n\n00:01:04.000 --> 00:01:06.000\nScott: I will review it."
  );
  assert.equal(result.segments[0].speaker, "Morgan");
  assert.equal(result.segments[0].start, 1.2);
  assert.equal(result.segments[1].start, 64);
  assert.match(result.text, /I will review/);
});
test("failed invalid saves leave drafts intact", (t) => {
  const { store } = fixture(t);
  const a = store.create();
  assert.throws(() => store.save(a.id, { notes: "x".repeat(2_000_001) }, a.revision), /large/i);
  assert.equal(store.get(a.id).revision, 1);
});

test("save a copy in the same folder keeps an externally edited original", (t) => {
  const { root, store } = fixture(t);
  const pin = store.pinFolder(root);
  const a = store.create();
  const first = store.file(a.id, pin.id);
  fs.writeFileSync(first.path, "External version");
  const copy = store.file(a.id, pin.id, { asCopy: true });
  assert.notEqual(copy.path, first.path);
  assert.equal(fs.readFileSync(first.path, "utf8"), "External version");
});
