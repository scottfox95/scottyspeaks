#!/usr/bin/env node

const { existsSync } = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const rootDir = path.resolve(__dirname, "..");
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, args, options = {}) {
  const label = [command, ...args].join(" ");
  console.log(`\n> ${label}`);

  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: "inherit",
    shell: false,
    env: {
      ...process.env,
      ...options.env,
    },
  });

  if (result.error) {
    console.error(`\nFailed to start: ${label}`);
    console.error(result.error.message);
    process.exit(1);
  }

  if (result.status !== 0) {
    console.error(`\nCommand failed with exit code ${result.status}: ${label}`);
    process.exit(result.status || 1);
  }
}

function npmRun(script, extraArgs = [], options = {}) {
  run(npmCmd, ["run", script, ...extraArgs], options);
}

function installDependencies() {
  const packageLockPath = path.join(rootDir, "package-lock.json");
  const installArgs = existsSync(packageLockPath) ? ["ci"] : ["install"];

  run(npmCmd, installArgs);
}

function prepareNativeAssets() {
  if (process.platform === "darwin") {
    npmRun("prebuild:mac");
    return;
  }

  if (process.platform === "win32") {
    npmRun("prebuild:win");
    return;
  }

  if (process.platform === "linux") {
    npmRun("prebuild:linux");
    npmRun("compile:linux-paste");
    return;
  }

  console.error(`Unsupported platform: ${process.platform}`);
  process.exit(1);
}

function packageUnsignedApp() {
  const electronBuilder = path.join(
    rootDir,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "electron-builder.cmd" : "electron-builder",
  );

  npmRun("build:renderer");
  run(electronBuilder, ["--dir", "--publish", "never"], {
    env: {
      CSC_IDENTITY_AUTO_DISCOVERY: "false",
    },
  });
}

function printResult() {
  const buildPaths = {
    darwin: [
      "dist/mac-arm64/ScottySpeaks.app",
      "dist/mac/ScottySpeaks.app",
      "dist/mac-x64/ScottySpeaks.app",
    ],
    win32: ["dist/win-unpacked/ScottySpeaks.exe"],
    linux: ["dist/linux-unpacked/scottyspeaks", "dist/linux-unpacked/ScottySpeaks"],
  };

  const candidates = buildPaths[process.platform] || [];
  const found = candidates.find((candidate) => existsSync(path.join(rootDir, candidate)));

  console.log("\nCodex install packaging complete.");
  if (found) {
    console.log(`Built app: ${found}`);
  } else if (candidates.length > 0) {
    console.log("Expected one of:");
    candidates.forEach((candidate) => console.log(`- ${candidate}`));
  }

  if (process.platform === "darwin") {
    console.log("macOS may block the unsigned app on first launch. Right-click the app and choose Open.");
  }
}

installDependencies();
prepareNativeAssets();
packageUnsignedApp();
printResult();
