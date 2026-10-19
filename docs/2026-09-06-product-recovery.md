# ScottySpeaks: reliability and call notebook

Status: implemented in 0.2.0 on `codex/reliable-dictation-call-notebook`. The findings below describe the original baseline. See [Call notes](CALL_NOTES.md) for the delivered workflow and [Development](DEVELOPMENT.md) for verification and remaining hardware/provider acceptance checks.

## Outcome

Make everyday dictation predictable and add a call notebook that fits Scott's existing project, initiative, and people folders. Keep local dictation and the foot pedal. Offer paid transcription for calls through OpenRouter. Let Scott select the destination; pinned real filesystem folders are the primary filing mechanism.

## Verified findings

- The current checkout contains substantial uncommitted implementation work, including pedal support, CoreML, polishing, packaging, and settings migration. Preserve this work when establishing the implementation baseline.
- `src/services/StyleProcessor.ts` removes meaningful words using unconditional filler regexes. Executing the current function produced `I the option.` from `I like the right option.`, and `Use this microphone.` from `Use this kind of microphone.`. It also collapsed a blank line between two items. These are reproducible defects, not model-quality speculation.
- `src/utils/correctionLearner.js` ignores capitalization-only corrections. Executing `extractCorrections('I work at aravo', 'I work at Aravo', [])` returned an empty list. A spelling change from Shunade to Sinead was recognized in the same probe.
- Corrections in destination apps feed the dictionary through `IPCHandlers._processCorrections`. History edits have a separate route for teaching the polish engine. Dictionary hints do not guarantee a canonical spelling, and the current paths do not represent one consistent correction memory.
- `src/helpers/audioManager.js` validates polished output using word-count limits and a few response patterns. This cannot establish whether an equally long rewrite changes meaning or invents a sentence ending. The source of Scott's actual hallucinations still needs a raw-versus-final example and, ideally, its audio.
- The notes subsystem already has a Markdown editor, database folders, audio upload, and explicit export. Database folders are not the same as pinned Finder directories; the desired filing workflow needs a real filesystem contract.
- `npm run typecheck` fails before any changes. Failures include obsolete authentication/subscription interfaces and function-versus-result mismatches in audio upload and reasoning. Establishing a passing baseline is part of the work.

## Relevant workflow evidence

Prior ScottySpeaks Claude conversations describe repeated Aravo capitalization problems, different formatting and latency on the work machine, and friction deploying updates between computers. One conversation describes the work computer as the same model with more memory; treat that as historical context until confirmed.

The local TenenbaumAI project and relevant Codex task show a consulting workflow built around client context, discovery, private review, and evidence. Aravo initiative documents use meeting agendas and decision records. Useful extensions are therefore transcript-linked decisions, actions and open questions, plus a Markdown handoff that another coding agent can read from the chosen project folder. These are feature candidates, not permission to publish or send client material.

## Recommended sequence

1. **Reliable dictation.** Capture a repeatable baseline; fix destructive fallback formatting; make canonical spelling and correction learning inspectable and reversible; preserve source text; distinguish recognition errors from polish errors; measure transcription and polish latency separately. Test foot-pedal, hotkey, paste, local inference, and settings persistence explicitly.
2. **Folder-based call notebook.** Reuse the Markdown editing foundation. Support existing transcript imports as well as recorded audio. Keep source transcript, editable notes, and generated summary distinct. Pin actual directories through the native folder picker. Autosave a recoverable draft; file the reviewed note with a collision-safe filename and show its save state. Detect unavailable folders and external edits without overwriting work.
3. **Call capture and speaker-aware transcription.** Validate microphone plus remote/system audio on the actual target OS. Make recording state, pause, stop, audio sources, and recovery explicit. Add MAI through a dedicated transcription adapter. Preserve timed segments and words; let the user rename speakers. Speaker numbers from separate audio chunks must not be assumed to identify the same person.
4. **Portable operation and agent support.** Add repeatable verification commands, synthetic regression fixtures, and documented IPC/provider/file contracts. Make it easy to compare versions, settings, engines, and timings across machines. Export/import preferences and learned vocabulary deliberately; keep work and personal content separate by default.

## Call document contract to refine

- Human-readable `.md` stored in Scott's selected folder.
- Stable meeting identity, date, title, source, and editable participant labels.
- Separate personal notes, optional generated summary, decisions/actions, and speaker-attributed transcript.
- Generated decisions/actions link back to timed transcript evidence; inferred owners or deadlines remain unassigned rather than invented.
- Retain machine-readable segment/word metadata separately when needed for playback; an edited transcript must not silently retain inaccurate word alignment.
- File operations happen in the Electron main process with validated IPC payloads and an explicit selected destination.
- External folder writes preserve existing files and surface errors. An app crash or failed cloud request leaves a recoverable local draft.
- Cloud model selection must be visible. Do not upload historical client chats or documents as implicit model context.

## Provider findings, checked September 6, 2026

[MAI-Transcribe 2](https://openrouter.ai/microsoft/mai-transcribe-2) is speech-to-text. OpenRouter lists speaker diarization, word timestamps, keyword biasing, verbatim/clean styles, and a price of $0.10 per audio hour. Availability and actual quality still require a synthetic integration check and representative audio evaluation.

The [OpenRouter STT guide](https://openrouter.ai/docs/guides/overview/multimodal/stt) specifies `/api/v1/audio/transcriptions`, `verbose_json`, timestamp granularities, and `provider.options.azure.diarization.enabled`. This should be implemented as an audio transcription integration rather than passed through the text-polish endpoint. Long calls need size/time limits, bounded retries, absolute timestamp offsets, and explicit handling of chunk-local speaker IDs.

## Resolved requirements and remaining evidence

- Both target computers are Macs; the work Mac can capture system audio.
- Corrections normally happen in the destination application.
- Zoom, Teams, and phone calls all route through the computer.
- Both entirely local and explicit OpenRouter transcription are required and implemented.
- Representative wrong-output/corrected-output pairs with audio are still needed to assess recognition quality beyond the deterministic regressions.
- Automatic meeting summaries, extracted decisions/actions, and evidence-linked follow-ups remain optional product candidates. Version 0.2.0 provides the requested transcript and personal Markdown notes; it does not generate these additional artifacts.

## Release evidence required

A passing typecheck and relevant automated regression checks; realistic silence and truncated-sentence audio cases; successful dictation through the pedal/hotkey/paste path; restart-safe corrections; Markdown save/reopen and external-edit conflict checks; a synthetic speaker/timestamp API contract check; and a repeatable work-computer validation procedure. Do not describe the app as fixed on both machines based solely on local unit tests.
