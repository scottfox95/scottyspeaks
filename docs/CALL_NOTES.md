# Call notes in SS2 0.2.0

Open **Call notes** in the sidebar. This notebook stores calls locally and files ordinary Markdown into the folders you choose.

## Your workflow

1. Create a **New call**, give it a title, and start recording. macOS 15 or newer is required for microphone plus system audio capture. Permit SS2 in Microphone and Screen & System Audio Recording when macOS asks. Calls must play through this Mac; a separate phone is not captured.
2. Write notes while the call runs. The recording indicator remains visible when you visit another section. Stop finalizes microphone and system tracks. You can record another take before transcribing.
3. Transcribe using the selected mode. Transcription starts only when you request it. You can instead import audio, or an existing Zoom/Teams VTT, SRT or text transcript. If a result is wrong or a provider fails, change the provider, model or key and choose **Transcribe again**. The old transcript remains until the retry succeeds.
4. Rename speakers, edit the transcript, and add Markdown notes. Draft changes save automatically. The source timing metadata remains in the local session; manually edited transcript text is explicitly marked as edited.
5. Pin a real project, initiative or person folder using the native folder picker. Select that destination and choose **Save Markdown**. Open the saved file in Finder. Pinning does not move or index the folder's existing contents.

Editing the draft does not automatically overwrite an already filed Markdown file. Save Markdown again when ready. If another editor changed that file, SS2 refuses to overwrite it; **Save a copy** preserves both versions. Missing/unavailable folders leave the draft intact.

## Local or MAI

**Local** is the default. Select the installed Parakeet or Whisper model in Call notes settings. Audio is processed on this Mac without remote inference. Synchronized microphone and call-audio tracks are mixed once for transcription so the conversation is not duplicated. Playback and **Export audio…** retain source selection, including microphone, call audio or the combined recording. Local transcription does not identify individual remote participants, and its timestamps identify processing chunks rather than individual words.

**OpenRouter / MAI-Transcribe 2** is optional. Add your OpenRouter API key in Call notes settings, select that mode, then explicitly transcribe. Version 0.2.1 shows a checkmark and “API key saved on this Mac” once stored; use Replace key to change it. Saving confirms secure local storage, not provider acceptance. OpenRouter checks the key when you transcribe. This sends the selected call audio and dictionary hints to OpenRouter's provider. The key is encrypted with Electron safeStorage and never returned to the renderer. SS2 decrypts a stored key once per app launch and keeps the plaintext only in main-process memory until quit; replacing or removing the key updates that memory immediately. There is no automatic fallback from local to cloud. Recording itself stays local in either mode.

MAI is speech-to-text and requests speaker diarization plus segment/word timestamps. The adapter follows the [OpenRouter STT contract](https://openrouter.ai/docs/guides/overview/multimodal/stt). [Model pricing](https://openrouter.ai/microsoft/mai-transcribe-2) was listed as $0.10/audio-hour when checked September 6, 2026. Cloud calls are sent as one compressed request so speaker identities remain consistent across the recording. A transient timeout or provider error retries that complete request once; it never subdivides the call into independently numbered speaker sets. Actual recognition and speaker accuracy still require review against the retained audio.

## Recovery and portability

Drafts and original audio are kept under the app's user-data directory in `call-notes/`. Quitting or a failed request does not intentionally discard them. Completed transcription parts are checkpointed for retry. Cancelling local transcription takes effect after the active preparation/inference operation finishes. Recordings stop automatically after six hours.

After a crash or imported recording, transcribe the saved audio and start a new call for additional recording. SS2 blocks appending where it cannot safely establish the next timestamp. An unexpected shutdown can still damage an audio file being written; recovery is best effort.

Pinned folder paths and call contents are local to each Mac. Pin the appropriate work folders on the work Mac. Use the existing settings export/import scripts to transfer dictation preferences and learned vocabulary deliberately; call audio and the OpenRouter key are not included in that settings transfer.

This version provides transcripts and your own notes. Automatic summaries, decisions and action extraction are potential follow-ups, not enabled features.
