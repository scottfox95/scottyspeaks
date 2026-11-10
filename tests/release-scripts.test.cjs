const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const root = path.join(__dirname, "..");
const {
  parsePublishArgs,
  nextVersion,
  compareVersions,
  withPackageVersion,
  withLockfileVersion,
  parseDesignatedRequirement,
  preflightProblems,
} = require("../scripts/lib/release-utils.js");
const { decideSigningAction, isReleaseBuild } = require("../scripts/ensure-signing.js");

const UPDATER = path.join(root, "scripts", "SS2-Update.command");

test("ensure-signing never mints a new identity implicitly", () => {
  const none = { hasKeychainIdentity: false, hasP12: false };
  assert.equal(decideSigningAction({ ...none, allowNew: false, release: false }).action, "fail");
  assert.equal(decideSigningAction({ ...none, allowNew: false, release: true }).action, "fail");
  // The first-time flag works for local setup only, never for a release.
  assert.equal(decideSigningAction({ ...none, allowNew: true, release: false }).action, "mint");
  const rel = decideSigningAction({ ...none, allowNew: true, release: true });
  assert.equal(rel.action, "fail");
  assert.match(rel.error, /release build/i);
  assert.match(rel.error, /Refusing to create a new identity/);
});

test("ensure-signing reuses an existing identity", () => {
  assert.equal(
    decideSigningAction({ hasKeychainIdentity: false, hasP12: true, allowNew: false, release: true }).action,
    "import"
  );
  const unlock = decideSigningAction({ hasKeychainIdentity: true, hasP12: true, allowNew: false, release: true });
  assert.equal(unlock.action, "unlock");
  assert.equal(unlock.warning, undefined);
  // Keychain alone still signs, but a release warns that the backup is gone.
  const noBackup = decideSigningAction({ hasKeychainIdentity: true, hasP12: false, allowNew: false, release: true });
  assert.equal(noBackup.action, "unlock");
  assert.match(noBackup.warning, /missing/);
  assert.equal(
    decideSigningAction({ hasKeychainIdentity: true, hasP12: false, allowNew: false, release: false }).warning,
    undefined
  );
});

test("release mode comes from SS2_RELEASE or --release", () => {
  assert.equal(isReleaseBuild({}, ["node", "x"]), false);
  assert.equal(isReleaseBuild({ SS2_RELEASE: "1" }, ["node", "x"]), true);
  assert.equal(isReleaseBuild({ SS2_RELEASE: "0" }, ["node", "x"]), false);
  assert.equal(isReleaseBuild({}, ["node", "x", "--release"]), true);
});

test("publish arguments keep none/minor working and add --dry-run/--replace", () => {
  assert.deepEqual(parsePublishArgs([]), { kind: "patch", dryRun: false, replace: false });
  assert.equal(parsePublishArgs(["minor"]).kind, "minor");
  assert.equal(parsePublishArgs(["NONE"]).kind, "none");
  assert.deepEqual(parsePublishArgs(["--dry-run", "none", "--replace"]), {
    kind: "none",
    dryRun: true,
    replace: true,
  });
  assert.throws(() => parsePublishArgs(["minro"]), /Unknown argument/);
  assert.throws(() => parsePublishArgs(["minor", "patch"]), /Unknown argument/);
});

test("version bumps", () => {
  assert.equal(nextVersion("0.3.9", "patch"), "0.3.10");
  assert.equal(nextVersion("0.3.14", "minor"), "0.4.0");
  assert.equal(nextVersion("0.3.14", "major"), "1.0.0");
  assert.equal(nextVersion("0.3.14", "none"), "0.3.14");
  assert.throws(() => nextVersion("0.3", "patch"), /x\.y\.z/);
});

test("versions compare numerically", () => {
  assert.equal(compareVersions("0.3.10", "0.3.9"), 1);
  assert.equal(compareVersions("0.3.9", "0.3.10"), -1);
  assert.equal(compareVersions("v1.0.0", "1.0"), 0);
  assert.equal(compareVersions("0.10.0", "0.9.99"), 1);
});

test("version rewrite preserves the repository's JSON formatting", () => {
  const pkgText = fs.readFileSync(path.join(root, "package.json"), "utf8");
  const lockText = fs.readFileSync(path.join(root, "package-lock.json"), "utf8");
  const v = JSON.parse(pkgText).version;
  assert.equal(withPackageVersion(pkgText, v), pkgText);
  assert.equal(withLockfileVersion(lockText, v), lockText);
  const lock = JSON.parse(withLockfileVersion(lockText, "9.8.7"));
  assert.equal(lock.version, "9.8.7");
  assert.equal(lock.packages[""].version, "9.8.7");
  assert.equal(JSON.parse(withPackageVersion(pkgText, "9.8.7")).version, "9.8.7");
});

test("designated requirement parsing", () => {
  const req = 'identifier "com.scottfox.scottyspeaks" and certificate root = H"abc123"';
  assert.equal(parseDesignatedRequirement(`Executable=/x\ndesignated => ${req}\n`), req);
  assert.equal(parseDesignatedRequirement("code object is not signed at all"), null);
});

test("publish preflight blocks dirty trees, missing identity, no gh, and republishing", () => {
  const ok = { porcelain: "", signing: { action: "unlock" }, ghAuthed: true, tagExists: false, tag: "v1.0.0" };
  assert.deepEqual(preflightProblems(ok), []);
  const dirty = preflightProblems({ ...ok, porcelain: " M src/a.js\n?? notes.txt\n" });
  assert.equal(dirty.length, 1);
  assert.match(dirty[0], /not clean[\s\S]*src\/a\.js[\s\S]*notes\.txt/);
  assert.match(preflightProblems({ ...ok, signing: { action: "fail", error: "no identity" } })[0], /no identity/);
  assert.match(preflightProblems({ ...ok, ghAuthed: false })[0], /gh auth login/);
  assert.match(preflightProblems({ ...ok, tagExists: true })[0], /already published/);
  assert.deepEqual(preflightProblems({ ...ok, tagExists: true, replace: true }), []);
});

test("SS2-Update.command is valid bash and uses no python", () => {
  execFileSync("/bin/bash", ["-n", UPDATER]);
  const text = fs.readFileSync(UPDATER, "utf8");
  assert.doesNotMatch(text.replace(/^\s*#.*$/gm, ""), /python/);
  assert.equal(fs.statSync(UPDATER).mode & 0o111, 0o111);
});

test("SS2-Diagnose.command (shipped with each release) is valid bash and uses no python", () => {
  const diag = path.join(root, "scripts", "diagnose.command");
  execFileSync("/bin/bash", ["-n", diag]);
  assert.doesNotMatch(fs.readFileSync(diag, "utf8").replace(/^\s*#.*$/gm, ""), /python/);
});

test("SS2-Update.command never removes the installed app before the new one verifies", () => {
  const text = fs.readFileSync(UPDATER, "utf8");
  assert.doesNotMatch(text, /rm -rf "?\$DEST"?\s*\n\s*ditto/);
  const stagedVerify = text.indexOf('codesign --verify --deep --strict "$STAGED"');
  const moveAside = text.indexOf('mv "$DEST" "$BACKUP"');
  const removeBackup = text.lastIndexOf('rm -rf "$BACKUP"');
  assert.ok(stagedVerify > 0 && moveAside > stagedVerify, "staged copy verifies before the old app moves");
  assert.ok(removeBackup > text.indexOf('codesign --verify --deep --strict "$DEST"'), "backup removed last");
});

test("SS2-Update.command compares versions numerically", () => {
  const cmp = (a, b) => execFileSync("/bin/bash", [UPDATER, "--compare", a, b], { encoding: "utf8" }).trim();
  assert.equal(cmp("0.3.10", "0.3.9"), "newer");
  assert.equal(cmp("0.3.9", "0.3.10"), "older");
  assert.equal(cmp("0.3.14", "0.3.14"), "same");
  assert.equal(cmp("v0.4.0", "0.3.99"), "newer");
  assert.equal(cmp("1.0", "1.0.0"), "same");
  assert.equal(cmp("0.3.08", "0.3.8"), "same");
});

test("SS2-Update.command parses the release JSON without python", { skip: process.platform !== "darwin" }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss2-update-parse-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "release.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      tag_name: "v0.3.15",
      body: "notes with \"quotes\" and\nnewlines",
      assets: [
        { name: "SS2-Diagnose.command", browser_download_url: "https://example.invalid/diag" },
        { name: "SS2-0.3.15.zip", browser_download_url: "https://example.invalid/SS2-0.3.15.zip" },
      ],
    })
  );
  const out = execFileSync("/bin/bash", [UPDATER, "--parse-release", file], { encoding: "utf8" }).split("\n");
  assert.equal(out[0], "0.3.15");
  assert.equal(out[1], "https://example.invalid/SS2-0.3.15.zip");

  fs.writeFileSync(file, JSON.stringify({ tag_name: "v1.0.0", assets: [] }));
  const empty = execFileSync("/bin/bash", [UPDATER, "--parse-release", file], { encoding: "utf8" }).split("\n");
  assert.equal(empty[0], "1.0.0");
  assert.equal(empty[1] || "", "");

  fs.writeFileSync(file, "not json");
  const bad = execFileSync("/bin/bash", [UPDATER, "--parse-release", file], { encoding: "utf8" });
  assert.equal(bad.trim(), "");
});
