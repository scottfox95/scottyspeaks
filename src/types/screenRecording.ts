export type ScreenRecordingResult<T> =
  | { success: true; data: T }
  | { success: false; error: string; code: string | null };

export interface ScreenSource {
  type: "display" | "window";
  id: number;
}

export interface ScreenDisplay {
  id: number;
  index: number;
  width: number;
  height: number;
}

export interface ScreenWindow {
  id: number;
  title: string;
  app: string;
}

export interface ScreenRecordingOutcome {
  name: string;
  file: string | null;
  duration: number;
  error: string | null;
  reason: "disk" | null;
  convertError?: string;
}

export interface ScreenRecordingStatus {
  recording: boolean;
  stopping?: boolean;
  startedAt?: number;
  name?: string;
  bytes?: number;
  finalizing: boolean;
  last: ScreenRecordingOutcome | null;
}

export interface ScreenRecordingFile {
  name: string;
  bytes: number;
  modifiedAt: number;
}

export interface ScreenRecordingConfig {
  available: boolean;
  directory: string;
  permission: "granted" | "denied" | "not-determined" | "restricted" | "unknown";
}

export interface ScreenRecordingAPI {
  status: () => Promise<ScreenRecordingResult<ScreenRecordingStatus>>;
  config: () => Promise<ScreenRecordingResult<ScreenRecordingConfig>>;
  sources: () => Promise<
    ScreenRecordingResult<{ displays: ScreenDisplay[]; windows: ScreenWindow[] }>
  >;
  list: () => Promise<ScreenRecordingResult<ScreenRecordingFile[]>>;
  start: (args: {
    source?: ScreenSource;
    systemAudio: boolean;
    microphone: boolean;
  }) => Promise<ScreenRecordingResult<ScreenRecordingStatus>>;
  stop: () => Promise<ScreenRecordingResult<ScreenRecordingOutcome | null>>;
  open: (args: { name: string }) => Promise<ScreenRecordingResult<void>>;
  reveal: (args: { name: string }) => Promise<ScreenRecordingResult<void>>;
  openFolder: () => Promise<ScreenRecordingResult<void>>;
  delete: (args: { name: string }) => Promise<ScreenRecordingResult<void>>;
  openPermissionSettings: () => Promise<ScreenRecordingResult<void>>;
}
