export interface RecordingAlert {
  key: string;
  source: "call" | "screen";
  id: string | null;
  reason: string;
  severity: "warning" | "error";
  title: string;
  body: string;
  at: number;
}

export interface RecordingAlertsState {
  alerts: RecordingAlert[];
  hasError: boolean;
}

type Result<T> = { success: true; data: T } | { success: false; error: string };

export interface RecordingAlertsAPI {
  get: () => Promise<Result<RecordingAlertsState>>;
  acknowledge: (args?: { key?: string }) => Promise<Result<RecordingAlertsState>>;
  onChange: (callback: (state: RecordingAlertsState) => void) => () => void;
}
