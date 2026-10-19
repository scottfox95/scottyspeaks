import type { MeetingResult } from "./meeting";
export interface CaptureSettings {
  provider?: string;
  model?: string;
  language?: string;
  styleId?: string;
  styleName?: string;
  styleRules?: Record<string, string | boolean>;
  dictionary?: string[];
  polishProvider?: string;
  polishModel?: string;
  cleanup?: {
    exact?: boolean;
    removeFillers?: boolean;
    resolveCorrections?: boolean;
    preserveTechnical?: boolean;
  };
}
export interface CaptureAttempt {
  id: string;
  createdAt: string;
  settings: CaptureSettings;
  rawText: string;
  finalText: string;
}
export interface DictationCapture {
  id: string;
  createdAt: string;
  durationSeconds: number;
  mimeType: string;
  settings: CaptureSettings;
  status: "processing" | "ready" | "failed";
  rawText: string;
  finalText: string;
  historyId?: number | null;
  error?: string | null;
  attempts: CaptureAttempt[];
  acceptedAttemptId?: string;
  acceptedText?: string;
  correctedText?: string;
  fixtureIds?: string[];
  audioAvailable: boolean;
  audioUnavailableReason: "disabled" | "expired" | null;
}
export interface CorrectionFixture {
  id: string;
  createdAt: string;
  captureId: string;
  expected: string;
}
export interface CaptureAPI {
  retryStatus(args: {
    id: string;
  }): Promise<MeetingResult<{ stage: "idle" | "preparing" | "queued" | "transcribing" }>>;
  listFixtures(): Promise<MeetingResult<CorrectionFixture[]>>;
  deleteFixture(args: { id: string }): Promise<MeetingResult<null>>;
  create(args: {
    audio: ArrayBuffer;
    mimeType: string;
    durationSeconds: number;
    settings: CaptureSettings;
  }): Promise<MeetingResult<DictationCapture>>;
  complete(args: {
    id: string;
    rawText?: string;
    finalText?: string;
    historyId?: number;
    error?: string;
  }): Promise<MeetingResult<DictationCapture>>;
  delete(args: { id: string }): Promise<MeetingResult<null>>;
  list(): Promise<MeetingResult<DictationCapture[]>>;
  get(args: { id: string }): Promise<MeetingResult<DictationCapture>>;
  forHistory(args: { historyId: number }): Promise<MeetingResult<DictationCapture | null>>;
  getConfig(): Promise<MeetingResult<{ retentionDays: 0 | 1 | 7 | 30 }>>;
  setConfig(args: {
    retentionDays: 0 | 1 | 7 | 30;
  }): Promise<MeetingResult<{ retentionDays: 0 | 1 | 7 | 30 }>>;
  playback(args: { id: string }): Promise<MeetingResult<{ url: string; durationSeconds: number }>>;
  releasePlayback(args: { url: string }): Promise<MeetingResult<null>>;
  retry(args: {
    id: string;
    provider: "whisper" | "parakeet" | "openrouter";
    model: string;
    language?: string;
    allowCloud?: boolean;
  }): Promise<MeetingResult<CaptureAttempt>>;
  cancelRetry(args: { id: string }): Promise<MeetingResult<null>>;
  acceptAttempt(args: { id: string; attemptId: string }): Promise<MeetingResult<DictationCapture>>;
  saveFixture(args: {
    id: string;
    correctedText: string;
  }): Promise<MeetingResult<{ id: string; path: string }>>;
}
