import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import AudioManager from "../helpers/audioManager";
import logger from "../utils/logger";
import { playStartCue, playStopCue } from "../utils/dictationCues";
import { getSettings } from "../stores/settingsStore";
import { getRecordingErrorTitle } from "../utils/recordingErrors";

const FAILED_LABEL_MS = 4000;
const LEVEL_HISTORY = 28; // ~2.8 s of meter at 100 ms per sample

export const useAudioRecording = (toast, options = {}) => {
  const { t } = useTranslation();
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [pipelineStage, setPipelineStage] = useState("idle");
  const [isStreaming, setIsStreaming] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [partialTranscript, setPartialTranscript] = useState("");
  // Overlay v2 (destination card): what the card shows besides the stage.
  const [levels, setLevels] = useState(() => new Array(LEVEL_HISTORY).fill(0));
  const [targetApp, setTargetApp] = useState("");
  const [startedAt, setStartedAt] = useState(null);
  const [outcome, setOutcome] = useState(null);
  const audioManagerRef = useRef(null);
  const startLockRef = useRef(false);
  const stopLockRef = useRef(false);
  const commandModeRef = useRef(false);
  const { onToggle, card = false } = options;
  // In card mode dictation outcomes (pasted, on clipboard, failed) belong to
  // the card, not to toasts.
  const cardRef = useRef(card);
  cardRef.current = card;
  const targetAppRef = useRef("");
  const pipelineStageRef = useRef("idle");
  pipelineStageRef.current = pipelineStage;
  // The dictation engine must live for the whole window: tearing it down
  // because `t` (language load), `toast` or `onToggle` changed identity can
  // drop a hotkey press that arrives during the swap. Read them through refs.
  const tRef = useRef(t);
  const toastRef = useRef(toast);
  const onToggleRef = useRef(onToggle);
  useEffect(() => {
    tRef.current = t;
    toastRef.current = toast;
    onToggleRef.current = onToggle;
  });

  // "Failed" under the idle button is a notice, not a state: clear it after a
  // few seconds (the next dictation also replaces it).
  useEffect(() => {
    if (pipelineStage !== "failed") return;
    const timer = setTimeout(() => {
      setPipelineStage((current) => (current === "failed" ? "idle" : current));
    }, FAILED_LABEL_MS);
    return () => clearTimeout(timer);
  }, [pipelineStage]);

  const performStartRecording = useCallback(async () => {
    if (startLockRef.current) return false;
    startLockRef.current = true;
    try {
      if (!audioManagerRef.current) return false;

      const currentState = audioManagerRef.current.getState();
      if (currentState.isRecording || currentState.isProcessing) return false;

      const didStart = audioManagerRef.current.shouldUseStreaming()
        ? await audioManagerRef.current.startStreamingRecording()
        : await audioManagerRef.current.startRecording();

      if (didStart) {
        void playStartCue();
      } else {
        commandModeRef.current = false;
        if (audioManagerRef.current) audioManagerRef.current.commandMode = false;
      }

      return didStart;
    } finally {
      startLockRef.current = false;
    }
  }, []);

  const performStopRecording = useCallback(async () => {
    if (stopLockRef.current) return false;
    stopLockRef.current = true;
    try {
      if (!audioManagerRef.current) return false;

      const currentState = audioManagerRef.current.getState();
      if (
        !currentState.isRecording &&
        !currentState.isRecordingStartInProgress &&
        !currentState.isStreamingStartInProgress
      ) {
        return false;
      }

      if (currentState.isStreaming || currentState.isStreamingStartInProgress) {
        void playStopCue();
        return await audioManagerRef.current.stopStreamingRecording();
      }

      const didStop = audioManagerRef.current.stopRecording();

      if (didStop) {
        void playStopCue();
      }

      return didStop;
    } finally {
      stopLockRef.current = false;
    }
  }, []);

  useEffect(() => {
    const t = (...args) => tRef.current(...args);
    const toast = (...args) => toastRef.current(...args);
    const onToggle = () => onToggleRef.current?.();
    audioManagerRef.current = new AudioManager();

    audioManagerRef.current.setCallbacks({
      onLevel: (level) => {
        setLevels((previous) => [...previous.slice(1), level]);
      },
      onTarget: ({ appName }) => {
        targetAppRef.current = appName || "";
        setTargetApp(appName || "");
      },
      onStateChange: ({ isRecording, isProcessing, isStreaming, pipelineStage }) => {
        if (isRecording) {
          // A new take: start the timer, clear the last outcome and meter.
          setStartedAt((previous) => previous ?? Date.now());
          setOutcome(null);
        } else if (!isProcessing) {
          setStartedAt(null);
          setLevels(new Array(LEVEL_HISTORY).fill(0));
        }
        setIsRecording(isRecording);
        setIsProcessing(isProcessing);
        setPipelineStage((previous) => pipelineStage || (isRecording ? "recording" : isProcessing ? "transcribing" : previous === "failed" ? "failed" : "idle"));
        setIsStreaming(isStreaming ?? false);
        if (!isStreaming) {
          setPartialTranscript("");
        }
      },
      onError: (error) => {
        if (error.code !== "POLISH_UNAVAILABLE" && error.code !== "PASTE_FAILED") setPipelineStage("failed");
        const pasteKey = error.onClipboard ? "clipboard" : "manual";
        const title = error.code === "PASTE_FAILED" ? t(`recordingTarget.${pasteKey}Title`) : error.code === "POLISH_UNAVAILABLE" ? t("dictationCleanup.polishUnavailableTitle") : getRecordingErrorTitle(error, t);
        const isSoftPasteFailure =
          error.code === "PASTE_FAILED" || error.code === "POLISH_UNAVAILABLE";
        // Say which gate fired and where, so a refusal is never a mystery.
        const reasonKey = `recordingTarget.reasons.${error.reason || "unknown"}`;
        const reasonText = t(reasonKey) === reasonKey ? t("recordingTarget.reasons.unknown") : t(reasonKey);
        if (cardRef.current && error.code !== "POLISH_UNAVAILABLE") {
          setOutcome(
            error.code === "PASTE_FAILED"
              ? { kind: error.onClipboard ? "clipboard" : "manual", app: error.appName || targetAppRef.current, reason: reasonText }
              : { kind: "failed", title, description: error.description || "" }
          );
          return;
        }
        const pasteDescription =
          error.onClipboard && error.appName
            ? t("recordingTarget.clipboardDescriptionApp", { app: error.appName, reason: reasonText })
            : error.onClipboard
              ? t("recordingTarget.clipboardDescriptionReason", { reason: reasonText })
              : t(`recordingTarget.${pasteKey}Description`);
        toast({
          title,
          description: error.code === "PASTE_FAILED" ? pasteDescription : error.code === "POLISH_UNAVAILABLE" ? t("dictationCleanup.polishUnavailable") : error.description,
          variant: isSoftPasteFailure ? "default" : "destructive",
          duration: error.code === "AUTH_EXPIRED" ? 8000 : isSoftPasteFailure ? 6000 : undefined,
        });
      },
      onPartialTranscript: (text) => {
        setPartialTranscript(text);
      },
      onTranscriptionComplete: async (result) => {
        const manager = audioManagerRef.current;
        const cancelled = () => !manager || audioManagerRef.current !== manager || result.isCancelled?.();
        if (cancelled()) return;
        if (result.success) {
          const transcribedText = result.text?.trim();

          if (!transcribedText) {
            if (commandModeRef.current) {
              commandModeRef.current = false;
              if (audioManagerRef.current) audioManagerRef.current.commandMode = false;
            }
            return;
          }

          // Voice command mode: the transcript is an instruction, not content
          if (commandModeRef.current) {
            result.evidenceFinalText = "";
            result.evidenceError = "Voice command did not apply";
            commandModeRef.current = false;
            if (audioManagerRef.current) audioManagerRef.current.commandMode = false;
            try {
              const { applyVoiceCommand } = await import("../services/polish/voiceCommand");
              if (cancelled()) return;
              const lastPasted = manager.lastPastedText;
              const res = await applyVoiceCommand(transcribedText, lastPasted, result.targetToken);
              if (cancelled()) return;
              if (res.ok && res.text) {
                result.evidenceFinalText = res.text;
                result.evidenceError = undefined;
                let replaced = false;
                if (res.usedSelection) {
                  // Pasting over a live selection already replaces it
                  const pasted = await audioManagerRef.current.safePaste(res.text, { targetToken: result.targetToken, exact: result.captureSnapshot?.cleanup.exact });
                  result.evidenceFinalText = pasted?.text ?? res.text;
                  if (!pasted || pasted.success === false) result.evidenceError = "Result retained for manual copy; original target could not be verified";
                  replaced = !!pasted && pasted.success !== false;
                } else {
                  // Nothing selected: replace our own previous paste when it's
                  // still verifiably on screen; otherwise retain for manual Copy.
                  const replacement = await window.electronAPI?.replaceLastPaste?.(
                    res.text,
                    res.target || lastPasted || "",
                    { targetToken: result.targetToken }
                  );
                  replaced = !!replacement?.replaced;
                  if (replaced) manager.lastPastedText = res.text;
                  else result.evidenceError = "Result retained for manual copy; original target could not be verified";
                }
                if (cancelled()) return;
                const saved = await manager.saveTranscription(result.evidenceFinalText, result.rawText);
                result.historyId = saved?.transcription?.id;
                if (!saved?.success) result.evidenceError = "History could not be saved";
                // A failed safePaste has already shown its own paste-failure
                // toast; a second "Text ready to copy" would only repeat it.
                if (res.usedSelection && !replaced) return;
                toast({
                  title: replaced ? `✨ ${transcribedText}` : t("recordingTarget.manualTitle"),
                  description: replaced
                    ? t(res.usedSelection ? "recordingTarget.selectionReplaced" : "recordingTarget.dictationReplaced")
                    : t("recordingTarget.manualDescription"),
                  variant: "default",
                  duration: 4000,
                });
              } else {
                toast({
                  title: "Voice command didn't apply",
                  description:
                    res.error === "no-target"
                      ? "Select some text first, or dictate something to edit."
                      : "The AI couldn't process that instruction. Try again.",
                  variant: "default",
                  duration: 5000,
                });
              }
            } catch (e) {
              toast({
                title: "Voice command failed",
                description: e?.message,
                variant: "destructive",
              });
            }
            return;
          }

          // Snippet matching: check if transcribed text matches a snippet keyword
          let finalText = result.text;
          let wasSnippet = false;
          try {
            const snippet = result.captureSnapshot?.cleanup.exact ? null : await window.electronAPI?.findSnippet?.(transcribedText);
            if (snippet) {
              finalText = snippet.expansion;
              wasSnippet = true;
            }
          } catch (e) {
            // Snippet lookup failed, use original text
          }

          if (cancelled()) return;

          // Apply regex style rules only when the AI polish pass didn't run
          // (snippets and AI-polished text must not be re-mangled by regex)
          const wasAiPolished = result.polished === true;
          if (!wasSnippet && !wasAiPolished && !result.captureSnapshot?.cleanup.exact) {
            try {
              const profile = result.captureSnapshot ?
                (result.captureSnapshot.context.styleRules ? { rules: JSON.stringify(result.captureSnapshot.context.styleRules) } : null)
                : await window.electronAPI?.getActiveStyleProfile?.();
              if (cancelled()) return;
              if (profile) {
                const { applyStyleRules } = await import("../services/StyleProcessor");
                if (cancelled()) return;
                const rules = JSON.parse(profile.rules);
                finalText = applyStyleRules(finalText, rules, result.captureSnapshot?.cleanup);
              }
            } catch (e) {
              // Style processing failed, use text as-is
            }
          }

          if (cancelled()) return;
          setTranscript(finalText);

          const isStreaming = result.source?.includes("streaming");
          const pasteStart = performance.now();
          const pasteResult = await audioManagerRef.current.safePaste(
            finalText,
            { fromStreaming: !!isStreaming, targetToken: result.targetToken, exact: result.captureSnapshot?.cleanup.exact }
          );
          logger.info(
            "Paste timing",
            {
              pasteMs: Math.round(performance.now() - pasteStart),
              source: result.source,
              textLength: finalText.length,
            },
            "streaming"
          );

          result.evidenceFinalText = pasteResult?.text ?? finalText;
          if (pasteResult === false || pasteResult?.success === false) result.evidenceError = "Result retained for manual copy; original target could not be verified";
          else if (cardRef.current && !cancelled())
            setOutcome({
              kind: "pasted",
              app: pasteResult?.appName || targetAppRef.current,
              words: (pasteResult?.text ?? finalText).split(/\s+/).filter(Boolean).length,
            });
          if (cancelled()) return;
          const saved = await manager.saveTranscription(result.evidenceFinalText, result.rawText);
          result.historyId = saved?.transcription?.id;
          if (!saved?.success) result.evidenceError = "History could not be saved";

          // Record usage stats
          const wordCount = finalText.split(/\s+/).filter(w => w.length > 0).length;
          const durationSeconds = result.audioDurationMs
            ? Math.round(result.audioDurationMs / 1000)
            : 0;
          window.electronAPI?.recordUsage?.(wordCount, durationSeconds).catch(() => {});

          if (result.source === "openai-fallback" && getSettings().useLocalWhisper) {
            toast({
              title: t("hooks.audioRecording.fallback.title"),
              description: t("hooks.audioRecording.fallback.description"),
              variant: "default",
            });
          }

          // Cloud usage: limit reached after this transcription
          if (result.source === "openwhispr" && result.limitReached) {
            // Notify control panel to show UpgradePrompt dialog
            window.electronAPI?.notifyLimitReached?.({
              wordsUsed: result.wordsUsed,
              limit:
                result.wordsRemaining !== undefined
                  ? result.wordsUsed + result.wordsRemaining
                  : 2000,
            });
          }

          if (audioManagerRef.current.sttConfig?.dictation?.mode === "streaming") {
            audioManagerRef.current.warmupStreamingConnection();
          }
        }
      },
    });

    audioManagerRef.current.setContext("dictation");
    window.electronAPI.getSttConfig?.().then((config) => {
      if (config && audioManagerRef.current) {
        audioManagerRef.current.setSttConfig(config);
        if (config.dictation?.mode === "streaming") {
          audioManagerRef.current.warmupStreamingConnection();
        }
      }
    });

    const handleToggle = async () => {
      if (!audioManagerRef.current) return;
      const currentState = audioManagerRef.current.getState();

      if (
        currentState.isRecording ||
        currentState.isRecordingStartInProgress ||
        currentState.isStreamingStartInProgress
      ) {
        await performStopRecording();
      } else if (!currentState.isProcessing) {
        await performStartRecording();
      }
    };

    const handleStart = async () => {
      await performStartRecording();
    };

    const handleStop = async () => {
      await performStopRecording();
    };

    const disposeToggle = window.electronAPI.onToggleDictation(() => {
      handleToggle();
      onToggle?.();
    });

    const disposeStart = window.electronAPI.onStartDictation?.(() => {
      handleStart();
      onToggle?.();
    });

    const disposeStop = window.electronAPI.onStopDictation?.(() => {
      handleStop();
      onToggle?.();
    });

    // Pedal "command" switch: record a spoken instruction instead of content
    const disposeCommand = window.electronAPI.onStartCommandDictation?.(() => {
      commandModeRef.current = true;
      if (audioManagerRef.current) audioManagerRef.current.commandMode = true;
      handleStart();
      onToggle?.();
    });

    const handleNoAudioDetected = () => {
      if (cardRef.current) {
        setOutcome({
          kind: "failed",
          title: t("hooks.audioRecording.noAudio.title"),
          description: t("hooks.audioRecording.noAudio.description"),
        });
        return;
      }
      toast({
        title: t("hooks.audioRecording.noAudio.title"),
        description: t("hooks.audioRecording.noAudio.description"),
        variant: "default",
      });
    };

    const disposeNoAudio = window.electronAPI.onNoAudioDetected?.(handleNoAudioDetected);

    // Cleanup
    return () => {
      disposeToggle?.();
      disposeStart?.();
      disposeStop?.();
      disposeCommand?.();
      disposeNoAudio?.();
      if (audioManagerRef.current) {
        audioManagerRef.current.cleanup();
      }
    };
  }, [performStartRecording, performStopRecording]);

  const startRecording = async () => {
    return performStartRecording();
  };

  const stopRecording = async () => {
    return performStopRecording();
  };

  const cancelRecording = async () => {
    if (audioManagerRef.current) {
      const state = audioManagerRef.current.getState();
      const cancelled =
        state.isStreaming || audioManagerRef.current.streamingStartInProgress
          ? await audioManagerRef.current.cancelStreamingRecording()
          : audioManagerRef.current.cancelRecording();
      if (cancelled) setOutcome({ kind: "cancelled" });
      return cancelled;
    }
    return false;
  };

  /** During polish this pastes the unrefined text (see D23); earlier it discards the take. */
  const cancelProcessing = () => {
    if (audioManagerRef.current) {
      const refining = pipelineStageRef.current === "refining";
      const cancelled = audioManagerRef.current.cancelProcessing();
      if (cancelled && !refining) setOutcome({ kind: "cancelled" });
      return cancelled;
    }
    return false;
  };

  const dismissOutcome = useCallback(() => setOutcome(null), []);

  const toggleListening = async () => {
    const currentState = audioManagerRef.current?.getState();
    if (!currentState) return;
    if (
      currentState.isRecording ||
      currentState.isRecordingStartInProgress ||
      currentState.isStreamingStartInProgress
    ) {
      await stopRecording();
    } else if (!currentState.isProcessing) {
      await startRecording();
    }
  };

  return {
    isRecording,
    isProcessing,
    pipelineStage,
    isStreaming,
    transcript,
    partialTranscript,
    startRecording,
    stopRecording,
    cancelRecording,
    cancelProcessing,
    toggleListening,
    levels,
    targetApp,
    startedAt,
    outcome,
    dismissOutcome,
  };
};
