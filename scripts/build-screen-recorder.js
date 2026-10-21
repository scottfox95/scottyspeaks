const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
if (process.platform !== "darwin") process.exit(0);
const root = path.resolve(__dirname, "..");
const source = path.join(root, "resources/screen-recorder.swift");
const arg = process.argv.indexOf("--arch");
const arch = arg >= 0 ? process.argv[arg + 1] : process.env.TARGET_ARCH || process.arch;
if (!["arm64", "x64"].includes(arch)) throw new Error("Unsupported capture architecture");
const output = path.join(root, `resources/bin/screen-recorder-${arch}`);
const digest = crypto
  .createHash("sha256")
  .update(fs.readFileSync(source))
  .update(arch)
  .digest("hex");
if (
  fs.existsSync(output) &&
  fs.existsSync(output + ".hash") &&
  fs.readFileSync(output + ".hash", "utf8") === digest
)
  process.exit(0);
fs.mkdirSync(path.dirname(output), { recursive: true });
execFileSync(
  "xcrun",
  [
    "swiftc",
    source,
    "-o",
    output,
    "-O",
    "-target",
    `${arch === "x64" ? "x86_64" : "arm64"}-apple-macosx13.0`,
    "-framework",
    "ScreenCaptureKit",
    "-framework",
    "AVFoundation",
    "-framework",
    "CoreMedia",
    "-framework",
    "VideoToolbox",
    "-framework",
    "CoreText",
  ],
  { stdio: "inherit" }
);
fs.chmodSync(output, 0o755);
fs.writeFileSync(output + ".hash", digest);
console.log("Built " + path.basename(output));
