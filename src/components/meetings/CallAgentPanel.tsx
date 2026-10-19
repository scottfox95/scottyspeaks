import { ReadAloud } from "../speech/ReadAloud";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import type { CallAgentState, AgentDraft } from "../../types/callAgent";
import type { MeetingResult } from "../../types/meeting";
async function unwrap<T>(promise: Promise<MeetingResult<T>>): Promise<T> {
  const result = await promise;
  if (!result.success) throw Error("error" in result ? result.error : "callAgent.actionFailed");
  return result.data;
}
export function CallAgentPanel({
  callId,
  folderId,
  flush,
  disabled = false,
}: {
  callId: string;
  folderId: string;
  flush: () => Promise<void>;
  disabled?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const api = window.electronAPI.callAgent;
  const [state, setState] = useState<CallAgentState | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(false),
    [copied, setCopied] = useState(false),
    [filed, setFiled] = useState(false);
  const [handoff, setHandoff] = useState(""),
    [review, setReview] = useState<AgentDraft | null>(null);
  const refresh = useCallback(
    async () => setState(await unwrap(api.state({ callId }))),
    [api, callId]
  );
  useEffect(() => {
    let active = true;
    api.state({ callId }).then((result) => {
      if (active) {
        if (result.success) setState(result.data);
        else setError(true);
      }
    });
    return () => {
      active = false;
    };
  }, [api, callId]);
  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(false);
    setCopied(false);
    setFiled(false);
    try {
      await flush();
      await work();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  const blocked = busy || disabled;
  const copy = async (value: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
  };
  return (
    <section className="flex flex-col gap-5 py-4" aria-label={t("callAgent.title")}>
      <div>
        <h3 className="text-sm font-semibold">{t("callAgent.title")}</h3>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">{t("callAgent.help")}</p>
      </div>
      <p role="status" className="text-xs text-muted-foreground">
        {state?.ready ? t("callAgent.ready") : t("callAgent.unavailable")} ·{" "}
        {state?.lastConnectedAt
          ? t("callAgent.lastConnected", {
              time: new Date(state.lastConnectedAt).toLocaleString(i18n.language),
            })
          : t("callAgent.notConnected")}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={blocked || !state}
          variant={state?.shared ? "outline" : "default"}
          onClick={() =>
            void act(async () => {
              setState(
                await unwrap(state?.shared ? api.revoke({ callId }) : api.grant({ callId }))
              );
              setHandoff("");
            })
          }
        >
          {state?.shared ? t("callAgent.revoke") : t("callAgent.share")}
        </Button>
        <Button disabled={blocked} variant="outline" onClick={() => void act(refresh)}>
          {t("callAgent.refresh")}
        </Button>
        <Button
          disabled={blocked}
          variant="outline"
          onClick={() => void act(async () => setHandoff(await unwrap(api.handoff({ callId }))))}
        >
          {t("callAgent.previewHandoff")}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {state?.shared ? t("callAgent.sharedHelp") : t("callAgent.privateHelp")}
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {t("callAgent.actionFailed")}
        </p>
      )}
      {copied && (
        <p role="status" className="text-sm">
          {t("callAgent.copied")}
        </p>
      )}
      {filed && (
        <p role="status" className="text-sm">
          {t("callAgent.filed")}
        </p>
      )}
      {state && (
        <details className="rounded-md border border-border p-3">
          <summary className="cursor-pointer text-sm font-medium">
            {t("callAgent.configure")}
          </summary>
          <p className="my-3 text-xs text-muted-foreground">{t("callAgent.configHelp")}</p>
          {(
            [
              ["json", "callAgent.json"],
              ["codex", "callAgent.codex"],
              ["claude", "callAgent.claude"],
            ] as const
          ).map(([kind, key]) => (
            <div className="mb-3" key={kind}>
              <p className="text-xs font-semibold">{t(key)}</p>
              <pre className="my-2 max-h-56 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-3 text-xs">
                {state.configuration[kind]}
              </pre>
              <Button
                size="sm"
                variant="outline"
                disabled={blocked}
                onClick={() => void act(() => copy(state.configuration[kind]))}
              >
                {t("callAgent.copyConfig")}
              </Button>
            </div>
          ))}
        </details>
      )}
      {handoff && (
        <div className="rounded-md border border-border p-3">
          <h4 className="text-sm font-semibold">{t("callAgent.handoff")}</h4>
          <pre className="my-3 max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs">
            {handoff}
          </pre>
          <Button
            disabled={blocked}
            variant="outline"
            onClick={() =>
              void act(async () => {
                const latest = await unwrap(api.handoff({ callId }));
                setHandoff(latest);
                await copy(latest);
              })
            }
          >
            {t("callAgent.copyHandoff")}
          </Button>
          <p className="mt-2 text-xs text-muted-foreground">{t("callAgent.handoffHelp")}</p>
        </div>
      )}
      <div>
        <h4 className="mb-3 text-sm font-semibold">{t("callAgent.drafts")}</h4>
        <p className="mb-3 text-xs text-muted-foreground">{t("callAgent.draftHelp")}</p>
        {!state?.drafts.length && (
          <p className="text-sm text-muted-foreground">{t("callAgent.noDrafts")}</p>
        )}
        {state?.drafts.map((draft) => (
          <div
            key={draft.id}
            className="mb-2 flex flex-wrap items-center justify-between gap-3 rounded-md border border-border p-3"
          >
            <span className="min-w-0 break-words text-sm">{draft.title}</span>
            <Button
              size="sm"
              variant="outline"
              disabled={blocked}
              onClick={() =>
                void act(async () => {
                  await refresh();
                  setReview(await unwrap(api.getDraft({ draftId: draft.id })));
                })
              }
            >
              {t("callAgent.review")}
            </Button>
          </div>
        ))}
      </div>
      {review && (
        <article data-speech-source className="rounded-md border border-border p-4">
          <ReadAloud text={review.body} label={t("speech.draft")} />
          <h4 className="break-words text-base font-semibold">{review.title}</h4>
          <p className="mt-3 whitespace-pre-wrap break-words text-sm">{review.body}</p>
          <h5 className="mb-2 mt-5 text-xs font-semibold">{t("callAgent.evidence")}</h5>
          <p className="mb-3 break-all text-[11px] text-muted-foreground">
            {t("callAgent.evidenceSaved", {
              time: new Date(review.createdAt).toLocaleString(i18n.language),
            })}
          </p>
          {review.citations.map((c) => (
            <blockquote key={c.evidenceId} className="mb-3 border-l-2 border-border pl-3">
              <p className="text-xs text-muted-foreground">
                {c.start === null
                  ? t("callAgent.untimed")
                  : t("callAgent.timed", { start: c.start, end: c.end })}{" "}
                ·{" "}
                {t(
                  c.kind === "notes"
                    ? "callAgent.notes"
                    : c.kind === "original-transcript"
                      ? "callAgent.original"
                      : "callAgent.edited"
                )}
              </p>
              <p className="mt-1 whitespace-pre-wrap break-words text-sm">{c.quote}</p>
            </blockquote>
          ))}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              disabled={blocked || !folderId}
              onClick={() =>
                void act(async () => {
                  await unwrap(api.fileDraft({ draftId: review.id, folderId }));
                  setFiled(true);
                })
              }
            >
              {t("callAgent.file")}
            </Button>
            <Button variant="outline" disabled={blocked} onClick={() => setReview(null)}>
              {t("callAgent.close")}
            </Button>
          </div>
          {!folderId && (
            <p className="mt-2 text-xs text-muted-foreground">{t("callAgent.chooseFolder")}</p>
          )}
        </article>
      )}
    </section>
  );
}
