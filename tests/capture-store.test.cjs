const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { CaptureStore } = require("../src/helpers/captureStore");
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ss2-captures-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let now = Date.UTC(2026, 8, 7);
  return {
    root,
    store: new CaptureStore(root, { now: () => now }),
    advance: (days) => {
      now += days * 86400000;
    },
  };
}
const input = () => ({
  audio: Buffer.from("synthetic audio"),
  mimeType: "audio/webm;codecs=opus",
  durationSeconds: 2,
  settings: {
    provider: "local",
    model: "base",
    language: "en",
    cleanup: { exact: true },
    styleId: "7", styleName: "Technical", polishModel: "qwen-test", polishProvider: "local",
    dictionary: ["foo_bar", "SS2_API_KEY"],
    styleRules: { aiPolish: false, instructions: "Preserve syntax", apiKey: "must-not-persist" },
    apiKey: "must-not-persist",
  },
});
test("capture persists original audio and allowlisted snapshot across reload", (t) => {
  const { root, store } = setup(t);
  const capture = store.create(input());
  store.complete(capture.id, {
    rawText: "first\n\nsecond",
    finalText: "First\n\nSecond",
    historyId: 42,
  });
  const again = new CaptureStore(root).forHistory(42);
  assert.equal(again.rawText, "first\n\nsecond");
  assert.deepEqual(fs.readFileSync(store.audioPath(capture.id)), input().audio);
  assert.equal(again.settings.apiKey, undefined);
  assert.equal(again.settings.styleRules.apiKey, undefined);
  assert.deepEqual(again.settings.dictionary, ["foo_bar", "SS2_API_KEY"]);
  assert.equal(again.settings.styleId, "7");
  assert.equal(again.settings.styleRules.aiPolish, false);
  assert.equal(
    fs
      .readFileSync(path.join(root, capture.id, "capture.json"), "utf8")
      .includes("must-not-persist"),
    false
  );
});
test("retry previews and accepted repairs never overwrite source evidence", (t) => {
  const { store } = setup(t);
  const c = store.create(input());
  store.complete(c.id, { rawText: "aravo", finalText: "aravo", historyId: 1 });
  const preview = store.addAttempt(c.id, {
    provider: "local",
    model: "turbo",
    rawText: "Aravo",
    finalText: "Aravo",
  });
  assert.equal(store.get(c.id).finalText, "aravo");
  store.acceptAttempt(c.id, preview.id);
  assert.equal(store.get(c.id).acceptedText, "Aravo");
  assert.equal(store.get(c.id).rawText, "aravo");
  assert.throws(
    () => store.complete(c.id, { rawText: "overwrite", finalText: "overwrite" }),
    /already finalized/
  );
});
test("retention removes audio while keeping transcript, attempts and metadata", (t) => {
  const { store, advance } = setup(t);
  const c = store.create(input());
  store.complete(c.id, { rawText: "hello", finalText: "Hello" });
  const cache = path.join(store.directory(c.id), `playback-${"a".repeat(64)}.mp3`);
  fs.writeFileSync(cache, "cached audio");
  advance(8);
  store.prune();
  assert.equal(fs.existsSync(cache), false);
  assert.equal(store.get(c.id).audioAvailable, false);
  assert.equal(store.get(c.id).audioUnavailableReason, "expired");
  assert.equal(store.get(c.id).rawText, "hello");
  assert.throws(() => store.audioPath(c.id), /unavailable/);
});
test("disabled retention keeps no audio and invalid policies do not change settings", (t) => {
  const { store } = setup(t);
  store.setRetentionDays(0);
  const c = store.create(input());
  assert.equal(c.audioAvailable, false);
  assert.equal(c.audioUnavailableReason, "disabled");
  assert.throws(() => store.setRetentionDays(-1), /retention/);
  assert.equal(store.retentionDays, 0);
});
test("explicit wrong-output fixture preserves source and expected text after audio expiry", (t) => {
  const { store, advance } = setup(t);
  const c = store.create(input());
  store.complete(c.id, { rawText: "aravo", finalText: "aravo" });
  const fixture = store.saveFixture(c.id, "Aravo");
  const record = JSON.parse(fs.readFileSync(fixture.path, "utf8"));
  assert.equal(record.expected, "Aravo");
  assert.equal(record.rawText, "aravo");
  advance(8);
  store.prune();
  assert.ok(fs.existsSync(path.join(path.dirname(fixture.path), record.audioFile)));
});
test("rejects path traversal, symlink escape and oversized metadata", (t) => {
  const { root, store } = setup(t);
  const c = store.create(input());
  assert.throws(() => store.get("../secret"), /ID/);
  assert.throws(() => store.create({ ...input(), settings: { model: "x".repeat(1000) } }), /model/);
  const audio = store.audioPath(c.id);
  fs.unlinkSync(audio);
  fs.symlinkSync(path.join(root, "settings.json"), audio);
  assert.throws(() => store.audioPath(c.id), /regular file/);
});
test("restart removes abandoned retry and playback work even for already unavailable audio", (t) => {
  const { root, store } = setup(t);
  const capture = store.create(input());
  store.setRetentionDays(0);
  const dir = store.directory(capture.id);
  const retry = `retry-${require("node:crypto").randomUUID()}`;
  const playback = `playback-${require("node:crypto").randomUUID()}.tmp.mp3`;
  fs.mkdirSync(path.join(dir, retry));
  fs.writeFileSync(path.join(dir, retry, "chunk-00000.wav"), "recoverable audio");
  fs.writeFileSync(path.join(dir, playback), "recoverable audio");
  fs.writeFileSync(path.join(dir, "keep.txt"), "not generated work");
  const restarted = new CaptureStore(root);
  assert.equal(fs.existsSync(path.join(dir, retry)), false);
  assert.equal(fs.existsSync(path.join(dir, playback)), false);
  assert.equal(fs.existsSync(path.join(dir, "keep.txt")), true);
  restarted.prune();
  assert.equal(restarted.get(capture.id).audioAvailable, false);
});
test("expiry removes derived copies and confined cleanup never follows work directory links", (t) => {
  const { root, store, advance } = setup(t);
  const capture = store.create(input());
  const dir = store.directory(capture.id);
  const external = path.join(root, "outside");
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, "keep.wav"), "external");
  fs.symlinkSync(external, path.join(dir, `retry-${require("node:crypto").randomUUID()}`));
  fs.writeFileSync(
    path.join(dir, `playback-${require("node:crypto").randomUUID()}.tmp.mp3`),
    "derived"
  );
  advance(8);
  store.prune();
  assert.equal(fs.readFileSync(path.join(external, "keep.wav"), "utf8"), "external");
  assert.deepEqual(fs.readdirSync(dir), ["capture.json"]);
  assert.equal(store.get(capture.id).audioUnavailableReason, "expired");
});
test("explicit fixtures can be listed and deleted independently of capture/audio retention", (t) => {
  const { store } = setup(t);
  const capture = store.create(input());
  const saved = store.saveFixture(capture.id, "corrected text");
  store.delete(capture.id);
  const list = store.listFixtures();
  assert.equal(list.length, 1);
  assert.deepEqual(Object.keys(list[0]).sort(), ["captureId", "createdAt", "expected", "id"]);
  assert.equal(list[0].expected, "corrected text");
  assert.equal(list[0].id, saved.id);
  assert.throws(() => store.deleteFixture("../outside"), /Invalid/);
  const outside = path.join(store.root, "outside");
  fs.mkdirSync(outside);
  const linkId = require("node:crypto").randomUUID();
  fs.symlinkSync(outside, path.join(store.root, "fixtures", linkId));
  assert.throws(() => store.deleteFixture(linkId), /Invalid/);
  assert.equal(fs.existsSync(outside), true);
  store.deleteFixture(saved.id);
  assert.equal(fs.existsSync(path.dirname(saved.path)), false);
  assert.deepEqual(store.listFixtures(), []);
});
