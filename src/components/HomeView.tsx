import { useMemo, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Flame, Pencil, Zap, Loader2 } from "lucide-react";
import TranscriptionItem from "./ui/TranscriptionItem";
import type { TranscriptionItem as TranscriptionItemType } from "../types/electron";
import { formatHotkeyLabel } from "../utils/hotkeys";
import { formatDateGroup } from "../utils/dateFormatting";

interface UsageStats {
  totalDays: number;
  totalWords: number;
  totalDictations: number;
  averageWpm: number;
}

interface HomeViewProps {
  history: TranscriptionItemType[];
  isLoading: boolean;
  hotkey: string;
  copyToClipboard: (text: string) => void;
  deleteTranscription: (id: number) => void;
}

function formatNumber(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

export default function HomeView({
  history,
  isLoading,
  hotkey,
  copyToClipboard,
  deleteTranscription,
}: HomeViewProps) {
  const { t } = useTranslation();
  const [stats, setStats] = useState<UsageStats>({
    totalDays: 0,
    totalWords: 0,
    totalDictations: 0,
    averageWpm: 0,
  });

  useEffect(() => {
    window.electronAPI?.getUsageStats?.().then((data: UsageStats) => {
      if (data) setStats(data);
    });
  }, [history.length]);

  const groupedHistory = useMemo(() => {
    if (history.length === 0) return [];

    const groups: { label: string; items: TranscriptionItemType[] }[] = [];
    let currentLabel: string | null = null;

    for (const item of history) {
      const label = formatDateGroup(item.timestamp, t);

      if (label !== currentLabel) {
        groups.push({ label, items: [item] });
        currentLabel = label;
      } else {
        groups[groups.length - 1].items.push(item);
      }
    }

    return groups;
  }, [history, t]);

  return (
    <div className="px-4 pt-4 pb-6">
      <div className="max-w-3xl mx-auto">
        {/* Welcome header with stats */}
        <div className="mb-6">
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-xl font-semibold text-foreground tracking-tight" style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}>Welcome back, Scott</h1>
            {stats.totalDays > 0 && (
              <div className="flex items-center gap-3">
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Flame size={12} className="text-orange-500" />
                  {stats.totalDays} {stats.totalDays === 1 ? "day" : "days"}
                </span>
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Pencil size={12} className="text-blue-500" />
                  {formatNumber(stats.totalWords)} words
                </span>
                {stats.averageWpm > 0 && (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Zap size={12} className="text-yellow-500" />
                    {stats.averageWpm} WPM
                  </span>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Recent activity */}
        {isLoading ? (
          <div className="rounded-lg border border-border bg-card/50 dark:bg-card/60 backdrop-blur-sm">
            <div className="flex items-center justify-center gap-2 py-8">
              <Loader2 size={14} className="animate-spin text-primary" />
              <span className="text-sm text-muted-foreground">{t("controlPanel.loading")}</span>
            </div>
          </div>
        ) : history.length === 0 ? (
          <div className="rounded-lg border border-border bg-card/50 dark:bg-card/60 backdrop-blur-sm">
            <div className="flex flex-col items-center justify-center py-16 px-4">
              <svg
                className="text-foreground dark:text-white mb-5"
                width="64"
                height="64"
                viewBox="0 0 64 64"
                fill="none"
              >
                <rect
                  x="24"
                  y="6"
                  width="16"
                  height="28"
                  rx="8"
                  fill="currentColor"
                  fillOpacity={0.04}
                  stroke="currentColor"
                  strokeOpacity={0.1}
                />
                <rect
                  x="28"
                  y="12"
                  width="8"
                  height="3"
                  rx="1.5"
                  fill="currentColor"
                  fillOpacity={0.06}
                />
                <path
                  d="M18 28c0 7.7 6.3 14 14 14s14-6.3 14-14"
                  fill="none"
                  stroke="currentColor"
                  strokeOpacity={0.07}
                  strokeWidth={1.5}
                  strokeLinecap="round"
                />
                <line
                  x1="32"
                  y1="42"
                  x2="32"
                  y2="50"
                  stroke="currentColor"
                  strokeOpacity={0.07}
                  strokeWidth={1.5}
                  strokeLinecap="round"
                />
                <line
                  x1="26"
                  y1="50"
                  x2="38"
                  y2="50"
                  stroke="currentColor"
                  strokeOpacity={0.07}
                  strokeWidth={1.5}
                  strokeLinecap="round"
                />
              </svg>
              <h3 className="text-xs font-semibold text-foreground/70 dark:text-foreground/60 mb-2">
                {t("controlPanel.history.empty")}
              </h3>
              <div className="flex items-center gap-2 text-xs text-foreground/50 dark:text-foreground/25">
                <span>{t("controlPanel.history.press")}</span>
                <kbd className="inline-flex items-center h-5 px-1.5 rounded-sm bg-surface-1 dark:bg-white/6 border border-border/50 text-xs font-mono font-medium text-foreground/60 dark:text-foreground/40">
                  {formatHotkeyLabel(hotkey)}
                </kbd>
                <span>{t("controlPanel.history.toStart")}</span>
              </div>
            </div>
          </div>
        ) : (
          <div>
            {groupedHistory.map((group, index) => (
              <div key={group.label} className={index > 0 ? "mt-4" : ""}>
                <div className="sticky -top-1 z-10 -mx-4 px-5 pt-2 pb-2 bg-background">
                  <span className="text-[11px] font-semibold text-muted-foreground dark:text-muted-foreground uppercase tracking-wide">
                    {group.label}
                  </span>
                </div>
                <div className="space-y-1.5 relative z-0">
                  {group.items.map((item) => (
                    <TranscriptionItem
                      key={item.id}
                      item={item}
                      onCopy={copyToClipboard}
                      onDelete={deleteTranscription}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
