#!/usr/bin/env node
/**
 * Restores an archive created by export-settings.js onto this Mac.
 *
 * Any existing SS2 data is moved aside first (never deleted), so an import
 * can always be undone.
 *
 * Usage: npm run settings:import -- ~/Desktop/ss2-settings-2026-07-21.tar.gz
 */
const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const USER_DATA = path.join(os.homedir(), "Library", "Application Support", "scotty-speaks");

function appIsRunning() {
  const r = spawnSync("pgrep", ["-f", "SS2.app/Contents/MacOS"], { encoding: "utf8" });
  return r.status === 0 && r.stdout.trim().length > 0;
}

function main() {
  const archive = process.argv[2];
  if (!archive || !fs.existsSync(archive)) {
    console.error("[import] Usage: npm run settings:import -- <ss2-settings-*.tar.gz>");
    process.exit(1);
  }

  if (appIsRunning()) {
    console.error("[import] SS2 is running — quit it first, then re-run this.");
    process.exit(1);
  }

  // Back up whatever is already here rather than overwriting it
  if (fs.existsSync(USER_DATA)) {
    const existing = ["Local Storage", "transcriptions.db", "pedal-config.json", ".env"].filter(
      (item) => fs.existsSync(path.join(USER_DATA, item))
    );
    if (existing.length) {
      const backup = `${USER_DATA}-backup-${Date.now()}`;
      fs.mkdirSync(backup, { recursive: true });
      for (const item of existing) {
        fs.renameSync(path.join(USER_DATA, item), path.join(backup, item));
      }
      console.log(`[import] Existing data moved to ${backup}`);
    }
  } else {
    fs.mkdirSync(USER_DATA, { recursive: true });
  }

  // Stale WAL/shm files would shadow the imported database
  for (const suffix of ["-wal", "-shm"]) {
    const p = path.join(USER_DATA, `transcriptions.db${suffix}`);
    if (fs.existsSync(p)) fs.rmSync(p, { force: true });
  }

  execFileSync("tar", ["-xzf", archive, "-C", USER_DATA]);

  console.log(`[import] Restored into ${USER_DATA}`);
  console.log("[import] Launch SS2 — your hotkey, style, history and pedal mapping are back.");
  console.log("[import] Models re-download on first use (Settings → Transcription / AI).");
}

main();
