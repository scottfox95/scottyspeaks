#!/usr/bin/env node
/**
 * One command to ship a new build to every Mac.
 *
 * Order matters, and every step before the GitHub release is a gate:
 *   1. Preflight: clean git tree (untracked files included), signing identity
 *      present (never minted during a release), gh logged in, tag not already
 *      published, then `npm test` and `npm run typecheck`.
 *   2. Bump package.json + package-lock.json and commit it
 *      ("release: SS2 x.y.z"), so the release is built from, and tagged at,
 *      a commit that contains its own version.
 *   3. Pack + sign, then check the build: signature, version, and the same
 *      designated requirement (signing identity) as the installed SS2.
 *   4. Zip the packed app, tag the release commit, push ONLY the tag (never a
 *      branch), and create the GitHub Release.
 *   5. Install locally, and write SS2-Update.command to the Desktop.
 *
 * Other Macs update by double-clicking SS2-Update.command, which pulls from
 * that release — no iCloud, no shared Apple account, nothing to install.
 *
 * Usage: npm run publish                (patch bump: 0.1.0 -> 0.1.1)
 *        npm run publish -- minor       (0.1.0 -> 0.2.0)
 *        npm run publish -- none        (no bump; publish the current version)
 *        npm run publish -- --dry-run   (preflight + tests only, change nothing)
 *        npm run publish -- none --replace  (delete and recreate an existing release)
 *
 * SS2_ALLOW_IDENTITY_CHANGE=1 lets a build signed by a different identity than
 * the installed app through (it resets permissions on every Mac).
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  parsePublishArgs,
  nextVersion,
  withPackageVersion,
  withLockfileVersion,
  parseDesignatedRequirement,
  preflightProblems,
} = require("./lib/release-utils.js");
const { decideSigningAction, signingIdentityState } = require("./ensure-signing.js");

const PROJECT = path.join(__dirname, "..");
const REPO = "scottfox95/scottyspeaks";
const PKG_PATH = path.join(PROJECT, "package.json");
const LOCK_PATH = path.join(PROJECT, "package-lock.json");
const INSTALLED_APP = "/Applications/SS2.app";
const PACKED_APP = path.join(
  PROJECT,
  "dist",
  `mac${process.arch === "arm64" ? "-arm64" : ""}`,
  "SS2.app"
);
const UPDATER_SRC = path.join(__dirname, "SS2-Update.command");
const DIAGNOSE_SRC = path.join(__dirname, "diagnose.command");

// Children build a release: ensure-signing must never mint a new identity.
const RELEASE_ENV = { ...process.env, SS2_RELEASE: "1" };
delete RELEASE_ENV.SS2_ALLOW_NEW_IDENTITY;

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: PROJECT, stdio: "inherit", env: RELEASE_ENV, ...opts });

const capture = (cmd, args) =>
  execFileSync(cmd, args, {
    cwd: PROJECT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: RELEASE_ENV,
  }).trim();

const succeeds = (cmd, args) => {
  try {
    execFileSync(cmd, args, { cwd: PROJECT, stdio: "ignore", env: RELEASE_ENV });
    return true;
  } catch {
    return false;
  }
};

function fail(message) {
  console.error(`\n[publish] ${message}\n`);
  process.exit(1);
}

function designatedRequirement(appPath) {
  try {
    // codesign -d writes to stderr on most macOS versions; merge both.
    const out = execFileSync("codesign", ["-d", "-r-", appPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return parseDesignatedRequirement(out);
  } catch (error) {
    return parseDesignatedRequirement(`${error.stdout || ""}\n${error.stderr || ""}`);
  }
}

function plistValue(appPath, key) {
  return capture("plutil", ["-extract", key, "raw", "-o", "-", path.join(appPath, "Contents", "Info.plist")]);
}

function releaseExists(tag) {
  const remoteTag = succeeds("git", ["ls-remote", "--exit-code", "--tags", "origin", `refs/tags/${tag}`]);
  return remoteTag || succeeds("gh", ["release", "view", tag, "--repo", REPO]);
}

function preflight(opts, version, tag) {
  if (process.platform !== "darwin") fail("Publishing requires macOS.");
  const signing = decideSigningAction({ ...signingIdentityState(), allowNew: false, release: true });
  if (signing.warning) console.warn(`[publish] WARNING: ${signing.warning}`);
  const problems = preflightProblems({
    porcelain: capture("git", ["status", "--porcelain", "--untracked-files=all"]),
    signing,
    ghAuthed: succeeds("gh", ["auth", "status"]),
    tagExists: releaseExists(tag),
    replace: opts.replace,
    tag,
  });
  if (problems.length) fail(`Cannot publish ${version}:\n\n- ${problems.join("\n\n- ")}`);

  console.log("[publish] Running tests and typecheck...");
  try {
    run("npm", ["test"]);
    run("npm", ["run", "typecheck"]);
  } catch {
    fail("Tests or typecheck failed. Nothing was bumped, built or published.");
  }
}

function bumpAndCommit(version, kind) {
  if (kind === "none") return;
  fs.writeFileSync(PKG_PATH, withPackageVersion(fs.readFileSync(PKG_PATH, "utf8"), version));
  fs.writeFileSync(LOCK_PATH, withLockfileVersion(fs.readFileSync(LOCK_PATH, "utf8"), version));
  run("git", ["add", "package.json", "package-lock.json"]);
  run("git", ["commit", "-m", `release: SS2 ${version}`]);
}

function verifyPackedApp(version) {
  if (!fs.existsSync(PACKED_APP)) fail(`No packed app at ${PACKED_APP}.`);
  try {
    run("codesign", ["--verify", "--deep", "--strict", PACKED_APP]);
  } catch {
    fail("The packed app failed its signature check.");
  }
  const built = plistValue(PACKED_APP, "CFBundleShortVersionString");
  if (built !== version) fail(`The packed app is version ${built}, expected ${version}.`);

  if (!fs.existsSync(INSTALLED_APP)) return;
  const want = designatedRequirement(INSTALLED_APP);
  const got = designatedRequirement(PACKED_APP);
  if (want && got !== want) {
    const msg =
      "The new build is signed by a different identity than the installed SS2.\n" +
      `  installed: ${want}\n  new:       ${got}\n` +
      "Every Mac would lose Accessibility, Microphone and Screen Recording on update.";
    if (process.env.SS2_ALLOW_IDENTITY_CHANGE === "1") console.warn(`[publish] WARNING: ${msg}`);
    else fail(`${msg}\nRestore the original identity.p12, or set SS2_ALLOW_IDENTITY_CHANGE=1 if this is intended.`);
  }
}

function main() {
  let opts;
  try {
    opts = parsePublishArgs(process.argv.slice(2));
  } catch (error) {
    fail(error.message);
  }
  const current = JSON.parse(fs.readFileSync(PKG_PATH, "utf8")).version;
  const version = nextVersion(current, opts.kind);
  const tag = `v${version}`;
  console.log(`\n=== ${opts.dryRun ? "Dry run: " : ""}Publishing SS2 ${current} -> ${version} ===\n`);

  preflight(opts, version, tag);

  if (opts.dryRun) {
    console.log(`\n[publish] Dry run passed. A real run would:`);
    if (opts.kind !== "none") console.log(`  - commit "release: SS2 ${version}" (package.json, package-lock.json)`);
    if (opts.replace) console.log(`  - delete the existing ${tag} release and tag`);
    console.log(`  - pack, sign and verify ${PACKED_APP}`);
    console.log(`  - push tag ${tag} only and create the GitHub release on ${REPO}`);
    console.log(`  - install to ${INSTALLED_APP} and write SS2-Update.command to the Desktop`);
    return;
  }

  bumpAndCommit(version, opts.kind);
  const releaseCommit = capture("git", ["rev-parse", "HEAD"]);

  try {
    // `pack` builds the renderer itself; postpack signs (SS2_RELEASE=1).
    run("npm", ["run", "pack"]);
  } catch {
    fail(
      `Build failed. ${opts.kind === "none" ? "" : `The version bump is committed as ${releaseCommit.slice(0, 7)}; `}` +
        "fix the build and rerun with `npm run publish -- none`."
    );
  }
  verifyPackedApp(version);

  // Zip the packed app (install:local consumes dist/, so this comes first)
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "ss2-pub-"));
  const zipPath = path.join(stage, `SS2-${version}.zip`);
  const payload = path.join(stage, "payload");
  fs.mkdirSync(payload);
  execFileSync("ditto", [PACKED_APP, path.join(payload, "SS2.app")]);
  execFileSync("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", payload, zipPath]);

  // Ship the diagnostic and the updater alongside every build
  const diagAsset = path.join(stage, "SS2-Diagnose.command");
  const updaterAsset = path.join(stage, "SS2-Update.command");
  fs.copyFileSync(DIAGNOSE_SRC, diagAsset);
  fs.copyFileSync(UPDATER_SRC, updaterAsset);

  if (opts.replace) {
    console.log(`[publish] Replacing the existing ${tag} release`);
    succeeds("gh", ["release", "delete", tag, "--repo", REPO, "--yes", "--cleanup-tag"]);
    succeeds("git", ["push", "origin", `:refs/tags/${tag}`]);
  }
  succeeds("git", ["tag", "-d", tag]);
  run("git", ["tag", "-a", tag, "-m", `SS2 ${version}`, releaseCommit]);
  // Push the tag only: the release commit travels with it, no branch moves.
  run("git", ["push", "origin", `refs/tags/${tag}`]);

  const notes = `SS2 ${version}\n\nBuilt ${new Date().toDateString()} from ${releaseCommit.slice(0, 7)}.\n\nUpdate by double-clicking SS2-Update.command, or download the zip below.`;
  run("gh", [
    "release", "create", tag, zipPath, diagAsset, updaterAsset,
    "--repo", REPO,
    "--verify-tag",
    "--title", `SS2 ${version}`,
    "--notes", notes,
  ]);

  const mb = (fs.statSync(zipPath).size / 1048576).toFixed(0);
  fs.rmSync(stage, { recursive: true, force: true });

  try {
    run("npm", ["run", "install:local"]);
  } catch {
    console.warn("[publish] WARNING: the release is published, but installing it on this Mac failed.");
  }

  // The updater script — send this to a Mac once
  const desktopUpdater = path.join(os.homedir(), "Desktop", "SS2-Update.command");
  fs.copyFileSync(UPDATER_SRC, desktopUpdater);
  fs.chmodSync(desktopUpdater, 0o755);

  console.log(`\n=== Published ${tag} (${mb} MB) ===`);
  console.log(`Release : https://github.com/${REPO}/releases/tag/${tag}`);
  console.log(`Commit  : ${releaseCommit.slice(0, 7)} (tag pushed; push or merge the branch yourself)`);
  console.log(`Updater : ${desktopUpdater}`);
  console.log(`On any other Mac: double-click SS2-Update.command — it pulls this build.`);
}

main();
