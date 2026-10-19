// Copied to ignored src/temp/workspace-preview by preview-workspace.mjs.
// Only sample data lives here. Every host operation below stays in memory.
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider, useTranslation } from "react-i18next";
import i18n, { i18nReady } from "../../i18n";
import HomeView from "../../components/HomeView";
import MeetingsView from "../../components/meetings/MeetingsView";
import ControlPanelSidebar from "../../components/ControlPanelSidebar";
import { SpeechProvider } from "../../hooks/useSpeech";
import { ToastProvider, useToast } from "../../components/ui/Toast";
import "../../index.css";

const clone = (value) => structuredClone(value);
const ok = async (value) => ({ success: true, data: clone(value) });
const now = Date.now();
const listeners = new Set();
const publishHistory = () => listeners.forEach((listener) => listener(history.slice(0, 50)));
const sampleTexts = [
  "Let’s keep the next version focused on reliable recording, clear notes, and finding what I said.",
  "Follow up with the project team on Friday. Ask for the revised drawings and a firm delivery date.",
  "The best version of this is simple: press a key, say it once, and keep moving.",
  "Add a reminder to review the call notes before tomorrow’s planning session.",
  "I want the action items to stay close to the conversation that created them.",
  "We agreed to keep the first prototype small and try it for a week.",
];
let history = Array.from({ length: 72 }, (_, index) => ({
  id: 1000 - index,
  timestamp: new Date(now - index * 3_600_000).toISOString(),
  text:
    index === 64
      ? "Archived lighthouse planning note: confirm the material samples."
      : sampleTexts[index % sampleTexts.length],
  raw_text: index === 63 ? "raw-only compass reference" : sampleTexts[index % sampleTexts.length],
}));
const sampleSegments = [
  {
    start: 0,
    end: 8,
    speaker: "microphone",
    text: "Let’s leave this call with a clear plan for the prototype.",
  },
  {
    start: 12,
    end: 24,
    speaker: "system",
    text: "The recording flow looks good. I’ll send the revised scope on Friday.",
  },
  {
    start: 28,
    end: 42,
    speaker: "microphone",
    text: "I’ll test the first version this week and write down anything that slows me down.",
  },
  {
    start: 48,
    end: 61,
    speaker: "system",
    text: "Great. Let’s review the feedback together next Tuesday.",
  },
];
const makeCall = (id, title, days, notes, recorded = false) => ({
  id,
  title,
  notes,
  transcript: recorded ? sampleSegments.map((segment) => segment.text).join("\n\n") : "",
  transcriptEdited: false,
  segments: recorded ? clone(sampleSegments) : [],
  speakers: { microphone: "Me", system: "Alex" },
  revision: 1,
  createdAt: new Date(now - days * 86_400_000).toISOString(),
  updatedAt: new Date(now - days * 86_400_000).toISOString(),
  status: recorded ? "ready" : "draft",
  provider: "local",
  audio: recorded
    ? [
        { file: "sample.wav", source: "microphone", offset: 0 },
        { file: "sample-system.wav", source: "system", offset: 0 },
      ]
    : [],
  recordedDuration: recorded ? 72 : 0,
});
let calls = [
  makeCall(
    "preview-planning",
    "Prototype planning",
    0,
    "## Decisions\nKeep the first version focused on recording and useful notes.\n\n## Next steps\n- [ ] Alex: send the revised scope on Friday\n- [ ] Me: test the prototype this week\n- [ ] Review feedback next Tuesday",
    true
  ),
  makeCall(
    "preview-project",
    "Project check-in",
    1,
    "## Before the call\n- Confirm the delivery date\n- Review material samples\n- Clarify who owns the next update"
  ),
  makeCall(
    "preview-ideas",
    "A few ideas to try",
    3,
    "Capture the thought while it’s fresh. Clean it up later.\n\n- Faster access to old dictations\n- One place for the audio and the notes"
  ),
];
let folders = [{ id: "preview-folder", name: "Sample project", path: "/Preview/Sample project" }];
let capture = { id: null };
let config = {
  provider: "local",
  localEngine: "nvidia",
  localModel: "parakeet-tdt-0.6b-v3",
  hasKey: false,
  captureAvailable: true,
};
let retention = { retentionDays: 7 };
const findCall = (id) => {
  const item = calls.find((call) => call.id === id);
  if (!item) throw new Error("Sample call no longer exists.");
  return item;
};
const updateCall = (id, patch) => {
  const item = findCall(id);
  Object.assign(item, patch, { revision: item.revision + 1, updatedAt: new Date().toISOString() });
  return item;
};
const createCall = () => {
  const item = makeCall(`preview-${Date.now()}`, i18n.t("meetings.new"), 0, "");
  calls.unshift(item);
  return item;
};
const silentAudio = () => {
  const samples = 8000 * 72;
  const bytes = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(bytes);
  const text = (offset, value) =>
    [...value].forEach((character, index) =>
      view.setUint8(offset + index, character.charCodeAt(0))
    );
  text(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 16000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples * 2, true);
  return {
    url: URL.createObjectURL(new Blob([bytes], { type: "audio/wav" })),
    durationSeconds: 72,
  };
};
const sampleCaptures = history.slice(0, 3).map((item) => ({
  id: `capture-${item.id}`,
  historyId: item.id,
  createdAt: item.timestamp,
  durationSeconds: 12,
  mimeType: "audio/wav",
  settings: { provider: "parakeet", model: "parakeet-tdt-0.6b-v3", language: "en" },
  status: "ready",
  rawText: item.raw_text,
  finalText: item.text,
  attempts: [],
  audioAvailable: true,
  audioUnavailableReason: null,
}));
const copyText = async (text) => {
  if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
  else {
    const input = document.createElement("textarea");
    input.value = text;
    document.body.append(input);
    input.select();
    const copied = document.execCommand("copy");
    input.remove();
    if (!copied) throw new Error("Copy was unavailable.");
  }
  return { success: true };
};
const agentState = {
  ready: false,
  lastConnectedAt: null,
  shared: false,
  drafts: [],
  configuration: { json: "{}", codex: "", claude: "" },
};
window.electronAPI = {
  getUsageStats: async () => ({
    totalDays: 14,
    totalWords: 8632,
    totalDictations: history.length,
    averageWpm: 142,
  }),
  queryTranscriptions: async ({ query = "", limit = 50, cursor } = {}) => {
    const value = query.trim().toLocaleLowerCase();
    const matches = history.filter(
      (item) =>
        (!value ||
          item.text.toLocaleLowerCase().includes(value) ||
          item.raw_text.toLocaleLowerCase().includes(value)) &&
        (!cursor ||
          item.timestamp < cursor.timestamp ||
          (item.timestamp === cursor.timestamp && item.id < cursor.id))
    );
    const items = matches.slice(0, limit),
      last = items.at(-1),
      hasMore = matches.length > limit;
    return clone({
      items,
      hasMore,
      nextCursor: hasMore && last ? { id: last.id, timestamp: last.timestamp } : null,
    });
  },
  getTranscriptions: async (limit = 50) => clone(history.slice(0, limit)),
  updateTranscription: async (id, text) => {
    history = history.map((item) => (item.id === id ? { ...item, text } : item));
    publishHistory();
    return { success: true, transcription: clone(history.find((item) => item.id === id)) };
  },
  addStyleExample: async () => ({ success: true }),
  writeClipboard: copyText,
  getLogLevel: async () => "error",
  log: async () => {},
  openExternal: async () => ({ success: false }),
  listWhisperModels: async () => ({ success: true, models: [{ model: "tiny", downloaded: true }] }),
  listParakeetModels: async () => ({
    success: true,
    models: [{ model: "parakeet-tdt-0.6b-v3", downloaded: true }],
  }),
  speech: {
    status: async () => ({
      available: false,
      recording: false,
      speaking: false,
      starting: false,
      settings: { rate: 200 },
    }),
    onChange: () => () => {},
  },
  meetings: {
    list: ({ query = "" } = {}) => {
      const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
      return ok(
        calls
          .filter((item) => {
            const text = `${item.title}\n${item.notes}\n${item.transcript}`.toLocaleLowerCase();
            return terms.every((term) => text.includes(term));
          })
          .map((item) => ({
            ...item,
            preview: (item.notes || item.transcript).replace(/\s+/g, " ").slice(0, 160),
          }))
      );
    },
    get: ({ id }) => ok(findCall(id)),
    create: () => ok(createCall()),
    save: async ({ id, revision, patch }) =>
      revision !== findCall(id).revision
        ? { success: false, error: "Sample revision conflict" }
        : ok(updateCall(id, patch)),
    delete: ({ id }) => {
      calls = calls.filter((item) => item.id !== id);
      return ok(null);
    },
    folders: () => ok(folders),
    pinFolder: () => {
      const pin = {
        id: `folder-${folders.length}`,
        name: "Sample notes",
        path: "/Preview/Sample notes",
      };
      folders.push(pin);
      return ok(pin);
    },
    unpinFolder: ({ id }) => {
      folders = folders.filter((folder) => folder.id !== id);
      return ok(null);
    },
    file: ({ id, folderId }) => {
      const destination = `${folders.find((folder) => folder.id === folderId)?.path}/sample.md`;
      return ok({ path: destination, meeting: updateCall(id, { exportPath: destination }) });
    },
    reveal: () => ok(null),
    getConfig: () => ok(config),
    setConfig: (patch) => {
      const { apiKey, ...preferences } = patch;
      config = { ...config, ...preferences, ...(apiKey === undefined ? {} : { hasKey: !!apiKey }) };
      return ok(config);
    },
    captureStatus: () => ok(capture),
    startCapture: ({ id }) => {
      capture = { id, startedAt: Date.now() };
      updateCall(id, { status: "recording" });
      return ok(capture);
    },
    stopCapture: ({ id }) => {
      capture = { id: null };
      return ok(
        updateCall(id, {
          status: "ready",
          audio: [{ file: "simulated.wav", source: "microphone", offset: 0 }],
          recordedDuration: 72,
          segments: clone(sampleSegments),
          transcript: sampleSegments.map((item) => item.text).join("\n\n"),
        })
      );
    },
    transcribe: ({ id }) =>
      ok(
        updateCall(id, {
          status: "ready",
          segments: clone(sampleSegments),
          transcript: sampleSegments.map((item) => item.text).join("\n\n"),
        })
      ),
    cancelTranscription: () => ok(null),
    importTranscript: () => {
      const item = createCall();
      return ok(
        updateCall(item.id, {
          title: "Imported sample transcript",
          transcript: sampleSegments.map((segment) => segment.text).join("\n\n"),
        })
      );
    },
    importAudio: () => {
      const item = createCall();
      return ok(
        updateCall(item.id, {
          title: "Imported sample recording",
          audio: [{ file: "sample.wav", source: "audio", offset: 0 }],
        })
      );
    },
    playback: () => ok(silentAudio()),
    releasePlayback: ({ url }) => {
      URL.revokeObjectURL(url);
      return ok(null);
    },
    exportAudio: () => ok(null),
  },
  captures: {
    list: () => ok(sampleCaptures),
    getConfig: () => ok(retention),
    setConfig: (value) => {
      retention = value;
      return ok(retention);
    },
    playback: () => ok(silentAudio()),
    releasePlayback: ({ url }) => {
      URL.revokeObjectURL(url);
      return ok(null);
    },
    listFixtures: () => ok([]),
    cancelRetry: () => ok(null),
    retryStatus: () => ok({ stage: "idle" }),
    retry: ({ id }) => {
      const item = sampleCaptures.find((value) => value.id === id);
      const attempt = {
        id: `attempt-${Date.now()}`,
        createdAt: new Date().toISOString(),
        settings: item.settings,
        rawText: item.rawText,
        finalText: item.finalText,
      };
      item.attempts.push(attempt);
      return ok(attempt);
    },
    acceptAttempt: ({ id, attemptId }) => {
      const item = sampleCaptures.find((value) => value.id === id);
      item.acceptedAttemptId = attemptId;
      item.acceptedText = item.attempts.find((attempt) => attempt.id === attemptId)?.finalText;
      return ok(item);
    },
    saveFixture: () => ok({ id: "sample-fixture", path: "/Preview/example.json" }),
    deleteFixture: () => ok(null),
  },
  callAgent: {
    state: () => ok(agentState),
    grant: () => {
      agentState.shared = true;
      return ok(agentState);
    },
    revoke: () => {
      agentState.shared = false;
      return ok(agentState);
    },
    handoff: ({ callId }) => {
      const item = findCall(callId);
      return ok(`# ${item.title}\n\n${item.notes}\n\n${item.transcript}`);
    },
  },
};

function Preview() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const viewFromHash = () => location.hash.slice(1) || "meetings";
  const [view, setView] = useState(viewFromHash);
  const [recent, setRecent] = useState(() => history.slice(0, 50));
  useEffect(() => {
    const navigate = () => setView(viewFromHash());
    window.addEventListener("hashchange", navigate);
    listeners.add(setRecent);
    return () => {
      window.removeEventListener("hashchange", navigate);
      listeners.delete(setRecent);
    };
  }, []);
  const copy = async (text) => {
    try {
      await copyText(text);
      toast({ title: t("controlPanel.history.copiedTitle"), variant: "success" });
    } catch {
      toast({ title: t("controlPanel.history.couldNotCopyTitle"), variant: "destructive" });
    }
  };
  return (
    <div className="flex h-dvh min-h-0 flex-col bg-background text-foreground">
      <div
        className="shrink-0 border-b border-amber-500/20 bg-amber-500/10 px-4 py-2 text-center text-xs text-foreground"
        role="status"
      >
        {t("workspacePreview.banner")}
      </div>
      <div className="flex min-h-0 flex-1">
        <ControlPanelSidebar
          activeView={view}
          onViewChange={(next) => {
            location.hash = next;
          }}
          onOpenSettings={() => {
            location.hash = "settings";
          }}
        />
        <main className="min-h-0 min-w-0 flex-1 overflow-auto">
          {view === "meetings" ? (
            <MeetingsView />
          ) : view === "home" ? (
            <HomeView
              history={recent}
              isLoading={false}
              hotkey="GLOBE"
              copyToClipboard={copy}
              deleteTranscription={(id) => {
                history = history.filter((item) => item.id !== id);
                publishHistory();
              }}
            />
          ) : (
            <p className="p-8 text-sm text-muted-foreground">{t("workspacePreview.desktopOnly")}</p>
          )}
        </main>
      </div>
    </div>
  );
}

void i18nReady.then(() => {
  createRoot(document.getElementById("root")).render(
    <I18nextProvider i18n={i18n}>
      <ToastProvider>
        <SpeechProvider>
          <Preview />
        </SpeechProvider>
      </ToastProvider>
    </I18nextProvider>
  );
});
