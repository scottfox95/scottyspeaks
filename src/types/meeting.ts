export interface MeetingSegment {
  start: number;
  end: number;
  text: string;
  speaker: string;
}
export interface Meeting {
  id: string;
  title: string;
  notes: string;
  transcript: string;
  transcriptEdited: boolean;
  segments: MeetingSegment[];
  speakers: Record<string, string>;
  revision: number;
  createdAt: string;
  updatedAt: string;
  status: string;
  provider: string;
  audio: { file: string; source: string; offset: number }[];
  exportPath?: string;
  lastError?: string;
  lastErrorCode?: string | null;
  lastErrorStatus?: number | null;
  lastErrorDetail?: string | null;
  recordedDuration?: number;
  needsTranscription?: boolean;
  progress?: { completed: number; total: number };
}
export interface MeetingFolder {
  id: string;
  name: string;
  path: string;
}
export interface MeetingConfig {
  provider: "local" | "openrouter";
  localEngine: "whisper" | "nvidia";
  localModel: string;
  hasKey: boolean;
  captureAvailable: boolean;
}
export interface CaptureStatus {
  id: string | null;
  startedAt?: number;
  stopping?: boolean;
}
export type MeetingResult<T> = { success: true; data: T } | { success: false; error: string };
export interface MeetingAPI {
  playback(args: {
    id: string;
    source?: "all" | "microphone" | "system" | "audio";
  }): Promise<MeetingResult<{ url: string; durationSeconds: number }>>;
  releasePlayback(args: { url: string }): Promise<MeetingResult<null>>;
  exportAudio(args: {
    id: string;
    source?: "all" | "microphone" | "system" | "audio";
  }): Promise<MeetingResult<{ path: string } | null>>;
  list(args?: unknown): Promise<MeetingResult<Meeting[]>>;
  create(args?: unknown): Promise<MeetingResult<Meeting>>;
  get(args: { id: string }): Promise<MeetingResult<Meeting>>;
  save(args: {
    id: string;
    patch: Partial<Meeting>;
    revision: number;
  }): Promise<MeetingResult<Meeting>>;
  folders(args?: unknown): Promise<MeetingResult<MeetingFolder[]>>;
  delete(args: { id: string }): Promise<MeetingResult<null>>;
  pinFolder(args?: unknown): Promise<MeetingResult<MeetingFolder | null>>;
  unpinFolder(args: { id: string }): Promise<MeetingResult<void>>;
  file(args: {
    id: string;
    folderId: string;
    asCopy?: boolean;
  }): Promise<MeetingResult<{ path: string; meeting: Meeting }>>;
  reveal(args: { id: string }): Promise<MeetingResult<void>>;
  getConfig(args?: unknown): Promise<MeetingResult<MeetingConfig>>;
  setConfig(
    args: Partial<MeetingConfig> & { apiKey?: string }
  ): Promise<MeetingResult<MeetingConfig>>;
  importTranscript(args?: unknown): Promise<MeetingResult<Meeting | null>>;
  importAudio(args?: unknown): Promise<MeetingResult<Meeting | null>>;
  startCapture(args: { id: string }): Promise<MeetingResult<CaptureStatus>>;
  stopCapture(args: { id: string }): Promise<MeetingResult<Meeting>>;
  captureStatus(args?: unknown): Promise<MeetingResult<CaptureStatus>>;
  transcribe(args: { id: string; force?: boolean }): Promise<MeetingResult<Meeting>>;
  cancelTranscription(args: { id: string }): Promise<MeetingResult<void>>;
}
