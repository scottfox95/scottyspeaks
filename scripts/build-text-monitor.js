#!/usr/bin/env node

// macOS uses a native Swift binary compiled from resources/macos-text-monitor.swift.
// SS2 is macOS-only; other platforms have no text monitor.
const path = require("path");
const { execFileSync } = require("child_process");

if (process.platform === "darwin") {
  execFileSync("node", [path.join(__dirname, "build-macos-text-monitor.js")], { stdio: "inherit" });
}
