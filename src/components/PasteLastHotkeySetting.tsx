import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { HotkeyInput } from "./ui/HotkeyInput";
import { formatHotkeyLabel } from "../utils/hotkeys";

const DEFAULT_HOTKEY = "Control+Alt+V";

/** Settings → Hotkeys: the global "Paste last dictation" shortcut (macOS). */
export default function PasteLastHotkeySetting() {
  const { t } = useTranslation();
  const api = (window as any).electronAPI;
  const [hotkey, setHotkey] = useState<string>("");
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      ?.getPasteLastHotkey?.()
      .then((r: { hotkey?: string }) => setHotkey(r?.hotkey || ""))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async (next: string) => {
    setBusy(true);
    try {
      const result = await api?.setPasteLastHotkey?.(next);
      setError(!result?.success);
      if (result?.success) setHotkey(next);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <HotkeyInput
        value={hotkey}
        onChange={save}
        disabled={busy}
        onCaptureChange={(capturing) => api?.suspendPasteLastHotkey?.(capturing)}
      />
      {error && <p className="text-xs text-amber-600">{t("pasteLast.settings.unavailable")}</p>}
      <div className="flex gap-3">
        {hotkey !== DEFAULT_HOTKEY && (
          <button
            onClick={() => save(DEFAULT_HOTKEY)}
            disabled={busy}
            className="text-xs text-muted-foreground/70 hover:text-foreground transition-colors disabled:opacity-50"
          >
            {t("pasteLast.settings.reset", { hotkey: formatHotkeyLabel(DEFAULT_HOTKEY) })}
          </button>
        )}
        {hotkey && (
          <button
            onClick={() => save("")}
            disabled={busy}
            className="text-xs text-muted-foreground/70 hover:text-foreground transition-colors disabled:opacity-50"
          >
            {t("pasteLast.settings.off")}
          </button>
        )}
      </div>
    </div>
  );
}
