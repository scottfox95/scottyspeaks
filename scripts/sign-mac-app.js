#!/usr/bin/env node
/**
 * Re-signs the packed macOS .app with the stable "ScottySpeaks Local Signing"
 * identity so TCC permissions (Accessibility, Microphone) survive rebuilds.
 *
 * electron-builder refuses untrusted identities, so it packs ad-hoc and this
 * script re-signs everything inside-out afterwards, preserving each binary's
 * existing entitlements.
 *
 * Usage: node scripts/sign-mac-app.js [path-to-app]
 *        (defaults to the newest .app under dist/)
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { IDENTITY_NAME, ensureSigning } = require("./ensure-signing.js");

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
}

function findApp() {
  const distDir = path.join(__dirname, "..", "dist");
  const candidates = [];
  const scan = (dir, depth) => {
    if (depth > 2 || !fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir)) {
      const p = path.join(dir, entry);
      if (entry.endsWith(".app")) {
        candidates.push(p);
      } else {
        try {
          if (fs.statSync(p).isDirectory()) scan(p, depth + 1);
        } catch {}
      }
    }
  };
  scan(distDir, 0);
  if (!candidates.length) return null;
  candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return candidates[0];
}

function isMachO(file) {
  try {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    const magic = buf.readUInt32BE(0);
    return [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(magic);
  } catch {
    return false;
  }
}

function collectSignables(appPath) {
  // Inner-most first; the .app bundle itself is signed last by the caller.
  const dylibs = [];
  const binaries = [];
  const frameworks = [];
  const helperApps = [];

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir)) {
      const p = path.join(dir, entry);
      let stat;
      try {
        stat = fs.lstatSync(p);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        if (entry.endsWith(".framework")) {
          frameworks.push(p);
          walk(p);
        } else if (entry.endsWith(".app") && p !== appPath) {
          helperApps.push(p);
          walk(p);
        } else {
          walk(p);
        }
      } else if (stat.isFile()) {
        if (entry.endsWith(".dylib") || entry.endsWith(".so") || entry.endsWith(".node")) {
          dylibs.push(p);
        } else if ((stat.mode & 0o111) !== 0 && isMachO(p)) {
          binaries.push(p);
        }
      }
    }
  };
  walk(path.join(appPath, "Contents"));

  const mainExec = path.join(
    appPath,
    "Contents",
    "MacOS",
    fs
      .readdirSync(path.join(appPath, "Contents", "MacOS"))
      .find((f) => isMachO(path.join(appPath, "Contents", "MacOS", f)))
  );

  return {
    dylibs,
    binaries: binaries.filter((b) => b !== mainExec),
    frameworks,
    helperApps,
    mainExec,
  };
}

function extractEntitlements(target, tmpDir, index) {
  try {
    const xml = run("codesign", ["-d", "--entitlements", ":-", target]);
    if (xml && xml.includes("<dict") && xml.includes("<key>")) {
      const file = path.join(tmpDir, `ent-${index}.plist`);
      fs.writeFileSync(file, xml);
      return file;
    }
  } catch {}
  return null;
}

function sign(target, { entitlements, runtime } = {}) {
  const args = ["--force", "--sign", IDENTITY_NAME, "--timestamp=none"];
  if (runtime) args.push("--options", "runtime");
  if (entitlements) args.push("--entitlements", entitlements);
  args.push(target);
  run("codesign", args);
}

function main() {
  if (process.platform !== "darwin") return;

  // Make sure the identity + unlocked keychain are ready
  ensureSigning();

  const appPath = process.argv[2] || findApp();
  if (!appPath || !fs.existsSync(appPath)) {
    console.error("[sign-mac-app] No .app found under dist/ — run a pack/build first.");
    process.exit(1);
  }

  console.log(`[sign-mac-app] Re-signing ${appPath} with "${IDENTITY_NAME}"`);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scotty-sign-"));
  const { dylibs, binaries, frameworks, helperApps, mainExec } = collectSignables(appPath);

  let entIndex = 0;
  const signWithPreservedEntitlements = (target, runtime) => {
    const ent = extractEntitlements(target, tmpDir, entIndex++);
    sign(target, { entitlements: ent, runtime });
  };

  for (const f of dylibs) sign(f, {});
  // helper .app executables are already in `binaries` via the recursive walk
  for (const b of binaries) signWithPreservedEntitlements(b, true);
  for (const f of frameworks) sign(f, {});
  // deepest helper apps first so outer signatures seal inner ones
  helperApps.sort((a, b) => b.length - a.length);
  for (const h of helperApps) signWithPreservedEntitlements(h, true);
  signWithPreservedEntitlements(mainExec, true);
  signWithPreservedEntitlements(appPath, true);

  const verify = run("codesign", ["--verify", "--deep", "--strict", "-v", appPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const dr = run("codesign", ["-d", "-r-", appPath]);
  console.log("[sign-mac-app] Verified OK");
  console.log(`[sign-mac-app] ${dr.trim().split("\n").pop()}`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

main();
