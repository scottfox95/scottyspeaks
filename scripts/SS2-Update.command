#!/bin/bash
# SS2 updater — double-click to install the newest build.
# Downloads from GitHub Releases, so it works on any Mac with internet,
# regardless of which iCloud/Apple account it is signed into.
#
# Uses only tools that ship with macOS (curl, ditto, plutil, codesign,
# osascript). No python3: on a stock Mac that is a Command Line Tools shim
# that pops up an "install developer tools" prompt.
#
# The installed app is never removed until the new one has been copied into
# /Applications and its signature verified there.
#
# Test hooks (no side effects):
#   SS2-Update.command --compare A B        prints newer|same|older (A vs B)
#   SS2-Update.command --parse-release FILE prints version, then zip URL

REPO="scottfox95/scottyspeaks"
BUNDLE_ID="com.scottfox.scottyspeaks"
DEST="/Applications/SS2.app"

# Prints newer|same|older for version $1 relative to $2, numerically
# (0.3.10 is newer than 0.3.9). A leading "v" and any "-suffix" are ignored.
ver_cmp() {
  local a="${1#[vV]}" b="${2#[vV]}" i x y
  a="${a%%-*}"
  b="${b%%-*}"
  local IFS=.
  local -a A B
  read -r -a A <<< "$a"
  read -r -a B <<< "$b"
  for i in 0 1 2; do
    x="${A[$i]:-0}"
    y="${B[$i]:-0}"
    x="${x//[^0-9]/}"
    y="${y//[^0-9]/}"
    x=$((10#${x:-0}))
    y=$((10#${y:-0}))
    if [ "$x" -gt "$y" ]; then echo newer; return 0; fi
    if [ "$x" -lt "$y" ]; then echo older; return 0; fi
  done
  echo same
}

# Prints two lines from a GitHub "latest release" JSON file: the version
# (tag without "v") and the SS2-*.zip download URL (empty when missing).
parse_release() {
  /usr/bin/osascript -l JavaScript -e '
function run(argv) {
  ObjC.import("Foundation");
  try {
    var s = $.NSString.stringWithContentsOfFileEncodingError(argv[0], $.NSUTF8StringEncoding, null);
    var d = JSON.parse(ObjC.unwrap(s));
    var tag = String(d.tag_name || "").replace(/^v/i, "");
    var assets = d.assets || [];
    var zips = assets.filter(function (a) { return /^SS2-.*\.zip$/i.test(a.name || ""); });
    if (!zips.length) zips = assets.filter(function (a) { return /\.zip$/i.test(a.name || ""); });
    return tag + "\n" + (zips.length ? zips[0].browser_download_url : "");
  } catch (e) {
    return "\n";
  }
}' "$1" 2>/dev/null
}

plist_value() { # $1 = Info.plist, $2 = key
  /usr/bin/plutil -extract "$2" raw -o - "$1" 2>/dev/null ||
    /usr/libexec/PlistBuddy -c "Print :$2" "$1" 2>/dev/null
}

designated_requirement() {
  /usr/bin/codesign -d -r- "$1" 2>&1 | sed -n 's/^designated => //p' | head -n 1
}

case "$1" in
  --compare) ver_cmp "$2" "$3"; exit 0 ;;
  --parse-release) parse_release "$2"; exit 0 ;;
esac

TMP=""
STAGED=""
cleanup() {
  [ -n "$STAGED" ] && rm -rf "$STAGED"
  [ -n "$TMP" ] && rm -rf "$TMP"
}
trap cleanup EXIT

finish() { # $1 = exit code, $2.. = message
  local code="$1"
  shift
  [ $# -gt 0 ] && echo "$*"
  read -n 1 -s -r -p "Press any key to close..."
  echo
  exit "$code"
}

echo "Checking for updates..."
echo

TMP=$(mktemp -d -t ss2-update) || finish 1 "Could not create a temporary folder."
META="$TMP/release.json"
if ! curl -fsSL -o "$META" "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null; then
  finish 1 "Could not reach GitHub. Check your internet connection."
fi

PARSED=$(parse_release "$META")
NEW_VER=$(printf '%s\n' "$PARSED" | sed -n 1p)
URL=$(printf '%s\n' "$PARSED" | sed -n 2p)
if [ -z "$NEW_VER" ] || [ -z "$URL" ]; then
  finish 1 "No downloadable build found in the latest release."
fi

OLD_VER=""
[ -d "$DEST" ] && OLD_VER=$(plist_value "$DEST/Contents/Info.plist" CFBundleShortVersionString)

echo "Installed: ${OLD_VER:-none}"
echo "Available: $NEW_VER"
echo

if [ -n "$OLD_VER" ]; then
  case "$(ver_cmp "$NEW_VER" "$OLD_VER")" in
    same) finish 0 "Already up to date." ;;
    older) finish 0 "The installed build is newer than the latest release. Nothing to do." ;;
  esac
fi

ZIP="$TMP/SS2.zip"
echo "Downloading $NEW_VER..."
curl -fL --progress-bar -o "$ZIP" "$URL" || finish 1 "Download failed. SS2 was not changed."

mkdir -p "$TMP/unzipped"
ditto -x -k "$ZIP" "$TMP/unzipped" || finish 1 "Could not unzip the download. SS2 was not changed."

APP=$(find "$TMP/unzipped" -maxdepth 3 -name "SS2.app" -type d -print -quit)
[ -n "$APP" ] || finish 1 "SS2.app not found inside the zip. SS2 was not changed."

# --- Check the download before touching the installed app -------------------
GOT_ID=$(plist_value "$APP/Contents/Info.plist" CFBundleIdentifier)
[ "$GOT_ID" = "$BUNDLE_ID" ] ||
  finish 1 "The download is not SS2 (bundle id '$GOT_ID'). SS2 was not changed."

GOT_VER=$(plist_value "$APP/Contents/Info.plist" CFBundleShortVersionString)
if [ -n "$OLD_VER" ] && [ "$(ver_cmp "$GOT_VER" "$OLD_VER")" != "newer" ]; then
  finish 1 "The download is version '$GOT_VER', not newer than $OLD_VER. SS2 was not changed."
fi

# Transferred apps are quarantined; clear it so macOS will launch this build
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true

if ! codesign --verify --deep --strict "$APP" 2>/dev/null; then
  finish 1 "The download failed its signature check. SS2 was not changed. Tell Scott."
fi

# Same signing identity as the installed app? A different one means macOS
# treats it as a new app and drops Accessibility, Microphone and Screen
# Recording permissions, so paste stops working until they are re-granted.
if [ -n "$OLD_VER" ]; then
  REQ=$(designated_requirement "$DEST")
  if [ -n "$REQ" ] && ! codesign --verify --strict -R "=$REQ" "$APP" 2>/dev/null; then
    echo "WARNING: this build is signed by a different identity than the installed SS2."
    echo "After installing it you will have to grant Accessibility, Microphone and"
    echo "Screen Recording again (System Settings > Privacy & Security). Tell Scott."
    echo
    printf "Type yes to install anyway: "
    read -r ANSWER
    [ "$ANSWER" = "yes" ] || finish 1 "Cancelled. SS2 was not changed."
  fi
fi

# --- Copy next to the installed app and verify the copy ---------------------
echo "Installing..."
STAGED="/Applications/.SS2-update-$$.app"
rm -rf "$STAGED"
if ! ditto "$APP" "$STAGED"; then
  finish 1 "Could not copy into /Applications. SS2 was not changed."
fi
if ! codesign --verify --deep --strict "$STAGED" 2>/dev/null; then
  finish 1 "The copied app failed its signature check. SS2 was not changed."
fi

# --- Quit SS2 (gracefully first, so recordings finalize) ---------------------
running() { pgrep -f "^$DEST/Contents/MacOS/" >/dev/null 2>&1; }
wait_quit() { # $1 = seconds
  local n=0
  while running && [ "$n" -lt "$(($1 * 2))" ]; do sleep 0.5; n=$((n + 1)); done
  ! running
}
if running; then
  osascript -e "tell application id \"$BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
  if ! wait_quit 20; then
    pkill -TERM -f "^$DEST/Contents/MacOS/" 2>/dev/null || true
    wait_quit 10 || finish 1 "SS2 is still running. Quit it and run this again. SS2 was not changed."
  fi
fi

# --- Swap: old app aside, new app in, old app removed only after success -----
BACKUP=""
if [ -d "$DEST" ]; then
  BACKUP="/Applications/.SS2-previous-$$.app"
  rm -rf "$BACKUP"
  mv "$DEST" "$BACKUP" || finish 1 "Could not move the old SS2 aside. SS2 was not changed."
fi
if ! mv "$STAGED" "$DEST"; then
  [ -n "$BACKUP" ] && mv "$BACKUP" "$DEST"
  finish 1 "Could not install the new SS2. The previous version was put back."
fi
STAGED=""
if ! codesign --verify --deep --strict "$DEST" 2>/dev/null; then
  rm -rf "$DEST"
  [ -n "$BACKUP" ] && mv "$BACKUP" "$DEST"
  finish 1 "The installed app failed its signature check. The previous version was put back."
fi
[ -n "$BACKUP" ] && rm -rf "$BACKUP"

/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
  -f "$DEST" >/dev/null 2>&1 || true

echo "Signature OK."
open "$DEST"
echo
finish 0 "Updated to $NEW_VER and relaunched."
