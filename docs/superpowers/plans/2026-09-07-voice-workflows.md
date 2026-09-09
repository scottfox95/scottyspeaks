# Voice workflows implementation plan

Spec: `docs/superpowers/specs/2026-09-07-voice-workflows.md`.
Keep branch `codex/reliable-dictation-call-notebook`, preserve the substantial existing dirty tree. No commits/pushes as a side effect of task execution. User approved the proposed feature set and delegated implementation choices.

## Global constraints

- Preserve earlier app changes and installed user data/API keys.
- All UI text uses every locale. New persisted data stays inside app userData unless the user explicitly files/exports it.
- Cloud remains opt-in; do not upload real recordings, client documents or chats for tests.
- Sender validation, strict path confinement, bounded payloads, no secret logging.
- Keep raw evidence; never overwrite manually edited transcripts or external Markdown without conflict detection.
- App architecture remains Electron/React and existing native macOS helpers.

## Tasks and authoritative completion evidence

### 1. Shared local inference priority
Files: new `src/helpers/inferenceScheduler.js`, `tests/inference-scheduler.test.cjs`; integration in `ipcHandlers.js` and `meetingHandlers.js`.
Interface: export singleton `inferenceScheduler` and class `InferenceScheduler`; `run(task,{priority:'foreground'|'background',signal?})` returns task result; `status()` reports active/queued counts. Internal foreground reservation API if needed for actual recording priority is explicitly documented.
Write tests for foreground overtaking queued background work, serial execution, failure recovery, queued cancellation, and fairness/resumption. Wire dictation local IPC foreground and meeting per-chunk inference background. Verify actual handlers use the shared instance. Retain no-network local contract. Later UI task surfaces queue state.

### 2. Audio evidence store and safe playback
Files: new capture store/handlers, existing `audioManager.js`, `useAudioRecording.js`, `database.js`, `main.js`, `preload.js`, types; meeting playback support in `meetingHandlers.js`/`meetingStore.js`.
Persist dictation audio and metadata using generated IDs with retention (off/1/7/30 days; default 7 days and visible UI). Capture after silence validation, finalize text after processing, link history ID. Playback reads only registered ID/source; serve seekable audio through a confined protocol or bounded chunk interface, not arbitrary renderer file reads. Prepare browser-playable audio for CAF with cached conversion; handle take offsets. Write temp-store/retention/path/cancel tests and synthetic playback checks.

### 3. Replay/repair and call playback UI
Files: history detail component, history integration, meeting audio player, MeetingsView, all locales.
Show original audio, raw/final text and settings snapshots. Retry requires explicit model/provider choice and returns a preview. This-was-wrong saves original/final/corrected fixture locally. Do not silently paste or replace external text. Timestamp click selects correct take/source and seeks; text-only import is clear. Keyboard controls and normal media seeking work. Real isolated Electron tests must actually exercise playback position, repair preview/save and retention-unavailable state.

### 4. Cleanup controls and visible pipeline
Files: settings store/hook/UI, style/polish service and audio manager, all locales.
Separate exact wording from optional cleanup/self-corrections/technical preservation, snapshot settings per capture. Distinguish transcribing/refining/queued/failed states. Regression inputs include meaningful fillers, paragraphs, code identifiers, dictated questions, numeric corrections, incomplete utterances and negation. Compatibility with existing styles and voice commands is required. UI tests validate changed controls affect processing requests.

### 5. Original-target paste and clipboard integrity
Files: native target helper, `clipboard.js`, `ipcHandlers.js`, recording start integration, preload/types/build integration, tests.
Capture PID/window/AX field identity at start, verify before paste, safely restore original focus only when verifiable; otherwise manual-copy fallback with retained transcript. Clipboard restoration gated on pasteboard change count and preserves supported existing formats. Avoid raw target text retention. Test focus-change/stale-target/new-copy branches and compile native helper. Actual non-sensitive destination app acceptance when available.

### 6. Selected-call agent interface and evidence drafts
Files: dedicated local bridge/store adapters, stdio MCP executable, call sharing/export controls and types, main/preload, packaging, all locales.
Use explicit per-call grants/revocation with least-privilege read tools, timed source metadata, selected-call Markdown handoff. No broad file access. Agent draft submission validates selected grant and attaches citations to existing segment IDs/time references, stays separate from source and requires review/file action. Supply install/config instructions without automatically changing external agent permissions. Test MCP initialize/tools/list/tools/call framing, unknown methods, denied unselected/revoked calls, path attempts, draft isolation and evidence validation; live subprocess transport test.

### 7. Local read-aloud, agent notifications and final release
Files: local speech manager, UI speech controls, bridge optional speaking tool, all locales, docs/package.
Use system voices via a bounded main-process invocation, no shell text interpolation. Visible speaking state and Stop; call/dictation start suppresses playback. Agent speech disabled by default and rejects while recording. Test lifecycle/cancel/mute; real synthetic text synthesis to file (no surprise speaker playback). Finish all preceding gaps, final review, core + UI + native + bridge verification, package/sign/install preserving credentials/data, update work-Mac ZIP and docs. Record hardware/cloud quality limits separately from implemented contracts.

## Cross-task boundaries

| Tasks | Interface | Review requirement |
| --- | --- | --- |
| 1/2/4 | scheduler and audio lifecycle | queue state spans local inference, failures always release |
| 2/3 | capture ID/audio metadata | no arbitrary file paths, immutable source and offsets |
| 2/4 | settings snapshot | old captures retain original flags/model |
| 2/5 | recording-start target | a target is scoped to one recording, never reused accidentally |
| 3/6 | selected call and evidence | grants reference existing sessions; drafts never replace sources |
| 1/7 | recording/speech activity | call and dictation starts stop optional spoken output |
| All | main/preload/types/locales | serialize edits to shared integration files, review before release |

Each task's evidence must cover its specified behavior, not just pure helpers. Work is incomplete until UI, main-process paths, installed packaging, and documented access boundaries agree.
