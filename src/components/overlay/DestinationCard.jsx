import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import "./destinationCard.css";
import { formatElapsed } from "./overlayState";

/** Progress bars: listen → transcribe → polish. */
const STEPS = {
  listening: ["on", "", ""],
  transcribing: ["done", "on", ""],
  polishing: ["done", "done", "on"],
  pasted: ["done", "done", "done"],
  clipboard: ["done", "done", "done"],
  manual: ["done", "done", "done"],
};

/**
 * Overlay v2, Direction B: says where the text is going before you finish,
 * shows a live level meter and timer, and ends with what happened.
 */
export default function DestinationCard({
  state,
  targetApp,
  levels,
  startedAt,
  outcome,
  isHandsFree,
  pasteAgainLabel,
  leaving,
  onCancel,
  onPasteRaw,
  onDismiss,
  onPointerInside,
}) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());
  const [frozenAt, setFrozenAt] = useState(null);

  // Tick the timer while listening; freeze it when the take ends.
  useEffect(() => {
    if (state !== "listening") {
      setFrozenAt((previous) => previous ?? Date.now());
      return;
    }
    setFrozenAt(null);
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [state]);

  const elapsed = startedAt ? (frozenAt ?? now) - startedAt : 0;
  const app = outcome?.app || targetApp;
  const live = state === "listening";
  const steps = STEPS[state] || ["", "", ""];

  const what = {
    listening: t("overlay.stage.listening"),
    transcribing: t("overlay.stage.transcribing"),
    polishing: t("overlay.stage.polishing"),
    pasted: t("overlay.stage.done"),
    clipboard: t("overlay.stage.notPasted"),
    manual: t("overlay.stage.notPasted"),
    cancelled: t("overlay.stage.cancelled"),
    failed: t("overlay.stage.failed"),
  }[state];

  return (
    <div
      className={`ss2-card${leaving ? " is-leaving" : ""}`}
      data-state={state}
      onMouseEnter={() => onPointerInside?.(true)}
      onMouseLeave={() => onPointerInside?.(false)}
    >
      <div className="ss2-card__row1">
        <span className="ss2-card__dest">
          {app ? (
            <>
              <span className="ss2-card__appic" aria-hidden="true">
                {app.trim().charAt(0).toUpperCase()}
              </span>
              <span>
                {t("overlay.into")} <b>{app}</b>
              </span>
            </>
          ) : (
            <span>{t("overlay.dictating")}</span>
          )}
        </span>
        {isHandsFree && live && <span className="ss2-card__chip">{t("overlay.handsFree")}</span>}
        <span className="ss2-card__time" aria-label={t("overlay.elapsed")}>
          {formatElapsed(elapsed)}
        </span>
      </div>

      <div className={`ss2-card__wave${live ? " is-live" : ""}`} aria-hidden="true">
        {levels.map((level, index) => (
          <i key={index} style={{ height: `${Math.round(3 + (live ? level : 0) * 28)}px` }} />
        ))}
      </div>

      <div className="ss2-card__stage">
        <span className="ss2-card__steps" aria-hidden="true">
          {steps.map((step, index) => (
            <i key={index} className={step ? `is-${step}` : ""} />
          ))}
        </span>
        <span className="ss2-card__what" role="status" aria-live="polite">
          {what}
        </span>
        <span className="ss2-card__acts">
          {state === "polishing" && (
            <button type="button" className="ss2-card__btn is-primary" onClick={onPasteRaw}>
              {t("overlay.pasteRaw")} <kbd>Esc</kbd>
            </button>
          )}
          {(state === "listening" || state === "transcribing") && (
            <button type="button" className="ss2-card__btn" onClick={onCancel}>
              {t("overlay.cancel")} <kbd>Esc</kbd>
            </button>
          )}
        </span>
      </div>

      {state === "pasted" && (
        <div className="ss2-card__note is-ok">
          <b>{app ? t("overlay.pastedInto", { app }) : t("overlay.pasted")}</b>
          {" · "}
          {t("overlay.words", { count: outcome?.words || 0 })}
          {pasteAgainLabel ? <> {t("overlay.pasteAgain", { hotkey: pasteAgainLabel })}</> : null}
        </div>
      )}
      {(state === "clipboard" || state === "manual") && (
        <div className="ss2-card__note is-amber">
          <b>{state === "clipboard" ? t("overlay.clipboardTitle") : t("overlay.manualTitle")}</b>{" "}
          {state === "clipboard"
            ? app
              ? t("overlay.clipboardBody", { app, reason: outcome?.reason })
              : t("overlay.clipboardBodyNoApp", { reason: outcome?.reason })
            : t("overlay.manualBody", { reason: outcome?.reason })}
          <button type="button" className="ss2-card__btn" onClick={onDismiss}>
            {t("overlay.gotIt")}
          </button>
        </div>
      )}
      {state === "failed" && (
        <div className="ss2-card__note is-error">
          <b>{outcome?.title}</b> {outcome?.description}
          <button type="button" className="ss2-card__btn" onClick={onDismiss}>
            {t("overlay.gotIt")}
          </button>
        </div>
      )}
      {state === "cancelled" && (
        <div className="ss2-card__note is-quiet">{t("overlay.cancelledBody")}</div>
      )}
    </div>
  );
}
