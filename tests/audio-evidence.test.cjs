const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AudioEvidence, playbackInputs } = require("../src/helpers/audioEvidence");
test("media capability supports byte ranges, rejects malformed ranges, and revokes access", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ss2-media-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "audio.mp3");
  fs.writeFileSync(file, "0123456789");
  const media = new AudioEvidence();
  const url = media.issue(() => file);
  const response = await media.handle(new Request(url, { headers: { Range: "bytes=3-6" } }));
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), "bytes 3-6/10");
  assert.equal(await response.text(), "3456");
  assert.equal(
    (await media.handle(new Request(url, { headers: { Range: "bytes=99-" } }))).status,
    416
  );
  assert.equal(
    (await media.handle(new Request(url, { headers: { Range: "bytes=0-1,4-5" } }))).status,
    416
  );
  assert.equal(
    await (await media.handle(new Request(url, { headers: { Range: "bytes=-2" } }))).text(),
    "89"
  );
  media.revoke(url);
  assert.equal((await media.handle(new Request(url))).status, 404);
  assert.equal(
    (await media.handle(new Request("ss2-audio://playback/../../etc/passwd"))).status,
    404
  );
});
test("capability cannot follow a replaced symlink and expires", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ss2-media-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "audio.mp3");
  const secret = path.join(root, "not-audio");
  fs.writeFileSync(file, "audio");
  fs.writeFileSync(secret, "secret");
  let now = 0;
  const media = new AudioEvidence({ now: () => now, ttl: 10 });
  const url = media.issue(() => file);
  fs.unlinkSync(file);
  fs.symlinkSync(secret, file);
  assert.equal((await media.handle(new Request(url))).status, 404);
  now = 11;
  assert.equal((await media.handle(new Request(url))).status, 404);
});
test("playback sources preserve take offsets and reject traversal and invalid timing", (t) => {
  const meeting = {
    audio: [
      { file: "take-one/microphone.caf", source: "microphone", offset: 0 },
      { file: "take-two/system.caf", source: "system", offset: 12 },
    ],
  };
  assert.deepEqual(playbackInputs(meeting, "system"), [
    { file: "take-two/system.caf", offset: 12 },
  ]);
  assert.equal(playbackInputs(meeting, "all").length, 2);
  assert.throws(
    () => playbackInputs({ audio: [{ file: "../../secret", offset: 0 }] }),
    /audio file/
  );
  assert.throws(() => playbackInputs({ audio: [{ file: "audio.wav", offset: -2 }] }), /offset/);
});
test("synthetic CAF playback conversion preserves a later take's offset and seeks by range", async (t) => {
  const { execFileSync } = require("node:child_process");
  const ffmpeg = require("ffmpeg-static");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ss2-offset-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync(ffmpeg, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=0.5:sample_rate=16000",
    "-c:a",
    "pcm_s16le",
    path.join(root, "take.caf"),
  ]);
  const media = new AudioEvidence();
  const inputs = playbackInputs(
    { audio: [{ source: "microphone", file: "take.caf", offset: 1 }] },
    "microphone"
  );
  const file = await media.prepare(root, inputs);
  assert.equal(await media.prepare(root, inputs), file);
  const pcm = execFileSync(ffmpeg, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    file,
    "-f",
    "s16le",
    "-ac",
    "1",
    "-ar",
    "16000",
    "pipe:1",
  ]);
  const peak = (from, to) => {
    let p = 0;
    for (let i = from * 16000 * 2; i < Math.min(to * 16000 * 2, pcm.length); i += 2)
      p = Math.max(p, Math.abs(pcm.readInt16LE(i)));
    return p;
  };
  assert.ok(pcm.length / 32000 >= 1.45);
  assert.ok(peak(0, 0.8) < 20, "offset starts with silence");
  assert.ok(peak(1.1, 1.4) > 1000, "tone occurs at its source offset");
  const url = media.issue(() => file);
  const response = await media.handle(new Request(url, { headers: { Range: "bytes=100-199" } }));
  assert.equal(response.status, 206);
  assert.equal((await response.arrayBuffer()).byteLength, 100);
});
