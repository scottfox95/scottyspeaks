#!/usr/bin/env node
/**
 * One command to ship a new build to every Mac.
 *
 * Bumps the version, builds, signs, installs locally, and publishes the zip as
 * a GitHub Release. Other Macs update by double-clicking SS2-Update.command,
 * which pulls from that release — no iCloud, no shared Apple account, and
 * nothing to install on the target machine.
 *
 * Usage: npm run publish            (patch bump: 0.1.0 -> 0.1.1)
 *        npm run publish -- minor   (0.1.0 -> 0.2.0)
 *        npm run publish -- none    (no bump, just re-publish)
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PROJECT = path.join(__dirname, "..");
const REPO = "scottfox95/scottyspeaks";

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: PROJECT, stdio: "inherit", ...opts });

const capture = (cmd, args) =>
  execFileSync(cmd, args, { cwd: PROJECT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

function bumpVersion(kind) {
  const pkgPath = path.join(PROJECT, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  if (kind === "none") return pkg.version;

  const [maj, min, pat] = pkg.version.split(".").map(Number);
  const next =
    kind === "major" ? `${maj + 1}.0.0` : kind === "minor" ? `${maj}.${min + 1}.0` : `${maj}.${min}.${pat + 1}`;
  pkg.version = next;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  return next;
}

const UPDATER = `#!/bin/bash
# SS2 updater — double-click to install the newest build.
# Downloads from GitHub Releases, so it works on any Mac with internet,
# regardless of which iCloud/Apple account it is signed into.

REPO="scottfox95/scottyspeaks"
echo "Checking for updates..."
echo

META=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null)
if [ -z "$META" ]; then
  echo "Could not reach GitHub. Check your internet connection."
  read -n 1 -s -r -p "Press any key to close..."; exit 1
fi

NEW_VER=$(echo "$META" | python3 -c "import sys,json; print(json.load(sys.stdin)['tag_name'].lstrip('v'))" 2>/dev/null)
URL=$(echo "$META" | python3 -c "
import sys,json
d=json.load(sys.stdin)
a=[x for x in d.get('assets',[]) if x['name'].endswith('.zip')]
print(a[0]['browser_download_url'] if a else '')" 2>/dev/null)

if [ -z "$URL" ]; then
  echo "No downloadable build found in the latest release."
  read -n 1 -s -r -p "Press any key to close..."; exit 1
fi

OLD_VER=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" \\
  /Applications/SS2.app/Contents/Info.plist 2>/dev/null || echo "none")

echo "Installed: $OLD_VER"
echo "Available: $NEW_VER"
echo

if [ "$OLD_VER" = "$NEW_VER" ]; then
  echo "Already up to date."
  read -n 1 -s -r -p "Press any key to close..."; exit 0
fi

TMP=$(mktemp -d)
ZIP="$TMP/SS2.zip"
echo "Downloading $NEW_VER (about 167 MB)..."
if ! curl -fL --progress-bar -o "$ZIP" "$URL"; then
  echo "Download failed."; rm -rf "$TMP"
  read -n 1 -s -r -p "Press any key to close..."; exit 1
fi

echo "Installing..."
pkill -f "SS2.app/Contents/MacOS" 2>/dev/null || true
sleep 2

ditto -x -k "$ZIP" "$TMP" || { echo "Could not unzip."; rm -rf "$TMP"; read -n 1 -s -r -p "Press any key..."; exit 1; }

APP=$(find "$TMP" -maxdepth 3 -name "SS2.app" -print -quit)
if [ -z "$APP" ]; then
  echo "SS2.app not found inside the zip."; rm -rf "$TMP"
  read -n 1 -s -r -p "Press any key to close..."; exit 1
fi

rm -rf /Applications/SS2.app
ditto "$APP" /Applications/SS2.app
rm -rf "$TMP"

# Transferred apps are quarantined; clear it so macOS will launch this build
xattr -dr com.apple.quarantine /Applications/SS2.app 2>/dev/null || true

if codesign --verify --strict /Applications/SS2.app 2>/dev/null; then
  echo "Signature OK."
else
  echo "WARNING: signature check failed — the app may still run, but tell Scott."
fi

open /Applications/SS2.app
echo
echo "Updated to $NEW_VER and relaunched."
read -n 1 -s -r -p "Press any key to close..."
`;

function main() {
  const kind = (process.argv[2] || "patch").toLowerCase();
  const version = bumpVersion(kind);
  console.log(`\n=== Publishing SS2 v${version} ===\n`);

  run("npm", ["run", "build:renderer"]);
  run("npm", ["run", "pack"]);
  run("npm", ["run", "install:local"]);

  // Build the zip
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "ss2-pub-"));
  const zipPath = path.join(stage, `SS2-${version}.zip`);
  const payload = path.join(stage, "payload");
  fs.mkdirSync(payload);
  execFileSync("ditto", ["/Applications/SS2.app", path.join(payload, "SS2.app")]);
  execFileSync("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", payload, zipPath]);

  // Publish to GitHub Releases — reachable from any Mac on any Apple account
  const tag = `v${version}`;
  const releaseCommit = capture("git", ["rev-parse", "HEAD"]);
  const notes = `SS2 ${version}\n\nBuilt ${new Date().toDateString()} from ${
    releaseCommit.slice(0, 7) || "local"
  }.\n\nUpdate by double-clicking SS2-Update.command, or download the zip below.`;
  try {
    execFileSync("gh", ["release", "delete", tag, "--repo", REPO, "--yes", "--cleanup-tag"], {
      stdio: "ignore",
    });
  } catch {}
  // Ship the diagnostic alongside every build so any Mac can self-check
  const diagSrc = path.join(PROJECT, "scripts", "diagnose.command");
  const diagAsset = path.join(path.dirname(zipPath), "SS2-Diagnose.command");
  fs.copyFileSync(diagSrc, diagAsset);

  run("gh", [
    "release", "create", tag, zipPath, diagAsset,
    "--repo", REPO,
    "--target", releaseCommit,
    "--title", `SS2 ${version}`,
    "--notes", notes,
  ]);

  const mb = (fs.statSync(zipPath).size / 1048576).toFixed(0);
  fs.rmSync(stage, { recursive: true, force: true });

  // The updater script — send this to a Mac once; it self-updates thereafter
  const desktopUpdater = path.join(os.homedir(), "Desktop", "SS2-Update.command");
  fs.writeFileSync(desktopUpdater, UPDATER);
  fs.chmodSync(desktopUpdater, 0o755);

  console.log(`\n=== Published ${tag} (${mb} MB) ===`);
  console.log(`Release : https://github.com/${REPO}/releases/tag/${tag}`);
  console.log(`Updater : ${desktopUpdater}`);
  console.log(`On any other Mac: double-click SS2-Update.command — it pulls this build.`);
}

main();
