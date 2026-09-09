#!/usr/bin/env node
/**
 * Ensures a stable local code-signing identity exists and is usable.
 *
 * Why: ad-hoc signatures change on every rebuild, which makes macOS TCC
 * (Accessibility / Microphone) silently revoke permissions each time the app
 * is rebuilt. Signing with a persistent self-signed identity gives the app a
 * stable designated requirement (`identifier ... and certificate root = H"..."`),
 * so permissions survive rebuilds.
 *
 * The identity lives in a dedicated keychain with a known password so signing
 * is fully non-interactive. The certificate does NOT need to be trusted for
 * signing or for TCC matching (trust only matters for Gatekeeper, which does
 * not apply to locally built, unquarantined apps).
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const IDENTITY_NAME = "ScottySpeaks Local Signing";
const KEYCHAIN = path.join(os.homedir(), "Library/Keychains/scottyspeaks-build.keychain-db");
const KEYCHAIN_PASS = "scottylocal-kc";
const SIGNING_DIR = path.join(os.homedir(), ".scottyspeaks-signing");
const P12_PATH = path.join(SIGNING_DIR, "identity.p12");
const P12_PASS = "scottylocal";

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
}

function keychainHasIdentity() {
  try {
    // No -v: the self-signed cert is untrusted so it never shows as "valid",
    // but codesign can still use it.
    const out = run("security", ["find-identity", KEYCHAIN]);
    return out.includes(IDENTITY_NAME);
  } catch {
    return false;
  }
}

function ensureP12() {
  if (fs.existsSync(P12_PATH)) return;
  fs.mkdirSync(SIGNING_DIR, { recursive: true });
  const cnf = path.join(SIGNING_DIR, "openssl.cnf");
  fs.writeFileSync(
    cnf,
    [
      "[req]",
      "distinguished_name = dn",
      "x509_extensions = v3_code",
      "prompt = no",
      "[dn]",
      `CN = ${IDENTITY_NAME}`,
      "O = ScottySpeaks",
      "[v3_code]",
      "keyUsage = critical,digitalSignature",
      "extendedKeyUsage = critical,codeSigning",
      "basicConstraints = critical,CA:false",
      "subjectKeyIdentifier = hash",
      "",
    ].join("\n")
  );
  const key = path.join(SIGNING_DIR, "key.pem");
  const cert = path.join(SIGNING_DIR, "cert.pem");
  run("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-days", "3650", "-nodes",
    "-keyout", key, "-out", cert, "-config", cnf,
  ]);
  try {
    run("openssl", [
      "pkcs12", "-export", "-legacy", "-out", P12_PATH,
      "-inkey", key, "-in", cert, "-passout", `pass:${P12_PASS}`,
    ]);
  } catch {
    // Older openssl without -legacy flag
    run("openssl", [
      "pkcs12", "-export", "-out", P12_PATH,
      "-inkey", key, "-in", cert, "-passout", `pass:${P12_PASS}`,
    ]);
  }
  fs.chmodSync(P12_PATH, 0o600);
  console.log(`[ensure-signing] Generated new signing identity at ${P12_PATH}`);
  console.log(
    "[ensure-signing] NOTE: a new identity means macOS permissions must be re-granted once."
  );
}

function main() {
  if (process.platform !== "darwin") return;

  if (!keychainHasIdentity()) {
    ensureP12();
    try {
      run("security", ["delete-keychain", KEYCHAIN]);
    } catch {}
    run("security", ["create-keychain", "-p", KEYCHAIN_PASS, KEYCHAIN]);
    // No auto-lock timeout
    run("security", ["set-keychain-settings", KEYCHAIN]);
    run("security", ["unlock-keychain", "-p", KEYCHAIN_PASS, KEYCHAIN]);
    run("security", [
      "import", P12_PATH, "-k", KEYCHAIN, "-P", P12_PASS,
      "-T", "/usr/bin/codesign", "-T", "/usr/bin/security",
    ]);
    try {
      run("security", [
        "set-key-partition-list", "-S", "apple-tool:,apple:,codesign:",
        "-s", "-k", KEYCHAIN_PASS, KEYCHAIN,
      ]);
    } catch {}
    // Keep the build keychain in the user search list (idempotent)
    const current = run("security", ["list-keychains", "-d", "user"])
      .split("\n")
      .map((l) => l.trim().replace(/^"|"$/g, ""))
      .filter(Boolean);
    if (!current.includes(KEYCHAIN)) {
      run("security", ["list-keychains", "-d", "user", "-s", ...current, KEYCHAIN]);
    }
    console.log(`[ensure-signing] Created build keychain with identity "${IDENTITY_NAME}"`);
  } else {
    run("security", ["unlock-keychain", "-p", KEYCHAIN_PASS, KEYCHAIN]);
    console.log(`[ensure-signing] Identity "${IDENTITY_NAME}" ready (keychain unlocked)`);
  }
}

if (require.main === module) {
  main();
}

module.exports = { IDENTITY_NAME, KEYCHAIN, ensureSigning: main };
