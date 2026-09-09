import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { SpeechStatus } from "../types/speech";
const SpeechContext = createContext<SpeechStatus | null>(null);
export function SpeechProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SpeechStatus | null>(null);
  useEffect(() => {
    const api = window.electronAPI?.speech;
    if (!api) return;
    let recording = false,
      disposed = false,
      changed = false;
    const apply = (state: SpeechStatus) => {
      if (disposed) return;
      recording = state.recording;
      if (recording)
        document
          .querySelectorAll<HTMLMediaElement>("audio, video")
          .forEach((media) => media.pause());
      setStatus(state);
    };
    const unsubscribe = api.onChange((state) => {
      changed = true;
      apply(state);
    });
    void api
      .status()
      .then((state) => {
        if (!changed) apply(state);
      })
      .catch(() => {});
    const guard = (event: Event) => {
      if (recording && event.target instanceof HTMLMediaElement) event.target.pause();
    };
    document.addEventListener("play", guard, true);
    return () => {
      disposed = true;
      unsubscribe();
      document.removeEventListener("play", guard, true);
    };
  }, []);
  return <SpeechContext.Provider value={status}>{children}</SpeechContext.Provider>;
}
export const useSpeech = () => useContext(SpeechContext);
