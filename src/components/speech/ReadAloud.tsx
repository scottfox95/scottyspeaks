import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useSpeech } from "../../hooks/useSpeech";
import { Button } from "../ui/button";
export function ReadAloud({ text, label }: { text: string; label: string }) {
  const status = useSpeech(),
    { t } = useTranslation();
  const [error, setError] = useState(false);
  if (!status?.available) return null;
  const read = (value: string) => {
    setError(false);
    if (!value.trim()) {
      setError(true);
      return;
    }
    void window.electronAPI.speech.speak({ text: value }).catch(() => setError(true));
  };
  return (
    <div className="my-2 flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        variant="outline"
        disabled={status.recording || !text.trim()}
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => {
          const scope = event.currentTarget.closest("[data-speech-source]");
          const active = document.activeElement;
          const selection = window.getSelection();
          const selected =
            active instanceof HTMLTextAreaElement && scope?.contains(active)
              ? active.value.slice(active.selectionStart, active.selectionEnd)
              : selection?.anchorNode &&
                  scope?.contains(selection.anchorNode) &&
                  selection.focusNode &&
                  scope.contains(selection.focusNode)
                ? selection.toString()
                : "";
          read(selected);
        }}
      >
        {t("speech.readSelection")}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={status.recording || !text.trim()}
        onClick={() => read(text)}
      >
        {t("speech.readAll", { source: label })}
      </Button>
      {error && (
        <span role="alert" className="text-xs text-destructive">
          {t("speech.readError")}
        </span>
      )}
    </div>
  );
}
