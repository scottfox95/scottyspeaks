import { useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Square, Volume2, Settings2 } from "lucide-react";
import { useSpeech } from "../../hooks/useSpeech";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "../ui/dialog";
import { Input } from "../ui/input";
export function SpeechControls({ compact = false }: { compact?: boolean }) {
  const status = useSpeech();
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [voices, setVoices] = useState<{ name: string; language: string }[]>([]);
  const [error, setError] = useState(false);
  if (!status) return null;
  const busy = status.speaking || status.starting;
  if (compact && !busy) return null;
  const api = window.electronAPI.speech;
  const act = (operation: Promise<unknown>) => {
    setError(false);
    void operation.catch(() => setError(true));
  };
  const stop = (
    <Button
      size="sm"
      className={compact ? "size-12 rounded-full" : undefined}
      variant="outline"
      style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
      title={t("speech.stop")}
      aria-label={t("speech.stop")}
      onClick={() => act(api.stop())}
    >
      <Square data-icon="inline-start" />
      {compact ? null : t("speech.stop")}
    </Button>
  );
  if (compact) return stop;
  return (
    <aside
      className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border bg-background px-4 py-2"
      aria-label={t("speech.title")}
    >
      <Volume2 className="size-4" aria-hidden="true" />
      <span role="status" className="text-xs">
        {t(
          !status.available
            ? "speech.unavailable"
            : status.recording
              ? "speech.recording"
              : busy
                ? status.source === "agent"
                  ? "speech.agentSpeaking"
                  : "speech.speaking"
                : "speech.ready"
        )}
      </span>
      {busy && stop}
      {busy && status.text && (
        <span className="max-w-96 truncate text-xs text-muted-foreground" title={status.text}>
          {status.text}
        </span>
      )}
      <Button
        size="sm"
        variant="ghost"
        style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
        onClick={() => {
          setOpen(true);
          act(api.voices().then(setVoices));
        }}
      >
        <Settings2 data-icon="inline-start" />
        {t("speech.settings")}
      </Button>
      {(error || status.error) && (
        <span role="alert" className="text-xs text-destructive">
          {t("speech.error")}
        </span>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("speech.settings")}</DialogTitle>
            <DialogDescription>{t("speech.help")}</DialogDescription>
          </DialogHeader>
          <label className="flex flex-col gap-2 text-sm" htmlFor="speech-voice">
            {t("speech.voice")}
            <select
              id="speech-voice"
              className="rounded border border-border bg-background p-2"
              value={status.voice}
              disabled={!status.available}
              onChange={(e) => act(api.configure({ voice: e.target.value }))}
            >
              <option value="">{t("speech.defaultVoice")}</option>
              {voices.map((voice) => (
                <option key={voice.name} value={voice.name}>
                  {voice.name} · {voice.language}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-2 text-sm" htmlFor="speech-rate">
            {t("speech.rate")}
            <Input
              id="speech-rate"
              type="number"
              min={100}
              max={350}
              defaultValue={status.rate}
              key={status.rate}
              disabled={!status.available}
              onBlur={(e) => {
                const rate = Number(e.target.value);
                if (Number.isInteger(rate) && rate >= 100 && rate <= 350)
                  act(api.configure({ rate }));
                else {
                  e.target.value = String(status.rate);
                  setError(true);
                }
              }}
            />
          </label>
          <label className="flex items-center gap-3 text-sm">
            <input
              type="checkbox"
              checked={status.agentEnabled}
              disabled={!status.available}
              onChange={(e) => act(api.configure({ agentEnabled: e.target.checked }))}
            />
            {t("speech.agentEnabled")}
          </label>
          <p className="text-xs text-muted-foreground">{t("speech.agentHelp")}</p>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {t("speech.error")}
            </p>
          )}
        </DialogContent>
      </Dialog>
    </aside>
  );
}
