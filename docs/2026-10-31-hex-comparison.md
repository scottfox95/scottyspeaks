# What SS2 should borrow from Hex (October 31, 2026)

Hex is a local push-to-talk dictation app: hold Option, speak, and the text pastes at the cursor. This is a read-only study of its source. Nothing was built, run or installed. No SS2 code changes come out of this document yet.

**Sources read**

- **Current Hex:** [anomalyco/hex](https://github.com/anomalyco/hex) at `01f42bde`. It is a ground-up Rust rewrite with its own GPU UI toolkit. Its `docs/features/dictation.md` records measured timings, which are quoted below.
- **Legacy Hex:** [kitlangton/Hex](https://github.com/kitlangton/Hex) at `3e300721`, a Swift app now marked unmaintained. It ran Parakeet through FluidAudio and WhisperKit, the same stack SS2 uses today. Hex has since moved off it.

Hex's numbers come from replayed clips on its developers' machines (M4 MacBook Air, M2 Max). Hex never measured release-to-paste with a real microphone. SS2's numbers are the ones in `CLAUDE.md`.

## Side by side

| Area | Hex | SS2 today |
|---|---|---|
| Speech model and runtime | Parakeet (Unified English or TDT v3) as Q8 GGUF via `transcribe.cpp` on the Metal GPU. 216–234 ms per clip on an M2 Max. A Metal shader compile on first launch takes 9.9 s, so it prewarms at launch. | Parakeet TDT v3 via FluidAudio CoreML on the Neural Engine: 74 ms for 10.8 s of audio, with sherpa-onnx as the fallback. |
| Release to text | Streams to the model while you hold, then finalizes after release. Measured 140 ms for a 10 s clip and 253 ms for a 131 s clip, against 156 ms and 2,838 ms when the whole clip is transcribed after release. | Transcribes the whole clip after release (74 ms), then the LLM polish pass (~800 ms for 41 words, which is ~80% of the total), then paste (~140 ms). |
| Start of the clip | The mic stays open while idle, so each clip begins with 450 ms of pre-roll. Without pre-roll, syllables were lost when speech began 150–300 ms before the press. | The mic opens on press. A one-time driver warm-up gets `getUserMedia` to ~100–200 ms. There is no pre-roll, so speech that starts with the press can lose its first syllable. |
| End of the clip | Capture continues 200 ms past the key release, cut using the key event's own timestamp. The last word survived 10/10 times; releasing 100 ms early kept it 7/10. | `MediaRecorder.stop()` runs as soon as the key is released. There is no tail. |
| Short taps and chords | Holds under 300 ms are discarded. Any other key pressed during an Option hold discards the clip. An injected unused key code (0x44) stops Raycast and Karabiner from reading the hold as an Option tap. A 5 s health check re-enables taps macOS has disabled. | 150 ms minimum hold (`windowManager.js`). The Globe listener re-enables its tap when macOS disables it. A modifier hold is not discarded when another key is pressed during it. |
| Empty clips | Clips that never exceed -50 dBFS are dropped, then Silero VAD drops clips with no speech. Both target "thank you" hallucinations. | Peak-RMS silence gate (`audioManager.js`). No VAD. |
| Clipboard | Snapshotted at key-down, with every item and data type kept. The transcript is marked transient so clipboard managers skip it. Restored after 500 ms, but only if nothing else has written the clipboard since. | Saves the clipboard text only (`clipboard.readText()`). An image or rich text on the clipboard is replaced by its plain text. Restores unconditionally after 450 ms. The transcript lands in clipboard-manager history. |
| Paste method | Cmd+V via CGEvent, with V looked up in the current keyboard layout. For Chromium 155/156, which drop pastes, it types the text instead. | Cmd+V via CGEvent (`macos-fast-paste`), with an AppleScript fallback. Uses a fixed key code. |
| Idle footprint | The model stays loaded. Inference scratch memory is freed after each run (1,195 MB → ~801 MB). Unloading when idle is an option, off by default. The tone output device is released after 5 idle minutes, because holding it open kept Macs from sleeping. | Parakeet and the polish LLM stay loaded and are prewarmed at app start. |
| First run | Starts the model download as soon as the tour opens. One checklist screen (Microphone, Accessibility, Model) polls every 400 ms. A practice field warns "No sound" after 1.5 s. | An 8-step onboarding wizard. The model is chosen and downloaded within the flow. |
| Mic choice | Skips a Bluetooth default mic in favour of the built-in one, so AirPods don't drop to call-quality audio. | Uses the selected device. |

## What SS2 already does better

- **Transcription speed.** The Neural Engine runs Parakeet in 74 ms with a ~150 ms cold start. That beats Hex's GPU path (216–234 ms per clip) and leaves the GPU free for the polish model. Streaming would only pay off for long dictations, and SS2's whole transcribe step is already 6% of its latency.
- **Formatting.** Hex pastes raw text, plus simple Labs rules for filler, "new line" and symbols. SS2's polish pass handles lists, paragraphs, self-corrections and app-aware tone. It also has the invention guard and the Balanced/Verbatim split.
- **Learning names.** Hex's vocabulary is a typed list, with decoder biasing off by default. SS2 learns "sounds like" aliases from History edits and the Teach Word dialog.
- **Everything beyond dictation.** Call recording with diarization, screen recording, Stream Deck pedal modes, voice commands on selected text, and replace-in-place.

## What to borrow, ranked

Impact is the expected gain in daily dictation quality. Effort assumes the current architecture.

| # | Idea | Impact | Effort | Notes |
|---|---|---|---|---|
| 1 | **A complete clipboard snapshot, restored only if unchanged.** Snapshot every pasteboard item and type at key-down (in `macos-fast-paste`, using `NSPasteboard` items). Mark the transcript `org.nspasteboard.TransientType` / `AutoGeneratedType`. Restore only if `changeCount` still matches the paste. | High | Low | Fixes three real defects: a copied image or rich text is lost after dictating; a copy made within 450 ms of a paste is overwritten; and every dictation fills clipboard history. It is a small native change, testable in isolation. |
| 2 | **A 200 ms tail after release.** Keep `MediaRecorder` running ~200 ms after key-up. Play the stop cue at release so it still feels instant. | High | Low | Hex measured the last word kept 10/10 with the tail and 7/10 when cut 100 ms early. It adds 200 ms of wall time, but the polish pass (~800 ms) dwarfs it. |
| 3 | **Pre-roll from a warm mic.** Keep a ~450 ms ring buffer of input open while idle and prepend it to each clip. | High | Medium | It catches the first syllable when speech starts with the press. The cost is that the macOS mic indicator stays on, so make it a setting ("Keep microphone ready"). It would need an AudioWorklet ring buffer in the renderer or a small native capture helper. Measure first-word loss before and after. |
| 4 | **Treat a modifier-only hold as a chord when another key is pressed.** Discard the clip if a non-modifier key is pressed during a Globe/Option hold. Raise the modifier-only minimum to 300 ms. | Medium | Low | Prevents stray recordings from shortcuts such as Fn+F or Option+click. The chord-breaker key (0x44) matters only if Scott binds Option or uses Raycast/Karabiner tap detection. |
| 5 | **A voice detector after the loudness gate.** Silero VAD is 1.2 MB and runs on the CPU. | Medium | Medium | SS2's peak-RMS gate catches true silence but not a cough or keyboard noise, which Parakeet can turn into a word. Matters less for Parakeet than for Whisper. |
| 6 | **Avoid Bluetooth default mics.** When the system default input is Bluetooth, use the built-in mic. | Medium | Low | AirPods switching to the call-quality profile also degrades whatever audio is playing. Offer it as a setting, on by default. |
| 7 | **Look up the V key in the current layout.** Use `UCKeyTranslate` to find the Command-layer V, and type the text for Chromium builds that drop pastes. | Low–medium | Low | Only matters on non-US layouts or the affected Chrome versions. |
| 8 | **Stream transcription during long holds.** | Low for SS2 | High | Most of Hex's gain is on clips over a minute (2.8 s → 0.25 s). For SS2's typical dictation, polish output length dominates, so streaming the *polish* would help more than streaming ASR. Revisit only for long-form dictation. |

## Recommended next PR

**Ideas 1 and 2 together: a lossless clipboard, plus a 200 ms release tail.** Both are small, measurable and low-risk:

- **Clipboard:** a `--snapshot` / `--restore-if-unchanged` mode in `resources/macos-fast-paste.swift`, called from `ClipboardManager.pasteMacOS`. Test by copying an image, dictating, and checking the image comes back. Test the race by copying text 200 ms after a paste and checking it survives.
- **Tail:** delay `MediaRecorder.stop()` by 200 ms in `audioManager.stopRecording` and keep the stop cue at release. Accept it when a 20-phrase "ends on a hard consonant" set keeps every last word, with the transcript otherwise unchanged.

Pre-roll (idea 3) should follow as its own PR, starting with a first-word-loss measurement. It changes the always-on mic behaviour, which is Scott's call.
