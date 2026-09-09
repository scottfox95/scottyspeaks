import CaptureReplay from "../captures/CaptureReplay";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./button";
import { Textarea } from "./textarea";
import { Copy, Trash2, Pencil, Check, X, Sparkles } from "lucide-react";
import type { TranscriptionItem as TranscriptionItemType } from "../../types/electron";
import { cn } from "../lib/utils";

interface TranscriptionItemProps {
  item: TranscriptionItemType & { raw_text?: string | null };
  onCopy: (text: string) => void;
  onDelete: (id: number) => void;
}

export default function TranscriptionItem({ item, onCopy, onDelete }: TranscriptionItemProps) {
  const { i18n, t } = useTranslation();
  const [isHovered, setIsHovered] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(item.text);
  const [justLearned, setJustLearned] = useState(false);
  const [saving, setSaving] = useState(false);

  const timestampSource = item.timestamp.endsWith("Z") ? item.timestamp : `${item.timestamp}Z`;
  const timestampDate = new Date(timestampSource);
  const formattedTime = Number.isNaN(timestampDate.getTime())
    ? ""
    : timestampDate.toLocaleTimeString(i18n.language, {
        hour: "2-digit",
        minute: "2-digit",
      });

  const startEdit = () => {
    setDraft(item.text);
    setIsEditing(true);
  };

  const cancelEdit = () => {
    setIsEditing(false);
    setDraft(item.text);
  };

  const saveEdit = async () => {
    const next = draft.trim();
    if (!next || next === item.text) {
      setIsEditing(false);
      return;
    }
    setSaving(true);
    try {
      const api = (window as any).electronAPI;
      await api?.updateTranscription?.(item.id, next);
      // Teach the polish pass: raw transcript (or previous output) → the
      // user's preferred version
      await api?.addStyleExample?.(item.raw_text || item.text, next, "history-edit");
      setJustLearned(true);
      setTimeout(() => setJustLearned(false), 3500);
      setIsEditing(false);
    } catch {
      setIsEditing(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="group rounded-md border border-border/40 dark:border-border-subtle/60 bg-card/50 dark:bg-surface-2/60 px-3 py-2.5 transition-colors duration-150 hover:bg-muted/30 dark:hover:bg-surface-2/80"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <div className="flex items-start gap-3">
        {formattedTime && (
          <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums pt-0.5">
            {formattedTime}
          </span>
        )}

        {isEditing ? (
          <div className="flex-1 min-w-0 space-y-1.5">
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={Math.min(8, Math.max(2, draft.split("\n").length + 1))}
              autoFocus
              className="text-sm leading-[1.5]"
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) saveEdit();
                if (e.key === "Escape") cancelEdit();
              }}
            />
            <div className="flex items-center gap-1.5">
              <Button
                size="sm"
                onClick={saveEdit}
                disabled={saving}
                className="press-tactile h-6 rounded-full px-3 text-[11px]"
              >
                <Check size={11} />
                {t("history.edit.save", { defaultValue: "Save & learn" })}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={cancelEdit}
                className="h-6 rounded-full px-3 text-[11px] text-muted-foreground"
              >
                <X size={11} />
                {t("common.cancel", { defaultValue: "Cancel" })}
              </Button>
              <span className="text-[10px] text-muted-foreground/70">
                {t("history.edit.hint", {
                  defaultValue: "Your fix teaches the polish engine your style.",
                })}
              </span>
            </div>
          </div>
        ) : (
          <p className="flex-1 min-w-0 text-foreground text-sm leading-[1.5] break-words whitespace-pre-wrap">
            {item.text}
          </p>
        )}

        {!isEditing && (
          <div
            className={cn(
              "flex items-center gap-0.5 shrink-0 transition-opacity duration-150",
              isHovered || justLearned ? "opacity-100" : "opacity-0 group-focus-within:opacity-100"
            )}
          >
            <CaptureReplay historyId={item.id} />
            {justLearned && (
              <span className="onb-pop inline-flex items-center gap-1 text-[10px] font-medium text-violet-500 bg-violet-500/10 rounded-full px-2 py-0.5 mr-1">
                <Sparkles size={10} />
                {t("history.edit.learned", { defaultValue: "Learned" })}
              </span>
            )}
            <Button
              size="icon"
              variant="ghost"
              onClick={startEdit}
              title={t("history.edit.tooltip", { defaultValue: "Edit — teaches your style" })}
              className="h-6 w-6 rounded-sm text-muted-foreground hover:text-foreground hover:bg-foreground/10"
            >
              <Pencil size={12} />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              onClick={() => onCopy(item.text)}
              className="h-6 w-6 rounded-sm text-muted-foreground hover:text-foreground hover:bg-foreground/10"
            >
              <Copy size={12} />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              onClick={() => onDelete(item.id)}
              className="h-6 w-6 rounded-sm text-muted-foreground hover:text-destructive hover:bg-destructive/10"
            >
              <Trash2 size={12} />
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
