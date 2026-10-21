import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Circle,
  Square,
  Loader2,
  FolderOpen,
  Play,
  Trash2,
  RefreshCw,
  ShieldAlert,
  MonitorPlay,
} from "lucide-react";
import { Button } from "../ui/button";
import { Toggle } from "../ui/toggle";
import type {
  ScreenRecordingResult,
  ScreenRecordingStatus,
  ScreenRecordingConfig,
  ScreenRecordingFile,
  ScreenDisplay,
  ScreenWindow,
} from "../../types/screenRecording";

class ScreenRecordingError extends Error {
  code: string | null;
  constructor(message: string, code: string | null) {
    super(message);
    this.code = code;
  }
}

async function unwrap<T>(promise: Promise<ScreenRecordingResult<T>>): Promise<T> {
  const result = await promise;
  if (!result.success)
    throw new ScreenRecordingError(
      "error" in result ? result.error : "Screen recording failed",
      "code" in result ? result.code : null
    );
  return result.data;
}

const clock = (seconds: number) => {
  const n = Math.max(0, Math.floor(seconds));
  const h = Math.floor(n / 3600);
  const mm = String(Math.floor((n % 3600) / 60)).padStart(2, "0");
  const ss = String(n % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};
const megabytes = (bytes: number) =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(2)} GB`
    : `${Math.round(bytes / 1024 ** 2)} MB`;
const PREFS_KEY = "screenRecordingPrefs";

export default function ScreenRecordingsView() {
  const { t, i18n } = useTranslation();
  const api = window.electronAPI.screenRecordings;
  const [config, setConfig] = useState<ScreenRecordingConfig | null>(null);
  const [status, setStatus] = useState<ScreenRecordingStatus>({
    recording: false,
    finalizing: false,
    last: null,
  });
  const [files, setFiles] = useState<ScreenRecordingFile[]>([]);
  const [displays, setDisplays] = useState<ScreenDisplay[]>([]);
  const [windows, setWindows] = useState<ScreenWindow[]>([]);
  const [source, setSource] = useState("display:");
  const [prefs, setPrefs] = useState(() => {
    try {
      return {
        systemAudio: true,
        microphone: true,
        ...JSON.parse(localStorage.getItem(PREFS_KEY) || "{}"),
      };
    } catch {
      return { systemAudio: true, microphone: true };
    }
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [permissionProblem, setPermissionProblem] = useState(false);
  const [now, setNow] = useState(Date.now());

  const refreshFiles = useCallback(async () => {
    setFiles(await unwrap(api.list()));
  }, [api]);

  const refreshSources = useCallback(async () => {
    try {
      const data = await unwrap(api.sources());
      setDisplays(data.displays);
      setWindows(data.windows);
      setPermissionProblem(false);
    } catch (e) {
      if (e instanceof ScreenRecordingError && e.code === "permission") setPermissionProblem(true);
    }
  }, [api]);

  useEffect(() => {
    void unwrap(api.config()).then((value) => {
      setConfig(value);
      if (value.permission === "denied") setPermissionProblem(true);
    });
    void refreshFiles().catch(() => {});
  }, [api, refreshFiles]);

  useEffect(() => {
    let previous = false;
    const tick = async () => {
      try {
        const next = await unwrap(api.status());
        setStatus(next);
        setNow(Date.now());
        const busyNow = next.recording || next.finalizing;
        if (previous && !busyNow) void refreshFiles().catch(() => {});
        previous = busyNow;
      } catch {}
    };
    void tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [api, refreshFiles]);

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {}
  }, [prefs]);

  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      if (e instanceof ScreenRecordingError && e.code === "permission") setPermissionProblem(true);
      else
        setError(
          e instanceof ScreenRecordingError && e.code === "disk"
            ? t("screenRecordings.lowDisk")
            : e instanceof Error
              ? e.message
              : String(e)
        );
    } finally {
      setBusy(false);
    }
  };

  const start = () =>
    act(async () => {
      const [type, id] = source.split(":");
      const next = await unwrap(
        api.start({
          source: id ? { type: type as "display" | "window", id: Number(id) } : undefined,
          systemAudio: prefs.systemAudio,
          microphone: prefs.microphone,
        })
      );
      setPermissionProblem(false);
      setStatus(next);
    });

  const stop = () =>
    act(async () => {
      await unwrap(api.stop());
      await refreshFiles();
    });

  const last = status.last;
  const recording = status.recording;
  const elapsed = recording && status.startedAt ? (now - status.startedAt) / 1000 : 0;
  const unavailable = config && !config.available;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">{t("screenRecordings.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("screenRecordings.subtitle")}</p>
      </header>

      {permissionProblem && (
        <section
          role="alert"
          className="flex flex-col gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4"
        >
          <div className="flex items-start gap-3">
            <ShieldAlert size={18} className="mt-0.5 shrink-0 text-destructive" />
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium">{t("screenRecordings.permission.title")}</p>
              <p className="text-sm text-muted-foreground">
                {t("screenRecordings.permission.body")}
              </p>
            </div>
          </div>
          <div className="flex gap-2 pl-7">
            <Button size="sm" onClick={() => void api.openPermissionSettings()}>
              {t("screenRecordings.permission.open")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void refreshSources()}>
              {t("screenRecordings.permission.retry")}
            </Button>
          </div>
        </section>
      )}

      <section className="flex flex-col gap-4 rounded-lg border border-border bg-card p-5 shadow-[var(--shadow-card)]">
        {recording ? (
          <div className="flex flex-wrap items-center gap-4" aria-live="polite">
            <span className="size-2.5 shrink-0 animate-pulse rounded-full bg-destructive" />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="font-mono text-2xl tabular-nums">{clock(elapsed)}</span>
              <span className="text-xs text-muted-foreground">
                {t("screenRecordings.recordingDetail", { size: megabytes(status.bytes || 0) })}
              </span>
            </div>
            <Button
              variant="destructive"
              disabled={busy || status.stopping}
              onClick={() => void stop()}
            >
              {status.stopping ? <Loader2 className="animate-spin" /> : <Square />}
              {status.stopping ? t("screenRecordings.saving") : t("screenRecordings.stop")}
            </Button>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-4">
              <label className="flex min-w-56 flex-1 flex-col gap-1 text-xs">
                {t("screenRecordings.source")}
                <div className="flex gap-2">
                  <select
                    className="min-w-0 flex-1 rounded border border-border bg-background p-2 text-sm"
                    value={source}
                    disabled={busy}
                    onFocus={() => void refreshSources()}
                    onChange={(e) => setSource(e.target.value)}
                  >
                    <option value="display:">{t("screenRecordings.entireScreen")}</option>
                    {displays.length > 1 &&
                      displays.map((display) => (
                        <option key={display.id} value={`display:${display.id}`}>
                          {t("screenRecordings.display", {
                            index: display.index,
                            width: display.width,
                            height: display.height,
                          })}
                        </option>
                      ))}
                    {windows.length > 0 && (
                      <optgroup label={t("screenRecordings.windows")}>
                        {windows.map((window) => (
                          <option key={window.id} value={`window:${window.id}`}>
                            {window.title ? `${window.app} — ${window.title}` : window.app}
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={t("screenRecordings.refreshSources")}
                    title={t("screenRecordings.refreshSources")}
                    disabled={busy}
                    onClick={() => void refreshSources()}
                  >
                    <RefreshCw />
                  </Button>
                </div>
              </label>
            </div>
            <div className="flex flex-wrap gap-6">
              <label className="flex items-center gap-3 text-sm">
                <Toggle
                  checked={prefs.systemAudio}
                  disabled={busy}
                  ariaLabel={t("screenRecordings.systemAudio")}
                  onChange={(systemAudio) => setPrefs({ ...prefs, systemAudio })}
                />
                {t("screenRecordings.systemAudio")}
              </label>
              <label className="flex items-center gap-3 text-sm">
                <Toggle
                  checked={prefs.microphone}
                  disabled={busy}
                  ariaLabel={t("screenRecordings.microphone")}
                  onChange={(microphone) => setPrefs({ ...prefs, microphone })}
                />
                {t("screenRecordings.microphone")}
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                disabled={busy || !!unavailable || status.finalizing}
                onClick={() => void start()}
              >
                {busy ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Circle className="fill-current text-destructive" />
                )}
                {t("screenRecordings.start")}
              </Button>
              {status.finalizing && (
                <span
                  role="status"
                  className="flex items-center gap-2 text-xs text-muted-foreground"
                >
                  <Loader2 size={14} className="animate-spin" />
                  {t("screenRecordings.finalizing")}
                </span>
              )}
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {unavailable ? t("screenRecordings.unavailable") : t("screenRecordings.help")}
            </p>
          </>
        )}
      </section>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {!recording && last?.reason === "disk" && (
        <p role="status" className="text-sm text-destructive">
          {t("screenRecordings.stoppedForDisk")}
        </p>
      )}
      {!recording && last?.error && last.reason !== "disk" && (
        <p role="status" className="text-sm text-destructive">
          {last.file ? t("screenRecordings.endedEarly", { error: last.error }) : last.error}
        </p>
      )}

      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium">{t("screenRecordings.saved")}</h2>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void act(() => unwrap(api.openFolder()))}
          >
            <FolderOpen />
            {t("screenRecordings.openFolder")}
          </Button>
        </div>
        {files.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            {t("screenRecordings.empty")}
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
            {files.map((file) => (
              <li key={file.name} className="flex items-center gap-3 px-4 py-3">
                <MonitorPlay size={16} className="shrink-0 text-muted-foreground" />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm">{file.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {new Date(file.modifiedAt).toLocaleString(i18n.language)} ·{" "}
                    {megabytes(file.bytes)}
                    {file.name.endsWith(".mov") && ` · ${t("screenRecordings.unmixed")}`}
                  </span>
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={t("screenRecordings.play")}
                  title={t("screenRecordings.play")}
                  onClick={() => void act(() => unwrap(api.open({ name: file.name })))}
                >
                  <Play />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={t("screenRecordings.reveal")}
                  title={t("screenRecordings.reveal")}
                  onClick={() => void act(() => unwrap(api.reveal({ name: file.name })))}
                >
                  <FolderOpen />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={t("screenRecordings.delete")}
                  title={t("screenRecordings.delete")}
                  onClick={() =>
                    void act(async () => {
                      await unwrap(api.delete({ name: file.name }));
                      await refreshFiles();
                    })
                  }
                >
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
