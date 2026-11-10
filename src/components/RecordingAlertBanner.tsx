import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, X } from "lucide-react";
import { Button } from "./ui/button";
import type { RecordingAlert } from "../types/recordingAlerts";

// Persistent banner for recording stops and failures the person did not ask
// for. It stays until dismissed; dismissing also clears the menu-bar warning.
// The auto-stop warning is shown by the call page's live countdown instead.
export default function RecordingAlertBanner({ source }: { source: "call" | "screen" }) {
  const { t } = useTranslation();
  const api = window.electronAPI.recordingAlerts;
  const [alerts, setAlerts] = useState<RecordingAlert[]>([]);
  const apply = useCallback(
    (list: RecordingAlert[]) =>
      setAlerts(
        list.filter((alert) => alert.source === source && alert.reason !== "autoStopWarning")
      ),
    [source]
  );
  useEffect(() => {
    if (!api) return;
    let mounted = true;
    api
      .get()
      .then((result) => {
        if (mounted && result.success) apply(result.data.alerts);
      })
      .catch(() => {});
    const unsubscribe = api.onChange((state) => apply(state.alerts));
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [api, apply]);

  if (!alerts.length) return null;
  return (
    <div className="flex flex-col">
      {alerts.map((alert) => {
        const warning = alert.severity === "warning";
        return (
          <div
            key={alert.key}
            role={warning ? "status" : "alert"}
            className={`flex items-start gap-3 border-b px-4 py-3 text-sm md:px-6 ${
              warning
                ? "border-amber-500/30 bg-amber-500/10"
                : "border-destructive/30 bg-destructive/10"
            }`}
          >
            <AlertTriangle
              size={16}
              className={`mt-0.5 shrink-0 ${warning ? "text-amber-600" : "text-destructive"}`}
            />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="font-medium">{alert.title}</span>
              <span className="text-muted-foreground">{alert.body}</span>
              <span className="text-xs text-muted-foreground">
                {new Date(alert.at).toLocaleTimeString()}
              </span>
            </div>
            <Button
              size="icon"
              variant="ghost"
              aria-label={t("recordingAlerts.dismiss")}
              title={t("recordingAlerts.dismiss")}
              onClick={() =>
                void api.acknowledge({ key: alert.key }).then((result) => {
                  if (result.success) apply(result.data.alerts);
                })
              }
            >
              <X />
            </Button>
          </div>
        );
      })}
    </div>
  );
}
