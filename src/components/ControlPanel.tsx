import { SpeechControls } from "./speech/SpeechControls";
import React, { Suspense, useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import { Download, RefreshCw, Loader2 } from "lucide-react";
import { ConfirmDialog, AlertDialog } from "./ui/dialog";
import { useDialogs } from "../hooks/useDialogs";
import { useHotkey } from "../hooks/useHotkey";
import { useToast } from "./ui/Toast";
import { useUpdater } from "../hooks/useUpdater";
import { useSettings } from "../hooks/useSettings";
import {
  useTranscriptions,
  initializeTranscriptions,
  removeTranscription as removeFromStore,
} from "../stores/transcriptionStore";
import ControlPanelSidebar, { type ControlPanelView } from "./ControlPanelSidebar";
import HomeView from "./HomeView";

const SettingsModal = React.lazy(() => import("./SettingsModal"));
const MeetingsView = React.lazy(() => import("./meetings/MeetingsView"));
const ScreenRecordingsView = React.lazy(() => import("./screen/ScreenRecordingsView"));
const PersonalNotesView = React.lazy(() => import("./notes/PersonalNotesView"));
const DictionaryView = React.lazy(() => import("./DictionaryView"));
const SnippetsView = React.lazy(() => import("./SnippetsView"));
const StyleView = React.lazy(() => import("./StyleView"));

export default function ControlPanel() {
  const { t } = useTranslation();
  const history = useTranscriptions();
  const [isLoading, setIsLoading] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsSection, setSettingsSection] = useState<string | undefined>();
  const [aiCTADismissed, setAiCTADismissed] = useState(
    () => localStorage.getItem("aiCTADismissed") === "true"
  );
  const [activeView, setActiveView] = useState<ControlPanelView>(() => {
    const saved = localStorage.getItem("controlPanelView");
    return ["home", "meetings", "screen", "personal-notes", "dictionary", "snippets", "style"].includes(
      saved || ""
    )
      ? (saved as ControlPanelView)
      : "home";
  });
  const { hotkey } = useHotkey();
  const { toast } = useToast();
  useSettings(); // initialize settings provider

  const {
    status: updateStatus,
    downloadProgress,
    isDownloading,
    isInstalling,
    downloadUpdate,
    installUpdate,
    error: updateError,
  } = useUpdater();

  const {
    confirmDialog,
    alertDialog,
    showConfirmDialog,
    showAlertDialog,
    hideConfirmDialog,
    hideAlertDialog,
  } = useDialogs();

  useEffect(() => {
    loadTranscriptions();
  }, []);

  useEffect(() => {
    localStorage.setItem("controlPanelView", activeView);
  }, [activeView]);

  useEffect(() => {
    const navigate = (event: KeyboardEvent) => {
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        event.shiftKey ||
        document.querySelector('[role="dialog"]')
      )
        return;
      const view = { "1": "home", "2": "meetings", "3": "personal-notes", "4": "screen" }[event.key];
      if (view) {
        event.preventDefault();
        setActiveView(view as ControlPanelView);
      }
    };
    window.addEventListener("keydown", navigate);
    return () => window.removeEventListener("keydown", navigate);
  }, []);

  useEffect(() => {
    if (updateStatus.updateDownloaded && !isDownloading) {
      toast({
        title: t("controlPanel.update.readyTitle"),
        description: t("controlPanel.update.readyDescription"),
        variant: "success",
      });
    }
  }, [updateStatus.updateDownloaded, isDownloading, toast, t]);

  useEffect(() => {
    if (updateError) {
      toast({
        title: t("controlPanel.update.problemTitle"),
        description: t("controlPanel.update.problemDescription"),
        variant: "destructive",
      });
    }
  }, [updateError, toast, t]);

  const loadTranscriptions = async () => {
    try {
      setIsLoading(true);
      await initializeTranscriptions();
    } catch (error) {
      showAlertDialog({
        title: t("controlPanel.history.couldNotLoadTitle"),
        description: t("controlPanel.history.couldNotLoadDescription"),
      });
    } finally {
      setIsLoading(false);
    }
  };

  const copyToClipboard = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        toast({
          title: t("controlPanel.history.copiedTitle"),
          description: t("controlPanel.history.copiedDescription"),
          variant: "success",
          duration: 2000,
        });
      } catch (err) {
        toast({
          title: t("controlPanel.history.couldNotCopyTitle"),
          description: t("controlPanel.history.couldNotCopyDescription"),
          variant: "destructive",
        });
      }
    },
    [toast, t]
  );

  const deleteTranscription = useCallback(
    async (id: number) => {
      showConfirmDialog({
        title: t("controlPanel.history.deleteTitle"),
        description: t("controlPanel.history.deleteDescription"),
        onConfirm: async () => {
          try {
            const result = await window.electronAPI.deleteTranscription(id);
            if (result.success) {
              removeFromStore(id);
            } else {
              showAlertDialog({
                title: t("controlPanel.history.couldNotDeleteTitle"),
                description: t("controlPanel.history.couldNotDeleteDescription"),
              });
            }
          } catch {
            showAlertDialog({
              title: t("controlPanel.history.couldNotDeleteTitle"),
              description: t("controlPanel.history.couldNotDeleteDescriptionGeneric"),
            });
          }
        },
        variant: "destructive",
      });
    },
    [showConfirmDialog, showAlertDialog, t]
  );

  const handleUpdateClick = async () => {
    if (updateStatus.updateDownloaded) {
      showConfirmDialog({
        title: t("controlPanel.update.installTitle"),
        description: t("controlPanel.update.installDescription"),
        onConfirm: async () => {
          try {
            await installUpdate();
          } catch (error) {
            toast({
              title: t("controlPanel.update.couldNotInstallTitle"),
              description: t("controlPanel.update.couldNotInstallDescription"),
              variant: "destructive",
            });
          }
        },
      });
    } else if (updateStatus.updateAvailable && !isDownloading) {
      try {
        await downloadUpdate();
      } catch (error) {
        toast({
          title: t("controlPanel.update.couldNotDownloadTitle"),
          description: t("controlPanel.update.couldNotDownloadDescription"),
          variant: "destructive",
        });
      }
    }
  };

  const getUpdateButtonContent = () => {
    if (isInstalling) {
      return (
        <>
          <Loader2 size={14} className="animate-spin" />
          <span>{t("controlPanel.update.installing")}</span>
        </>
      );
    }
    if (isDownloading) {
      return (
        <>
          <Loader2 size={14} className="animate-spin" />
          <span>{Math.round(downloadProgress)}%</span>
        </>
      );
    }
    if (updateStatus.updateDownloaded) {
      return (
        <>
          <RefreshCw size={14} />
          <span>{t("controlPanel.update.installButton")}</span>
        </>
      );
    }
    if (updateStatus.updateAvailable) {
      return (
        <>
          <Download size={14} />
          <span>{t("controlPanel.update.availableButton")}</span>
        </>
      );
    }
    return null;
  };

  return (
    <div className="h-screen bg-background flex flex-col">
      <ConfirmDialog
        open={confirmDialog.open}
        onOpenChange={hideConfirmDialog}
        title={confirmDialog.title}
        description={confirmDialog.description}
        onConfirm={confirmDialog.onConfirm}
        variant={confirmDialog.variant}
      />

      <AlertDialog
        open={alertDialog.open}
        onOpenChange={hideAlertDialog}
        title={alertDialog.title}
        description={alertDialog.description}
        onOk={() => {}}
      />

      {showSettings && (
        <Suspense fallback={null}>
          <SettingsModal
            open={showSettings}
            onOpenChange={(open) => {
              setShowSettings(open);
              if (!open) setSettingsSection(undefined);
            }}
            initialSection={settingsSection}
          />
        </Suspense>
      )}

      <div
        data-window-titlebar
        className="shrink-0 select-none"
        style={
          {
            WebkitAppRegion: window.electronAPI.getPlatform() === "darwin" ? "no-drag" : "drag",
          } as React.CSSProperties
        }
      >
        <SpeechControls />
      </div>
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <ControlPanelSidebar
          activeView={activeView}
          onViewChange={setActiveView}
          onOpenSettings={() => {
            setSettingsSection(undefined);
            setShowSettings(true);
          }}
          updateAction={
            !updateStatus.isDevelopment &&
            (updateStatus.updateAvailable ||
              updateStatus.updateDownloaded ||
              isDownloading ||
              isInstalling) ? (
              <Button
                variant={updateStatus.updateDownloaded ? "default" : "outline"}
                size="sm"
                onClick={handleUpdateClick}
                disabled={isInstalling || isDownloading}
                className="gap-1.5 text-xs w-full h-7"
              >
                {getUpdateButtonContent()}
              </Button>
            ) : undefined
          }
        />
        <main className="min-h-0 min-w-0 flex-1 flex flex-col overflow-hidden">
          <div
            className={`min-h-0 flex-1 pt-1 ${activeView === "meetings" ? "flex flex-col overflow-hidden" : "overflow-y-auto"}`}
          >
            {activeView === "home" && (
              <HomeView
                history={history}
                isLoading={isLoading}
                hotkey={hotkey}
                copyToClipboard={copyToClipboard}
                deleteTranscription={deleteTranscription}
              />
            )}
            {activeView === "personal-notes" && (
              <Suspense fallback={null}>
                <PersonalNotesView
                  onOpenSettings={(section) => {
                    setSettingsSection(section);
                    setShowSettings(true);
                  }}
                />
              </Suspense>
            )}
            {activeView === "meetings" && (
              <Suspense fallback={null}>
                <MeetingsView />
              </Suspense>
            )}
            {activeView === "screen" && (
              <Suspense fallback={null}>
                <ScreenRecordingsView />
              </Suspense>
            )}
            {activeView === "dictionary" && (
              <Suspense fallback={null}>
                <DictionaryView />
              </Suspense>
            )}
            {activeView === "snippets" && (
              <Suspense fallback={null}>
                <SnippetsView />
              </Suspense>
            )}
            {activeView === "style" && (
              <Suspense fallback={null}>
                <StyleView />
              </Suspense>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
