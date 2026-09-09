#!/usr/bin/env node

// Builds the parakeet-coreml helper (SwiftPM package in resources/parakeet-coreml)
// and installs it as resources/bin/parakeet-coreml-darwin-arm64.
//
// Unlike the single-file swiftc helpers (fast-paste, globe-listener), this one
// depends on the FluidAudio package, so it goes through `swift build`. The first
// build fetches ~100MB of Swift sources and takes ~45s; afterwards the source
// hash check short-circuits.

const { spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

if (process.platform !== "darwin") {
  process.exit(0);
}

// FluidAudio's CoreML models target the Apple Neural Engine, which only exists
// on Apple Silicon. There is no useful x64 build of this helper.
const archIndex = process.argv.indexOf("--arch");
const targetArch =
  (archIndex !== -1 && process.argv[archIndex + 1]) || process.env.TARGET_ARCH || process.arch;

function log(message) {
  console.log(`[parakeet-coreml] ${message}`);
}

if (targetArch !== "arm64") {
  log(`Skipping build for ${targetArch} (Neural Engine path is Apple Silicon only)`);
  process.exit(0);
}

const projectRoot = path.resolve(__dirname, "..");
const packageDir = path.join(projectRoot, "resources", "parakeet-coreml");
const outputDir = path.join(projectRoot, "resources", "bin");
const outputBinary = path.join(outputDir, "parakeet-coreml-darwin-arm64");
const hashFile = path.join(outputDir, ".parakeet-coreml.arm64.hash");

const sourceFiles = [
  path.join(packageDir, "Package.swift"),
  path.join(packageDir, "Sources", "parakeet-coreml", "main.swift"),
];

const CPU_TYPE_ARM64 = 0x0100000c;

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function verifyBinaryArch(binaryPath) {
  try {
    const fd = fs.openSync(binaryPath, "r");
    const header = Buffer.alloc(8);
    fs.readSync(fd, header, 0, 8, 0);
    fs.closeSync(fd);
    if (header.readUInt32LE(0) !== 0xfeedfacf) return false;
    return header.readInt32LE(4) === CPU_TYPE_ARM64;
  } catch {
    return false;
  }
}

function computeSourceHash() {
  const hash = crypto.createHash("sha256");
  for (const file of sourceFiles) {
    hash.update(fs.readFileSync(file));
  }
  // Package.resolved pins the FluidAudio revision; a dependency bump must
  // invalidate the cache even when our own sources are untouched.
  const resolved = path.join(packageDir, "Package.resolved");
  if (fs.existsSync(resolved)) {
    hash.update(fs.readFileSync(resolved));
  }
  return hash.digest("hex");
}

for (const file of sourceFiles) {
  if (!fs.existsSync(file)) {
    console.error(`[parakeet-coreml] Source not found at ${file}`);
    process.exit(1);
  }
}

ensureDir(outputDir);

const currentHash = computeSourceHash();

if (fs.existsSync(outputBinary) && verifyBinaryArch(outputBinary) && fs.existsSync(hashFile)) {
  try {
    if (fs.readFileSync(hashFile, "utf8").trim() === currentHash) {
      process.exit(0);
    }
    log("Source hash changed, rebuild needed");
  } catch {
    log("Hash check failed, forcing rebuild");
  }
}

log("Building (first build fetches FluidAudio and takes ~45s)...");

const result = spawnSync("swift", ["build", "-c", "release", "--arch", "arm64"], {
  cwd: packageDir,
  stdio: "inherit",
});

if (result.error && result.error.code === "ENOENT") {
  console.error(
    "[parakeet-coreml] `swift` not found. Install Xcode or the Command Line Tools " +
      "(xcode-select --install) to build the Neural Engine transcription helper."
  );
  process.exit(1);
}

if (result.status !== 0) {
  console.error("[parakeet-coreml] swift build failed.");
  process.exit(result.status ?? 1);
}

const builtBinary = path.join(packageDir, ".build", "release", "parakeet-coreml");
if (!fs.existsSync(builtBinary)) {
  console.error(`[parakeet-coreml] Expected build product missing at ${builtBinary}`);
  process.exit(1);
}

fs.copyFileSync(builtBinary, outputBinary);

try {
  fs.chmodSync(outputBinary, 0o755);
} catch (error) {
  console.warn(`[parakeet-coreml] Unable to set executable permissions: ${error.message}`);
}

if (!verifyBinaryArch(outputBinary)) {
  console.error("[parakeet-coreml] FATAL: built binary is not arm64.");
  process.exit(1);
}

try {
  fs.writeFileSync(hashFile, currentHash);
} catch (err) {
  log(`Warning: could not save source hash: ${err.message}`);
}

log("Successfully built parakeet-coreml (arm64).");
