const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("fs"),
  vm = require("vm"),
  os = require("os"),
  path = require("path");
const sandbox = { require, module: { exports: {} }, process: { argv: [] } };
vm.runInNewContext(
  fs.readFileSync("scripts/package-share.js", "utf8").replace(/\nmain\(\);\s*$/, "") +
    "\nmodule.exports={archivePath};",
  sandbox
);
test("share refuses mismatched installed version and preserves existing archives", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss2-share-version-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { archivePath } = sandbox.module.exports;
  assert.throws(() => archivePath(dir, "0.3.0", "0.2.1", "2026-09-07"), /version/i);
  const first = archivePath(dir, "0.3.0", "0.3.0", "2026-09-07");
  fs.writeFileSync(first, "older archive");
  const next = archivePath(dir, "0.3.0", "0.3.0", "2026-09-07");
  assert.notEqual(next, first);
  assert.equal(fs.readFileSync(first, "utf8"), "older archive");
});
