import { useEffect, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Footprints, Check } from "lucide-react";
import { Button } from "./ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";

interface PedalStatus {
  supported: boolean;
  connected: boolean;
  device?: { model: string; serialNumber?: string } | null;
  config?: { enabled: boolean; mappings: Record<string, string> };
  blocked?: boolean;
  blockingApp?: string | null;
  devicePresent?: boolean;
}

const ACTIONS = ["toggle", "hold", "command", "off"] as const;

const SWITCH_LABELS = ["Left", "Middle", "Right"];

export default function PedalSettings() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<PedalStatus | null>(null);
  const [quitting, setQuitting] = useState(false);

  const actionLabel: Record<string, string> = {
    toggle: t("settings.pedal.actionToggle", { defaultValue: "Tap to talk (toggle)" }),
    hold: t("settings.pedal.actionHold", { defaultValue: "Hold to talk" }),
    command: t("settings.pedal.actionCommand", { defaultValue: "Voice command" }),
    off: t("settings.pedal.actionOff", { defaultValue: "Do nothing" }),
  };

  const refresh = useCallback(async () => {
    try {
      const s = await (window as any).electronAPI?.pedalGetStatus?.();
      setStatus(s);
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    refresh();
    const dispose = (window as any).electronAPI?.onPedalStatusChanged?.((s: PedalStatus) =>
      setStatus(s)
    );
    return () => dispose?.();
  }, [refresh]);

  const setMapping = async (index: number, action: string) => {
    try {
      const next = await (window as any).electronAPI?.pedalSetConfig?.({
        mappings: { [index]: action },
      });
      setStatus(next);
    } catch {
      // keep old state
    }
  };

  if (!status?.supported) return null;

  const connected = status.connected;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <div
          className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${
            connected ? "bg-emerald-500/10" : "bg-muted"
          }`}
        >
          <Footprints
            className={`w-4.5 h-4.5 ${connected ? "text-emerald-600" : "text-muted-foreground"}`}
          />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-foreground flex items-center gap-2">
            {t("settings.pedal.title", { defaultValue: "Stream Deck Pedal" })}
            {connected ? (
              <span className="inline-flex items-center gap-1 text-[10px] font-medium text-emerald-600 bg-emerald-500/10 rounded-full px-2 py-0.5">
                <Check className="w-3 h-3" />
                {t("settings.pedal.connected", { defaultValue: "Connected" })}
              </span>
            ) : status.blocked ? (
              <span className="text-[10px] font-medium text-amber-600 bg-amber-500/10 rounded-full px-2 py-0.5">
                {t("settings.pedal.blocked", { defaultValue: "In use by another app" })}
              </span>
            ) : (
              <span className="text-[10px] font-medium text-muted-foreground bg-muted rounded-full px-2 py-0.5">
                {t("settings.pedal.notConnected", { defaultValue: "Not connected" })}
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            {connected
              ? t("settings.pedal.connectedDetail", {
                  defaultValue: "Works alongside your keyboard shortcut.",
                })
              : status.blocked
                ? t("settings.pedal.blockedDetail", {
                    app: status.blockingApp || "Another app",
                    defaultValue:
                      "{{app}} has an exclusive lock on the pedal. Quit it and SS2 will pick the pedal up automatically — SS2 talks to the pedal directly and doesn't need that app.",
                  })
                : t("settings.pedal.plugIn", {
                    defaultValue: "Plug in an Elgato Stream Deck Pedal to configure it here.",
                  })}
          </p>
        </div>
      </div>

      {status.blocked && (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={async () => {
              setQuitting(true);
              try {
                await (window as any).electronAPI?.pedalQuitBlockingApp?.();
                // the manager rescans ~1.2s after the app quits
                setTimeout(refresh, 2000);
              } finally {
                setTimeout(() => setQuitting(false), 2000);
              }
            }}
            disabled={quitting}
            className="press-tactile h-7 rounded-full text-xs px-3"
          >
            {quitting
              ? t("settings.pedal.quitting", { defaultValue: "Quitting…" })
              : t("settings.pedal.quitBlockingApp", {
                  app: status.blockingApp || "the other app",
                  defaultValue: "Quit {{app}}",
                })}
          </Button>
          <span className="text-[10px] text-muted-foreground">
            {t("settings.pedal.blockedHint", {
              defaultValue: "Tip: remove it from Login Items so it stops reclaiming the pedal.",
            })}
          </span>
        </div>
      )}

      {connected && (
        <div className="grid grid-cols-3 gap-2">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="rounded-lg border border-border/60 bg-surface-1 p-3 space-y-2 text-center"
            >
              <div className="mx-auto h-1.5 w-10 rounded-full bg-muted-foreground/30" />
              <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                {t(`settings.pedal.switch${SWITCH_LABELS[i]}`, {
                  defaultValue: SWITCH_LABELS[i],
                })}
              </div>
              <Select
                value={status.config?.mappings?.[i] ?? "off"}
                onValueChange={(v) => setMapping(i, v)}
              >
                <SelectTrigger className="h-7 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ACTIONS.map((a) => (
                    <SelectItem key={a} value={a} className="text-xs">
                      {actionLabel[a]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ))}
        </div>
      )}

      {connected && (
        <p className="text-[11px] text-muted-foreground leading-relaxed">
          {t("settings.pedal.commandHint", {
            defaultValue:
              "Voice command: hold the switch and speak an instruction — \"make that more formal\", \"turn this into bullet points\" — it's applied to your selected text or last dictation.",
          })}
        </p>
      )}
    </div>
  );
}
