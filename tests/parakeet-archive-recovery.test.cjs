// R9 (Fable 5.2 review): a corrupt Parakeet archive left by an earlier attempt
// must be replaced, not reused forever. No network: downloads are stubbed.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const downloadUtils = require("../src/helpers/downloadUtils");
const downloads = [];
downloadUtils.downloadFile = async (url, destination) => {
  downloads.push(url);
  fs.writeFileSync(destination, "fresh synthetic archive");
};
downloadUtils.checkDiskSpace = async () => ({ ok: true, availableBytes: Infinity });
const ParakeetManager = require("../src/helpers/parakeet");
const MODEL = "parakeet-tdt-0.6b-v3";

function manager(t, extract) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ss-parakeet-archive-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const m = new ParakeetManager();
  m.getModelsDir = () => root;
  m.serverManager = { isModelDownloaded: () => false, isAvailable: () => false };
  m._extractModel = extract;
  const archive = path.join(root, `${MODEL}.tar.bz2`);
  return { m, archive };
}

test("a reused archive that fails to extract is downloaded again", async (t) => {
  downloads.length = 0;
  const seen = [];
  const { m, archive } = manager(t, async (file) => {
    const content = fs.readFileSync(file, "utf8");
    seen.push(content);
    if (content === "truncated") throw new Error("bzip2: unexpected end of file");
  });
  fs.writeFileSync(archive, "truncated");
  const result = await m.downloadParakeetModel(MODEL);
  assert.equal(result.success, true);
  assert.equal(downloads.length, 1);
  assert.deepEqual(seen, ["truncated", "fresh synthetic archive"]);
  assert.equal(fs.existsSync(archive), false);
});

test("an archive that never extracts is deleted so the next attempt starts fresh", async (t) => {
  downloads.length = 0;
  const { m, archive } = manager(t, async () => {
    throw new Error("tar: damaged archive");
  });
  await assert.rejects(
    m.downloadParakeetModel(MODEL),
    (error) => error.code === "EXTRACTION_FAILED"
  );
  assert.equal(downloads.length, 1);
  assert.equal(fs.existsSync(archive), false);
});
