import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Scissors } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { cn } from "../lib/utils";
import type { Meeting, MeetingAPI, MeetingResult, SpeechAnalysis } from "../../types/meeting";

async function unwrap<T>(promise: Promise<MeetingResult<T>>): Promise<T> {
  const result = await promise;
  if (!result.success) throw new Error("error" in result ? result.error : "Call notes failed");
  return result.data;
}
const clock = (seconds: number) => {
  const n = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
};
// Accepts "17:31", "1:02:05" or plain minutes ("17.5").
const parseClock = (value: string) => {
  const text = value.trim();
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text) * 60;
  if (!/^\d+(:\d{1,2}){1,2}$/.test(text)) return NaN;
  return text.split(":").reduce((total, part) => total * 60 + Number(part), 0);
};

export function TrimRecording({
  meeting,
  api,
  onTrimmed,
  onClose,
}: {
  meeting: Meeting;
  api: MeetingAPI;
  onTrimmed: (meeting: Meeting) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [analysis, setAnalysis] = useState<SpeechAnalysis | null>(null);
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [trimming, setTrimming] = useState(false);
  useEffect(() => {
    let live = true;
    unwrap(api.analyzeSpeech({ id: meeting.id }))
      .then((result) => {
        if (!live) return;
        setAnalysis(result);
        if (result.suggestions[0]) setValue(clock(result.suggestions[0].end));
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [api, meeting.id]);
  const end = parseClock(value);
  const valid = !!analysis && Number.isFinite(end) && end >= 1 && end < analysis.duration - 1;
  const trim = async () => {
    setTrimming(true);
    setError("");
    try {
      onTrimmed(await unwrap(api.trim({ id: meeting.id, end })));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setTrimming(false);
    }
  };
  return (
    <section
      aria-label={t("meetings.trim.title")}
      className="flex flex-col gap-3 rounded-lg border border-border bg-muted/20 p-4"
    >
      <div>
        <h3 className="text-sm font-medium">{t("meetings.trim.title")}</h3>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {t("meetings.trim.help")}
        </p>
      </div>
      {!analysis && !error && (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {t("meetings.trim.analyzing")}
        </p>
      )}
      {analysis && (
        <>
          <p className="text-xs text-muted-foreground">
            {t("meetings.trim.length", { length: clock(analysis.duration) })}
            {!analysis.suggestions.length && ` ${t("meetings.trim.noSuggestions")}`}
          </p>
          {analysis.suggestions.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {analysis.suggestions.map((suggestion) => (
                <button
                  key={suggestion.end}
                  type="button"
                  onClick={() => setValue(clock(suggestion.end))}
                  className={cn(
                    "rounded-md border px-3 py-2 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    value === clock(suggestion.end)
                      ? "border-primary bg-primary/8"
                      : "border-border hover:bg-muted"
                  )}
                >
                  <span className="block text-sm font-medium">{clock(suggestion.end)}</span>
                  <span className="text-muted-foreground">
                    {suggestion.resumesAt == null
                      ? t("meetings.trim.quietToEnd", {
                          minutes: Math.round(suggestion.quietSeconds / 60),
                        })
                      : t("meetings.trim.quietThenResumes", {
                          minutes: Math.round(suggestion.quietSeconds / 60),
                          resumes: clock(suggestion.resumesAt),
                        })}
                  </span>
                </button>
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-xs">
              {t("meetings.trim.endAt")}
              <Input
                className="w-32"
                value={value}
                placeholder="17:30"
                onChange={(e) => setValue(e.target.value)}
              />
            </label>
            <Button size="sm" disabled={!valid || trimming} onClick={trim}>
              {trimming ? <Loader2 className="animate-spin" /> : <Scissors />}
              {valid ? t("meetings.trim.apply", { time: clock(end) }) : t("meetings.trim.title")}
            </Button>
            <Button size="sm" variant="ghost" disabled={trimming} onClick={onClose}>
              {t("meetings.trim.cancel")}
            </Button>
          </div>
          {valid && (
            <p className="text-xs text-muted-foreground">
              {t("meetings.trim.warning", { removed: clock(analysis.duration - end) })}
            </p>
          )}
        </>
      )}
      {error && (
        <div className="flex items-center justify-between gap-3">
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
          {!analysis && (
            <Button size="sm" variant="ghost" onClick={onClose}>
              {t("meetings.trim.cancel")}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
