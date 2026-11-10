import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import AudioManager from "../helpers/audioManager";
import logger from "../utils/logger";
import { getRecordingErrorTitle } from "../utils/recordingErrors";

interface UseNoteRecordingOptions {
  onTranscriptionComplete: (text: string) => void;
  onError?: (error: { title: string; description: string }) => void;
}

interface UseNoteRecordingReturn {
  isRecording: boolean;
  isProcessing: boolean;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
  cancelRecording: () => void;
}

export function useNoteRecording({
  onTranscriptionComplete,
  onError,
}: UseNoteRecordingOptions): UseNoteRecordingReturn {
  const { t } = useTranslation();
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const audioManagerRef = useRef<InstanceType<typeof AudioManager> | null>(null);

  const callbacksRef = useRef({ onTranscriptionComplete, onError });
  callbacksRef.current = { onTranscriptionComplete, onError };

  useEffect(() => {
    const manager = new AudioManager();
    audioManagerRef.current = manager;
    manager.setSkipReasoning(true);

    manager.setCallbacks({
      onStateChange: ({
        isRecording,
        isProcessing,
      }: {
        isRecording: boolean;
        isProcessing: boolean;
      }) => {
        setIsRecording(isRecording);
        setIsProcessing(isProcessing);
      },
      onError: (error: { title: string; description: string; code?: string }) => {
        const title = getRecordingErrorTitle(error, t);
        callbacksRef.current.onError?.({ title, description: error.description });
      },
      onTranscriptionComplete: (result: { success: boolean; text: string }) => {
        if (result.success) {
          callbacksRef.current.onTranscriptionComplete(result.text);
        }
      },
    });

    manager.setContext("notes");

    return () => {
      manager.cleanup();
      audioManagerRef.current = null;
    };
  }, []);

  const startRecording = useCallback(async () => {
    const manager = audioManagerRef.current;
    if (!manager) return;

    const state = manager.getState();
    if (state.isRecording || state.isProcessing) return;

    const didStart = await manager.startRecording();
    if (!didStart) {
      logger.debug("Note recording failed to start", {}, "notes");
    }
  }, []);

  const stopRecording = useCallback(async () => {
    const manager = audioManagerRef.current;
    if (!manager) return;

    const state = manager.getState();
    if (!state.isRecording) return;

    manager.stopRecording();
  }, []);

  const cancelRecording = useCallback(() => {
    audioManagerRef.current?.cancelRecording();
  }, []);

  return {
    isRecording,
    isProcessing,
    startRecording,
    stopRecording,
    cancelRecording,
  };
}
