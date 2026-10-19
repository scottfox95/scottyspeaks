#!/usr/bin/env node
/**
 * Exports SS2's settings and data into a single portable archive so the same
 * setup can be restored on another Mac.
 *
 * Includes: preferences (hotkey, models, style/dictation choices), dictation
 * history, custom dictionary, snippets, style profiles, learned style
 * examples, pedal mapping, and API keys (.env).
 *
 * Deliberately excludes the model cache (~/.cache/scottyspeaks) — it is
 * multiple GB and re-downloads on the target machine.
 *
 * Usage: npm run settings:export [-- /output/dir]
 */
const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const USER_DATA = path.join(os.homedir(), "Library", "Application Support", "scotty-speaks");
const ITEMS = ["Local Storage", "transcriptions.db", "pedal-config.json", ".env"];

function appIsRunning() {
  const r = spawnSync("pgrep", ["-f", "SS2.app/Contents/MacOS"], { encoding: "utf8" });
  return r.status === 0 && r.stdout.trim().length > 0;
}

function main() {
  if (!fs.existsSync(USER_DATA)) {
    console.error(`[export] No SS2 data found at ${USER_DATA}`);
    process.exit(1);
  }

  if (appIsRunning()) {
    console.error("[export] SS2 is running — quit it first so the database exports cleanly.");
    process.exit(1);
  }

  // Fold the write-ahead log into the main db so a single file is consistent
  const db = path.join(USER_DATA, "transcriptions.db");
  if (fs.existsSync(db)) {
    try {
      execFileSync("sqlite3", [db, "PRAGMA wal_checkpoint(TRUNCATE);"], { stdio: "ignore" });
    } catch {
      console.warn("[export] Could not checkpoint the database; exporting as-is.");
    }
  }

  const present = ITEMS.filter((item) => fs.existsSync(path.join(USER_DATA, item)));
  if (!present.length) {
    console.error("[export] Nothing to export.");
    process.exit(1);
  }

  const outDir = process.argv[2] || path.join(os.homedir(), "Desktop");
  const stamp = new Date().toISOString().slice(0, 10);
  const outFile = path.join(outDir, `ss2-settings-${stamp}.tar.gz`);

  execFileSync("tar", ["-czf", outFile, "-C", USER_DATA, ...present]);

  const size = (fs.statSync(outFile).size / 1024).toFixed(0);
  console.log(`[export] Wrote ${outFile} (${size} KB)`);
  console.log(`[export] Included: ${present.join(", ")}`);

  // Companion restorer so the target Mac needs nothing installed — no repo,
  // no Node, no npm. Double-clickable in Finder.
  const restorer = path.join(outDir, "SS2-Restore-Settings.command");
  fs.writeFileSync(
    restorer,
    `#!/bin/bash
# Restores SS2 settings exported from another Mac.
# Put this file next to ss2-settings-*.tar.gz and double-click it.
set -e
cd "$(dirname "$0")"

ARCHIVE=$(ls -t ss2-settings-*.tar.gz 2>/dev/null | head -1)
if [ -z "$ARCHIVE" ]; then
  echo "No ss2-settings-*.tar.gz found next to this script."
  echo "Put both files in the same folder and try again."
  read -n 1 -s -r -p "Press any key to close..."
  exit 1
fi

DEST="$HOME/Library/Application Support/scotty-speaks"
echo "Restoring $ARCHIVE"
echo "     into $DEST"
echo

pkill -f "SS2.app/Contents/MacOS" 2>/dev/null || true
sleep 1

# Never overwrite existing data — move it aside first
if [ -e "$DEST/transcriptions.db" ] || [ -e "$DEST/Local Storage" ]; then
  BACKUP="$DEST-backup-$(date +%s)"
  mkdir -p "$BACKUP"
  for item in "Local Storage" transcriptions.db pedal-config.json .env; do
    [ -e "$DEST/$item" ] && mv "$DEST/$item" "$BACKUP/" || true
  done
  echo "Existing data backed up to: $BACKUP"
fi

mkdir -p "$DEST"
rm -f "$DEST/transcriptions.db-wal" "$DEST/transcriptions.db-shm"
tar -xzf "$ARCHIVE" -C "$DEST"

echo
echo "Done. Open SS2 — your hotkey, style, dictionary and history are restored."
echo "Speech and AI models will download on first use."
echo
read -n 1 -s -r -p "Press any key to close..."
`
  );
  fs.chmodSync(restorer, 0o755);
  console.log(`[export] Wrote ${restorer}`);
  console.log("[export] Copy BOTH files to the other Mac, then double-click the .command file.");
}

main();
