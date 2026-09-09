# Development and verification

SS2 is the personal ScottySpeaks fork of OpenWhispr. Runtime authentication/subscriptions are disabled; local dictation, pedal support, history, dictionary and optional BYOK processing remain available.

## Repeatable checks

```sh
npm test
npm run typecheck
npm run i18n:check
npm run build:renderer
npm run compile:meeting-recorder
npm run test:meetings-ui
# Optional, requires an already installed Parakeet model:
node tests/local-inference-smoke.cjs
```

`npm run verify:core` runs tests, typecheck and the renderer build. Tests use temporary directories and synthetic speech-provider responses. The Electron smoke runs the actual notebook UI, preload, IPC and file store in an isolated user profile; it never records the microphone or uploads real data. Node tests include real FFmpeg preparation and background transcription jobs, including complete-request retry behavior for transient cloud failures. The smoke needs a desktop Electron runtime.

For a no-device native conversion check:

```sh
resources/bin/meeting-recorder-arm64 --check
resources/bin/meeting-recorder-arm64 --self-test /tmp/ss2-native-audio-check
```

The self-test supplies generated audio buffers to the same conversion writer; it does not exercise screen/microphone permissions or device capture.

## Build, install, roll back

```sh
npm run pack
npm run install:local
npm run share
```

`pack` builds native helpers and renderer, rebuilds SQLite for Electron, packages, then signs with the stable local signing identity. `install:local` validates and stages the complete bundle before replacement, retains the old app under `~/Library/Application Support/SS2 App Backups.noindex/`, and leaves user data/model caches in place. Quit SS2 before installation. To roll back, quit SS2, move the current app aside, and copy the backed-up `SS2.app` into `/Applications`.

`share` packages the installed app and installation instructions on the Desktop; it does not rebuild. No personal settings, keys, audio or client files are bundled. This build is locally signed, not Apple-notarized. A work Mac may require its normal administrator-approved app installation process. The provided archive targets Apple Silicon; Intel Macs require a separate build and matching native resources.

## Call notebook contracts

- `src/helpers/meetingHandlers.js` registers the `meetings:*` IPC namespace. Only the control-panel renderer can call it. Preload exposes typed operations via `window.electronAPI.meetings`; credentials never cross back into the renderer.
- `meetingStore.js` owns UUID-addressed sessions, optimistic revisions, real folder pins, atomic draft writes, Markdown generation, exclusive new filenames, and external-file hash conflicts. Editable fields are allowlisted; audio paths and provider metadata cannot be edited through the draft API.
- `meetingRecorder.js` owns one capture process. `resources/meeting-recorder.swift` uses ScreenCaptureKit on macOS 15+, with synchronized microphone/system CAF tracks. It persists paths before starting, handles stop/EOF/signals and uses a common audio clock.
- `meetingTranscriber.js` normalizes timestamps and scopes speaker IDs by request. Local uses 120-second WAVs. Cloud mixes the capture tracks and prepares up to one hour of compressed MP3 per request. Transient cloud failures retry the complete request once so diarization identities cannot multiply across artificial subdivisions. Completed requests are checkpointed; no local-to-cloud fallback exists.
- `src/components/meetings/meetingDraft.ts` preserves edits made while autosave is pending. The view journals unsaved edits, waits before switching calls, prevents action responses from replacing new edits, and stops recording independently of note-save success.
- Exported Markdown contains meeting identity/date/provider, personal Notes and Transcript. Machine-readable segment and word data stays in the local session JSON. Edited transcript text is not represented as word-aligned source.
- New UI text must use all locale files. Run `i18n:check`; Japanese is present in addition to the nine locales listed in older architecture instructions.

## Release evidence and limits

Version 0.2.0 has automated regressions for destructive filler removal, paragraph loss, canonical/casing corrections, disable/undo/paste boundaries, polish additions/numbers/names/negation, stale writes, file conflicts, capture recovery, provider contracts and background jobs. Typecheck, renderer build, native compilation/conversion and isolated Electron notebook interactions are part of the release gate. Code review found four material issues during development; all were fixed and covered by regression or focused inspection.

These checks do not certify real device capture or model accuracy. Run this short acceptance on each target Mac before relying on it for a live call:

1. Confirm the displayed version, existing models, hotkey/pedal mode, dictionary, history and settings survived the update.
2. Dictate into the usual destination app. Correct a name/capitalization, repeat it, restart, and verify the learned spelling persists. Check a paragraph, a truncated sentence, a number and a negation. If a destination does not expose editable text through Accessibility, automatic learning may not work there.
3. Record a short test call with headphones and two people. Confirm both microphone and remote audio, stop, transcribe locally, save Markdown, edit it externally and confirm the overwrite conflict.
4. If using MAI, add the key and transcribe that same test call. Compare content, speaker changes, word timestamps, latency and cost. Live paid-provider behavior was not tested during development because no OpenRouter key was configured.
5. Repeat after device changes and a longer call. Assess echo, synchronization, CPU load and simultaneous dictation. On the work Mac verify native capture permissions and the pinned folder paths.

The generated-speech local check passed using the actual Parakeet ONNX backend: it retained “review the project on Friday”, the $42 amount and “Do not publish the draft.” This is a controlled inference check, not microphone or real-call accuracy evidence. The installed 0.2.0 app was launched successfully and its Call notes screen inspected. Critical settings/history files matched their pre-install hashes before launch; the old app and local data were backed up.

No Windows/Linux capture claim is made. Their existing dictation paths were retained but cannot be hardware-verified from this Mac. The deterministic polish guard reduces known failure patterns; it cannot prove semantic equivalence or repair every ASR hallucination. Retain a raw/final/audio example for any remaining defect.

## 0.3.0 verification and sharing

Run `npm run verify:core` and `npm run i18n:check`. Focused actual Electron checks are `npm run test:meetings-ui`, `npm run test:replay-ui`, `npm run test:cleanup-ui`, `npm run test:call-agent-ui`, and `npm run test:speech-ui`. These use temporary profiles and synthetic content. They do not inspect installed user keys or use a microphone/cloud provider. The speech UI check substitutes a speech child and plays only muted generated audio; `npm run test:speech-native` separately synthesizes text through the actual macOS voice engine to a temporary file and verifies nonzero audio duration/bytes, without speaker playback. Local socket and native system services may require execution outside a restrictive sandbox.

`npm run compile:recording-target` builds the native helper; `npm run test:target-native` runs its six isolated clipboard checks using a disposable UUID pasteboard, never the general clipboard or a real Accessibility field. The Node suite separately covers recording-target manager lifecycle. Real Accessibility target acceptance is a separate check: a passing mock or isolated helper test does not establish successful insertion into arbitrary applications. Actual device capture, provider quality, speaker separation, long calls and different target apps remain hardware/manual acceptance work. A generated-speech local inference check is distinct from these real-world checks; do not infer cloud or microphone quality from it.

For release, package/sign, preserve an installed-app rollback backup, install without deleting userData, and perform installed read-only sanity checks. Compare the encrypted key file’s hash before/after without reading its contents. `npm run share` then reads the installed app’s CFBundleShortVersionString and refuses to name an archive for a different package version. Existing archives remain untouched; repeated archives get a numeric suffix. It ships SS2.app and current INSTALL.txt, with no personal data. Root release execution records the final installed version and ZIP path after review; source changes alone do not establish delivery.

The 0.3.0 usage guide is [voice-workflows.md](voice-workflows.md). Use fresh generated agent configuration on the work Mac, whose paths differ from the development machine. The adapter runs with the packaged Electron runtime and needs no separate Node installation.
