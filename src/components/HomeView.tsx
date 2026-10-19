import { useMemo, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Copy, Loader2, Mic, Search } from "lucide-react";
import CaptureReplay from "./captures/CaptureReplay";
import TranscriptionItem from "./ui/TranscriptionItem";
import { Alert, AlertDescription } from "./ui/alert";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import type { TranscriptionItem as TranscriptionItemType, UsageStats } from "../types/electron";
import { useHistorySearch } from "../hooks/useHistorySearch";
import { formatHotkeyLabel } from "../utils/hotkeys";
import { formatDateGroup, normalizeDbDate } from "../utils/dateFormatting";

interface HomeViewProps {
  history: TranscriptionItemType[];
  isLoading: boolean;
  hotkey: string;
  copyToClipboard: (text: string) => void;
  deleteTranscription: (id: number) => void;
}

export default function HomeView({
  history,
  isLoading,
  hotkey,
  copyToClipboard,
  deleteTranscription,
}: HomeViewProps) {
  const { t, i18n } = useTranslation();
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const [stats, setStats] = useState<UsageStats | null>(null);
  const result = useHistorySearch(query, history);
  const searching = query.trim().length > 0;
  const loading = isLoading || result.loading;
  const latest = history[0];

  useEffect(() => {
    let active = true;
    window.electronAPI
      ?.getUsageStats?.()
      .then((data) => {
        if (active && data) setStats(data);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [history]);

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      // A replay/settings dialog owns its own keyboard interaction.
      if (document.querySelector('[role="dialog"]')) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  const groupedHistory = useMemo(() => {
    const groups: { label: string; items: TranscriptionItemType[] }[] = [];
    for (const item of result.items) {
      const label = formatDateGroup(normalizeDbDate(item.timestamp), t);
      const last = groups[groups.length - 1];
      if (last?.label === label) last.items.push(item);
      else groups.push({ label, items: [item] });
    }
    return groups;
  }, [result.items, t]);

  return (
    <div className="px-4 py-6 sm:px-6">
      <div className="mx-auto flex max-w-3xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <h1
            className="text-2xl font-semibold tracking-tight text-foreground"
            style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}
          >
            {t("historyHome.welcome")}
          </h1>
          <p className="text-sm text-muted-foreground">{t("historyHome.description")}</p>
          {stats && stats.totalDictations > 0 && (
            <p className="text-xs tabular-nums text-muted-foreground">
              {t("historyHome.usage", {
                dictations: stats.totalDictations.toLocaleString(i18n.language),
                words: stats.totalWords.toLocaleString(i18n.language),
              })}
            </p>
          )}
        </header>

        <section className="flex flex-col gap-3" aria-label={t("historyHome.tools")}>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="press-tactile"
              disabled={!latest}
              onClick={() => latest && copyToClipboard(latest.text)}
            >
              <Copy data-icon="inline-start" />
              {t("historyHome.copyLatest")}
            </Button>
            <div className="[&>button]:mb-0">
              <CaptureReplay />
            </div>
          </div>
          <label htmlFor="history-search" className="sr-only">
            {t("historyHome.searchLabel")}
          </label>
          <div className="flex items-center gap-2">
            <Input
              id="history-search"
              ref={searchRef}
              type="search"
              value={query}
              maxLength={500}
              placeholder={t("historyHome.searchPlaceholder")}
              aria-describedby="history-search-help"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setQuery("");
                  event.preventDefault();
                }
              }}
            />
            {searching && (
              <Button
                variant="ghost"
                size="sm"
                className="press-tactile"
                onClick={() => setQuery("")}
              >
                {t("historyHome.clear")}
              </Button>
            )}
          </div>
          <p id="history-search-help" className="text-xs text-muted-foreground">
            {t("historyHome.searchHelp")}
          </p>
        </section>

        {result.error && (
          <Alert variant="destructive">
            <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
              <span>{t("historyHome.loadError")}</span>
              <Button variant="outline" size="sm" className="press-tactile" onClick={result.retry}>
                {t("historyHome.retry")}
              </Button>
            </AlertDescription>
          </Alert>
        )}

        <section className="flex flex-col gap-4" aria-busy={loading || result.loadingMore}>
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-medium text-foreground">
              {t(searching ? "historyHome.results" : "historyHome.history")}
            </h2>
            <span role="status" className="text-xs tabular-nums text-muted-foreground">
              {loading
                ? t("controlPanel.loading")
                : t("historyHome.shown", { count: result.items.length })}
            </span>
          </div>
          {loading && result.items.length === 0 ? (
            <div className="flex justify-center py-12">
              <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden="true" />
            </div>
          ) : result.items.length === 0 && !result.error ? (
            <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-6 py-12 text-center">
              {searching ? (
                <Search className="size-6 text-muted-foreground" aria-hidden="true" />
              ) : (
                <Mic className="size-6 text-muted-foreground" aria-hidden="true" />
              )}
              <p className="text-sm font-medium text-foreground">
                {t(searching ? "historyHome.noResults" : "controlPanel.history.empty")}
              </p>
              {searching ? (
                <p className="text-sm text-muted-foreground">{t("historyHome.tryAnother")}</p>
              ) : (
                <p className="flex flex-wrap items-center justify-center gap-2 text-sm text-muted-foreground">
                  <span>{t("controlPanel.history.press")}</span>
                  <kbd className="rounded border border-border bg-muted px-2 py-1 text-xs font-mono">
                    {formatHotkeyLabel(hotkey)}
                  </kbd>
                  <span>{t("controlPanel.history.toStart")}</span>
                </p>
              )}
            </div>
          ) : (
            groupedHistory.map((group) => (
              <div key={group.label} className="flex flex-col gap-2">
                <h3 className="text-xs font-medium text-muted-foreground">{group.label}</h3>
                <div className="flex flex-col gap-2">
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
            ))
          )}
          {result.hasMore && (
            <Button
              variant="outline"
              className="press-tactile self-center"
              disabled={loading || result.loadingMore}
              onClick={result.loadMore}
            >
              {result.loadingMore && <Loader2 data-icon="inline-start" className="animate-spin" />}
              {t(result.loadingMore ? "controlPanel.loading" : "historyHome.loadMore")}
            </Button>
          )}
        </section>
      </div>
    </div>
  );
}
