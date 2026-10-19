import CaptureReplay from "../captures/CaptureReplay";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./button";
import { Textarea } from "./textarea";
import { Copy, Trash2, Pencil, Check, X, Sparkles, Loader2 } from "lucide-react";
import type { TranscriptionItem as TranscriptionItemType } from "../../types/electron";

interface TranscriptionItemProps {
  item: TranscriptionItemType & { raw_text?: string | null };
  onCopy: (text: string) => void;
  onDelete: (id: number) => void;
}

export default function TranscriptionItem({ item, onCopy, onDelete }: TranscriptionItemProps) {
  const { i18n, t } = useTranslation();
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(item.text);
  const [justLearned, setJustLearned] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const savingRef = useRef(false);
  const learnedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (learnedTimer.current) clearTimeout(learnedTimer.current);
    },
    []
  );

  const timestampSource = item.timestamp.endsWith("Z") ? item.timestamp : `${item.timestamp}Z`;
  const timestampDate = new Date(timestampSource);
  const formattedTime = Number.isNaN(timestampDate.getTime())
    ? ""
    : timestampDate.toLocaleTimeString(i18n.language, {
        hour: "2-digit",
        minute: "2-digit",
      });

  const startEdit = () => {
    setError("");
    setDraft(item.text);
    setIsEditing(true);
  };

  const cancelEdit = () => {
    if (savingRef.current) return;
    setError("");
    setIsEditing(false);
    setDraft(item.text);
  };

  const saveEdit = async () => {
    if (savingRef.current) return;
    const next = draft.trim();
    if (!next || next === item.text) {
      setIsEditing(false);
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setError("");
    try {
      const api = (window as any).electronAPI;
      const saved = await api?.updateTranscription?.(item.id, next);
      if (!saved?.success) throw new Error("Save failed");
      // Teach the polish pass: raw transcript (or previous output) → the
      // user's preferred version
      setIsEditing(false);
      try {
        const learned = await api?.addStyleExample?.(
          item.raw_text || item.text,
          next,
          "history-edit"
        );
        if (!learned) throw new Error("Learning failed");
        setJustLearned(true);
        if (learnedTimer.current) clearTimeout(learnedTimer.current);
        learnedTimer.current = setTimeout(() => setJustLearned(false), 3500);
      } catch {
        setError(t("workspace.learnFailed"));
      }
    } catch {
      // Keep the draft visible and retryable instead of silently discarding the edit.
      setError(t("workspace.saveFailed"));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <div className="group rounded-lg bg-card px-4 py-3 shadow-[var(--shadow-card)]">
      <div className="flex flex-wrap items-start gap-3">
        {formattedTime && (
          <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums pt-0.5">
            {formattedTime}
          </span>
        )}

        {isEditing ? (
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Textarea
              aria-label={t("workspace.editDictation")}
              disabled={saving}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={Math.min(8, Math.max(2, draft.split("\n").length + 1))}
              autoFocus
              className="text-sm leading-[1.5]"
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void saveEdit();
                }
                if (e.key === "Escape") cancelEdit();
              }}
            />
            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                size="sm"
                onClick={saveEdit}
                disabled={saving}
                className="press-tactile h-6 rounded-full px-3 text-[11px]"
              >
                {saving ? <Loader2 className="animate-spin" /> : <Check size={11} />}
                {t("workspace.saveAndLearn")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={cancelEdit}
                disabled={saving}
                className="h-6 rounded-full px-3 text-[11px] text-muted-foreground"
              >
                <X size={11} />
                {t("common.cancel", { defaultValue: "Cancel" })}
              </Button>
              <span className="text-[10px] text-muted-foreground/70">
                {t("workspace.editHint")}
              </span>
            </div>
          </div>
        ) : (
          <p className="flex-1 min-w-0 text-foreground text-sm leading-[1.5] break-words whitespace-pre-wrap">
            {item.text}
          </p>
        )}

        {!isEditing && (
          <div className="flex shrink-0 items-center gap-0.5">
            <CaptureReplay historyId={item.id} />
            {justLearned && (
              <span className="onb-pop inline-flex items-center gap-1 text-[10px] font-medium text-violet-500 bg-violet-500/10 rounded-full px-2 py-0.5 mr-1">
                <Sparkles size={10} />
                {t("workspace.learned")}
              </span>
            )}
            <Button
              size="icon"
              variant="ghost"
              onClick={startEdit}
              aria-label={t("workspace.editDictation")}
              title={t("workspace.editDictation")}
              className="h-6 w-6 rounded-sm text-muted-foreground hover:text-foreground hover:bg-foreground/10"
            >
              <Pencil size={12} />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              onClick={() => onCopy(item.text)}
              aria-label={t("workspace.copyText")}
              title={t("workspace.copyText")}
              className="h-6 w-6 rounded-sm text-muted-foreground hover:text-foreground hover:bg-foreground/10"
            >
              <Copy size={12} />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              onClick={() => onDelete(item.id)}
              aria-label={t("controlPanel.history.deleteTitle")}
              title={t("controlPanel.history.deleteTitle")}
              className="h-6 w-6 rounded-sm text-muted-foreground hover:text-destructive hover:bg-destructive/10"
            >
              <Trash2 size={12} />
            </Button>
          </div>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
