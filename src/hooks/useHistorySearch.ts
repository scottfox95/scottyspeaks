import { useCallback, useEffect, useRef, useState } from "react";
import type { TranscriptionCursor, TranscriptionItem } from "../types/electron";

const PAGE_SIZE = 50;

export function useHistorySearch(query: string, recentHistory: TranscriptionItem[]) {
  const search = query.trim();
  const [items, setItems] = useState<TranscriptionItem[]>([]);
  const [cursor, setCursor] = useState<TranscriptionCursor | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const generation = useRef(0);
  const previousSearch = useRef(search);
  const visibleCount = useRef(PAGE_SIZE);

  useEffect(() => {
    const request = ++generation.current;
    const changed = previousSearch.current !== search;
    previousSearch.current = search;
    if (changed) {
      visibleCount.current = PAGE_SIZE;
      setItems([]);
      setCursor(null);
    }
    setLoading(true);
    setLoadingMore(false);
    setError(false);

    const timer = window.setTimeout(
      async () => {
        try {
          const collected: TranscriptionItem[] = [];
          let nextCursor: TranscriptionCursor | null = null;
          // Keep already-browsed pages visible after a correction, deletion or new dictation.
          do {
            const page = await window.electronAPI.queryTranscriptions({
              query: search,
              limit: PAGE_SIZE,
              cursor: nextCursor,
            });
            if (generation.current !== request) return;
            collected.push(...page.items);
            nextCursor = page.nextCursor;
          } while (nextCursor && collected.length < visibleCount.current);
          setItems(collected);
          setCursor(nextCursor);
          visibleCount.current = Math.max(PAGE_SIZE, collected.length);
        } catch {
          if (generation.current === request) setError(true);
        } finally {
          if (generation.current === request) setLoading(false);
        }
      },
      changed ? 180 : 0
    );

    return () => {
      window.clearTimeout(timer);
      generation.current = request + 1;
    };
  }, [search, recentHistory, refresh]);

  const loadMore = useCallback(async () => {
    if (!cursor || loading || loadingMore) return;
    const request = generation.current;
    setLoadingMore(true);
    setError(false);
    try {
      const page = await window.electronAPI.queryTranscriptions({
        query: search,
        limit: PAGE_SIZE,
        cursor,
      });
      if (generation.current !== request) return;
      setItems((current) => {
        const known = new Set(current.map((item) => item.id));
        const next = [...current, ...page.items.filter((item) => !known.has(item.id))];
        visibleCount.current = next.length;
        return next;
      });
      setCursor(page.nextCursor);
    } catch {
      if (generation.current === request) setError(true);
    } finally {
      if (generation.current === request) setLoadingMore(false);
    }
  }, [cursor, loading, loadingMore, search]);

  const retry = useCallback(() => setRefresh((value) => value + 1), []);
  return { items, hasMore: !!cursor, loading, loadingMore, error, loadMore, retry };
}
