#!/usr/bin/env node
/**
 * Produces a shareable zip of SS2 plus install instructions.
 *
 * The app is signed with a local self-signed identity, not an Apple Developer
 * certificate, so macOS Gatekeeper on any *other* Mac will refuse to open it
 * until the quarantine flag (added by AirDrop/download/email) is cleared.
 * That step is unavoidable without a paid Apple Developer ID, so INSTALL.txt
 * spells it out.
 *
 * Usage: npm run share   (packages the already installed app)
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const APP = "/Applications/SS2.app";
const OUT_DIR = process.argv[2] || path.join(os.homedir(), "Desktop");

const INSTALL_TXT = `SS2 — voice dictation that formats itself
=========================================

Requirements: Apple Silicon Mac (M1 or newer), macOS 13+ for dictation; macOS 15+ for call capture.

INSTALL
-------
1. Unzip and drag SS2.app into your Applications folder.

2. Open Terminal and run this line (copy/paste it):

       xattr -dr com.apple.quarantine /Applications/SS2.app

   This is required. SS2 is signed with a personal certificate rather than a
   paid Apple Developer ID, so macOS quarantines it after transfer and will
   otherwise say it is damaged or from an unidentified developer. The command
   removes that quarantine flag. It does not disable any other security.

3. Open SS2 from Applications. Setup walks you through the rest.

FIRST RUN
---------
- Allow microphone access when prompted.
- Grant Accessibility when asked (System Settings > Privacy & Security >
  Accessibility, add SS2). This lets it paste into other apps.
- Setup downloads a speech model and, optionally, a 2.5 GB local AI model
  that cleans up your dictation. Local mode runs on your Mac. Optional cloud processing sends audio/text
  to your selected provider. No app account or subscription is required.

USING IT
--------
- Press your hotkey (default Control+Space), speak, press again to stop.
  SS2 remembers the app and field where recording began. If that original
  target can no longer be verified, use the recovered transcript Copy action
  and paste manually. Moving focus never authorizes pasting into a new field.
- Speak lists naturally ("first... second... third...", or "A... B... C...")
  and they come out formatted as lists.
- An Elgato Stream Deck Pedal, if you have one, is detected automatically:
  tap-to-talk, hold-to-talk, and a voice-command switch.
- Destination-app corrections teach canonical spelling when auto-learn is on
  and the app exposes editable text through Accessibility. History edits also
  teach writing style.

REPLAY AND CLEANUP
------------------
- History audio retention is configurable: Off, 1, 7 or 30 days. Retained
  audio stays local; expiry leaves the text. Correction examples are separate
  explicit local fixtures and remain until you delete them.
- Replay saved audio, compare raw/final text, retry with an available model,
  preview a replacement, or save a correction example.
- Cleanup controls cover fillers, explicit self-corrections, and exact wording.
  Exact wording preserves technical text; review consequential output.

LOCAL READ-ALOUD
----------------
- Read selected notes, transcript or reviewed draft text, or explicitly read
  the whole field. Voice settings use installed macOS voices. Stop is visible
  in the control panel and floating icon; reading does not send text outside
  this Mac. Recording stops speech and in-app audio replay.
- Agent spoken updates are off by default. Enable them only if desired; they
  require a shared call and are rejected while recording.

CALL NOTES
----------
- Open Call notes, create a call, and record microphone + system audio.
  Grant the requested macOS recording permissions. Stop before transcribing.
- Choose local Parakeet/Whisper, or opt into OpenRouter / MAI-Transcribe 2 in
  Call notes settings with your API key. Cloud sends the selected call audio
  and dictionary hints to that provider. Local never falls back to cloud.
- Edit notes and transcripts; pin project/person folders and Save Markdown.
  Existing VTT/SRT/text transcripts and audio can also be imported.
- Local distinguishes microphone from call audio, not every remote person.
  MAI requests speaker labels and word timestamps; review and rename labels.
- Play retained call audio by source, and click timestamps to seek. Edited
  transcripts are labeled as unaligned; original audio remains separate.
- The Agents tab shares individual calls explicitly. Copy its configuration
  into your compatible MCP client; no external configuration is edited for you.
  Keep SS2 open. Ready means the local bridge is listening; Last agent request
  indicates access. Revoke sharing in SS2; already exported copies remain.
  Drafts stay separate for review and explicit filing. The generated packaged
  configuration uses SS2’s bundled runtime, so no Node installation is needed.
  Generate fresh configuration on the work Mac after installation.
- Local dictation takes priority over queued local call chunks. An active
  chunk may finish first. Cloud requests use your selected provider separately.
- Call notes and pins stay on each Mac. Test both audio sources on a short
  call before depending on live capture. This is a locally signed build;
  follow your work Mac's approved installation process.
`;

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function archivePath(directory, version, installedVersion, stamp) {
  if (installedVersion.trim() !== version)
    throw new Error(
      `Installed app version ${installedVersion.trim()} differs from package version ${version}; install the matching build first.`
    );
  const base = path.join(directory, `SS2-${version}-arm64-${stamp}`);
  let candidate = base + ".zip",
    counter = 2;
  while (fs.existsSync(candidate)) candidate = `${base}-${counter++}.zip`;
  return candidate;
}

function main() {
  if (!fs.existsSync(APP)) {
    console.error(`[share] ${APP} not found — run "npm run pack && npm run install:local" first.`);
    process.exit(1);
  }

  // Refuse to ship a build whose signature is broken
  try {
    run("codesign", ["--verify", "--strict", APP]);
  } catch {
    console.error("[share] Signature verification failed — not packaging a broken build.");
    process.exit(1);
  }

  const version = require("../package.json").version;
  const installedVersion = run("/usr/libexec/PlistBuddy", [
    "-c",
    "Print :CFBundleShortVersionString",
    path.join(APP, "Contents/Info.plist"),
  ]);
  const stamp = new Date().toISOString().slice(0, 10);
  const outFile = archivePath(OUT_DIR, version, installedVersion, stamp);
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), "ss2-share-"));
  const payload = path.join(stageDir, "SS2");
  fs.mkdirSync(payload);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // ditto preserves code signatures and resource forks; zip does not
  run("ditto", [APP, path.join(payload, "SS2.app")]);
  fs.writeFileSync(path.join(payload, "INSTALL.txt"), INSTALL_TXT);

  run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", payload, outFile]);
  fs.rmSync(stageDir, { recursive: true, force: true });

  const mb = (fs.statSync(outFile).size / 1048576).toFixed(0);
  console.log(`[share] Wrote ${outFile} (${mb} MB)`);
  console.log("[share] Contains SS2.app + INSTALL.txt (no personal data or settings).");
}

main();
