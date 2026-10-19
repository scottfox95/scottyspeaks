#!/usr/bin/env node
/** Install a verified local build, preserving the previous bundle for rollback.
 * User data, model caches, bundle identifier and signing identity stay in place.
 * Usage: npm run install:local (after npm run pack)
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const APP_NAME = "SS2";
const SOURCE = path.join(
  __dirname,
  "..",
  "dist",
  `mac${process.arch === "arm64" ? "-arm64" : ""}`,
  `${APP_NAME}.app`
);
const DEST = `/Applications/${APP_NAME}.app`;
function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
async function main() {
  if (process.platform !== "darwin") throw new Error("Local app installation requires macOS");
  if (!fs.existsSync(SOURCE)) throw new Error(`No packed app at ${SOURCE}; run npm run pack first`);
  run("codesign", ["--verify", "--deep", "--strict", SOURCE]);
  const staged = `/Applications/.SS2-install-${crypto.randomUUID()}.app`;
  let backup;
  try {
    // Finish the copy before stopping the current version or moving its bundle.
    run("ditto", [SOURCE, staged]);
    run("codesign", ["--verify", "--deep", "--strict", staged]);
    let pids = [];
    try {
      pids = run("pgrep", ["-f", "^/Applications/SS2[.]app/Contents/MacOS/SS2($| )"])
        .trim()
        .split(/\s+/)
        .map(Number)
        .filter(Number.isInteger);
    } catch (error) {
      if (error.status !== 1) throw error;
    }
    for (const pid of pids) process.kill(pid, "SIGTERM");
    const running = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const deadline = Date.now() + 10000;
    while (pids.some(running) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 100));
    if (pids.some(running))
      throw new Error(
        "SS2 is still running. Quit it and retry; the installed app has not been replaced."
      );
    if (fs.existsSync(DEST)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      backup = path.join(
        os.homedir(),
        "Library",
        "Application Support",
        "SS2 App Backups.noindex",
        stamp,
        "SS2.app"
      );
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      fs.renameSync(DEST, backup);
    }
    try {
      fs.renameSync(staged, DEST);
    } catch (error) {
      if (backup && !fs.existsSync(DEST)) fs.renameSync(backup, DEST);
      throw error;
    }
    try {
      run(
        "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
        ["-f", DEST]
      );
    } catch {}
    fs.rmSync(SOURCE, { recursive: true, force: true });
    console.log(`[install-local] Installed ${DEST}`);
    if (backup) console.log(`[install-local] Previous app: ${backup}`);
  } finally {
    fs.rmSync(staged, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(`[install-local] ${error.message}`);
  process.exitCode = 1;
});
