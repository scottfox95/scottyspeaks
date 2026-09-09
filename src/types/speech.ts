export interface SpeechStatus {
  available: boolean;
  speaking: boolean;
  starting: boolean;
  source: "user" | "agent" | null;
  text: string;
  recording: boolean;
  recordingCount: number;
  error: string | null;
  voice: string;
  rate: number;
  agentEnabled: boolean;
}
export interface SpeechAPI {
  status(): Promise<SpeechStatus>;
  voices(): Promise<{ name: string; language: string }[]>;
  configure(
    patch: Partial<Pick<SpeechStatus, "voice" | "rate" | "agentEnabled">>
  ): Promise<SpeechStatus>;
  speak(args: { text: string }): Promise<SpeechStatus>;
  stop(): Promise<SpeechStatus>;
  beginRecording(kind: "dictation" | "notes"): Promise<string>;
  endRecording(token: string): Promise<void>;
  onChange(callback: (state: SpeechStatus) => void): () => void;
}
