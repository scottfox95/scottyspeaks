import { ReadAloud } from "../speech/ReadAloud";
import { CallAgentPanel } from "./CallAgentPanel";
import { MeetingAudioPlayer, type MeetingAudioHandle } from "./MeetingAudioPlayer";
import { editable, changedFields, rebaseDraft } from "./meetingDraft";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { describeSpeakers, speakerLabels } from "../../utils/meetingSpeakers.mjs";
import { useTranslation } from "react-i18next";
import {
  Plus,
  FolderOpen,
  FileUp,
  Mic,
  Square,
  ArrowUpRight,
  Trash2,
  Settings2,
  Loader2,
  Headphones,
  X,
  CheckCircle2,
} from "lucide-react";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogFooter } from "../ui/dialog";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { MarkdownTextarea } from "../ui/MarkdownTextarea";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../ui/tabs";
import { cn } from "../lib/utils";
import { useSettingsStore } from "../../stores/settingsStore";
import type {
  Meeting,
  MeetingConfig,
  MeetingFolder,
  MeetingResult,
  CaptureStatus,
} from "../../types/meeting";

async function unwrap<T>(promise: Promise<MeetingResult<T>>): Promise<T> {
  const result = await promise;
  if (!result.success) throw new Error("error" in result ? result.error : "Call notes failed");
  return result.data;
}
const journalKey = (id: string) => `call-note-draft:${id}`;
const clock = (seconds: number) => {
  const n = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
};

export default function MeetingsView() {
  const { t, i18n } = useTranslation();
  const api = window.electronAPI.meetings;
  const [list, setList] = useState<Meeting[]>([]);
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [folders, setFolders] = useState<MeetingFolder[]>([]);
  const [destination, setDestination] = useState("");
  const [config, setConfig] = useState<MeetingConfig | null>(null);
  const [capture, setCapture] = useState<CaptureStatus>({ id: null });
  const [settings, setSettings] = useState(false);
  const [key, setKey] = useState("");
  const [editingKey, setEditingKey] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Meeting | null>(null);
  const [retranscribeTarget, setRetranscribeTarget] = useState<Meeting | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [editTranscript, setEditTranscript] = useState(false);
  const [now, setNow] = useState(Date.now());
  const audioPlayer = useRef<MeetingAudioHandle>(null);
  const current = useRef<Meeting | null>(null);
  const baseline = useRef<Meeting | null>(null);
  const version = useRef(0);
  const dirtyRef = useRef(false);
  const pending = useRef<Promise<void> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const whisperModel = useSettingsStore((s) => s.whisperModel);
  const parakeetModel = useSettingsStore((s) => s.parakeetModel);
  const adopt = useCallback((m: Meeting) => {
    current.current = m;
    baseline.current = m;
    setMeeting(m);
    dirtyRef.current = false;
    setDirty(false);
    setEditTranscript(false);
  }, []);
  const refreshList = useCallback(async () => setList(await unwrap(api.list())), [api]);
  const flush = useCallback(async (): Promise<void> => {
    if (timer.current) clearTimeout(timer.current);
    if (pending.current) {
      await pending.current;
      if (dirtyRef.current) return flush();
      return;
    }
    const value = current.current,
      base = baseline.current;
    if (!value || !base || !dirtyRef.current) return;
    const capturedVersion = version.current;
    setSaving(true);
    const work = (async () => {
      let saved: Meeting;
      const patch = changedFields(base, value);
      try {
        saved = await unwrap(api.save({ id: value.id, revision: base.revision, patch }));
      } catch (e) {
        // Background transcription changes metadata. Retry only when the fields
        // we edited still equal their original values; real edit conflicts remain visible.
        const latest = await unwrap(api.get({ id: value.id }));
        if (
          !Object.keys(patch).every(
            (key) => JSON.stringify(latest[key]) === JSON.stringify(base[key])
          )
        )
          throw e;
        saved = await unwrap(api.save({ id: value.id, revision: latest.revision, patch }));
      }
      baseline.current = saved;
      if (current.current?.id === saved.id) {
        if (version.current === capturedVersion) {
          current.current = saved;
          setMeeting(saved);
          dirtyRef.current = false;
          setDirty(false);
          localStorage.removeItem(journalKey(saved.id));
        } else {
          current.current = rebaseDraft(saved, value, current.current);
          setMeeting(current.current);
          localStorage.setItem(
            journalKey(saved.id),
            JSON.stringify({ base: saved, patch: editable(current.current) })
          );
        }
      }
      await refreshList();
    })();
    pending.current = work;
    try {
      await work;
    } finally {
      pending.current = null;
      setSaving(false);
    }
    if (dirtyRef.current) await flush();
  }, [api, refreshList]);
  const edit = (patch: Partial<Meeting>) => {
    if (!current.current) return;
    const updated = { ...current.current, ...patch };
    current.current = updated;
    version.current++;
    dirtyRef.current = true;
    setDirty(true);
    setMeeting(updated);
    try {
      localStorage.setItem(
        journalKey(updated.id),
        JSON.stringify({ base: baseline.current, patch: editable(updated) })
      );
    } catch {
      setError(t("meetings.draftStorageError"));
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      flush().catch((e) => setError(e.message));
    }, 500);
  };
  const open = useCallback(
    async (id: string) => {
      await flush();
      const next = await unwrap(api.get({ id }));
      adopt(next);
      const saved = localStorage.getItem(journalKey(id));
      if (saved) {
        try {
          const journal = JSON.parse(saved);
          baseline.current = journal.base;
          current.current = { ...next, ...journal.patch };
          setMeeting(current.current);
          dirtyRef.current = true;
          setDirty(true);
        } catch {
          setError(t("meetings.draftStorageError"));
        }
      }
    },
    [adopt, api, flush, t]
  );
  const act = async (fn: () => Promise<void>) => {
    setError("");
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    setBusy(true);
    Promise.all([
      unwrap(api.list()),
      unwrap(api.folders()),
      unwrap(api.getConfig()),
      unwrap(api.captureStatus()),
    ])
      .then(async ([items, pins, cfg, cap]) => {
        setList(items);
        setFolders(pins);
        setConfig(cfg);
        setCapture(cap);
        setDestination(pins[0]?.id || "");
        if (items.length) await open(cap.id || items[0].id);
      })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
    return () => {
      if (timer.current) clearTimeout(timer.current);
      flush().catch(() => {});
    };
  }, [api, flush, open]);
  useEffect(() => {
    const poll = setInterval(() => {
      setNow(Date.now());
      unwrap(api.captureStatus())
        .then(setCapture)
        .catch(() => {});
      const id = current.current?.id;
      if (id && !dirtyRef.current && !pending.current)
        unwrap(api.get({ id }))
          .then((value) => {
            if (current.current?.id === id && !dirtyRef.current && !pending.current) {
              current.current = value;
              baseline.current = value;
              setMeeting(value);
            }
          })
          .catch((e) => setError(e.message));
    }, 1500);
    return () => clearInterval(poll);
  }, [api]);
  const addFolder = async () => {
    const pin = await unwrap(api.pinFolder());
    if (pin) {
      setFolders(await unwrap(api.folders()));
      setDestination(pin.id);
    }
  };
  const deleteCall = async () => {
    if (!deleteTarget) return;
    const id = deleteTarget.id;
    if (timer.current) clearTimeout(timer.current);
    // Let already-issued saves settle before clearing their recovery journal.
    await pending.current?.catch(() => {});
    await unwrap(api.delete({ id }));
    localStorage.removeItem(journalKey(id));
    if (current.current?.id === id) {
      current.current = null;
      baseline.current = null;
      dirtyRef.current = false;
      setDirty(false);
      setMeeting(null);
    }
    setDeleteTarget(null);
    const items = await unwrap(api.list());
    setList(items);
    if (items.length) await open(items[0].id);
  };
  const create = async () => {
    await flush();
    adopt(await unwrap(api.create()));
    await refreshList();
  };
  const importFile = async (audio: boolean) => {
    await flush();
    const result = await unwrap(audio ? api.importAudio() : api.importTranscript());
    if (result) adopt(result);
    await refreshList();
  };
  const updateConfig = async (patch: Partial<MeetingConfig> & { apiKey?: string }) =>
    setConfig(await unwrap(api.setConfig(patch)));
  const recording = !!capture.id;
  const thisRecording = meeting?.id === capture.id;
  const transcribing = meeting?.status === "transcribing" || meeting?.status === "queued";
  const speakerEntries = useMemo(() => describeSpeakers(meeting || {}), [meeting]);
  const defaultLabels = useMemo(
    () => speakerLabels({ segments: meeting?.segments }, t),
    [meeting?.segments, t]
  );
  const labels = useMemo(() => speakerLabels(meeting || {}, t), [meeting, t]);
  const transcriptText =
    meeting?.transcriptEdited || !meeting?.segments.length
      ? meeting?.transcript || ""
      : meeting.segments
          .map((s) => `[${clock(s.start)}] ${labels.get(s.speaker)}: ${s.text}`)
          .join("\n\n");
  const meetingError =
    meeting?.lastErrorCode === "openrouterAuth"
      ? t("meetings.openrouterAuthError", { status: meeting.lastErrorStatus })
      : meeting?.lastErrorCode === "openrouterCredit"
        ? t("meetings.openrouterCreditError")
        : meeting?.lastErrorCode === "openrouterEmpty"
          ? t("meetings.openrouterEmptyError")
          : meeting?.lastErrorCode === "openrouterFailed"
            ? `${t("meetings.openrouterFailedError", { status: meeting.lastErrorStatus })}${meeting.lastErrorDetail ? ` ${meeting.lastErrorDetail}` : ""}`
            : meeting?.lastError;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border px-6 py-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{t("meetings.title")}</h1>
          <p className="mt-1 text-xs text-muted-foreground">{t("meetings.subtitle")}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => act(addFolder)}>
            <FolderOpen />
            {t("meetings.addFolder")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setSettings(!settings)}
            aria-label={t("meetings.settings")}
            aria-expanded={settings}
          >
            <Settings2 />
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => act(() => importFile(false))}
          >
            <FileUp />
            {t("meetings.importTranscript")}
          </Button>
          <Button size="sm" disabled={busy} onClick={() => act(create)}>
            <Plus />
            {t("meetings.new")}
          </Button>
        </div>
      </header>
      {error && (
        <div
          role="alert"
          className="flex items-start justify-between gap-3 border-b border-destructive/30 bg-destructive/5 px-6 py-3 text-sm"
        >
          <p>{error}</p>
          <Button
            variant="ghost"
            size="sm"
            aria-label={t("meetings.dismiss")}
            onClick={() => setError("")}
          >
            <X />
          </Button>
        </div>
      )}
      {recording && (
        <div
          role="status"
          className="flex items-center justify-between gap-3 border-b border-border bg-primary/5 px-6 py-3 text-sm"
        >
          <span className="flex items-center gap-2">
            <span className="size-2 rounded-full bg-destructive" />
            {t("meetings.recording")} · {clock((now - (capture.startedAt || now)) / 1000)}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || capture.stopping}
            onClick={() =>
              act(async () => {
                // Audio capture must stop even when a note cannot be saved.
                const stopped = await unwrap(api.stopCapture({ id: capture.id! }));
                setCapture({ id: null });
                await flush();
                if (current.current?.id === stopped.id)
                  adopt(await unwrap(api.get({ id: stopped.id })));
                await refreshList();
              })
            }
          >
            <Square />
            {t("meetings.stop")}
          </Button>
        </div>
      )}
      {settings && config && (
        <section
          aria-label={t("meetings.settings")}
          className="flex flex-col gap-3 border-b border-border bg-muted/20 px-6 py-4"
        >
          <div className="flex flex-wrap items-end gap-4">
            <label className="flex flex-col gap-1 text-xs">
              {t("meetings.provider")}
              <select
                className="rounded border border-border bg-background p-2 text-sm"
                value={config.provider}
                disabled={busy || transcribing || recording}
                onChange={(e) =>
                  act(() => updateConfig({ provider: e.target.value as MeetingConfig["provider"] }))
                }
              >
                <option value="local">{t("meetings.local")}</option>
                <option value="openrouter">{t("meetings.cloud")}</option>
              </select>
            </label>
            {config.provider === "local" && (
              <label className="flex flex-col gap-1 text-xs">
                {t("meetings.localEngine")}
                <select
                  className="rounded border border-border bg-background p-2 text-sm"
                  value={config.localEngine}
                  disabled={busy || transcribing}
                  onChange={(e) =>
                    act(() =>
                      updateConfig({
                        localEngine: e.target.value as "whisper" | "nvidia",
                        localModel: e.target.value === "whisper" ? whisperModel : parakeetModel,
                      })
                    )
                  }
                >
                  <option value="nvidia">Parakeet</option>
                  <option value="whisper">Whisper</option>
                </select>
              </label>
            )}
            {config.provider === "openrouter" && (
              <>
                {config.hasKey && !editingKey ? (
                  <div className="flex min-w-0 flex-1 items-center gap-3" role="status">
                    <CheckCircle2
                      className="size-5 shrink-0 text-emerald-600 dark:text-emerald-400"
                      aria-hidden="true"
                    />
                    <div className="flex-1">
                      <p className="text-sm font-medium">{t("meetings.keyStored")}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {t("meetings.keyNotVerified")}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => setEditingKey(true)}
                    >
                      {t("meetings.replaceKey")}
                    </Button>
                  </div>
                ) : (
                  <>
                    <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs">
                      {config.hasKey ? t("meetings.replaceKey") : t("meetings.apiKey")}
                      <Input
                        type="password"
                        autoComplete="off"
                        value={key}
                        disabled={busy}
                        placeholder={t("meetings.keyPlaceholder")}
                        onChange={(e) => setKey(e.target.value)}
                      />
                    </label>
                    <Button
                      size="sm"
                      disabled={busy || !key.trim()}
                      onClick={() =>
                        act(async () => {
                          await updateConfig({ apiKey: key });
                          setKey("");
                          setEditingKey(false);
                        })
                      }
                    >
                      {config.hasKey ? t("meetings.replaceKey") : t("meetings.saveKey")}
                    </Button>
                    {config.hasKey && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => {
                          setKey("");
                          setEditingKey(false);
                        }}
                      >
                        {t("meetings.cancelKeyChange")}
                      </Button>
                    )}
                  </>
                )}
                {config.hasKey && !editingKey && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => act(() => updateConfig({ apiKey: "" }))}
                  >
                    {t("meetings.removeKey")}
                  </Button>
                )}
              </>
            )}
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {config.provider === "local" ? t("meetings.localHelp") : t("meetings.cloudHelp")}
          </p>
          {!config.captureAvailable && (
            <p className="text-xs text-muted-foreground">{t("meetings.captureUnavailable")}</p>
          )}
        </section>
      )}
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-52 shrink-0 flex-col border-r border-border max-[850px]:w-40">
          <div className="flex items-center justify-between px-4 pb-2 pt-4">
            <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              {t("meetings.recent")}
            </span>
            <Button
              variant="ghost"
              size="sm"
              aria-label={t("meetings.importAudio")}
              onClick={() => act(() => importFile(true))}
              disabled={busy}
            >
              <Headphones />
            </Button>
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            {list.map((item) => (
              <button
                key={item.id}
                disabled={busy}
                onClick={() => act(() => open(item.id))}
                className={cn(
                  "mb-1 flex w-full flex-col gap-1 rounded-md px-3 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  meeting?.id === item.id ? "bg-primary/8" : "hover:bg-muted"
                )}
              >
                <span className="line-clamp-2 text-sm font-medium">
                  {item.title || t("meetings.untitled")}
                </span>
                <span className="text-[11px] text-muted-foreground">
                  {new Date(item.createdAt).toLocaleDateString(i18n.language, {
                    month: "short",
                    day: "numeric",
                  })}{" "}
                  · {t(`meetings.status.${item.status}`)}
                </span>
              </button>
            ))}
          </div>
        </aside>
        {!meeting ? (
          <main className="flex flex-1 flex-col items-center justify-center gap-4 px-8 text-center">
            <NotebookEmpty />
            <h2 className="text-xl font-medium">{t("meetings.emptyTitle")}</h2>
            <p className="max-w-md text-sm leading-relaxed text-muted-foreground">
              {t("meetings.emptyBody")}
            </p>
            {folders.length > 0 && (
              <p className="max-w-md break-words text-xs text-muted-foreground">
                {t("meetings.pinnedFolders")}: {folders.map((folder) => folder.name).join(" · ")}
              </p>
            )}
            <Button disabled={busy} onClick={() => act(create)}>
              <Plus />
              {t("meetings.new")}
            </Button>
          </main>
        ) : (
          <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <div data-call-content className="min-h-0 flex-1 overflow-y-auto">
              <div className="flex flex-col gap-4 px-6 pb-4 pt-6">
                <label className="sr-only" htmlFor="meeting-title">
                  {t("meetings.callTitle")}
                </label>
                <Input
                  id="meeting-title"
                  disabled={busy}
                  value={meeting.title}
                  maxLength={200}
                  placeholder={t("meetings.titlePlaceholder")}
                  className="h-11 border-0 bg-transparent px-0 text-2xl font-semibold shadow-none"
                  onChange={(e) => edit({ title: e.target.value })}
                />
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-xs text-muted-foreground" role="status">
                    {saving
                      ? t("meetings.saving")
                      : dirty
                        ? t("meetings.unsaved")
                        : t("meetings.saved")}{" "}
                    ·{" "}
                    {config?.provider === "openrouter" ? t("meetings.cloud") : t("meetings.local")}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={
                        busy || thisRecording || transcribing || meeting.status === "recording"
                      }
                      onClick={() => setDeleteTarget(meeting)}
                    >
                      <Trash2 />
                      {t("meetings.deleteCall")}
                    </Button>
                    {!recording && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={
                          busy || transcribing || !!meeting.transcript || !config?.captureAvailable
                        }
                        onClick={() =>
                          act(async () => {
                            await flush();
                            setCapture(await unwrap(api.startCapture({ id: meeting.id })));
                          })
                        }
                      >
                        <Mic />
                        {meeting.audio.length ? t("meetings.resume") : t("meetings.record")}
                      </Button>
                    )}
                    {meeting.audio.length > 0 && !thisRecording && (
                      <Button
                        size="sm"
                        disabled={busy || transcribing || recording}
                        onClick={() => {
                          if (meeting.transcript || meeting.segments.length)
                            setRetranscribeTarget(meeting);
                          else
                            void act(async () => {
                              await flush();
                              adopt(await unwrap(api.transcribe({ id: meeting.id })));
                            });
                        }}
                      >
                        {transcribing ? <Loader2 className="animate-spin" /> : <Headphones />}
                        {t(
                          meeting.transcript || meeting.segments.length
                            ? "meetings.transcribeAgain"
                            : config?.provider === "openrouter"
                              ? "meetings.transcribeCloud"
                              : "meetings.transcribe"
                        )}
                      </Button>
                    )}
                    {transcribing && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() =>
                          act(async () => {
                            await unwrap(api.cancelTranscription({ id: meeting.id }));
                          })
                        }
                      >
                        {t("meetings.cancel")}
                      </Button>
                    )}
                  </div>
                </div>
                {transcribing && (
                  <p role="status" className="text-sm text-muted-foreground">
                    {meeting.status === "queued"
                      ? t("dictationCleanup.stages.queued")
                      : t("meetings.processing", {
                          completed: meeting.progress?.completed || 0,
                          total: meeting.progress?.total || "…",
                        })}
                  </p>
                )}
                {meetingError && (
                  <p role="alert" className="text-sm text-destructive">
                    {meetingError}
                  </p>
                )}
              </div>
              <Tabs defaultValue="notes" className="flex min-h-80 flex-col px-6">
                <TabsList className="self-start">
                  <TabsTrigger value="notes">{t("meetings.notes")}</TabsTrigger>
                  <TabsTrigger value="transcript">{t("meetings.transcript")}</TabsTrigger>
                  <TabsTrigger value="agents">{t("callAgent.tab")}</TabsTrigger>
                </TabsList>
                <TabsContent data-speech-source value="notes" className="min-h-72 flex-1">
                  <ReadAloud text={meeting.notes || ""} label={t("speech.notes")} />
                  <MarkdownTextarea
                    disabled={busy}
                    ariaLabel={t("meetings.notes")}
                    value={meeting.notes}
                    onChange={(e) => edit({ notes: e.target.value })}
                    placeholder={t("meetings.notesPlaceholder")}
                    className="min-h-72"
                  />
                </TabsContent>
                <TabsContent data-speech-source value="transcript" className="flex-1 pb-5">
                  <ReadAloud text={transcriptText} label={t("speech.transcript")} />
                  <MeetingAudioPlayer
                    key={meeting.id}
                    ref={audioPlayer}
                    meeting={meeting}
                    recording={capture.id === meeting.id}
                  />
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                    <p className="max-w-lg text-xs leading-relaxed text-muted-foreground">
                      {meeting.provider === "openrouter"
                        ? t("meetings.speakerHelp")
                        : meeting.provider === "import"
                          ? t("meetings.importSpeakerHelp")
                          : t("meetings.localSpeakerHelp")}
                    </p>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={transcribing}
                      onClick={() => setEditTranscript(!editTranscript)}
                    >
                      {editTranscript ? t("meetings.readTranscript") : t("meetings.editTranscript")}
                    </Button>
                  </div>
                  {meeting.transcriptEdited && (
                    <p className="mb-3 text-xs text-muted-foreground">
                      {t("meetings.editedTranscriptHelp")}
                    </p>
                  )}
                  {editTranscript ? (
                    <Textarea
                      disabled={busy}
                      aria-label={t("meetings.transcript")}
                      value={transcriptText}
                      className="min-h-72 font-mono text-sm leading-relaxed"
                      onChange={(e) => edit({ transcript: e.target.value, transcriptEdited: true })}
                    />
                  ) : meeting.transcriptEdited || !meeting.segments.length ? (
                    <p className="whitespace-pre-wrap text-sm leading-relaxed">
                      {meeting.transcript || t("meetings.noTranscript")}
                    </p>
                  ) : (
                    <>
                      <details
                        data-speaker-editor
                        key={meeting.id}
                        open={speakerEntries.length <= 4}
                        className="mb-5 rounded-lg border border-border p-3"
                      >
                        <summary className="cursor-pointer text-sm font-medium">
                          {t("meetings.speakersTitle", { count: speakerEntries.length })}
                        </summary>
                        <p className="my-3 text-xs leading-relaxed text-muted-foreground">
                          {t("meetings.renameHelp")}
                        </p>
                        <div className="grid grid-cols-1 gap-3 min-[1050px]:grid-cols-2">
                          {speakerEntries.map(({ id: speaker, sample }) => (
                            <div
                              key={speaker}
                              className="flex min-w-0 flex-col gap-2 rounded-md border border-border p-3"
                            >
                              <label className="flex flex-col gap-1 text-xs font-medium">
                                {defaultLabels.get(speaker)}
                                <Input
                                  data-speaker-id={speaker}
                                  aria-label={t("meetings.renameSpeaker", {
                                    speaker: defaultLabels.get(speaker),
                                  })}
                                  disabled={busy}
                                  className="h-8"
                                  maxLength={100}
                                  value={meeting.speakers[speaker] || ""}
                                  placeholder={t("meetings.speakerName")}
                                  onChange={(e) =>
                                    edit({
                                      speakers: { ...meeting.speakers, [speaker]: e.target.value },
                                    })
                                  }
                                />
                              </label>
                              <p className="line-clamp-3 break-words text-xs leading-relaxed text-muted-foreground">
                                {sample.text}
                              </p>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="self-start"
                                disabled={!meeting.audio.length || capture.id === meeting.id}
                                aria-label={t("meetings.listenSpeaker", {
                                  speaker: labels.get(speaker),
                                  time: clock(sample.start),
                                })}
                                onClick={() =>
                                  audioPlayer.current?.seek(
                                    sample.start,
                                    speaker === "microphone"
                                      ? "microphone"
                                      : speaker === "system"
                                        ? "system"
                                        : "all"
                                  )
                                }
                              >
                                <Headphones />
                                {t("meetings.listenAt", { time: clock(sample.start) })}
                              </Button>
                            </div>
                          ))}
                        </div>
                      </details>
                      <div className="flex flex-col gap-5">
                        {meeting.segments.map((segment, index) => (
                          <div key={index} data-transcript-segment className="flex gap-4">
                            <button
                              type="button"
                              disabled={!meeting.audio.length || capture.id === meeting.id}
                              onClick={() =>
                                audioPlayer.current?.seek(
                                  segment.start,
                                  segment.speaker === "microphone"
                                    ? "microphone"
                                    : segment.speaker === "system"
                                      ? "system"
                                      : "all"
                                )
                              }
                              aria-label={t("replay.seek", { time: clock(segment.start) })}
                              className="w-12 shrink-0 self-start rounded pt-0.5 font-mono text-[11px] text-primary underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 disabled:text-muted-foreground disabled:no-underline"
                            >
                              {clock(segment.start)}
                            </button>
                            <div className="min-w-0 break-words">
                              <button
                                type="button"
                                className="mb-1 rounded text-left text-xs font-semibold text-primary underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2"
                                aria-label={t("meetings.renameSpeaker", {
                                  speaker: labels.get(segment.speaker),
                                })}
                                onClick={() => {
                                  const editor =
                                    document.querySelector<HTMLDetailsElement>(
                                      "[data-speaker-editor]"
                                    );
                                  if (!editor) return;
                                  editor.open = true;
                                  const input = [
                                    ...editor.querySelectorAll<HTMLInputElement>(
                                      "input[data-speaker-id]"
                                    ),
                                  ].find((item) => item.dataset.speakerId === segment.speaker);
                                  input?.scrollIntoView({ block: "center" });
                                  input?.focus({ preventScroll: true });
                                }}
                              >
                                {labels.get(segment.speaker)}
                              </button>
                              <p className="whitespace-pre-wrap text-sm leading-relaxed">
                                {segment.text}
                              </p>
                            </div>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </TabsContent>
                <TabsContent value="agents">
                  <CallAgentPanel
                    key={meeting.id}
                    callId={meeting.id}
                    folderId={destination}
                    flush={flush}
                    disabled={busy}
                  />
                </TabsContent>
              </Tabs>
            </div>
            <footer
              data-call-footer
              className="shrink-0 flex flex-col gap-2 border-t border-border bg-background px-6 py-4"
            >
              <div className="flex flex-wrap items-center gap-2">
                <FolderOpen className="size-4 text-muted-foreground" />
                <label className="sr-only" htmlFor="meeting-destination">
                  {t("meetings.destination")}
                </label>
                <select
                  id="meeting-destination"
                  className="min-w-40 flex-1 rounded border border-border bg-background px-2 py-2 text-sm"
                  value={destination}
                  onChange={(e) => setDestination(e.target.value)}
                >
                  <option value="">{t("meetings.chooseFolder")}</option>
                  {folders.map((folder) => (
                    <option key={folder.id} value={folder.id}>
                      {folder.name}
                    </option>
                  ))}
                </select>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(addFolder)}>
                  <FolderOpen />
                  {t("meetings.addFolder")}
                </Button>
                <Button
                  size="sm"
                  disabled={busy || !destination}
                  onClick={() =>
                    act(async () => {
                      await flush();
                      const result = await unwrap(
                        api.file({ id: meeting.id, folderId: destination })
                      );
                      adopt(result.meeting);
                      await refreshList();
                    })
                  }
                >
                  {t("meetings.file")}
                </Button>
                {meeting.exportPath && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || !destination}
                    onClick={() =>
                      act(async () => {
                        await flush();
                        const result = await unwrap(
                          api.file({ id: meeting.id, folderId: destination, asCopy: true })
                        );
                        adopt(result.meeting);
                        await refreshList();
                      })
                    }
                  >
                    {t("meetings.saveCopy")}
                  </Button>
                )}
                {destination && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    aria-label={t("meetings.unpinFolder")}
                    onClick={() =>
                      act(async () => {
                        await unwrap(api.unpinFolder({ id: destination }));
                        const pins = await unwrap(api.folders());
                        setFolders(pins);
                        setDestination(pins[0]?.id || "");
                      })
                    }
                  >
                    <X />
                  </Button>
                )}
                {meeting.exportPath && (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={t("meetings.reveal")}
                    onClick={() =>
                      act(async () => {
                        await unwrap(api.reveal({ id: meeting.id }));
                      })
                    }
                  >
                    <ArrowUpRight />
                  </Button>
                )}
              </div>
              <p
                className="truncate text-[11px] text-muted-foreground"
                title={meeting.exportPath || folders.find((f) => f.id === destination)?.path}
              >
                {meeting.exportPath ||
                  folders.find((f) => f.id === destination)?.path ||
                  t("meetings.draftHelp")}
              </p>
            </footer>
          </main>
        )}
      </div>
      <Dialog
        open={!!retranscribeTarget}
        onOpenChange={(isOpen) => {
          if (!isOpen && !busy) setRetranscribeTarget(null);
        }}
      >
        <DialogContent
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            document.getElementById("cancel-retranscription")?.focus();
          }}
        >
          <DialogTitle>{t("meetings.retranscribeTitle")}</DialogTitle>
          <DialogDescription>{t("meetings.retranscribeDescription")}</DialogDescription>
          <DialogFooter>
            <Button
              id="cancel-retranscription"
              variant="outline"
              disabled={busy}
              onClick={() => setRetranscribeTarget(null)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                const target = retranscribeTarget;
                if (!target) return;
                setRetranscribeTarget(null);
                void act(async () => {
                  await flush();
                  adopt(await unwrap(api.transcribe({ id: target.id, force: true })));
                });
              }}
            >
              {t("meetings.replaceTranscript")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!deleteTarget}
        onOpenChange={(isOpen) => {
          if (!isOpen && !busy) setDeleteTarget(null);
        }}
      >
        <DialogContent
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            document.getElementById("cancel-call-deletion")?.focus();
          }}
        >
          <DialogTitle>
            {t("meetings.deleteTitle", { title: deleteTarget?.title || t("meetings.untitled") })}
          </DialogTitle>
          <DialogDescription>{t("meetings.deleteDescription")}</DialogDescription>
          <DialogFooter>
            <Button
              id="cancel-call-deletion"
              variant="outline"
              disabled={busy}
              onClick={() => setDeleteTarget(null)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              variant="destructive"
              disabled={busy || thisRecording || transcribing}
              onClick={() => act(deleteCall)}
            >
              {t("meetings.confirmDelete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
function NotebookEmpty() {
  return (
    <div className="flex size-16 items-center justify-center rounded-2xl border border-border bg-muted/30">
      <Headphones className="size-7 text-muted-foreground" />
    </div>
  );
}
