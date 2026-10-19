import { useState } from "react";
import { Button } from "./ui/button";
import { Activity, Copy, Check, AlertTriangle, CheckCircle2 } from "lucide-react";

interface Diagnostics {
  chip?: string;
  memoryGB?: number;
  lowPowerMode?: boolean;
  onBattery?: boolean;
  cpuSpeedLimit?: number;
  llamaRunning?: boolean;
  parakeetRunning?: boolean;
  models?: Record<string, { files: string[]; bytes: number } | null>;
  recentCount?: number | null;
  recentPolished?: number | null;
  polishMs?: number;
  polishSample?: string | null;
  polishError?: string;
  llamaPort?: number | null;
}

const gb = (b: number) => (b / 1073741824).toFixed(2) + " GB";

export default function DiagnosticsPanel() {
  const [data, setData] = useState<Diagnostics | null>(null);
  const [running, setRunning] = useState(false);
  const [copied, setCopied] = useState(false);

  const run = async () => {
    setRunning(true);
    try {
      const result = await (window as any).electronAPI?.runDiagnostics?.();
      setData(result || null);
    } catch {
      setData(null);
    } finally {
      setRunning(false);
    }
  };

  const asText = (d: Diagnostics) =>
    [
      `SS2 diagnostics`,
      `Chip: ${d.chip} (${d.memoryGB} GB)`,
      `Low Power Mode: ${d.lowPowerMode ? "ON" : "off"} | Battery: ${d.onBattery ? "yes" : "no (AC)"} | CPU limit: ${d.cpuSpeedLimit}%`,
      `Polish engine running: ${d.llamaRunning} (port ${d.llamaPort ?? "-"})`,
      `Parakeet running: ${d.parakeetRunning}`,
      `Polish round-trip: ${d.polishMs != null ? d.polishMs + " ms" : "n/a"}${d.polishError ? " ERROR: " + d.polishError : ""}`,
      `Recent dictations polished: ${d.recentPolished}/${d.recentCount}`,
      ...Object.entries(d.models || {}).map(
        ([k, v]) => `${k}: ${v ? `${gb(v.bytes)} [${v.files.join(", ")}]` : "MISSING"}`
      ),
      d.polishSample ? `Sample output: ${d.polishSample}` : "",
    ]
      .filter(Boolean)
      .join("\n");

  const copy = async () => {
    if (!data) return;
    await navigator.clipboard.writeText(asText(data));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const Row = ({ label, value, bad }: { label: string; value: string; bad?: boolean }) => (
    <div className="flex items-center justify-between py-1.5 border-b border-border/40 last:border-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={`text-xs font-medium tabular-nums ${bad ? "text-amber-500" : "text-foreground"}`}>
        {value}
      </span>
    </div>
  );

  const verdicts: { bad: boolean; text: string }[] = [];
  if (data) {
    if (data.lowPowerMode)
      verdicts.push({ bad: true, text: "Low Power Mode is ON — this throttles the AI. Turn it off in System Settings › Battery." });
    if (data.onBattery)
      verdicts.push({ bad: true, text: "Running on battery — plug in for full speed." });
    if ((data.cpuSpeedLimit ?? 100) < 100)
      verdicts.push({ bad: true, text: `CPU is thermally limited to ${data.cpuSpeedLimit}%.` });
    if (!data.llamaRunning)
      verdicts.push({ bad: true, text: "Polish engine is not running — dictation will paste unformatted." });
    if (!data.parakeetRunning)
      verdicts.push({ bad: true, text: "Parakeet is not running — transcription may be using the slower Whisper engine." });
    if (data.recentPolished === 0 && (data.recentCount ?? 0) > 0)
      verdicts.push({ bad: true, text: "None of your recent dictations were AI-polished. That's why formatting is missing." });
    if (data.polishMs != null && data.polishMs > 4000)
      verdicts.push({ bad: true, text: `Polish took ${(data.polishMs / 1000).toFixed(1)}s — expected under 3s.` });
    if (!verdicts.length)
      verdicts.push({ bad: false, text: "Everything looks healthy." });
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={run} disabled={running} className="press-tactile h-8 rounded-full text-xs px-4">
          <Activity className="w-3.5 h-3.5" />
          {running ? "Running…" : "Run diagnostics"}
        </Button>
        {data && (
          <Button size="sm" variant="outline" onClick={copy} className="press-tactile h-8 rounded-full text-xs px-4">
            {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
            {copied ? "Copied" : "Copy report"}
          </Button>
        )}
      </div>

      {data && (
        <>
          <div className="space-y-1.5">
            {verdicts.map((v, i) => (
              <div
                key={i}
                className={`flex items-start gap-2 rounded-md px-3 py-2 text-xs ${
                  v.bad ? "bg-amber-500/10 text-amber-600" : "bg-emerald-500/10 text-emerald-600"
                }`}
              >
                {v.bad ? (
                  <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                ) : (
                  <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                )}
                <span>{v.text}</span>
              </div>
            ))}
          </div>

          <div className="rounded-lg border border-border/60 px-3 py-1">
            <Row label="Chip" value={`${data.chip} · ${data.memoryGB} GB`} />
            <Row label="Power" value={data.onBattery ? "Battery" : "Plugged in"} bad={data.onBattery} />
            <Row label="Low Power Mode" value={data.lowPowerMode ? "ON" : "Off"} bad={data.lowPowerMode} />
            <Row label="CPU speed limit" value={`${data.cpuSpeedLimit}%`} bad={(data.cpuSpeedLimit ?? 100) < 100} />
            <Row label="Polish engine" value={data.llamaRunning ? "Running" : "Not running"} bad={!data.llamaRunning} />
            <Row label="Transcription (Parakeet)" value={data.parakeetRunning ? "Running" : "Not running"} bad={!data.parakeetRunning} />
            <Row
              label="Polish speed"
              value={data.polishMs != null ? `${(data.polishMs / 1000).toFixed(1)}s` : "n/a"}
              bad={data.polishMs != null && data.polishMs > 4000}
            />
            <Row
              label="Recent dictations polished"
              value={`${data.recentPolished ?? "?"} of ${data.recentCount ?? "?"}`}
              bad={data.recentPolished === 0}
            />
            {Object.entries(data.models || {}).map(([k, v]) => (
              <Row key={k} label={k} value={v ? gb(v.bytes) : "MISSING"} bad={!v} />
            ))}
          </div>

          <p className="text-[10px] text-muted-foreground leading-relaxed">
            Short phrases (under 8 words, no list cues) skip the AI on purpose so they paste
            instantly — so "testing one two three" is never formatted, on any machine.
          </p>
        </>
      )}
    </div>
  );
}
