import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Meeting } from "../../types/meeting";
export interface MeetingAudioHandle {
  seek(seconds: number, source?: Source): void;
}
type Source = "all" | "microphone" | "system" | "audio";
export const MeetingAudioPlayer = forwardRef<
  MeetingAudioHandle,
  { meeting: Meeting; recording: boolean }
>(function MeetingAudioPlayer({ meeting, recording }, ref) {
  const { t } = useTranslation();
  const api = window.electronAPI.meetings;
  const player = useRef<HTMLAudioElement>(null);
  const pending = useRef<{ time: number; play: boolean } | null>(null);
  const [source, setSource] = useState<Source>("all");
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const sources = [...new Set(meeting.audio.map((item) => item.source))].filter((value) =>
    ["microphone", "system", "audio"].includes(value)
  ) as Source[];
  const manifest = JSON.stringify(meeting.audio);
  const seek = (seconds: number, targetSource: Source = "all") => {
    if (recording || !Number.isFinite(seconds) || seconds < 0) return;
    const wanted = targetSource === "all" || sources.includes(targetSource) ? targetSource : "all";
    if (wanted !== source) {
      pending.current = { time: seconds, play: true };
      setSource(wanted);
      return;
    }
    const audio = player.current;
    if (!audio || audio.readyState < 1) {
      pending.current = { time: seconds, play: true };
      return;
    }
    audio.currentTime = Math.min(
      seconds,
      Number.isFinite(audio.duration) ? audio.duration : seconds
    );
    void audio.play().catch(() => setError(t("replay.playManually")));
  };
  useImperativeHandle(ref, () => ({ seek }));
  useEffect(() => {
    setSource("all");
    pending.current = null;
  }, [meeting.id]);
  useEffect(() => {
    let active = true,
      issued = "";
    setUrl("");
    setError("");
    setLoading(false);
    if (!meeting.audio.length || recording) return;
    setLoading(true);
    api
      .playback({ id: meeting.id, source })
      .then((result) => {
        if (!result.success) throw new Error("error" in result ? result.error : "");
        issued = result.data.url;
        if (active) setUrl(issued);
        else void api.releasePlayback({ url: issued });
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      if (issued) void api.releasePlayback({ url: issued });
    };
  }, [api, meeting.id, manifest, source, recording]);
  if (!meeting.audio.length)
    return <p className="mb-4 text-xs text-muted-foreground">{t("replay.textOnly")}</p>;
  return (
    <div className="mb-5 space-y-2 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-semibold">{t("replay.callAudio")}</span>
        {sources.length > 1 && (
          <label className="flex items-center gap-2 text-xs">
            {t("replay.source")}
            <select
              aria-label={t("replay.source")}
              className="h-8 rounded border border-border bg-background px-2"
              value={source}
              disabled={recording}
              onChange={(e) => {
                const audio = player.current;
                pending.current = {
                  time: audio?.currentTime ?? pending.current?.time ?? 0,
                  play: false,
                };
                setSource(e.target.value as Source);
              }}
            >
              {["all", ...sources].map((value) => (
                <option key={value} value={value}>
                  {t(`replay.sources.${value}`)}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {recording ? (
        <p className="text-xs text-muted-foreground">{t("replay.stopToListen")}</p>
      ) : loading ? (
        <p role="status" className="text-xs">
          {t("replay.preparingAudio")}
        </p>
      ) : (
        url && (
          <audio
            key={url}
            ref={player}
            controls
            preload="metadata"
            src={url}
            aria-label={t("replay.callAudio")}
            className="w-full"
            onLoadedMetadata={() => {
              const target = pending.current;
              pending.current = null;
              if (target && player.current) {
                player.current.currentTime = Math.min(target.time, player.current.duration);
                if (target.play)
                  void player.current.play().catch(() => setError(t("replay.playManually")));
              }
            }}
            onError={() => setError(t("replay.audioError"))}
          />
        )
      )}
      {meeting.transcriptEdited && (
        <p className="text-xs text-muted-foreground">{t("replay.editedAlignment")}</p>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
});
