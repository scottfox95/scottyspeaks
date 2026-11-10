import { useSettingsStore } from "../stores/settingsStore";
import React, { useState, useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Badge } from "./ui/badge";
import {
  RefreshCw,
  Download,
  Mic,
  Shield,
  FolderOpen,
  Sun,
  Moon,
  Monitor,
} from "lucide-react";
import MicPermissionWarning from "./ui/MicPermissionWarning";
import MicrophoneSettings from "./ui/MicrophoneSettings";
import PermissionCard from "./ui/PermissionCard";
import TranscriptionModelPicker from "./TranscriptionModelPicker";
import { ConfirmDialog, AlertDialog } from "./ui/dialog";
import { useSettings } from "../hooks/useSettings";
import { useDialogs } from "../hooks/useDialogs";
import { useAgentName } from "../utils/agentName";
import { useWhisper } from "../hooks/useWhisper";
import { usePermissions } from "../hooks/usePermissions";
import { useClipboard } from "../hooks/useClipboard";
import { useUpdater } from "../hooks/useUpdater";

import PromptStudio from "./ui/PromptStudio";
import ReasoningModelSelector from "./ReasoningModelSelector";
import { HotkeyInput } from "./ui/HotkeyInput";
import { useHotkeyRegistration } from "../hooks/useHotkeyRegistration";
import { getValidationMessage } from "../utils/hotkeyValidator";
import { getPlatform, getCachedPlatform } from "../utils/platform";
import { getDefaultHotkey, formatHotkeyLabel } from "../utils/hotkeys";
import { ActivationModeSelector } from "./ui/ActivationModeSelector";
import PedalSettings from "./PedalSettings";
import DiagnosticsPanel from "./DiagnosticsPanel";
import { Toggle } from "./ui/toggle";
import DeveloperSection from "./DeveloperSection";
import LanguageSelector from "./ui/LanguageSelector";
import { useToast } from "./ui/Toast";
import { useTheme } from "../hooks/useTheme";
import type { LocalTranscriptionProvider } from "../types/electron";
import logger from "../utils/logger";
import { SettingsRow } from "./ui/SettingsSection";
import PasteLastHotkeySetting from "./PasteLastHotkeySetting";

export type SettingsSectionType =
  | "general"
  | "hotkeys"
  | "transcription"
  | "intelligence"
  | "privacyData"
  | "system"
  | "dictionary"
  | "aiModels"
  | "agentConfig"
  | "prompts";

interface SettingsPageProps {
  activeSection?: SettingsSectionType;
}

const UI_LANGUAGE_OPTIONS: import("./ui/LanguageSelector").LanguageOption[] = [
  { value: "en", label: "English", flag: "🇺🇸" },
  { value: "es", label: "Español", flag: "🇪🇸" },
  { value: "fr", label: "Français", flag: "🇫🇷" },
  { value: "de", label: "Deutsch", flag: "🇩🇪" },
  { value: "pt", label: "Português", flag: "🇵🇹" },
  { value: "it", label: "Italiano", flag: "🇮🇹" },
  { value: "ru", label: "Русский", flag: "🇷🇺" },
  { value: "ja", label: "日本語", flag: "🇯🇵" },
  { value: "zh-CN", label: "简体中文", flag: "🇨🇳" },
  { value: "zh-TW", label: "繁體中文", flag: "🇹🇼" },
];

function SettingsPanel({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-lg border border-border/50 dark:border-border-subtle/70 bg-card/50 dark:bg-surface-2/50 backdrop-blur-sm divide-y divide-border/30 dark:divide-border-subtle/50 ${className}`}
    >
      {children}
    </div>
  );
}

function SettingsPanelRow({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={`px-4 py-3 ${className}`}>{children}</div>;
}

function SectionHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div className="mb-3">
      <h3 className="text-xs font-semibold text-foreground tracking-tight">{title}</h3>
      {description && (
        <p className="text-xs text-muted-foreground/80 mt-0.5 leading-relaxed">{description}</p>
      )}
    </div>
  );
}

interface TranscriptionSectionProps {
  useLocalWhisper: boolean;
  setUseLocalWhisper: (value: boolean) => void;
  updateTranscriptionSettings: (settings: { useLocalWhisper: boolean }) => void;
  cloudTranscriptionProvider: string;
  setCloudTranscriptionProvider: (provider: string) => void;
  cloudTranscriptionModel: string;
  setCloudTranscriptionModel: (model: string) => void;
  localTranscriptionProvider: string;
  setLocalTranscriptionProvider: (provider: LocalTranscriptionProvider) => void;
  whisperModel: string;
  setWhisperModel: (model: string) => void;
  parakeetModel: string;
  setParakeetModel: (model: string) => void;
  openaiApiKey: string;
  setOpenaiApiKey: (key: string) => void;
  groqApiKey: string;
  setGroqApiKey: (key: string) => void;
  mistralApiKey: string;
  setMistralApiKey: (key: string) => void;
  customTranscriptionApiKey: string;
  setCustomTranscriptionApiKey: (key: string) => void;
  cloudTranscriptionBaseUrl?: string;
  setCloudTranscriptionBaseUrl: (url: string) => void;
}

function TranscriptionSection({
  useLocalWhisper,
  setUseLocalWhisper,
  updateTranscriptionSettings,
  cloudTranscriptionProvider,
  setCloudTranscriptionProvider,
  cloudTranscriptionModel,
  setCloudTranscriptionModel,
  localTranscriptionProvider,
  setLocalTranscriptionProvider,
  whisperModel,
  setWhisperModel,
  parakeetModel,
  setParakeetModel,
  openaiApiKey,
  setOpenaiApiKey,
  groqApiKey,
  setGroqApiKey,
  mistralApiKey,
  setMistralApiKey,
  customTranscriptionApiKey,
  setCustomTranscriptionApiKey,
  cloudTranscriptionBaseUrl,
  setCloudTranscriptionBaseUrl,
}: TranscriptionSectionProps) {
  const { t } = useTranslation();

  return (
    <div className="space-y-4">
      <SectionHeader
        title={t("settingsPage.transcription.title")}
        description={t("settingsPage.transcription.description")}
      />

      <TranscriptionModelPicker
        selectedCloudProvider={cloudTranscriptionProvider}
        onCloudProviderSelect={setCloudTranscriptionProvider}
        selectedCloudModel={cloudTranscriptionModel}
        onCloudModelSelect={setCloudTranscriptionModel}
        selectedLocalModel={localTranscriptionProvider === "nvidia" ? parakeetModel : whisperModel}
        onLocalModelSelect={(modelId) => {
          if (localTranscriptionProvider === "nvidia") {
            setParakeetModel(modelId);
          } else {
            setWhisperModel(modelId);
          }
        }}
        selectedLocalProvider={localTranscriptionProvider}
        onLocalProviderSelect={setLocalTranscriptionProvider}
        useLocalWhisper={useLocalWhisper}
        onModeChange={(isLocal) => {
          setUseLocalWhisper(isLocal);
          updateTranscriptionSettings({ useLocalWhisper: isLocal });
        }}
        openaiApiKey={openaiApiKey}
        setOpenaiApiKey={setOpenaiApiKey}
        groqApiKey={groqApiKey}
        setGroqApiKey={setGroqApiKey}
        mistralApiKey={mistralApiKey}
        setMistralApiKey={setMistralApiKey}
        customTranscriptionApiKey={customTranscriptionApiKey}
        setCustomTranscriptionApiKey={setCustomTranscriptionApiKey}
        cloudTranscriptionBaseUrl={cloudTranscriptionBaseUrl}
        setCloudTranscriptionBaseUrl={setCloudTranscriptionBaseUrl}
        variant="settings"
      />
    </div>
  );
}

export function DictationCleanupControls() {
  const { t } = useTranslation();
  const cleanup = useSettingsStore();
  return (
    <>
      {(
        [
          "dictationExact",
          "dictationRemoveFillers",
          "dictationResolveCorrections",
          "dictationPreserveTechnical",
        ] as const
      ).map((key) => (
        <SettingsPanelRow key={key}>
          <SettingsRow
            label={t(`dictationCleanup.${key}.label`)}
            description={t(`dictationCleanup.${key}.description`)}
          >
            <Toggle
              ariaLabel={t(`dictationCleanup.${key}.label`)}
              checked={cleanup[key]}
              disabled={key !== "dictationExact" && cleanup.dictationExact}
              onChange={(value) => {
                const setters = {
                  dictationExact: cleanup.setDictationExact,
                  dictationRemoveFillers: cleanup.setDictationRemoveFillers,
                  dictationResolveCorrections: cleanup.setDictationResolveCorrections,
                  dictationPreserveTechnical: cleanup.setDictationPreserveTechnical,
                };
                setters[key](value);
              }}
            />
          </SettingsRow>
        </SettingsPanelRow>
      ))}
    </>
  );
}

interface AiModelsSectionProps {
  useReasoningModel: boolean;
  setUseReasoningModel: (value: boolean) => void;
  reasoningModel: string;
  setReasoningModel: (model: string) => void;
  reasoningProvider: string;
  setReasoningProvider: (provider: string) => void;
  cloudReasoningBaseUrl: string;
  setCloudReasoningBaseUrl: (url: string) => void;
  openaiApiKey: string;
  setOpenaiApiKey: (key: string) => void;
  anthropicApiKey: string;
  setAnthropicApiKey: (key: string) => void;
  geminiApiKey: string;
  setGeminiApiKey: (key: string) => void;
  groqApiKey: string;
  setGroqApiKey: (key: string) => void;
  customReasoningApiKey: string;
  setCustomReasoningApiKey: (key: string) => void;
}

function AiModelsSection({
  useReasoningModel,
  setUseReasoningModel,
  reasoningModel,
  setReasoningModel,
  reasoningProvider,
  setReasoningProvider,
  cloudReasoningBaseUrl,
  setCloudReasoningBaseUrl,
  openaiApiKey,
  setOpenaiApiKey,
  anthropicApiKey,
  setAnthropicApiKey,
  geminiApiKey,
  setGeminiApiKey,
  groqApiKey,
  setGroqApiKey,
  customReasoningApiKey,
  setCustomReasoningApiKey,
}: AiModelsSectionProps) {
  const { t } = useTranslation();

  return (
    <div className="space-y-4">
      <SectionHeader
        title={t("settingsPage.aiModels.title")}
        description={t("settingsPage.aiModels.description")}
      />

      {/* Enable toggle — always at top */}
      <SettingsPanel>
        <SettingsPanelRow>
          <SettingsRow
            label={t("dictationCleanup.aiRefinement.label")}
            description={t("dictationCleanup.aiRefinement.description")}
          >
            <Toggle checked={useReasoningModel} onChange={setUseReasoningModel} />
          </SettingsRow>
        </SettingsPanelRow>

        <DictationCleanupControls />
      </SettingsPanel>

      {useReasoningModel && (
        <ReasoningModelSelector
          reasoningModel={reasoningModel}
          setReasoningModel={setReasoningModel}
          localReasoningProvider={reasoningProvider}
          setLocalReasoningProvider={setReasoningProvider}
          cloudReasoningBaseUrl={cloudReasoningBaseUrl}
          setCloudReasoningBaseUrl={setCloudReasoningBaseUrl}
          openaiApiKey={openaiApiKey}
          setOpenaiApiKey={setOpenaiApiKey}
          anthropicApiKey={anthropicApiKey}
          setAnthropicApiKey={setAnthropicApiKey}
          geminiApiKey={geminiApiKey}
          setGeminiApiKey={setGeminiApiKey}
          groqApiKey={groqApiKey}
          setGroqApiKey={setGroqApiKey}
          customReasoningApiKey={customReasoningApiKey}
          setCustomReasoningApiKey={setCustomReasoningApiKey}
        />
      )}
    </div>
  );
}

// Mouse button as secondary dictation trigger (macOS only)
function MouseButtonSetting() {
  const [buttonNumber, setButtonNumber] = useState<number>(-1);
  const [isCapturing, setIsCapturing] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    window.electronAPI?.getMouseButton?.().then((b) => {
      setButtonNumber(typeof b === "number" ? b : -1);
      setLoaded(true);
    });
  }, []);

  useEffect(() => {
    if (!isCapturing) return;
    const dispose = window.electronAPI?.onMouseButtonPressed?.((button: number) => {
      setButtonNumber(button);
      setIsCapturing(false);
      window.electronAPI?.setMouseButton?.(button);
    });
    return () => {
      dispose?.();
    };
  }, [isCapturing]);

  const isEnabled = buttonNumber >= 0;

  const BUTTON_LABELS: Record<number, string> = {
    2: "Middle Click",
    3: "Mouse Button 4",
    4: "Mouse Button 5",
  };
  const label =
    BUTTON_LABELS[buttonNumber] || (isEnabled ? `Mouse Button ${buttonNumber + 1}` : "");

  if (!loaded) return null;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {isEnabled ? (
            <kbd className="px-2.5 py-1 bg-surface-raised border border-border rounded-sm text-xs font-semibold text-foreground">
              {label}
            </kbd>
          ) : (
            <span className="text-xs text-muted-foreground">No mouse button configured</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {isCapturing ? (
            <span className="flex items-center gap-1.5 text-xs text-primary">
              <span className="w-1.5 h-1.5 bg-primary rounded-full animate-pulse" />
              Press a mouse button...
            </span>
          ) : (
            <>
              <button
                onClick={() => setIsCapturing(true)}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                {isEnabled ? "Change" : "Assign button"}
              </button>
              {isEnabled && (
                <button
                  onClick={() => {
                    setButtonNumber(-1);
                    window.electronAPI?.setMouseButton?.(-1);
                  }}
                  className="text-xs text-muted-foreground/60 hover:text-destructive transition-colors"
                >
                  Remove
                </button>
              )}
            </>
          )}
        </div>
      </div>
      <p className="text-xs text-muted-foreground/60">
        Works alongside your keyboard hotkey. Supports hold-to-speak, tap, and double-tap
        hands-free.
      </p>
    </div>
  );
}

export default function SettingsPage({ activeSection = "general" }: SettingsPageProps) {
  const {
    confirmDialog,
    alertDialog,
    showConfirmDialog,
    showAlertDialog,
    hideConfirmDialog,
    hideAlertDialog,
  } = useDialogs();

  const {
    useLocalWhisper,
    whisperModel,
    localTranscriptionProvider,
    parakeetModel,
    uiLanguage,
    preferredLanguage,
    cloudTranscriptionProvider,
    cloudTranscriptionModel,
    cloudTranscriptionBaseUrl,
    cloudReasoningBaseUrl,
    useReasoningModel,
    reasoningModel,
    reasoningProvider,
    openaiApiKey,
    anthropicApiKey,
    geminiApiKey,
    groqApiKey,
    mistralApiKey,
    dictationKey,
    activationMode,
    setActivationMode,
    preferBuiltInMic,
    selectedMicDeviceId,
    setPreferBuiltInMic,
    setSelectedMicDeviceId,
    setUseLocalWhisper,
    setUiLanguage,
    setWhisperModel,
    setLocalTranscriptionProvider,
    setParakeetModel,
    setCloudTranscriptionProvider,
    setCloudTranscriptionModel,
    setCloudTranscriptionBaseUrl,
    setCloudReasoningBaseUrl,
    setUseReasoningModel,
    setReasoningModel,
    setReasoningProvider,
    setOpenaiApiKey,
    setAnthropicApiKey,
    setGeminiApiKey,
    setGroqApiKey,
    setMistralApiKey,
    customTranscriptionApiKey,
    setCustomTranscriptionApiKey,
    customReasoningApiKey,
    setCustomReasoningApiKey,
    setDictationKey,
    autoLearnCorrections,
    setAutoLearnCorrections,
    updateTranscriptionSettings,
    updateReasoningSettings,
    audioCuesEnabled,
    setAudioCuesEnabled,
    floatingIconAutoHide,
    setFloatingIconAutoHide,
    customDictionary,
    setCustomDictionary,
  } = useSettings();

  const { t } = useTranslation();
  const { toast } = useToast();

  const [currentVersion, setCurrentVersion] = useState<string>("");
  const [isRemovingModels, setIsRemovingModels] = useState(false);
  const cachePathHint =
    typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent)
      ? "%USERPROFILE%\\.cache\\scottyspeaks"
      : "~/.cache/scottyspeaks";

  const {
    status: updateStatus,
    info: updateInfo,
    downloadProgress: updateDownloadProgress,
    isChecking: checkingForUpdates,
    isDownloading: downloadingUpdate,
    isInstalling: installInitiated,
    checkForUpdates,
    downloadUpdate,
    installUpdate: installUpdateAction,
    getAppVersion,
    error: updateError,
  } = useUpdater();

  const isUpdateAvailable =
    !updateStatus.isDevelopment && (updateStatus.updateAvailable || updateStatus.updateDownloaded);

  const whisperHook = useWhisper();
  const permissionsHook = usePermissions(showAlertDialog);
  useClipboard(showAlertDialog);
  const { agentName, setAgentName } = useAgentName();
  const [agentNameInput, setAgentNameInput] = useState(agentName);
  const [newDictionaryWord, setNewDictionaryWord] = useState("");

  const handleAddDictionaryWord = useCallback(() => {
    const existingWords = new Set(customDictionary.map((w) => w.toLowerCase()));
    const words = newDictionaryWord
      .split(",")
      .map((w) => w.trim())
      .filter((w) => {
        const normalized = w.toLowerCase();
        if (!w || existingWords.has(normalized)) return false;
        existingWords.add(normalized);
        return true;
      });
    if (words.length > 0) {
      setCustomDictionary([...customDictionary, ...words]);
      setNewDictionaryWord("");
    }
  }, [newDictionaryWord, customDictionary, setCustomDictionary]);

  const handleRemoveDictionaryWord = useCallback(
    (word: string) => {
      if (word === agentName) return;
      setCustomDictionary(customDictionary.filter((w) => w !== word));
    },
    [customDictionary, setCustomDictionary, agentName]
  );

  const handleSaveAgentName = useCallback(() => {
    const trimmed = agentNameInput.trim();
    const previousName = agentName;

    setAgentName(trimmed);
    setAgentNameInput(trimmed);

    let nextDictionary = customDictionary.filter((w) => w !== previousName);
    if (trimmed) {
      const hasName = nextDictionary.some((w) => w.toLowerCase() === trimmed.toLowerCase());
      if (!hasName) {
        nextDictionary = [trimmed, ...nextDictionary];
      }
    }
    setCustomDictionary(nextDictionary);

    showAlertDialog({
      title: t("settingsPage.agentConfig.dialogs.updatedTitle"),
      description: t("settingsPage.agentConfig.dialogs.updatedDescription", {
        name: trimmed,
      }),
    });
  }, [
    agentNameInput,
    agentName,
    customDictionary,
    setAgentName,
    setCustomDictionary,
    showAlertDialog,
    t,
  ]);

  const { theme, setTheme } = useTheme();
  const installTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { registerHotkey, isRegistering: isHotkeyRegistering } = useHotkeyRegistration({
    onSuccess: (registeredHotkey) => {
      setDictationKey(registeredHotkey);
    },
    showSuccessToast: false,
    showErrorToast: true,
    showAlert: showAlertDialog,
  });

  const validateHotkeyForInput = useCallback(
    (hotkey: string) => getValidationMessage(hotkey, getPlatform()),
    []
  );

  const platform = getCachedPlatform();

  const [autoStartEnabled, setAutoStartEnabled] = useState(false);
  const [autoStartLoading, setAutoStartLoading] = useState(true);

  useEffect(() => {
    if (platform === "linux") {
      setAutoStartLoading(false);
      return;
    }
    const loadAutoStart = async () => {
      if (window.electronAPI?.getAutoStartEnabled) {
        try {
          const enabled = await window.electronAPI.getAutoStartEnabled();
          setAutoStartEnabled(enabled);
        } catch (error) {
          logger.error("Failed to get auto-start status", error, "settings");
        }
      }
      setAutoStartLoading(false);
    };
    loadAutoStart();
  }, [platform]);

  const handleAutoStartChange = async (enabled: boolean) => {
    if (window.electronAPI?.setAutoStartEnabled) {
      try {
        setAutoStartLoading(true);
        const result = await window.electronAPI.setAutoStartEnabled(enabled);
        if (result.success) {
          setAutoStartEnabled(enabled);
        }
      } catch (error) {
        logger.error("Failed to set auto-start", error, "settings");
      } finally {
        setAutoStartLoading(false);
      }
    }
  };

  useEffect(() => {
    let mounted = true;

    const timer = setTimeout(async () => {
      if (!mounted) return;

      const version = await getAppVersion();
      if (version && mounted) setCurrentVersion(version);

      if (mounted) {
        whisperHook.checkWhisperInstallation();
      }
    }, 100);

    return () => {
      mounted = false;
      clearTimeout(timer);
    };
  }, [whisperHook.checkWhisperInstallation, getAppVersion]);

  useEffect(() => {
    if (updateError) {
      showAlertDialog({
        title: t("settingsPage.general.updates.dialogs.updateError.title"),
        description: t("settingsPage.general.updates.dialogs.updateError.description"),
      });
    }
  }, [updateError, showAlertDialog, t]);

  useEffect(() => {
    if (installInitiated) {
      if (installTimeoutRef.current) {
        clearTimeout(installTimeoutRef.current);
      }
      installTimeoutRef.current = setTimeout(() => {
        showAlertDialog({
          title: t("settingsPage.general.updates.dialogs.almostThere.title"),
          description: t("settingsPage.general.updates.dialogs.almostThere.description"),
        });
      }, 10000);
    } else if (installTimeoutRef.current) {
      clearTimeout(installTimeoutRef.current);
      installTimeoutRef.current = null;
    }

    return () => {
      if (installTimeoutRef.current) {
        clearTimeout(installTimeoutRef.current);
        installTimeoutRef.current = null;
      }
    };
  }, [installInitiated, showAlertDialog, t]);

  const resetAccessibilityPermissions = () => {
    const message = t("settingsPage.permissions.resetAccessibility.description");

    showConfirmDialog({
      title: t("settingsPage.permissions.resetAccessibility.title"),
      description: message,
      onConfirm: () => {
        permissionsHook.openAccessibilitySettings();
      },
    });
  };

  const handleRemoveModels = useCallback(() => {
    if (isRemovingModels) return;

    showConfirmDialog({
      title: t("settingsPage.developer.removeModels.title"),
      description: t("settingsPage.developer.removeModels.description", { path: cachePathHint }),
      confirmText: t("settingsPage.developer.removeModels.confirmText"),
      variant: "destructive",
      onConfirm: async () => {
        setIsRemovingModels(true);
        try {
          const results = await Promise.allSettled([
            window.electronAPI?.deleteAllWhisperModels?.(),
            window.electronAPI?.deleteAllParakeetModels?.(),
            window.electronAPI?.modelDeleteAll?.(),
          ]);

          const anyFailed = results.some(
            (r) =>
              r.status === "rejected" || (r.status === "fulfilled" && r.value && !r.value.success)
          );

          if (anyFailed) {
            showAlertDialog({
              title: t("settingsPage.developer.removeModels.failedTitle"),
              description: t("settingsPage.developer.removeModels.failedDescription"),
            });
          } else {
            window.dispatchEvent(new Event("openwhispr-models-cleared"));
            showAlertDialog({
              title: t("settingsPage.developer.removeModels.successTitle"),
              description: t("settingsPage.developer.removeModels.successDescription"),
            });
          }
        } catch {
          showAlertDialog({
            title: t("settingsPage.developer.removeModels.failedTitle"),
            description: t("settingsPage.developer.removeModels.failedDescriptionShort"),
          });
        } finally {
          setIsRemovingModels(false);
        }
      },
    });
  }, [isRemovingModels, cachePathHint, showConfirmDialog, showAlertDialog, t]);

  const renderSectionContent = () => {
    switch (activeSection) {
      case "general":
        return (
          <div className="space-y-6">
            {/* Appearance */}
            <div>
              <SectionHeader
                title={t("settingsPage.general.appearance.title")}
                description={t("settingsPage.general.appearance.description")}
              />
              <SettingsPanel>
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settingsPage.general.appearance.theme")}
                    description={t("settingsPage.general.appearance.themeDescription")}
                  >
                    <div className="inline-flex items-center gap-px p-0.5 bg-muted/60 dark:bg-surface-2 rounded-md">
                      {(
                        [
                          {
                            value: "light",
                            icon: Sun,
                            label: t("settingsPage.general.appearance.light"),
                          },
                          {
                            value: "dark",
                            icon: Moon,
                            label: t("settingsPage.general.appearance.dark"),
                          },
                          {
                            value: "auto",
                            icon: Monitor,
                            label: t("settingsPage.general.appearance.auto"),
                          },
                        ] as const
                      ).map((option) => {
                        const Icon = option.icon;
                        const isSelected = theme === option.value;
                        return (
                          <button
                            key={option.value}
                            onClick={() => setTheme(option.value)}
                            className={`
                              flex items-center gap-1 px-2.5 py-1 rounded-[5px] text-xs font-medium
                              transition-colors duration-100
                              ${
                                isSelected
                                  ? "bg-background dark:bg-surface-raised text-foreground shadow-sm"
                                  : "text-muted-foreground hover:text-foreground"
                              }
                            `}
                          >
                            <Icon className={`w-3 h-3 ${isSelected ? "text-primary" : ""}`} />
                            {option.label}
                          </button>
                        );
                      })}
                    </div>
                  </SettingsRow>
                </SettingsPanelRow>
              </SettingsPanel>
            </div>

            {/* Sound Effects */}
            <div>
              <SectionHeader title={t("settingsPage.general.soundEffects.title")} />
              <SettingsPanel>
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settingsPage.general.soundEffects.dictationSounds")}
                    description={t("settingsPage.general.soundEffects.dictationSoundsDescription")}
                  >
                    <Toggle checked={audioCuesEnabled} onChange={setAudioCuesEnabled} />
                  </SettingsRow>
                </SettingsPanelRow>
              </SettingsPanel>
            </div>

            {/* Floating Icon */}
            <div>
              <SectionHeader
                title={t("settingsPage.general.floatingIcon.title")}
                description={t("settingsPage.general.floatingIcon.description")}
              />
              <SettingsPanel>
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settingsPage.general.floatingIcon.autoHide")}
                    description={t("settingsPage.general.floatingIcon.autoHideDescription")}
                  >
                    <Toggle checked={floatingIconAutoHide} onChange={setFloatingIconAutoHide} />
                  </SettingsRow>
                </SettingsPanelRow>
              </SettingsPanel>
            </div>

            {/* Language */}
            <div>
              <SectionHeader
                title={t("settings.language.sectionTitle")}
                description={t("settings.language.sectionDescription")}
              />
              <SettingsPanel>
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settings.language.uiLabel")}
                    description={t("settings.language.uiDescription")}
                  >
                    <LanguageSelector
                      value={uiLanguage}
                      onChange={setUiLanguage}
                      options={UI_LANGUAGE_OPTIONS}
                      className="min-w-32"
                    />
                  </SettingsRow>
                </SettingsPanelRow>
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settings.language.transcriptionLabel")}
                    description={t("settings.language.transcriptionDescription")}
                  >
                    <LanguageSelector
                      value={preferredLanguage}
                      onChange={(value) =>
                        updateTranscriptionSettings({ preferredLanguage: value })
                      }
                    />
                  </SettingsRow>
                </SettingsPanelRow>
              </SettingsPanel>
            </div>

            {/* Startup */}
            {platform !== "linux" && (
              <div>
                <SectionHeader title={t("settingsPage.general.startup.title")} />
                <SettingsPanel>
                  <SettingsPanelRow>
                    <SettingsRow
                      label={t("settingsPage.general.startup.launchAtLogin")}
                      description={t("settingsPage.general.startup.launchAtLoginDescription")}
                    >
                      <Toggle
                        checked={autoStartEnabled}
                        onChange={(checked: boolean) => handleAutoStartChange(checked)}
                        disabled={autoStartLoading}
                      />
                    </SettingsRow>
                  </SettingsPanelRow>
                </SettingsPanel>
              </div>
            )}

            {/* Microphone */}
            <div>
              <SectionHeader
                title={t("settingsPage.general.microphone.title")}
                description={t("settingsPage.general.microphone.description")}
              />
              <SettingsPanel>
                <SettingsPanelRow>
                  <MicrophoneSettings
                    preferBuiltInMic={preferBuiltInMic}
                    selectedMicDeviceId={selectedMicDeviceId}
                    onPreferBuiltInChange={setPreferBuiltInMic}
                    onDeviceSelect={setSelectedMicDeviceId}
                  />
                </SettingsPanelRow>
              </SettingsPanel>
            </div>
          </div>
        );

      case "hotkeys":
        return (
          <div className="space-y-6">
            {/* Dictation Hotkey */}
            <div>
              <SectionHeader
                title={t("settingsPage.general.hotkey.title")}
                description={t("settingsPage.general.hotkey.description")}
              />
              <SettingsPanel>
                <SettingsPanelRow>
                  <HotkeyInput
                    value={dictationKey}
                    onChange={async (newHotkey) => {
                      await registerHotkey(newHotkey);
                    }}
                    disabled={isHotkeyRegistering}
                    validate={validateHotkeyForInput}
                  />
                  {dictationKey && dictationKey !== getDefaultHotkey() && (
                    <button
                      onClick={() => registerHotkey(getDefaultHotkey())}
                      disabled={isHotkeyRegistering}
                      className="mt-2 text-xs text-muted-foreground/70 hover:text-foreground transition-colors disabled:opacity-50"
                    >
                      {t("settingsPage.general.hotkey.resetToDefault", {
                        hotkey: formatHotkeyLabel(getDefaultHotkey()),
                      })}
                    </button>
                  )}
                </SettingsPanelRow>

                <SettingsPanelRow>
                  <p className="text-xs font-medium text-muted-foreground/80 mb-2">
                    {t("settingsPage.general.hotkey.activationMode")}
                  </p>
                  <ActivationModeSelector value={activationMode} onChange={setActivationMode} />
                </SettingsPanelRow>
              </SettingsPanel>
            </div>

            {/* Paste last dictation (macOS only) */}
            {getCachedPlatform() === "darwin" && (
              <div>
                <SectionHeader
                  title={t("pasteLast.settings.title")}
                  description={t("pasteLast.settings.description")}
                />
                <SettingsPanel>
                  <SettingsPanelRow>
                    <PasteLastHotkeySetting />
                  </SettingsPanelRow>
                </SettingsPanel>
              </div>
            )}

            {/* Mouse Button Trigger (macOS only) */}
            {getCachedPlatform() === "darwin" && (
              <div>
                <SectionHeader
                  title="Mouse Button Trigger"
                  description="Use a mouse button as an additional trigger alongside your keyboard hotkey."
                />
                <SettingsPanel>
                  <SettingsPanelRow>
                    <MouseButtonSetting />
                  </SettingsPanelRow>
                </SettingsPanel>
              </div>
            )}

            {/* Stream Deck Pedal */}
            <div>
              <SectionHeader
                title={t("settings.pedal.sectionTitle", { defaultValue: "Foot Pedal" })}
                description={t("settings.pedal.sectionDescription", {
                  defaultValue: "Elgato Stream Deck Pedal — three switches, three ways to talk.",
                })}
              />
              <SettingsPanel>
                <SettingsPanelRow>
                  <PedalSettings />
                </SettingsPanelRow>
              </SettingsPanel>
            </div>
          </div>
        );

      case "transcription":
        return (
          <TranscriptionSection
            useLocalWhisper={useLocalWhisper}
            setUseLocalWhisper={setUseLocalWhisper}
            updateTranscriptionSettings={updateTranscriptionSettings}
            cloudTranscriptionProvider={cloudTranscriptionProvider}
            setCloudTranscriptionProvider={setCloudTranscriptionProvider}
            cloudTranscriptionModel={cloudTranscriptionModel}
            setCloudTranscriptionModel={setCloudTranscriptionModel}
            localTranscriptionProvider={localTranscriptionProvider}
            setLocalTranscriptionProvider={setLocalTranscriptionProvider}
            whisperModel={whisperModel}
            setWhisperModel={setWhisperModel}
            parakeetModel={parakeetModel}
            setParakeetModel={setParakeetModel}
            openaiApiKey={openaiApiKey}
            setOpenaiApiKey={setOpenaiApiKey}
            groqApiKey={groqApiKey}
            setGroqApiKey={setGroqApiKey}
            mistralApiKey={mistralApiKey}
            setMistralApiKey={setMistralApiKey}
            customTranscriptionApiKey={customTranscriptionApiKey}
            setCustomTranscriptionApiKey={setCustomTranscriptionApiKey}
            cloudTranscriptionBaseUrl={cloudTranscriptionBaseUrl}
            setCloudTranscriptionBaseUrl={setCloudTranscriptionBaseUrl}
          />
        );

      case "dictionary":
        return (
          <div className="space-y-5">
            <SectionHeader
              title={t("settingsPage.dictionary.title")}
              description={t("settingsPage.dictionary.description")}
            />

            {/* Add Words */}
            <SettingsPanel>
              <SettingsPanelRow>
                <div className="space-y-2">
                  <p className="text-[12px] font-medium text-foreground">
                    {t("settingsPage.dictionary.addWordOrPhrase")}
                  </p>
                  <div className="flex gap-2">
                    <Input
                      placeholder={t("settingsPage.dictionary.placeholder")}
                      value={newDictionaryWord}
                      onChange={(e) => setNewDictionaryWord(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          handleAddDictionaryWord();
                        }
                      }}
                      className="flex-1 h-8 text-[12px]"
                    />
                    <Button
                      onClick={handleAddDictionaryWord}
                      disabled={!newDictionaryWord.trim()}
                      size="sm"
                      className="h-8"
                    >
                      {t("settingsPage.dictionary.add")}
                    </Button>
                  </div>
                  <p className="text-[10px] text-muted-foreground/50">
                    {t("settingsPage.dictionary.pressEnterToAdd")}
                  </p>
                </div>
              </SettingsPanelRow>
            </SettingsPanel>

            {/* Auto-learn from corrections */}
            <div>
              <SettingsPanel>
                <SettingsPanelRow>
                  <div className="flex items-center justify-between w-full">
                    <div>
                      <p className="text-[12px] font-medium text-foreground">
                        {t("settingsPage.dictionary.autoLearnTitle", {
                          defaultValue: "Auto-learn from corrections",
                        })}
                      </p>
                      <p className="text-[10px] text-muted-foreground/50 mt-0.5">
                        {t("settingsPage.dictionary.autoLearnDescription", {
                          defaultValue:
                            "When you correct a transcription in the target app, the corrected word is automatically added to your dictionary.",
                        })}
                      </p>
                    </div>
                    <button
                      onClick={() => setAutoLearnCorrections(!autoLearnCorrections)}
                      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                        autoLearnCorrections ? "bg-primary" : "bg-muted-foreground/20"
                      }`}
                    >
                      <span
                        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                          autoLearnCorrections ? "translate-x-[18px]" : "translate-x-[3px]"
                        }`}
                      />
                    </button>
                  </div>
                </SettingsPanelRow>
              </SettingsPanel>
            </div>

            {/* Word List */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <p className="text-[12px] font-medium text-foreground">
                  {t("settingsPage.dictionary.yourWords")}
                  {customDictionary.length > 0 && (
                    <span className="ml-1.5 text-muted-foreground/50 font-normal text-[11px]">
                      {customDictionary.length}
                    </span>
                  )}
                </p>
                {customDictionary.length > 0 && (
                  <button
                    onClick={() => {
                      showConfirmDialog({
                        title: t("settingsPage.dictionary.clearDictionaryTitle"),
                        description: t("settingsPage.dictionary.clearDictionaryDescription"),
                        confirmText: t("settingsPage.dictionary.clearAll"),
                        variant: "destructive",
                        onConfirm: () =>
                          setCustomDictionary(customDictionary.filter((w) => w === agentName)),
                      });
                    }}
                    className="text-[10px] text-muted-foreground/40 hover:text-destructive transition-colors"
                  >
                    {t("settingsPage.dictionary.clearAll")}
                  </button>
                )}
              </div>

              {customDictionary.length > 0 ? (
                <SettingsPanel>
                  <SettingsPanelRow>
                    <div className="flex flex-wrap gap-1">
                      {customDictionary.map((word) => {
                        const isAgentName = word === agentName;
                        return (
                          <span
                            key={word}
                            className={`group inline-flex items-center gap-0.5 py-0.5 rounded-[5px] text-[11px] border transition-all ${
                              isAgentName
                                ? "pl-2 pr-2 bg-primary/10 dark:bg-primary/15 text-primary border-primary/20 dark:border-primary/30"
                                : "pl-2 pr-1 bg-primary/5 dark:bg-primary/10 text-foreground border-border/30 dark:border-border-subtle hover:border-destructive/40 hover:bg-destructive/5"
                            }`}
                            title={
                              isAgentName
                                ? t("settingsPage.dictionary.agentNameAutoManaged")
                                : undefined
                            }
                          >
                            {word}
                            {!isAgentName && (
                              <button
                                onClick={() => handleRemoveDictionaryWord(word)}
                                className="ml-0.5 p-0.5 rounded-sm text-muted-foreground/40 hover:text-destructive transition-colors"
                                title={t("settingsPage.dictionary.removeWord")}
                              >
                                <svg
                                  width="9"
                                  height="9"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2.5"
                                  strokeLinecap="round"
                                >
                                  <path d="M18 6L6 18M6 6l12 12" />
                                </svg>
                              </button>
                            )}
                          </span>
                        );
                      })}
                    </div>
                  </SettingsPanelRow>
                </SettingsPanel>
              ) : (
                <div className="rounded-lg border border-dashed border-border/40 dark:border-border-subtle py-6 flex flex-col items-center justify-center text-center">
                  <p className="text-[11px] text-muted-foreground/50">
                    {t("settingsPage.dictionary.noWords")}
                  </p>
                  <p className="text-[10px] text-muted-foreground/40 mt-0.5">
                    {t("settingsPage.dictionary.wordsAppearHere")}
                  </p>
                </div>
              )}
            </div>

            {/* How it works */}
            <div>
              <SectionHeader title={t("settingsPage.dictionary.howItWorksTitle")} />
              <SettingsPanel>
                <SettingsPanelRow>
                  <p className="text-[12px] text-muted-foreground leading-relaxed">
                    {t("settingsPage.dictionary.howItWorksDescription")}
                  </p>
                </SettingsPanelRow>
                <SettingsPanelRow>
                  <p className="text-[12px] text-muted-foreground leading-relaxed">
                    <span className="font-medium text-foreground">
                      {t("settingsPage.dictionary.tipLabel")}
                    </span>{" "}
                    {t("settingsPage.dictionary.tipDescription")}
                  </p>
                </SettingsPanelRow>
              </SettingsPanel>
            </div>
          </div>
        );

      case "aiModels":
        return (
          <AiModelsSection
            useReasoningModel={useReasoningModel}
            setUseReasoningModel={(value) => {
              setUseReasoningModel(value);
              updateReasoningSettings({ useReasoningModel: value });
            }}
            reasoningModel={reasoningModel}
            setReasoningModel={setReasoningModel}
            reasoningProvider={reasoningProvider}
            setReasoningProvider={setReasoningProvider}
            cloudReasoningBaseUrl={cloudReasoningBaseUrl}
            setCloudReasoningBaseUrl={setCloudReasoningBaseUrl}
            openaiApiKey={openaiApiKey}
            setOpenaiApiKey={setOpenaiApiKey}
            anthropicApiKey={anthropicApiKey}
            setAnthropicApiKey={setAnthropicApiKey}
            geminiApiKey={geminiApiKey}
            setGeminiApiKey={setGeminiApiKey}
            groqApiKey={groqApiKey}
            setGroqApiKey={setGroqApiKey}
            customReasoningApiKey={customReasoningApiKey}
            setCustomReasoningApiKey={setCustomReasoningApiKey}
          />
        );

      case "agentConfig":
        return (
          <div className="space-y-5">
            <SectionHeader
              title={t("settingsPage.agentConfig.title")}
              description={t("settingsPage.agentConfig.description")}
            />

            {/* Agent Name */}
            <div>
              <p className="text-[13px] font-medium text-foreground mb-3">
                {t("settingsPage.agentConfig.agentName")}
              </p>
              <SettingsPanel>
                <SettingsPanelRow>
                  <div className="space-y-3">
                    <div className="flex gap-2">
                      <Input
                        placeholder={t("settingsPage.agentConfig.placeholder")}
                        value={agentNameInput}
                        onChange={(e) => setAgentNameInput(e.target.value)}
                        className="flex-1 text-center text-base font-mono"
                      />
                      <Button
                        onClick={handleSaveAgentName}
                        disabled={!agentNameInput.trim()}
                        size="sm"
                      >
                        {t("settingsPage.agentConfig.save")}
                      </Button>
                    </div>
                    <p className="text-[11px] text-muted-foreground/60">
                      {t("settingsPage.agentConfig.helper")}
                    </p>
                  </div>
                </SettingsPanelRow>
              </SettingsPanel>
            </div>

            {/* How it works */}
            <div>
              <SectionHeader title={t("settingsPage.agentConfig.howItWorksTitle")} />
              <SettingsPanel>
                <SettingsPanelRow>
                  <p className="text-[12px] text-muted-foreground leading-relaxed">
                    {t("settingsPage.agentConfig.howItWorksDescription", { agentName })}
                  </p>
                </SettingsPanelRow>
              </SettingsPanel>
            </div>

            {/* Examples */}
            <div>
              <SectionHeader title={t("settingsPage.agentConfig.examplesTitle")} />
              <SettingsPanel>
                <SettingsPanelRow>
                  <div className="space-y-2.5">
                    {[
                      {
                        input: `Hey ${agentName}, write a formal email about the budget`,
                        mode: t("settingsPage.agentConfig.instructionMode"),
                      },
                      {
                        input: `Hey ${agentName}, make this more professional`,
                        mode: t("settingsPage.agentConfig.instructionMode"),
                      },
                      {
                        input: `Hey ${agentName}, convert this to bullet points`,
                        mode: t("settingsPage.agentConfig.instructionMode"),
                      },
                      {
                        input: t("settingsPage.agentConfig.cleanupExample"),
                        mode: t("settingsPage.agentConfig.cleanupMode"),
                      },
                    ].map((example, i) => (
                      <div key={i} className="flex items-start gap-3">
                        <span
                          className={`shrink-0 mt-0.5 text-[10px] font-medium uppercase tracking-wider px-1.5 py-px rounded ${
                            example.mode === t("settingsPage.agentConfig.instructionMode")
                              ? "bg-primary/10 text-primary dark:bg-primary/15"
                              : "bg-muted text-muted-foreground"
                          }`}
                        >
                          {example.mode}
                        </span>
                        <p className="text-[12px] text-muted-foreground leading-relaxed">
                          "{example.input}"
                        </p>
                      </div>
                    ))}
                  </div>
                </SettingsPanelRow>
              </SettingsPanel>
            </div>
          </div>
        );

      case "prompts":
        return (
          <div className="space-y-5">
            <SectionHeader
              title={t("settingsPage.prompts.title")}
              description={t("settingsPage.prompts.description")}
            />

            <PromptStudio />
          </div>
        );

      case "intelligence":
        return (
          <div className="space-y-6">
            {/* Text Cleanup (AI Models) */}
            <AiModelsSection
              useReasoningModel={useReasoningModel}
              setUseReasoningModel={(value) => {
                updateReasoningSettings({ useReasoningModel: value });
              }}
              reasoningModel={reasoningModel}
              setReasoningModel={setReasoningModel}
              reasoningProvider={reasoningProvider}
              setReasoningProvider={setReasoningProvider}
              cloudReasoningBaseUrl={cloudReasoningBaseUrl}
              setCloudReasoningBaseUrl={setCloudReasoningBaseUrl}
              openaiApiKey={openaiApiKey}
              setOpenaiApiKey={setOpenaiApiKey}
              anthropicApiKey={anthropicApiKey}
              setAnthropicApiKey={setAnthropicApiKey}
              geminiApiKey={geminiApiKey}
              setGeminiApiKey={setGeminiApiKey}
              groqApiKey={groqApiKey}
              setGroqApiKey={setGroqApiKey}
              customReasoningApiKey={customReasoningApiKey}
              setCustomReasoningApiKey={setCustomReasoningApiKey}
            />

            {/* Agent Config */}
            <div className="border-t border-border/40 pt-6">
              <SectionHeader
                title={t("settingsPage.agentConfig.title")}
                description={t("settingsPage.agentConfig.description")}
              />

              <div className="space-y-5">
                <div>
                  <p className="text-xs font-medium text-foreground mb-3">
                    {t("settingsPage.agentConfig.agentName")}
                  </p>
                  <SettingsPanel>
                    <SettingsPanelRow>
                      <div className="space-y-3">
                        <div className="flex gap-2">
                          <Input
                            placeholder={t("settingsPage.agentConfig.placeholder")}
                            value={agentNameInput}
                            onChange={(e) => setAgentNameInput(e.target.value)}
                            className="flex-1 text-center text-base font-mono"
                          />
                          <Button
                            onClick={handleSaveAgentName}
                            disabled={!agentNameInput.trim()}
                            size="sm"
                          >
                            {t("settingsPage.agentConfig.save")}
                          </Button>
                        </div>
                        <p className="text-xs text-muted-foreground/60">
                          {t("settingsPage.agentConfig.helper")}
                        </p>
                      </div>
                    </SettingsPanelRow>
                  </SettingsPanel>
                </div>

                <div>
                  <SectionHeader title={t("settingsPage.agentConfig.howItWorksTitle")} />
                  <SettingsPanel>
                    <SettingsPanelRow>
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        {t("settingsPage.agentConfig.howItWorksDescription", { agentName })}
                      </p>
                    </SettingsPanelRow>
                  </SettingsPanel>
                </div>

                <div>
                  <SectionHeader title={t("settingsPage.agentConfig.examplesTitle")} />
                  <SettingsPanel>
                    <SettingsPanelRow>
                      <div className="space-y-2.5">
                        {[
                          {
                            input: t("settingsPage.agentConfig.examples.formalEmail", {
                              agentName,
                            }),
                            mode: t("settingsPage.agentConfig.instructionMode"),
                          },
                          {
                            input: t("settingsPage.agentConfig.examples.professional", {
                              agentName,
                            }),
                            mode: t("settingsPage.agentConfig.instructionMode"),
                          },
                          {
                            input: t("settingsPage.agentConfig.examples.bulletPoints", {
                              agentName,
                            }),
                            mode: t("settingsPage.agentConfig.instructionMode"),
                          },
                          {
                            input: t("settingsPage.agentConfig.cleanupExample"),
                            mode: t("settingsPage.agentConfig.cleanupMode"),
                          },
                        ].map((example, i) => (
                          <div key={i} className="flex items-start gap-3">
                            <span
                              className={`shrink-0 mt-0.5 text-xs font-medium uppercase tracking-wider px-1.5 py-px rounded ${
                                example.mode === t("settingsPage.agentConfig.instructionMode")
                                  ? "bg-primary/10 text-primary dark:bg-primary/15"
                                  : "bg-muted text-muted-foreground"
                              }`}
                            >
                              {example.mode}
                            </span>
                            <p className="text-xs text-muted-foreground leading-relaxed">
                              "{example.input}"
                            </p>
                          </div>
                        ))}
                      </div>
                    </SettingsPanelRow>
                  </SettingsPanel>
                </div>
              </div>
            </div>

            {/* System Prompt */}
            <div className="border-t border-border/40 pt-6">
              <SectionHeader
                title={t("settingsPage.prompts.title")}
                description={t("settingsPage.prompts.description")}
              />
              <PromptStudio />
            </div>
          </div>
        );

      case "privacyData":
        return (
          <div className="space-y-6">
            {/* Permissions */}
            <div>
              <SectionHeader
                title={t("settingsPage.permissions.title")}
                description={t("settingsPage.permissions.description")}
              />

              <div className="space-y-3">
                <PermissionCard
                  icon={Mic}
                  title={t("settingsPage.permissions.microphoneTitle")}
                  description={t("settingsPage.permissions.microphoneDescription")}
                  granted={permissionsHook.micPermissionGranted}
                  onRequest={permissionsHook.requestMicPermission}
                  buttonText={t("settingsPage.permissions.test")}
                  onOpenSettings={permissionsHook.openMicPrivacySettings}
                />

                {platform === "darwin" && (
                  <PermissionCard
                    icon={Shield}
                    title={t("settingsPage.permissions.accessibilityTitle")}
                    description={t("settingsPage.permissions.accessibilityDescription")}
                    granted={permissionsHook.accessibilityPermissionGranted}
                    onRequest={permissionsHook.testAccessibilityPermission}
                    buttonText={t("settingsPage.permissions.testAndGrant")}
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


              {platform === "darwin" && (
                <div className="mt-5">
                  <p className="text-xs font-medium text-foreground mb-3">
                    {t("settingsPage.permissions.troubleshootingTitle")}
                  </p>
                  <SettingsPanel>
                    <SettingsPanelRow>
                      <SettingsRow
                        label={t("settingsPage.permissions.resetAccessibility.label")}
                        description={t(
                          "settingsPage.permissions.resetAccessibility.rowDescription"
                        )}
                      >
                        <Button
                          onClick={resetAccessibilityPermissions}
                          variant="ghost"
                          size="sm"
                          className="text-foreground/70 hover:text-foreground"
                        >
                          {t("settingsPage.permissions.troubleshoot")}
                        </Button>
                      </SettingsRow>
                    </SettingsPanelRow>
                  </SettingsPanel>
                </div>
              )}
            </div>
          </div>
        );

      case "system":
        return (
          <div className="space-y-6">
            {/* Diagnostics */}
            <div>
              <SectionHeader
                title={t("settingsPage.diagnostics.title", { defaultValue: "Diagnostics" })}
                description={t("settingsPage.diagnostics.description", {
                  defaultValue:
                    "Check why dictation is slow or unformatted on this Mac, then copy the report.",
                })}
              />
              <SettingsPanel>
                <SettingsPanelRow>
                  <DiagnosticsPanel />
                </SettingsPanelRow>
              </SettingsPanel>
            </div>

            {/* Software Updates */}
            <div>
              <SectionHeader title={t("settingsPage.general.updates.title")} />
              <SettingsPanel>
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settingsPage.general.updates.currentVersion")}
                    description={
                      updateStatus.isDevelopment
                        ? t("settingsPage.general.updates.devMode")
                        : isUpdateAvailable
                          ? t("settingsPage.general.updates.newVersionAvailable")
                          : t("settingsPage.general.updates.latestVersion")
                    }
                  >
                    <div className="flex items-center gap-2.5">
                      <span className="text-xs tabular-nums text-muted-foreground font-mono">
                        {currentVersion || t("settingsPage.general.updates.versionPlaceholder")}
                      </span>
                      {updateStatus.isDevelopment ? (
                        <Badge variant="warning">
                          {t("settingsPage.general.updates.badges.dev")}
                        </Badge>
                      ) : isUpdateAvailable ? (
                        <Badge variant="success">
                          {t("settingsPage.general.updates.badges.update")}
                        </Badge>
                      ) : (
                        <Badge variant="outline">
                          {t("settingsPage.general.updates.badges.latest")}
                        </Badge>
                      )}
                    </div>
                  </SettingsRow>
                </SettingsPanelRow>

                <SettingsPanelRow>
                  <div className="space-y-2.5">
                    <Button
                      onClick={async () => {
                        try {
                          const result = await checkForUpdates();
                          if (result?.updateAvailable) {
                            showAlertDialog({
                              title: t(
                                "settingsPage.general.updates.dialogs.updateAvailable.title"
                              ),
                              description: t(
                                "settingsPage.general.updates.dialogs.updateAvailable.description",
                                {
                                  version:
                                    result.version || t("settingsPage.general.updates.newVersion"),
                                }
                              ),
                            });
                          } else {
                            showAlertDialog({
                              title: t("settingsPage.general.updates.dialogs.noUpdates.title"),
                              description:
                                result?.message ||
                                t("settingsPage.general.updates.dialogs.noUpdates.description"),
                            });
                          }
                        } catch {
                          showAlertDialog({
                            title: t("settingsPage.general.updates.dialogs.checkFailed.title"),
                            description: t(
                              "settingsPage.general.updates.dialogs.checkFailed.description"
                            ),
                          });
                        }
                      }}
                      disabled={checkingForUpdates || updateStatus.isDevelopment}
                      variant="outline"
                      className="w-full"
                      size="sm"
                    >
                      <RefreshCw
                        size={13}
                        className={`mr-1.5 ${checkingForUpdates ? "animate-spin" : ""}`}
                      />
                      {checkingForUpdates
                        ? t("settingsPage.general.updates.checking")
                        : t("settingsPage.general.updates.checkForUpdates")}
                    </Button>

                    {isUpdateAvailable && !updateStatus.updateDownloaded && (
                      <div className="space-y-2">
                        <Button
                          onClick={async () => {
                            try {
                              await downloadUpdate();
                            } catch {
                              showAlertDialog({
                                title: t(
                                  "settingsPage.general.updates.dialogs.downloadFailed.title"
                                ),
                                description: t(
                                  "settingsPage.general.updates.dialogs.downloadFailed.description"
                                ),
                              });
                            }
                          }}
                          disabled={downloadingUpdate}
                          variant="success"
                          className="w-full"
                          size="sm"
                        >
                          <Download
                            size={13}
                            className={`mr-1.5 ${downloadingUpdate ? "animate-pulse" : ""}`}
                          />
                          {downloadingUpdate
                            ? t("settingsPage.general.updates.downloading", {
                                progress: Math.round(updateDownloadProgress),
                              })
                            : t("settingsPage.general.updates.downloadUpdate", {
                                version: updateInfo?.version || "",
                              })}
                        </Button>

                        {downloadingUpdate && (
                          <div className="h-1 w-full overflow-hidden rounded-full bg-muted/50">
                            <div
                              className="h-full bg-success transition-[width] duration-200 rounded-full"
                              style={{
                                width: `${Math.min(100, Math.max(0, updateDownloadProgress))}%`,
                              }}
                            />
                          </div>
                        )}
                      </div>
                    )}

                    {updateStatus.updateDownloaded && (
                      <Button
                        onClick={() => {
                          showConfirmDialog({
                            title: t("settingsPage.general.updates.dialogs.installUpdate.title"),
                            description: t(
                              "settingsPage.general.updates.dialogs.installUpdate.description",
                              { version: updateInfo?.version || "" }
                            ),
                            confirmText: t(
                              "settingsPage.general.updates.dialogs.installUpdate.confirmText"
                            ),
                            onConfirm: async () => {
                              try {
                                await installUpdateAction();
                              } catch {
                                showAlertDialog({
                                  title: t(
                                    "settingsPage.general.updates.dialogs.installFailed.title"
                                  ),
                                  description: t(
                                    "settingsPage.general.updates.dialogs.installFailed.description"
                                  ),
                                });
                              }
                            },
                          });
                        }}
                        disabled={installInitiated}
                        className="w-full"
                        size="sm"
                      >
                        <RefreshCw
                          size={14}
                          className={`mr-2 ${installInitiated ? "animate-spin" : ""}`}
                        />
                        {installInitiated
                          ? t("settingsPage.general.updates.restarting")
                          : t("settingsPage.general.updates.installAndRestart")}
                      </Button>
                    )}
                  </div>

                  {updateInfo?.releaseNotes && (
                    <div className="mt-4 pt-4 border-t border-border/30">
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
                        {t("settingsPage.general.updates.whatsNew", {
                          version: updateInfo.version,
                        })}
                      </p>
                      <div
                        className="text-xs text-muted-foreground [&_ul]:list-disc [&_ul]:pl-4 [&_ul]:space-y-1 [&_ol]:list-decimal [&_ol]:pl-4 [&_ol]:space-y-1 [&_li]:pl-1 [&_p]:mb-2 [&_p:last-child]:mb-0 [&_a]:text-link [&_a]:underline"
                        dangerouslySetInnerHTML={{ __html: updateInfo.releaseNotes }}
                      />
                    </div>
                  )}
                </SettingsPanelRow>
              </SettingsPanel>
            </div>

            {/* Developer Tools */}
            <div className="border-t border-border/40 pt-6">
              <DeveloperSection />
            </div>

            {/* Data Management */}
            <div className="border-t border-border/40 pt-6">
              <SectionHeader
                title={t("settingsPage.developer.dataManagementTitle")}
                description={t("settingsPage.developer.dataManagementDescription")}
              />

              <div className="space-y-4">
                <SettingsPanel>
                  <SettingsPanelRow>
                    <SettingsRow
                      label={t("settingsPage.developer.modelCache")}
                      description={cachePathHint}
                    >
                      <div className="flex items-center gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => window.electronAPI?.openWhisperModelsFolder?.()}
                        >
                          <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
                          {t("settingsPage.developer.open")}
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={handleRemoveModels}
                          disabled={isRemovingModels}
                        >
                          {isRemovingModels
                            ? t("settingsPage.developer.removing")
                            : t("settingsPage.developer.clearCache")}
                        </Button>
                      </div>
                    </SettingsRow>
                  </SettingsPanelRow>
                </SettingsPanel>

                <SettingsPanel>
                  <SettingsPanelRow>
                    <SettingsRow
                      label={t("settingsPage.developer.resetAppData")}
                      description={t("settingsPage.developer.resetAppDataDescription")}
                    >
                      <Button
                        onClick={() => {
                          showConfirmDialog({
                            title: t("settingsPage.developer.resetAll.title"),
                            description: t("settingsPage.developer.resetAll.description"),
                            onConfirm: () => {
                              window.electronAPI
                                ?.cleanupApp()
                                .then(() => {
                                  showAlertDialog({
                                    title: t("settingsPage.developer.resetAll.successTitle"),
                                    description: t(
                                      "settingsPage.developer.resetAll.successDescription"
                                    ),
                                  });
                                  setTimeout(() => {
                                    window.location.reload();
                                  }, 1000);
                                })
                                .catch(() => {
                                  showAlertDialog({
                                    title: t("settingsPage.developer.resetAll.failedTitle"),
                                    description: t(
                                      "settingsPage.developer.resetAll.failedDescription"
                                    ),
                                  });
                                });
                            },
                            variant: "destructive",
                            confirmText: t("settingsPage.developer.resetAll.confirmText"),
                          });
                        }}
                        variant="outline"
                        size="sm"
                        className="text-destructive border-destructive/30 hover:bg-destructive/10 hover:border-destructive"
                      >
                        {t("common.reset")}
                      </Button>
                    </SettingsRow>
                  </SettingsPanelRow>
                </SettingsPanel>
              </div>
            </div>
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <>
      <ConfirmDialog
        open={confirmDialog.open}
        onOpenChange={(open) => !open && hideConfirmDialog()}
        title={confirmDialog.title}
        description={confirmDialog.description}
        onConfirm={confirmDialog.onConfirm}
        variant={confirmDialog.variant}
        confirmText={confirmDialog.confirmText}
        cancelText={confirmDialog.cancelText}
      />

      <AlertDialog
        open={alertDialog.open}
        onOpenChange={(open) => !open && hideAlertDialog()}
        title={alertDialog.title}
        description={alertDialog.description}
        onOk={() => {}}
      />

      {renderSectionContent()}
    </>
  );
}
