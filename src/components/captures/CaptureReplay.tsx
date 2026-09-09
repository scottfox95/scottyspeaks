import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Headphones, Loader2 } from "lucide-react";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import type { CaptureAttempt, DictationCapture, CorrectionFixture } from "../../types/capture";
import type { MeetingResult } from "../../types/meeting";

const selectClass = "h-9 rounded-md border border-border bg-background px-2 text-sm";
async function unwrap<T>(result: Promise<MeetingResult<T>>): Promise<T> {
  const value = await result;
  if (!value.success) throw new Error("error" in value ? value.error : "");
  return value.data;
}

export default function CaptureReplay({ historyId }: { historyId?: number }) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        size={historyId ? "icon" : "sm"}
        className={historyId ? "h-6 w-6" : "mb-3"}
        aria-label={t("replay.open")}
        title={t("replay.open")}
        onClick={() => setOpen(true)}
      >
        <Headphones size={14} />
        {!historyId && t("replay.open")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>{t("replay.title")}</DialogTitle>
            <DialogDescription>{t("replay.description")}</DialogDescription>
          </DialogHeader>
          {open && <ReplayBody historyId={historyId} locale={i18n.language} />}
        </DialogContent>
      </Dialog>
    </>
  );
}

function ReplayBody({ historyId, locale }: { historyId?: number; locale: string }) {
  const { t } = useTranslation();
  const api = window.electronAPI.captures;
  const [items, setItems] = useState<DictationCapture[]>([]);
  const [selected, setSelected] = useState<DictationCapture | null>(null);
  const [retention, setRetention] = useState<0 | 1 | 7 | 30>(7);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [retryStage, setRetryStage] = useState("preparing");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [exampleVersion, setExampleVersion] = useState(0);
  const [audio, setAudio] = useState("");
  const [audioLoading, setAudioLoading] = useState(false);
  const [models, setModels] = useState<
    { value: string; provider: "whisper" | "parakeet" | "openrouter"; model: string }[]
  >([]);
  const [choice, setChoice] = useState("");
  const [cloudConsent, setCloudConsent] = useState(false);
  const [preview, setPreview] = useState<CaptureAttempt | null>(null);
  const [corrected, setCorrected] = useState("");
  const [keepExample, setKeepExample] = useState(false);
  const mounted = useRef(true);
  const selectedId = useRef<string | null>(null);
  const retryId = useRef<string | null>(null);
  const generation = useRef(0);
  const adopt = (value: DictationCapture | null) => {
    generation.current++;
    selectedId.current = value?.id || null;
    setSelected(value);
    setPreview(null);
    setCorrected(value?.correctedText || value?.acceptedText || value?.finalText || "");
    setKeepExample(false);
    setCloudConsent(false);
    setError("");
    setNotice("");
  };
  useEffect(() => {
    mounted.current = true;
    let active = true;
    (async () => {
      try {
        const [records, config] = await Promise.all([unwrap(api.list()), unwrap(api.getConfig())]);
        if (!active || !mounted.current) return;
        setItems(records);
        setRetention(config.retentionDays);
        adopt(
          historyId
            ? records.find((item) => item.historyId === historyId) || null
            : records[0] || null
        );
        const results = await Promise.allSettled([
          window.electronAPI.listWhisperModels(),
          window.electronAPI.listParakeetModels(),
        ]);
        const available: typeof models = [];
        for (const [index, result] of results.entries())
          if (result.status === "fulfilled" && result.value.success)
            for (const model of result.value.models)
              if (model.downloaded) {
                const provider = index === 0 ? ("whisper" as const) : ("parakeet" as const);
                available.push({
                  value: `${provider}:${model.model}`,
                  provider,
                  model: model.model,
                });
              }
        available.push({
          value: "openrouter:microsoft/mai-transcribe-2",
          provider: "openrouter",
          model: "microsoft/mai-transcribe-2",
        });
        if (active && mounted.current) {
          setModels(available);
          setChoice(available[0]?.value || "");
        }
      } catch (e) {
        if (active && mounted.current) setError(String((e as Error).message));
      } finally {
        if (active && mounted.current) setLoading(false);
      }
    })();
    return () => {
      active = false;
      mounted.current = false;
      generation.current++;
      if (retryId.current) void api.cancelRetry({ id: retryId.current });
    };
  }, [api, historyId]);
  useEffect(() => {
    let active = true,
      url = "";
    setAudio("");
    setAudioLoading(false);
    if (selected?.audioAvailable) {
      setAudioLoading(true);
      unwrap(api.playback({ id: selected.id }))
        .then((value) => {
          url = value.url;
          if (active) setAudio(url);
          else void api.releasePlayback({ url });
        })
        .catch((e) => {
          if (active) setError(e.message);
        })
        .finally(() => {
          if (active) setAudioLoading(false);
        });
    }
    return () => {
      active = false;
      if (url) void api.releasePlayback({ url });
    };
  }, [api, selected?.id, selected?.audioAvailable]);
  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const update = (value: DictationCapture) => {
    if (!mounted.current || selectedId.current !== value.id) return;
    setSelected(value);
    setItems((old) => old.map((item) => (item.id === value.id ? value : item)));
  };
  const activeRetry = busy ? retryId.current : null;
  useEffect(() => {
    if (!activeRetry) return;
    let active = true;
    setRetryStage("preparing");
    const poll = async () => {
      try {
        const result = await api.retryStatus({ id: activeRetry });
        if (active && result.success && result.data.stage !== "idle")
          setRetryStage(result.data.stage);
      } catch {
        /* The retry result carries any terminal failure. */
      }
    };
    void poll();
    const timer = setInterval(poll, 400);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [api, activeRetry]);
  const model = models.find((item) => item.value === choice);
  const copy = (text: string) =>
    act(async () => {
      const result = await window.electronAPI.writeClipboard(text);
      if (!result.success) throw new Error(t("replay.copyFailed"));
      if (mounted.current) setNotice(t("replay.copied"));
    });
  return (
    <div className="space-y-5">
      <div className="rounded-lg border border-border bg-muted/20 p-3">
        <label className="flex flex-wrap items-center gap-3 text-sm">
          {t("replay.retention")}
          <select
            aria-label={t("replay.retention")}
            className={selectClass}
            value={retention}
            disabled={busy || loading}
            onChange={(e) => {
              const days = Number(e.target.value) as typeof retention;
              void act(async () => {
                const config = await unwrap(api.setConfig({ retentionDays: days }));
                const records = await unwrap(api.list());
                if (!mounted.current) return;
                setRetention(config.retentionDays);
                setItems(records);
                if (selectedId.current)
                  setSelected(records.find((item) => item.id === selectedId.current) || null);
              });
            }}
          >
            {[0, 1, 7, 30].map((days) => (
              <option key={days} value={days}>
                {days ? t("replay.days", { count: days }) : t("replay.off")}
              </option>
            ))}
          </select>
        </label>
        <p className="mt-2 text-xs text-muted-foreground">{t("replay.retentionHelp")}</p>
      </div>
      {loading ? (
        <p role="status" className="flex items-center gap-2">
          <Loader2 className="size-4 animate-spin" />
          {t("replay.loading")}
        </p>
      ) : (
        <>
          <label className="flex flex-col gap-2 text-sm">
            {t("replay.recording")}
            <select
              className={selectClass}
              aria-label={t("replay.recording")}
              value={selected?.id || ""}
              disabled={busy}
              onChange={(e) => adopt(items.find((item) => item.id === e.target.value) || null)}
            >
              {!selected && <option value="">{t("replay.noCapture")}</option>}
              {items.map((item) => (
                <option key={item.id} value={item.id}>
                  {new Date(item.createdAt).toLocaleString(locale)} ·{" "}
                  {t(`replay.state.${item.status}`)} ·{" "}
                  {(item.finalText || item.rawText).slice(0, 65)}
                </option>
              ))}
            </select>
          </label>
          {!selected ? (
            <p className="text-sm text-muted-foreground">{t("replay.noCaptureHelp")}</p>
          ) : (
            <>
              <div className="space-y-2">
                {audioLoading && (
                  <p role="status" className="text-sm">
                    {t("replay.preparingAudio")}
                  </p>
                )}
                {audio && (
                  <audio
                    key={audio}
                    controls
                    preload="metadata"
                    src={audio}
                    className="w-full"
                    aria-label={t("replay.originalAudio")}
                    onError={() => setError(t("replay.audioError"))}
                  />
                )}
                {!selected.audioAvailable && (
                  <p className="text-sm text-muted-foreground">
                    {t(
                      selected.audioUnavailableReason === "disabled"
                        ? "replay.audioDisabled"
                        : "replay.audioExpired"
                    )}
                  </p>
                )}
                {selected.error && <p className="text-sm text-destructive">{selected.error}</p>}
              </div>
              <dl className="flex flex-wrap gap-x-6 gap-y-2 text-xs text-muted-foreground">
                {(["provider", "model", "language", "styleId", "polishModel"] as const).map(
                  (key) =>
                    selected.settings[key] && (
                      <div key={key}>
                        <dt>{t(`replay.settings.${key}`)}</dt>
                        <dd className="mt-1 text-foreground">{selected.settings[key]}</dd>
                      </div>
                    )
                )}
                {Object.entries(selected.settings.cleanup || {}).map(([key, value]) => (
                  <div key={key}>
                    <dt>{t(`replay.settings.${key}`)}</dt>
                    <dd>{t(value ? "replay.enabled" : "replay.disabled")}</dd>
                  </div>
                ))}
              </dl>
              <div className="grid gap-4 sm:grid-cols-2">
                <TextBlock title={t("replay.raw")} text={selected.rawText} />
                <TextBlock title={t("replay.final")} text={selected.finalText} />
              </div>
              {selected.acceptedText && (
                <TextBlock title={t("replay.savedRetry")} text={selected.acceptedText} />
              )}
              <section className="space-y-3 border-t border-border pt-4">
                <h3 className="text-sm font-semibold">{t("replay.retryTitle")}</h3>
                <p className="text-xs text-muted-foreground">{t("replay.retryHelp")}</p>
                <label className="flex flex-wrap items-center gap-3 text-sm">
                  {t("replay.model")}
                  <select
                    className={selectClass}
                    aria-label={t("replay.model")}
                    value={choice}
                    disabled={busy}
                    onChange={(e) => {
                      setChoice(e.target.value);
                      setCloudConsent(false);
                    }}
                  >
                    {models.map((item) => (
                      <option key={item.value} value={item.value}>
                        {item.provider === "openrouter"
                          ? "MAI · OpenRouter"
                          : `${item.provider === "whisper" ? "Whisper" : "Parakeet"} · ${item.model}`}
                      </option>
                    ))}
                  </select>
                </label>
                {model?.provider === "openrouter" && (
                  <label className="flex items-start gap-2 text-xs leading-relaxed">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={cloudConsent}
                      disabled={busy}
                      onChange={(e) => setCloudConsent(e.target.checked)}
                    />
                    {t("replay.cloudConsent")}
                  </label>
                )}
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    disabled={
                      busy ||
                      !selected.audioAvailable ||
                      !model ||
                      (model.provider === "openrouter" && !cloudConsent)
                    }
                    onClick={() =>
                      void act(async () => {
                        if (!model) return;
                        const token = generation.current;
                        retryId.current = selected.id;
                        try {
                          const attempt = await unwrap(
                            api.retry({
                              id: selected.id,
                              provider: model.provider,
                              model: model.model,
                              language: selected.settings.language,
                              allowCloud: cloudConsent,
                            })
                          );
                          if (mounted.current && generation.current === token) {
                            setPreview(attempt);
                            update(await unwrap(api.get({ id: selected.id })));
                          }
                        } finally {
                          retryId.current = null;
                        }
                      })
                    }
                  >
                    {busy && retryId.current
                      ? t(`dictationCleanup.stages.${retryStage}`)
                      : t("replay.preview")}
                  </Button>
                  {busy && retryId.current && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void api.cancelRetry({ id: retryId.current! })}
                    >
                      {t("common.cancel")}
                    </Button>
                  )}
                </div>
                {selected.attempts.length > 0 && (
                  <label className="flex flex-col gap-2 text-xs">
                    {t("replay.previousAttempts")}
                    <select
                      className={selectClass}
                      value={preview?.id || ""}
                      disabled={busy}
                      onChange={(e) =>
                        setPreview(
                          selected.attempts.find((item) => item.id === e.target.value) || null
                        )
                      }
                    >
                      <option value="">{t("replay.choosePreview")}</option>
                      {selected.attempts.map((attempt) => (
                        <option key={attempt.id} value={attempt.id}>
                          {new Date(attempt.createdAt).toLocaleString(locale)} ·{" "}
                          {attempt.settings.model}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {preview && (
                  <div className="space-y-3 rounded-md border border-primary/30 bg-primary/5 p-3">
                    <TextBlock title={t("replay.previewResult")} text={preview.finalText} />
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            update(
                              await unwrap(
                                api.acceptAttempt({ id: selected.id, attemptId: preview.id })
                              )
                            );
                            setNotice(t("replay.retrySaved"));
                          })
                        }
                      >
                        {t("replay.keepRetry")}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => void copy(preview.finalText)}
                      >
                        {t("replay.copy")}
                      </Button>
                    </div>
                  </div>
                )}
              </section>
              <section className="space-y-3 border-t border-border pt-4">
                <h3 className="text-sm font-semibold">{t("replay.wrong")}</h3>
                <label className="block text-xs">
                  {t("replay.corrected")}
                  <Textarea
                    className="mt-2 min-h-24"
                    value={corrected}
                    disabled={busy}
                    onChange={(e) => {
                      setCorrected(e.target.value);
                      setKeepExample(false);
                    }}
                  />
                </label>
                <label className="flex items-start gap-2 text-xs leading-relaxed">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={keepExample}
                    disabled={busy}
                    onChange={(e) => setKeepExample(e.target.checked)}
                  />
                  {t("replay.fixtureConsent")}
                </label>
                <Button
                  size="sm"
                  disabled={busy || !corrected.trim() || !keepExample}
                  onClick={() =>
                    void act(async () => {
                      await unwrap(api.saveFixture({ id: selected.id, correctedText: corrected }));
                      update(await unwrap(api.get({ id: selected.id })));
                      setKeepExample(false);
                      setNotice(t("replay.exampleSaved"));
                      setExampleVersion((value) => value + 1);
                    })
                  }
                >
                  {t("replay.saveExample")}
                </Button>
              </section>
              <section className="border-t border-border pt-4">
                <p className="mb-2 text-xs text-muted-foreground">{t("replay.deleteHelp")}</p>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      await unwrap(api.delete({ id: selected.id }));
                      const records = await unwrap(api.list());
                      if (!mounted.current) return;
                      setItems(records);
                      adopt(null);
                      setNotice(t("replay.deleted"));
                    })
                  }
                >
                  {t("replay.delete")}
                </Button>
              </section>
            </>
          )}
        </>
      )}
      <CorrectionExamples refresh={exampleVersion} locale={locale} />
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm text-primary">
          {notice}
        </p>
      )}
    </div>
  );
}
function TextBlock({ title, text }: { title: string; text: string }) {
  return (
    <div>
      <h3 className="mb-2 text-xs font-semibold">{title}</h3>
      <p className="min-h-14 whitespace-pre-wrap break-words rounded-md bg-muted/30 p-3 text-sm leading-relaxed">
        {text || "—"}
      </p>
    </div>
  );
}

function CorrectionExamples({ refresh, locale }: { refresh: number; locale: string }) {
  const { t } = useTranslation();
  const api = window.electronAPI.captures;
  const [examples, setExamples] = useState<CorrectionFixture[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let active = true;
    unwrap(api.listFixtures())
      .then((value) => {
        if (active) setExamples(value);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [api, refresh]);
  return (
    <details className="border-t border-border pt-4">
      <summary className="cursor-pointer text-sm font-semibold">
        {t("replay.examples")} ({examples.length})
      </summary>
      <p className="my-3 text-xs text-muted-foreground">{t("replay.examplesHelp")}</p>
      {!examples.length && (
        <p className="text-xs text-muted-foreground">{t("replay.noExamples")}</p>
      )}
      <div className="space-y-3">
        {examples.map((example) => (
          <div key={example.id} className="rounded-md border border-border p-3">
            <p className="mb-2 text-xs text-muted-foreground">
              {new Date(example.createdAt).toLocaleString(locale)}
            </p>
            <p className="mb-3 line-clamp-3 whitespace-pre-wrap break-words text-sm">
              {example.expected}
            </p>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError("");
                setNotice("");
                try {
                  await unwrap(api.deleteFixture({ id: example.id }));
                  setExamples((old) => old.filter((item) => item.id !== example.id));
                  setNotice(t("replay.exampleDeleted"));
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t("replay.deleteExample")}
            </Button>
          </div>
        ))}
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="mt-2 text-xs text-primary">
          {notice}
        </p>
      )}
    </details>
  );
}
