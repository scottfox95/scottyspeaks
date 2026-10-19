# Codex Install Handoff

This file is for Ilan's Codex agent. It gives the agent a source-based install path that does not require release artifacts, Apple signing certificates, Windows signing certificates, or repository secrets.

## Goal

Build an unsigned local desktop app from a fresh clone and leave Ilan with a runnable app on his machine.

## Prerequisites

- Node.js 22 LTS or newer
- npm
- Git
- macOS: Xcode Command Line Tools for the Swift native helpers
- Linux: system build packages may be needed for native paste helpers, such as `gcc`, `libx11-dev`, and `libxtst-dev` on Debian or Ubuntu
- Windows: PowerShell and the standard Windows build/runtime environment

## One-command install

From the repository root, run:

```bash
npm run codex:install
```

The command does the full local source packaging flow:

1. Installs dependencies with `npm ci` when `package-lock.json` exists.
2. Downloads and compiles native assets for the current platform.
3. Builds the React renderer.
4. Packages an unsigned local app with `electron-builder --dir`.
5. Prints the built app path.

## Expected output paths

The exact folder depends on the current OS and CPU architecture:

- macOS Apple Silicon: `dist/mac-arm64/ScottySpeaks.app`
- macOS Intel: `dist/mac/ScottySpeaks.app` or `dist/mac-x64/ScottySpeaks.app`
- Windows: `dist/win-unpacked/ScottySpeaks.exe`
- Linux: `dist/linux-unpacked/scottyspeaks`

## Launch notes

### macOS

The app is unsigned. If macOS blocks the first launch, right-click `ScottySpeaks.app` and choose **Open**. Ilan may also need to grant microphone and accessibility permissions the first time the app runs.

### Windows

If Windows SmartScreen warns about the unsigned app, choose the advanced option to run it. The Windows packaging path also downloads the Windows paste and push-to-talk helpers.

### Linux

If automatic paste does not work, install the desktop-specific fallback tools described in `README.md` under the Linux paste section. The app still copies transcriptions to the clipboard when automatic paste is unavailable.

## Verification

After packaging, the Codex agent should verify:

```bash
npm run typecheck
npm run i18n:check
```

Then launch the packaged app from the expected output path and confirm the app opens.

## If packaging fails

- Re-run `npm run codex:install` once after a network-related download failure.
- Check that the current platform is supported: macOS, Windows, or Linux.
- Check that native toolchain prerequisites are installed for the platform.
- On GitHub API rate-limit errors, set `GITHUB_TOKEN` in the shell and rerun the command.
