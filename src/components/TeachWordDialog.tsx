import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Loader2, Mic, Square, X } from "lucide-react";
import AudioManager from "../helpers/audioManager";
import { getRecordingErrorTitle } from "../utils/recordingErrors";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { cn } from "./lib/utils";

// The speech model cannot learn a pronunciation, so "teaching" a word means
// recording what the recognizer actually hears for it and saving those
// mishearings as sounds-like aliases that are rewritten in every dictation.

const MAX_HEARD_WORDS = 4;
const SUGGESTED_TAKES = 3;

/** Same normalization as the main process uses when matching an alias. */
function normalizeHeard(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}'’\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface Take {
  heard: string;
  status: "alias" | "correct" | "empty" | "too-long";
}

interface TeachWordDialogProps {
  word: string | null;
  aliases: string[];
  dictionary: string[];
  onOpenChange: (open: boolean) => void;
  onSave: (word: string, aliases: string[]) => Promise<void>;
}

export default function TeachWordDialog({
  word,
  aliases,
  dictionary,
  onOpenChange,
  onSave,
}: TeachWordDialogProps) {
  const { t } = useTranslation();
  const [takes, setTakes] = useState<Take[]>([]);
  const [pending, setPending] = useState<string[]>([]);
  const [manual, setManual] = useState("");
  const [recording, setRecording] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const manager = useRef<InstanceType<typeof AudioManager> | null>(null);
  const wordRef = useRef(word);
  wordRef.current = word;

  const normalizedWord = word ? normalizeHeard(word) : "";
  const blocked = useMemo(() => new Set(dictionary.map(normalizeHeard)), [dictionary]);

  useEffect(() => {
    if (!word) return;
    setTakes([]);
    setPending(aliases);
    setManual("");
    setError("");
    // aliases is the list for this word at open time; later edits live in `pending`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [word]);

  const addAlias = useCallback(
    (value: string) => {
      const alias = normalizeHeard(value);
      if (!alias || alias === normalizedWord || blocked.has(alias)) return false;
      setPending((current) => (current.includes(alias) ? current : [...current, alias]));
      return true;
    },
    [normalizedWord, blocked]
  );
  const addAliasRef = useRef(addAlias);
  addAliasRef.current = addAlias;

  useEffect(() => {
    if (!word) return;
    const audio = new AudioManager();
    manager.current = audio;
    audio.setSkipReasoning(true);
    audio.setAliasSubstitution(false);
    audio.setContext("notes");
    audio.setCallbacks({
      onStateChange: (state: { isRecording: boolean; isProcessing: boolean }) => {
        setRecording(state.isRecording);
        setProcessing(state.isProcessing);
      },
      onError: (err: { title: string; description: string; code?: string }) => {
        setError(`${getRecordingErrorTitle(err, t)}: ${err.description}`);
      },
      onPartialTranscript: () => {},
      onStreamingCommit: () => {},
      onTranscriptionComplete: (result: { success: boolean; text: string }) => {
        if (!result.success) return;
        const heard = normalizeHeard(result.text || "");
        const target = normalizeHeard(wordRef.current || "");
        let status: Take["status"] = "alias";
        if (!heard) status = "empty";
        else if (heard === target) status = "correct";
        else if (heard.split(" ").length > MAX_HEARD_WORDS) status = "too-long";
        setTakes((current) => [...current, { heard, status }]);
        if (status === "alias") addAliasRef.current(heard);
      },
    });
    return () => {
      audio.cleanup();
      manager.current = null;
    };
  }, [word, t]);

  useEffect(() => {
    if (!recording) {
      setElapsed(0);
      return;
    }
    const timer = setInterval(() => setElapsed((seconds) => seconds + 1), 1000);
    return () => clearInterval(timer);
  }, [recording]);

  const toggleRecording = async () => {
    const audio = manager.current;
    if (!audio) return;
    setError("");
    const state = audio.getState();
    if (state.isRecording || state.isRecordingStartInProgress) {
      audio.stopRecording();
      return;
    }
    if (state.isProcessing) return;
    await audio.startRecording();
  };

  const addManual = () => {
    const values = manual.split(",");
    let added = false;
    for (const value of values) added = addAlias(value) || added;
    if (added || values.every((value) => !normalizeHeard(value))) setManual("");
  };

  const save = async () => {
    if (!word) return;
    setSaving(true);
    setError("");
    try {
      await onSave(word, pending);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const changed =
    pending.length !== aliases.length || pending.some((alias) => !aliases.includes(alias));
  const minutes = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const seconds = String(elapsed % 60).padStart(2, "0");

  return (
    <Dialog open={!!word} onOpenChange={(open) => !saving && onOpenChange(open)}>
      <DialogContent className="max-w-md" data-teach-word-dialog>
        <DialogHeader>
          <DialogTitle>{t("dictionary.teach.title", { word: word ?? "" })}</DialogTitle>
          <DialogDescription>{t("dictionary.teach.intro", { count: SUGGESTED_TAKES })}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center gap-3 py-2">
          <button
            type="button"
            onClick={() => void toggleRecording()}
            disabled={processing || saving}
            aria-label={recording ? t("dictionary.teach.stop") : t("dictionary.teach.record")}
            className={cn(
              "press-tactile flex size-16 items-center justify-center rounded-full border outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
              recording
                ? "border-destructive/40 bg-destructive/15 text-destructive"
                : "border-primary/20 bg-primary/10 text-primary hover:bg-primary/16",
              (processing || saving) && "opacity-60"
            )}
          >
            {processing ? (
              <Loader2 className="size-6 animate-spin" />
            ) : recording ? (
              <Square className="size-5" fill="currentColor" />
            ) : (
              <Mic className="size-6" />
            )}
          </button>
          <p className="text-xs text-muted-foreground" role="status" aria-live="polite">
            {recording
              ? `${t("dictionary.teach.listening")} ${minutes}:${seconds}`
              : processing
                ? t("dictionary.teach.processing")
                : t("dictionary.teach.take", { number: takes.length + 1 })}
          </p>
        </div>

        {takes.length > 0 && (
          <ol className="flex flex-col gap-1 text-sm" aria-label={t("dictionary.teach.takes")}>
            {takes.map((take, index) => (
              <li key={index} className="flex items-center gap-2">
                {take.status === "correct" ? (
                  <Check className="size-3.5 shrink-0 text-emerald-600" aria-hidden="true" />
                ) : (
                  <span className="size-3.5 shrink-0 text-center text-xs text-muted-foreground">
                    {index + 1}
                  </span>
                )}
                <span className="text-muted-foreground">
                  {take.status === "correct"
                    ? t("dictionary.teach.heardCorrect")
                    : take.status === "empty"
                      ? t("dictionary.teach.heardNothing")
                      : take.status === "too-long"
                        ? t("dictionary.teach.heardTooMuch", { heard: take.heard })
                        : t("dictionary.teach.heard", { heard: take.heard })}
                </span>
              </li>
            ))}
          </ol>
        )}

        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-foreground">
            {t("dictionary.teach.willFix", { word: word ?? "" })}
          </span>
          {pending.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("dictionary.teach.none")}</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {pending.map((alias) => (
                <span
                  key={alias}
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/40 py-0.5 pl-2 pr-1 text-xs"
                >
                  {alias}
                  <button
                    type="button"
                    onClick={() => setPending((current) => current.filter((a) => a !== alias))}
                    aria-label={t("dictionary.teach.removeAlias", { alias })}
                    className="rounded-sm p-0.5 text-muted-foreground hover:text-destructive"
                  >
                    <X size={10} strokeWidth={2} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2">
            <Input
              value={manual}
              placeholder={t("dictionary.teach.manualPlaceholder")}
              aria-label={t("dictionary.teach.manualLabel")}
              className="h-8 text-xs"
              onChange={(event) => setManual(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addManual();
                }
              }}
            />
            <Button size="sm" variant="outline" disabled={!manual.trim()} onClick={addManual}>
              {t("dictionary.teach.add")}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t("dictionary.teach.hint")}</p>
        </div>

        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button variant="ghost" disabled={saving} onClick={() => onOpenChange(false)}>
            {t("common.cancel", { defaultValue: "Cancel" })}
          </Button>
          <Button disabled={!changed || saving || recording || processing} onClick={() => void save()}>
            {saving && <Loader2 className="animate-spin" />}
            {t("dictionary.teach.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
