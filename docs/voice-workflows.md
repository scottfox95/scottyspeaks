# SS2 0.3.0 voice workflows

## Dictation replay and repair

History exposes saved recordings and raw/final text with the model and cleanup settings captured when recording began. Choose an available transcription model, retry locally or with your explicitly selected cloud provider, review the preview, then accept it. A correction example is an explicit local fixture; it is never automatically sent to a provider or added to source control.

Audio retention can be Off, 1, 7 or 30 days. Expiry removes ordinary dictation audio and leaves text. Old history rows explain when audio was never saved. Explicit correction fixtures have their own lifetime and remain until deleted. Call audio is independent of dictation retention and of edited notes.

## Cleanup and delivery

Filler cleanup, explicit spoken self-corrections and exact wording are separate choices. Exact wording preserves technical spelling and bypasses style rewrites. Raw recognition remains available for comparison. Review important names, numbers, negation and consequential instructions; synthetic checks cannot establish every model’s recognition quality.

SS2 remembers the intended application and field when recording starts. If it cannot verify that field later, the transcript remains available for manual Copy. A focus change does not authorize inserting into a different field. Clipboard restoration preserves supported formats and avoids replacing a newer clipboard copy. Explicit voice commands retain their own selection/replace behavior.

## Call audio and agents

Play or export all audio, microphone audio or system audio, and click timestamps to seek across takes. Edited transcripts are clearly unaligned; original timed evidence stays separate. Local transcription mixes synchronized tracks into one timeline to avoid duplicate text and does not identify every remote person. A confirmed retranscription uses the currently selected provider/model, retains the prior transcript on failure and replaces it only after success. Optional cloud speaker labels need human review.

In a call’s Agents tab, explicitly share that call, copy the generated MCP configuration, and configure the client yourself. Keep SS2 open. Ready means the app’s private local bridge is listening; Last agent request reports authenticated access. No client configuration is edited automatically. Revoke permission in the same tab. Revocation blocks future access and stops that call’s agent speech, but cannot retract exported copies. Agent drafts remain separate until you review and explicitly file them. See [the agent guide](selected-call-agents.md).

## Local read-aloud

The control panel’s Voice settings lists installed macOS voices and a rate of 100–350 words per minute. Choose Read selection in a notes, transcript or draft section, or explicitly choose Read all for that field. User text is bounded to 20 KB and sent to the local speech process through stdin. It is not placed in command-line arguments or sent to a speech provider.

Stop reading is visible in the control panel and floating icon while speech starts or plays. The icon is shown without activating its window, including when auto-hide is enabled; the existing auto-hide preference resumes after speech ends. Dictation, note recording, streaming microphone prewarm, permission/device microphone probes and native call capture stop speech before opening their capture path. Their reservation remains until actual tracks or the native process have stopped. In-app replay players pause while recording and cannot resume until recording ends. Recognition work can continue after recording ends without unnecessarily blocking read-aloud.

Agent spoken updates are **off by default**. Enabling them lets an agent issue a brief update for a shared call through `speak_update`. Updates are bounded to 3 KB, are visible as agent speech, can be stopped, and are rejected while recording. They are not queued for later. Disable the setting or revoke the call to stop its agent speech.

## Local versus cloud and delivery

The shared local inference queue prioritizes foreground dictation over waiting call chunks. A chunk already running may finish first. Cloud requests are separate and occur only through the selected cloud configuration. Tests use synthetic content; no private recordings, client documents or real provider requests are used for acceptance.

The distributed Apple Silicon build requires macOS 13+ for dictation and macOS 15+ for native call capture. Read-aloud uses installed macOS system voices. On another Mac, follow its approved installation process and the archive’s INSTALL.txt, grant microphone/Accessibility permissions and call recording permissions where needed, download the desired models, and regenerate agent configuration from that Mac’s installed app. The packaged adapter uses SS2’s bundled runtime; Node is not required on the destination Mac.
