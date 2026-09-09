import React, { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Card, CardContent } from "./ui/card";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import {
  ChevronRight,
  ChevronLeft,
  Check,
  Mic,
  Shield,
  Command,
  Sparkles,
  Download,
  Footprints,
  AudioLines,
  Lock,
  Settings,
} from "lucide-react";
import TitleBar from "./TitleBar";
import WindowControls from "./WindowControls";
import PermissionCard from "./ui/PermissionCard";
import MicPermissionWarning from "./ui/MicPermissionWarning";
import PasteToolsInfo from "./ui/PasteToolsInfo";
import StepProgress from "./ui/StepProgress";
import { AlertDialog, ConfirmDialog } from "./ui/dialog";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useDialogs } from "../hooks/useDialogs";
import { usePermissions } from "../hooks/usePermissions";
import { useClipboard } from "../hooks/useClipboard";
import { useSettings } from "../hooks/useSettings";
import LanguageSelector from "./ui/LanguageSelector";
import { setAgentName as saveAgentName } from "../utils/agentName";
import { formatHotkeyLabel, getDefaultHotkey, isGlobeLikeHotkey } from "../utils/hotkeys";
import { HotkeyInput } from "./ui/HotkeyInput";
import { useHotkeyRegistration } from "../hooks/useHotkeyRegistration";
import { getValidationMessage } from "../utils/hotkeyValidator";
import { getPlatform } from "../utils/platform";
import logger from "../utils/logger";
import { ActivationModeSelector } from "./ui/ActivationModeSelector";
import TranscriptionModelPicker from "./TranscriptionModelPicker";
import { useSettingsStore } from "../stores/settingsStore";

interface OnboardingFlowProps {
  onComplete: () => void;
}

const POLISH_MODEL_ID = "qwen3-4b-instruct-2507-q4_k_m";
const MAX_STEP = 5;

// ---------------------------------------------------------------------------
// Step 3 — AI Polish setup
// ---------------------------------------------------------------------------
function PolishStep() {
  const { t } = useTranslation();
  const { useReasoningModel, setUseReasoningModel } = useSettings();
  const [modelDownloaded, setModelDownloaded] = useState<boolean | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const checkModel = useCallback(async () => {
    try {
      const result = await (window as any).electronAPI?.modelCheck?.(POLISH_MODEL_ID);
      const downloaded = !!(result?.downloaded ?? result?.isDownloaded ?? result);
      setModelDownloaded(downloaded);
      return downloaded;
    } catch {
      setModelDownloaded(false);
      return false;
    }
  }, []);

  useEffect(() => {
    checkModel();
  }, [checkModel]);

  useEffect(() => {
    const dispose = (window as any).electronAPI?.onModelDownloadProgress?.(
      (_event: unknown, data: any) => {
        const payload = data?.modelId ? data : _event;
        if (payload?.modelId && payload.modelId !== POLISH_MODEL_ID) return;
        const pct = payload?.progress ?? payload?.percent ?? 0;
        setProgress(Math.round(pct));
      }
    );
    return () => dispose?.();
  }, []);

  const enablePolish = useCallback(() => {
    const store = useSettingsStore.getState();
    store.setUseReasoningModel(true);
    store.setReasoningModel(POLISH_MODEL_ID);
    store.setReasoningProvider("local");
  }, []);

  const startDownload = useCallback(async () => {
    setDownloading(true);
    setDownloadError(null);
    setProgress(0);
    try {
      await (window as any).electronAPI?.modelDownload?.(POLISH_MODEL_ID);
      const ok = await checkModel();
      if (ok) enablePolish();
      else setDownloadError(t("onboarding.polish.downloadFailed", { defaultValue: "Download didn't complete. Check your connection and try again." }));
    } catch (error: any) {
      setDownloadError(error?.message || "Download failed");
    } finally {
      setDownloading(false);
    }
  }, [checkModel, enablePolish, t]);

  useEffect(() => {
    // If the model is already on disk, make sure polish is wired to it
    if (modelDownloaded) enablePolish();
  }, [modelDownloaded, enablePolish]);

  const before = "so um three things first finalize pricing second email the beta users and third uh update the docs";
  const after = "Three things:\n1. Finalize pricing.\n2. Email the beta users.\n3. Update the docs.";

  return (
    <div className="space-y-4 onb-stagger">
      <div className="text-center space-y-1">
        <h2 className="text-lg font-semibold text-foreground tracking-tight">
          {t("onboarding.polish.title", { defaultValue: "Writing that formats itself" })}
        </h2>
        <p className="text-xs text-muted-foreground max-w-md mx-auto">
          {t("onboarding.polish.description", {
            defaultValue:
              "ScottySpeaks rewrites raw speech into clean text — lists become lists, filler words vanish, \"scratch that\" actually scratches it. All on-device.",
          })}
        </p>
      </div>

      {/* Before / after */}
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-lg border border-border/60 bg-muted/40 p-3">
          <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground mb-1.5">
            {t("onboarding.polish.youSay", { defaultValue: "You say" })}
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed italic">“{before}”</p>
        </div>
        <div
          className="rounded-lg p-3 border border-border/60 bg-surface-1"
          style={{ boxShadow: "var(--shadow-card)" }}
        >
          <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground mb-1.5 flex items-center gap-1">
            <Sparkles className="w-3 h-3" />
            {t("onboarding.polish.itTypes", { defaultValue: "It types" })}
          </div>
          <pre className="text-xs text-foreground leading-relaxed whitespace-pre-wrap font-sans">{after}</pre>
        </div>
      </div>

      {/* Model card */}
      <div
        className="rounded-lg border border-border/60 p-4 flex items-center gap-4 transition-shadow"
        style={{ boxShadow: "var(--shadow-card)" }}
      >
        <div className="w-10 h-10 rounded-full bg-violet-500/10 flex items-center justify-center shrink-0">
          <Lock className="w-5 h-5 text-violet-500" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-foreground">
            {t("onboarding.polish.modelName", { defaultValue: "Qwen3 4B Instruct" })}
            <span className="ml-2 text-[10px] font-normal text-muted-foreground uppercase tracking-wide">
              {t("onboarding.polish.localBadge", { defaultValue: "runs on your Mac" })}
            </span>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t("onboarding.polish.modelDetail", {
              defaultValue: "2.5 GB · private, free, no internet needed after download",
            })}
          </p>
          {downloading && (
            <div className="mt-2 h-1.5 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full rounded-full bg-violet-500 transition-[width]"
                style={{ width: `${progress}%`, transitionTimingFunction: "var(--ease-smooth)" }}
              />
            </div>
          )}
          {downloadError && <p className="text-xs text-red-500 mt-1.5">{downloadError}</p>}
        </div>
        <div className="shrink-0">
          {modelDownloaded ? (
            <span className="onb-pop inline-flex items-center gap-1 text-xs font-medium text-emerald-600 bg-emerald-500/10 rounded-full px-2.5 py-1">
              <Check className="w-3.5 h-3.5" />
              {t("onboarding.polish.ready", { defaultValue: "Ready" })}
            </span>
          ) : (
            <Button
              size="sm"
              onClick={startDownload}
              disabled={downloading || modelDownloaded === null}
              className="press-tactile h-8 rounded-full text-xs px-4"
            >
              <Download className="w-3.5 h-3.5" />
              {downloading
                ? `${progress}%`
                : t("onboarding.polish.download", { defaultValue: "Download" })}
            </Button>
          )}
        </div>
      </div>

      {/* Enable toggle */}
      <label className="flex items-center justify-between rounded-lg border border-border/60 px-4 py-3 cursor-pointer press-tactile">
        <div>
          <div className="text-sm font-medium text-foreground">
            {t("onboarding.polish.enableTitle", { defaultValue: "Polish my dictation" })}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t("onboarding.polish.enableDetail", {
              defaultValue: "Short phrases paste instantly; longer thoughts get formatted. You can turn this off anytime.",
            })}
          </p>
        </div>
        <input
          type="checkbox"
          className="h-4 w-4 accent-violet-500"
          checked={useReasoningModel && !!modelDownloaded}
          disabled={!modelDownloaded}
          onChange={(e) => {
            if (e.target.checked) enablePolish();
            else setUseReasoningModel(false);
          }}
        />
      </label>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pedal card (step 4)
// ---------------------------------------------------------------------------
function PedalCard() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<any>(null);

  useEffect(() => {
    let mounted = true;
    (window as any).electronAPI
      ?.pedalGetStatus?.()
      .then((s: any) => mounted && setStatus(s))
      .catch(() => {});
    const dispose = (window as any).electronAPI?.onPedalStatusChanged?.((s: any) =>
      setStatus(s?.connected !== undefined ? s : null)
    );
    return () => {
      mounted = false;
      dispose?.();
    };
  }, []);

  if (!status?.supported) return null;

  const connected = !!status?.connected;
  const mappings: Record<string, string> = {
    toggle: t("onboarding.pedal.actionToggle", { defaultValue: "Tap to talk" }),
    hold: t("onboarding.pedal.actionHold", { defaultValue: "Hold to talk" }),
    command: t("onboarding.pedal.actionCommand", { defaultValue: "Voice command" }),
    off: t("onboarding.pedal.actionOff", { defaultValue: "Off" }),
  };

  return (
    <div
      className={`rounded-lg border p-4 transition-all ${
        connected ? "border-emerald-500/40 bg-emerald-500/[0.03]" : "border-dashed border-border/70"
      }`}
      style={connected ? { boxShadow: "var(--shadow-card)" } : undefined}
    >
      <div className="flex items-center gap-3 mb-1">
        <div
          className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${
            connected ? "bg-emerald-500/10" : "bg-muted"
          }`}
        >
          <Footprints className={`w-4.5 h-4.5 ${connected ? "text-emerald-600" : "text-muted-foreground"}`} />
        </div>
        <div className="flex-1">
          <div className="text-sm font-medium text-foreground flex items-center gap-2">
            {t("onboarding.pedal.title", { defaultValue: "Stream Deck Pedal" })}
            {connected && (
              <span className="onb-pop inline-flex items-center gap-1 text-[10px] font-medium text-emerald-600 bg-emerald-500/10 rounded-full px-2 py-0.5">
                <Check className="w-3 h-3" />
                {t("onboarding.pedal.connected", { defaultValue: "Connected" })}
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            {connected
              ? t("onboarding.pedal.connectedDetail", {
                  defaultValue: "Your pedal works alongside the keyboard shortcut — no setup needed.",
                })
              : t("onboarding.pedal.plugIn", {
                  defaultValue: "Have an Elgato pedal? Plug it in and it appears here automatically.",
                })}
          </p>
        </div>
      </div>

      {connected && (
        <div className="grid grid-cols-3 gap-1.5 mt-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="rounded-md bg-surface-1 border border-border/50 px-2 py-2 text-center">
              <div className="mx-auto mb-1.5 h-1 w-8 rounded-full bg-muted-foreground/30" />
              <div className="text-[11px] font-medium text-foreground leading-tight">
                {mappings[status?.config?.mappings?.[i] ?? "off"]}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------
export default function OnboardingFlow({ onComplete }: OnboardingFlowProps) {
  const { t } = useTranslation();

  const [currentStep, setCurrentStep, removeCurrentStep] = useLocalStorage(
    "onboardingCurrentStep",
    0,
    {
      serialize: String,
      deserialize: (value) => {
        const parsed = parseInt(value, 10);
        if (isNaN(parsed) || parsed < 0) return 0;
        return Math.min(parsed, MAX_STEP);
      },
    }
  );

  const {
    useLocalWhisper,
    whisperModel,
    localTranscriptionProvider,
    parakeetModel,
    cloudTranscriptionProvider,
    cloudTranscriptionModel,
    cloudTranscriptionBaseUrl,
    openaiApiKey,
    groqApiKey,
    mistralApiKey,
    customTranscriptionApiKey,
    setCustomTranscriptionApiKey,
    dictationKey,
    activationMode,
    setActivationMode,
    setDictationKey,
    setOpenaiApiKey,
    setGroqApiKey,
    setMistralApiKey,
    updateTranscriptionSettings,
    preferredLanguage,
  } = useSettings();

  const [hotkey, setHotkey] = useState(dictationKey || getDefaultHotkey());
  const [isModelDownloaded, setIsModelDownloaded] = useState(false);
  const [isUsingGnomeHotkeys, setIsUsingGnomeHotkeys] = useState(false);
  const [testTyped, setTestTyped] = useState(false);
  const readableHotkey = formatHotkeyLabel(hotkey);
  const { alertDialog, confirmDialog, showAlertDialog, hideAlertDialog, hideConfirmDialog } =
    useDialogs();

  const autoRegisterInFlightRef = useRef(false);
  const hotkeyStepInitializedRef = useRef(false);

  const { registerHotkey, isRegistering: isHotkeyRegistering } = useHotkeyRegistration({
    onSuccess: (registeredHotkey) => {
      setHotkey(registeredHotkey);
      setDictationKey(registeredHotkey);
    },
    showSuccessToast: false,
    showErrorToast: false,
  });

  const validateHotkeyForInput = useCallback(
    (hk: string) => getValidationMessage(hk, getPlatform()),
    []
  );

  const permissionsHook = usePermissions(showAlertDialog);
  useClipboard(showAlertDialog);

  const steps = [
    { title: t("onboarding.steps.welcome"), icon: AudioLines },
    { title: t("onboarding.steps.permissions"), icon: Shield },
    { title: t("onboarding.steps.setup"), icon: Settings },
    { title: t("onboarding.steps.polish", { defaultValue: "Polish" }), icon: Sparkles },
    { title: t("onboarding.steps.controls", { defaultValue: "Controls" }), icon: Command },
    { title: t("onboarding.steps.test", { defaultValue: "Try it" }), icon: Mic },
  ];

  const showProgress = currentStep > 0;
  const CONTROLS_STEP = 4;
  const TEST_STEP = 5;

  useEffect(() => {
    const checkHotkeyMode = async () => {
      try {
        const info = await window.electronAPI?.getHotkeyModeInfo();
        if (info?.isUsingGnome) {
          setIsUsingGnomeHotkeys(true);
          setActivationMode("tap");
        }
      } catch (error) {
        logger.error("Failed to check hotkey mode", { error }, "onboarding");
      }
    };
    checkHotkeyMode();
  }, [setActivationMode]);

  useEffect(() => {
    const modelToCheck = localTranscriptionProvider === "nvidia" ? parakeetModel : whisperModel;
    if (!useLocalWhisper || !modelToCheck) {
      setIsModelDownloaded(false);
      return;
    }

    const checkStatus = async () => {
      try {
        const result =
          localTranscriptionProvider === "nvidia"
            ? await window.electronAPI?.checkParakeetModelStatus(modelToCheck)
            : await window.electronAPI?.checkModelStatus(modelToCheck);
        setIsModelDownloaded(result?.downloaded ?? false);
      } catch (error) {
        logger.error("Failed to check model status", { error }, "onboarding");
        setIsModelDownloaded(false);
      }
    };

    checkStatus();
  }, [useLocalWhisper, whisperModel, parakeetModel, localTranscriptionProvider]);

  // Auto-register default hotkey when entering the controls step
  useEffect(() => {
    if (currentStep !== CONTROLS_STEP) {
      hotkeyStepInitializedRef.current = false;
      return;
    }
    if (autoRegisterInFlightRef.current || hotkeyStepInitializedRef.current) {
      return;
    }

    const autoRegisterDefaultHotkey = async () => {
      autoRegisterInFlightRef.current = true;
      hotkeyStepInitializedRef.current = true;
      try {
        const defaultHotkey = getDefaultHotkey();
        const platform = window.electronAPI?.getPlatform?.() ?? "darwin";
        const shouldAutoRegister =
          !hotkey || hotkey.trim() === "" || (platform !== "darwin" && isGlobeLikeHotkey(hotkey));
        if (shouldAutoRegister) {
          const success = await registerHotkey(defaultHotkey);
          if (success) setHotkey(defaultHotkey);
        }
      } catch (error) {
        logger.error("Failed to auto-register default hotkey", { error }, "onboarding");
      } finally {
        autoRegisterInFlightRef.current = false;
      }
    };

    void autoRegisterDefaultHotkey();
  }, [currentStep, hotkey, registerHotkey]);

  const ensureHotkeyRegistered = useCallback(async () => {
    if (!window.electronAPI?.updateHotkey) return true;
    try {
      const result = await window.electronAPI.updateHotkey(hotkey);
      if (result && !result.success) {
        showAlertDialog({
          title: t("onboarding.hotkey.couldNotRegisterTitle"),
          description: result.message || t("onboarding.hotkey.couldNotRegisterDescription"),
        });
        return false;
      }
      return true;
    } catch (error) {
      logger.error("Failed to register onboarding hotkey", { error }, "onboarding");
      showAlertDialog({
        title: t("onboarding.hotkey.couldNotRegisterTitle"),
        description: t("onboarding.hotkey.couldNotRegisterDescription"),
      });
      return false;
    }
  }, [hotkey, showAlertDialog, t]);

  const saveSettings = useCallback(async () => {
    const hotkeyRegistered = await ensureHotkeyRegistered();
    if (!hotkeyRegistered) return false;
    setDictationKey(hotkey);
    saveAgentName("ScottySpeaks");
    localStorage.setItem("onboardingCompleted", "true");
    try {
      await window.electronAPI?.saveAllKeysToEnv?.();
    } catch (error) {
      logger.error("Failed to persist API keys", { error }, "onboarding");
    }
    return true;
  }, [hotkey, setDictationKey, ensureHotkeyRegistered]);

  const nextStep = useCallback(async () => {
    if (currentStep >= steps.length - 1) return;
    const newStep = currentStep + 1;
    setCurrentStep(newStep);
    if (newStep === TEST_STEP) {
      window.electronAPI?.showDictationPanel?.();
    }
  }, [currentStep, setCurrentStep, steps.length]);

  const prevStep = useCallback(() => {
    if (currentStep > 0) setCurrentStep(currentStep - 1);
  }, [currentStep, setCurrentStep]);

  const finishOnboarding = useCallback(async () => {
    const saved = await saveSettings();
    if (!saved) return;
    removeCurrentStep();
    onComplete();
  }, [saveSettings, removeCurrentStep, onComplete]);

  const platform = permissionsHook.pasteToolsInfo?.platform;
  const isMacOS = platform === "darwin";

  const renderStep = () => {
    switch (currentStep) {
      case 0: // Welcome
        return (
          <div className="text-center space-y-6 py-4 onb-stagger">
            <div className="mx-auto w-16 h-16 rounded-2xl bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center" style={{ boxShadow: "var(--shadow-lift)" }}>
              <AudioLines className="w-8 h-8 text-white" />
            </div>
            <div className="space-y-2">
              <h1 className="text-2xl font-semibold text-foreground tracking-tight">
                {t("onboarding.welcome.title", { defaultValue: "Speak. It types — polished." })}
              </h1>
              <p className="text-sm text-muted-foreground max-w-sm mx-auto leading-relaxed">
                {t("onboarding.welcome.subtitle", {
                  defaultValue:
                    "ScottySpeaks turns your voice into clean, formatted writing in any app. Private, on-device, and free.",
                })}
              </p>
            </div>
            <div className="flex items-center justify-center gap-5 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <Lock className="w-3.5 h-3.5" />
                {t("onboarding.welcome.local", { defaultValue: "100% local" })}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5" />
                {t("onboarding.welcome.formats", { defaultValue: "Formats itself" })}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Footprints className="w-3.5 h-3.5" />
                {t("onboarding.welcome.pedal", { defaultValue: "Pedal ready" })}
              </span>
            </div>
            <Button
              onClick={nextStep}
              className="press-tactile h-10 px-8 rounded-full text-sm font-medium"
            >
              {t("onboarding.welcome.cta", { defaultValue: "Set up in 2 minutes" })}
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        );

      case 1: // Permissions
        return (
          <div className="space-y-4 onb-stagger">
            <div className="text-center">
              <h2 className="text-lg font-semibold text-foreground tracking-tight">
                {t("onboarding.permissions.title")}
              </h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                {isMacOS
                  ? t("onboarding.permissions.requiredForApp")
                  : t("onboarding.permissions.microphoneRequired")}
              </p>
            </div>

            <div className="space-y-1.5">
              <PermissionCard
                icon={Mic}
                title={t("onboarding.permissions.microphoneTitle")}
                description={t("onboarding.permissions.microphoneDescription")}
                granted={permissionsHook.micPermissionGranted}
                onRequest={permissionsHook.requestMicPermission}
                buttonText={t("onboarding.permissions.grant")}
              />

              {isMacOS && (
                <PermissionCard
                  icon={Shield}
                  title={t("onboarding.permissions.accessibilityTitle")}
                  description={t("onboarding.permissions.accessibilityDescription")}
                  granted={permissionsHook.accessibilityPermissionGranted}
                  onRequest={permissionsHook.testAccessibilityPermission}
                  buttonText={t("onboarding.permissions.testAndGrant")}
                  onOpenSettings={permissionsHook.openAccessibilitySettings}
                />
              )}
            </div>

            {!permissionsHook.micPermissionGranted && permissionsHook.micPermissionError && (
              <MicPermissionWarning
                error={permissionsHook.micPermissionError}
                onOpenSoundSettings={permissionsHook.openSoundInputSettings}
                onOpenPrivacySettings={permissionsHook.openMicPrivacySettings}
              />
            )}

            {platform === "linux" &&
              permissionsHook.pasteToolsInfo &&
              !permissionsHook.pasteToolsInfo.available && (
                <PasteToolsInfo
                  pasteToolsInfo={permissionsHook.pasteToolsInfo}
                  isChecking={permissionsHook.isCheckingPasteTools}
                  onCheck={permissionsHook.checkPasteToolsAvailability}
                />
              )}
          </div>
        );

      case 2: // Transcription engine
        return (
          <div className="space-y-3 onb-stagger">
            <div className="text-center space-y-0.5">
              <h2 className="text-lg font-semibold text-foreground tracking-tight">
                {t("onboarding.transcription.title")}
              </h2>
              <p className="text-xs text-muted-foreground">
                {t("onboarding.transcription.description")}
              </p>
            </div>

            <TranscriptionModelPicker
              selectedCloudProvider={cloudTranscriptionProvider}
              onCloudProviderSelect={(provider) =>
                updateTranscriptionSettings({ cloudTranscriptionProvider: provider })
              }
              selectedCloudModel={cloudTranscriptionModel}
              onCloudModelSelect={(model) =>
                updateTranscriptionSettings({ cloudTranscriptionModel: model })
              }
              selectedLocalModel={
                localTranscriptionProvider === "nvidia" ? parakeetModel : whisperModel
              }
              onLocalModelSelect={(modelId) => {
                if (localTranscriptionProvider === "nvidia") {
                  updateTranscriptionSettings({ parakeetModel: modelId });
                } else {
                  updateTranscriptionSettings({ whisperModel: modelId });
                }
              }}
              selectedLocalProvider={localTranscriptionProvider}
              onLocalProviderSelect={(provider) =>
                updateTranscriptionSettings({
                  localTranscriptionProvider: provider as "whisper" | "nvidia",
                })
              }
              useLocalWhisper={useLocalWhisper}
              onModeChange={(isLocal) => updateTranscriptionSettings({ useLocalWhisper: isLocal })}
              openaiApiKey={openaiApiKey}
              setOpenaiApiKey={setOpenaiApiKey}
              groqApiKey={groqApiKey}
              setGroqApiKey={setGroqApiKey}
              mistralApiKey={mistralApiKey}
              setMistralApiKey={setMistralApiKey}
              customTranscriptionApiKey={customTranscriptionApiKey}
              setCustomTranscriptionApiKey={setCustomTranscriptionApiKey}
              cloudTranscriptionBaseUrl={cloudTranscriptionBaseUrl}
              setCloudTranscriptionBaseUrl={(url) =>
                updateTranscriptionSettings({ cloudTranscriptionBaseUrl: url })
              }
              variant="onboarding"
            />

            <div className="space-y-2 p-3 bg-muted/50 border border-border/60 rounded">
              <label className="block text-xs font-medium text-muted-foreground">
                {t("onboarding.transcription.preferredLanguage")}
              </label>
              <LanguageSelector
                value={preferredLanguage}
                onChange={(value) => {
                  updateTranscriptionSettings({ preferredLanguage: value });
                }}
                className="w-full"
              />
            </div>
          </div>
        );

      case 3: // AI Polish
        return <PolishStep />;

      case 4: // Controls: hotkey + mode + pedal
        return (
          <div className="space-y-4 onb-stagger">
            <div className="text-center space-y-0.5">
              <h2 className="text-lg font-semibold text-foreground tracking-tight">
                {t("onboarding.activation.title")}
              </h2>
              <p className="text-xs text-muted-foreground">
                {t("onboarding.activation.description")}
              </p>
            </div>

            <div
              className="rounded-lg border border-border-subtle bg-surface-1 overflow-hidden"
              style={{ boxShadow: "var(--shadow-card)" }}
            >
              <div className="p-4 border-b border-border-subtle">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    {t("onboarding.activation.hotkey")}
                  </span>
                </div>
                <HotkeyInput
                  value={hotkey}
                  onChange={async (newHotkey) => {
                    const success = await registerHotkey(newHotkey);
                    if (success) setHotkey(newHotkey);
                  }}
                  disabled={isHotkeyRegistering}
                  variant="hero"
                  validate={validateHotkeyForInput}
                />
              </div>

              {!isUsingGnomeHotkeys && (
                <div className="p-4 flex items-center justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                      {t("onboarding.activation.mode")}
                    </span>
                    <p className="text-xs text-muted-foreground/70 mt-0.5">
                      {activationMode === "tap"
                        ? t("onboarding.activation.tapDescription")
                        : t("onboarding.activation.holdDescription")}
                    </p>
                  </div>
                  <ActivationModeSelector
                    value={activationMode}
                    onChange={setActivationMode}
                    variant="compact"
                  />
                </div>
              )}
            </div>

            <PedalCard />
          </div>
        );

      case 5: // Try it
        return (
          <div className="space-y-4 onb-stagger">
            <div className="text-center space-y-0.5">
              <h2 className="text-lg font-semibold text-foreground tracking-tight">
                {t("onboarding.test.title", { defaultValue: "Take it for a spin" })}
              </h2>
              <p className="text-xs text-muted-foreground max-w-md mx-auto">
                {activationMode === "tap" || isUsingGnomeHotkeys
                  ? t("onboarding.activation.hotkeyToStartStop", { hotkey: readableHotkey })
                  : t("onboarding.activation.holdHotkey", { hotkey: readableHotkey })}
              </p>
            </div>

            <div className="rounded-lg border border-border/60 bg-muted/30 p-3">
              <p className="text-xs text-muted-foreground leading-relaxed">
                {t("onboarding.test.suggestion", {
                  defaultValue:
                    "Try saying: \"I need three things from the store first milk second eggs and third coffee\" — watch it become a list.",
                })}
              </p>
            </div>

            <Textarea
              rows={5}
              placeholder={t("onboarding.activation.textareaPlaceholder")}
              className="text-sm resize-none"
              onChange={(e) => setTestTyped(e.target.value.trim().length > 0)}
            />

            {testTyped && (
              <div className="onb-pop flex items-center justify-center gap-2 text-sm font-medium text-emerald-600">
                <span className="w-6 h-6 rounded-full bg-emerald-500/10 flex items-center justify-center">
                  <Check className="w-4 h-4" />
                </span>
                {t("onboarding.test.success", {
                  defaultValue: "That's it — you're ready. It works like this in every app.",
                })}
              </div>
            )}
          </div>
        );

      default:
        return null;
    }
  };

  const canProceed = () => {
    switch (currentStep) {
      case 0:
        return true;
      case 1: {
        if (!permissionsHook.micPermissionGranted) return false;
        if (isMacOS) return permissionsHook.accessibilityPermissionGranted;
        return true;
      }
      case 2: {
        if (useLocalWhisper) {
          const modelToCheck =
            localTranscriptionProvider === "nvidia" ? parakeetModel : whisperModel;
          return modelToCheck !== "" && isModelDownloaded;
        }
        if (cloudTranscriptionProvider === "openai") return openaiApiKey.trim().length > 0;
        if (cloudTranscriptionProvider === "groq") return groqApiKey.trim().length > 0;
        if (cloudTranscriptionProvider === "mistral") return mistralApiKey.trim().length > 0;
        if (cloudTranscriptionProvider === "custom") return true;
        return openaiApiKey.trim().length > 0;
      }
      case 3:
        return true; // polish is optional
      case 4:
        return hotkey.trim() !== "";
      case 5:
        return true;
      default:
        return false;
    }
  };

  const onboardingPlatform =
    typeof window !== "undefined" && window.electronAPI?.getPlatform
      ? window.electronAPI.getPlatform()
      : "darwin";

  return (
    <div
      className="h-screen flex flex-col bg-background"
      style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
    >
      <ConfirmDialog
        open={confirmDialog.open}
        onOpenChange={(open) => !open && hideConfirmDialog()}
        title={confirmDialog.title}
        description={confirmDialog.description}
        confirmText={confirmDialog.confirmText}
        cancelText={confirmDialog.cancelText}
        onConfirm={confirmDialog.onConfirm}
      />

      <AlertDialog
        open={alertDialog.open}
        onOpenChange={(open) => !open && hideAlertDialog()}
        title={alertDialog.title}
        description={alertDialog.description}
        onOk={() => {}}
      />

      {currentStep === 0 ? (
        <div
          className="flex items-center justify-end w-full h-10 shrink-0"
          style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
        >
          {onboardingPlatform !== "darwin" && (
            <div className="pr-1" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
              <WindowControls />
            </div>
          )}
        </div>
      ) : (
        <div className="shrink-0 z-10">
          <TitleBar
            showTitle={true}
            className="bg-background backdrop-blur-xl border-b border-border shadow-sm"
          ></TitleBar>
        </div>
      )}

      {showProgress && (
        <div className="shrink-0 bg-background/80 backdrop-blur-2xl border-b border-white/5 px-6 md:px-12 py-3 z-10">
          <div className="max-w-3xl mx-auto">
            <StepProgress steps={steps.slice(1)} currentStep={currentStep - 1} />
          </div>
        </div>
      )}

      <div
        className={`flex-1 px-6 md:px-12 overflow-y-auto ${currentStep === 0 ? "flex items-center" : "py-6"}`}
      >
        <div className={`w-full ${currentStep === 0 ? "max-w-md" : "max-w-3xl"} mx-auto`}>
          <Card
            className="bg-card/90 backdrop-blur-2xl border border-border/50 dark:border-white/5 rounded-xl overflow-hidden"
            style={{ boxShadow: "var(--shadow-lift)" }}
          >
            <CardContent className={currentStep === 0 ? "p-8" : "p-6 md:p-8"}>
              {/* key remounts step content so entrances replay */}
              <div key={currentStep}>{renderStep()}</div>
            </CardContent>
          </Card>
        </div>
      </div>

      {showProgress && (
        <div className="shrink-0 bg-background/80 backdrop-blur-2xl border-t border-white/5 px-6 md:px-12 py-3 z-10">
          <div className="max-w-3xl mx-auto flex items-center justify-between">
            <Button
              onClick={prevStep}
              variant="outline"
              disabled={currentStep === 0}
              className="press-tactile h-8 px-5 rounded-full text-xs"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
              {t("common.back")}
            </Button>

            <div className="flex items-center gap-2">
              {currentStep === steps.length - 1 ? (
                <Button
                  onClick={finishOnboarding}
                  disabled={!canProceed()}
                  variant="success"
                  className="press-tactile h-8 px-6 rounded-full text-xs"
                >
                  <Check className="w-3.5 h-3.5" />
                  {t("common.complete")}
                </Button>
              ) : (
                <Button
                  onClick={nextStep}
                  disabled={!canProceed()}
                  className="press-tactile h-8 px-6 rounded-full text-xs"
                >
                  {t("common.next")}
                  <ChevronRight className="w-3.5 h-3.5" />
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
