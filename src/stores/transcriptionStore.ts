import { create } from "zustand";
import type { TranscriptionItem } from "../types/electron";

interface TranscriptionState {
  transcriptions: TranscriptionItem[];
}

const useTranscriptionStore = create<TranscriptionState>()(() => ({
  transcriptions: [],
}));

let hasBoundIpcListeners = false;
const DEFAULT_LIMIT = 50;
let currentLimit = DEFAULT_LIMIT;

function ensureIpcListeners() {
  if (hasBoundIpcListeners || typeof window === "undefined") {
    return;
  }

  const disposers: Array<() => void> = [];

  if (window.electronAPI?.onTranscriptionAdded) {
    const dispose = window.electronAPI.onTranscriptionAdded((item) => {
      if (item) {
        addTranscription(item);
      }
    });
    if (typeof dispose === "function") {
      disposers.push(dispose);
    }
  }

  if (window.electronAPI?.onTranscriptionDeleted) {
    const dispose = window.electronAPI.onTranscriptionDeleted(({ id }) => {
      removeTranscription(id);
    });
    if (typeof dispose === "function") {
      disposers.push(dispose);
    }
  }

  if (window.electronAPI?.onTranscriptionsCleared) {
    const dispose = window.electronAPI.onTranscriptionsCleared(() => {
      clearTranscriptions();
    });
    if (typeof dispose === "function") {
      disposers.push(dispose);
    }
  }

  if ((window.electronAPI as any)?.onTranscriptionUpdated) {
    const dispose = (window.electronAPI as any).onTranscriptionUpdated(
      (item: TranscriptionItem) => {
        if (item) updateTranscriptionInStore(item);
      }
    );
    if (typeof dispose === "function") {
      disposers.push(dispose);
    }
  }

  hasBoundIpcListeners = true;

  window.addEventListener("beforeunload", () => {
    disposers.forEach((dispose) => dispose());
  });
}

export async function initializeTranscriptions(limit = DEFAULT_LIMIT) {
  currentLimit = limit;
  ensureIpcListeners();
  const items = await window.electronAPI.getTranscriptions(limit);
  useTranscriptionStore.setState({ transcriptions: items });
  return items;
}

export function addTranscription(item: TranscriptionItem) {
  if (!item) return;
  const { transcriptions } = useTranscriptionStore.getState();
  const withoutDuplicate = transcriptions.filter((existing) => existing.id !== item.id);
  useTranscriptionStore.setState({
    transcriptions: [item, ...withoutDuplicate].slice(0, currentLimit),
  });
}

export function updateTranscriptionInStore(item: TranscriptionItem) {
  if (!item) return;
  const { transcriptions } = useTranscriptionStore.getState();
  useTranscriptionStore.setState({
    transcriptions: transcriptions.map((existing) => (existing.id === item.id ? item : existing)),
  });
}

export function removeTranscription(id: number) {
  if (id == null) return;
  const { transcriptions } = useTranscriptionStore.getState();
  const next = transcriptions.filter((item) => item.id !== id);
  // Paginated/search views may contain an older item outside this recent cache.
  // Publish the deletion even then so those views refresh their query.
  useTranscriptionStore.setState({ transcriptions: next });
}

export function clearTranscriptions() {
  if (useTranscriptionStore.getState().transcriptions.length === 0) return;
  useTranscriptionStore.setState({ transcriptions: [] });
}

export function useTranscriptions() {
  return useTranscriptionStore((state) => state.transcriptions);
}
