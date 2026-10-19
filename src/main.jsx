import { SpeechProvider } from "./hooks/useSpeech";
import React, { Suspense, useState, useEffect } from "react";
import ReactDOM from "react-dom/client";
import { I18nextProvider, useTranslation } from "react-i18next";
import ErrorBoundary from "./components/ErrorBoundary.tsx";
import { ToastProvider } from "./components/ui/Toast.tsx";
import { SettingsProvider } from "./hooks/useSettings";
import { useTheme } from "./hooks/useTheme";
import i18n, { i18nReady } from "./i18n";
import "./index.css";

const controlPanelImport = () => import("./components/ControlPanel.tsx");
const onboardingFlowImport = () => import("./components/OnboardingFlow.tsx");
const dictationAppImport = () => import("./App.jsx");
const ControlPanel = React.lazy(controlPanelImport);
const OnboardingFlow = React.lazy(onboardingFlowImport);
const App = React.lazy(dictationAppImport);

let root = null;

// Wait for the saved language before the first frame; English is already local.
void i18nReady.then(mountApp);

function AppRouter() {
  useTheme();

  const [showOnboarding, setShowOnboarding] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  const isControlPanel =
    window.location.pathname.includes("control") || window.location.search.includes("panel=true");
  const isDictationPanel = !isControlPanel;

  // Preload lazy chunks
  useEffect(() => {
    if (isControlPanel) {
      controlPanelImport().catch(() => {});
      if (!localStorage.getItem("onboardingCompleted")) {
        onboardingFlowImport().catch(() => {});
      }
    } else {
      dictationAppImport().catch(() => {});
    }
  }, [isControlPanel]);

  useEffect(() => {
    const onboardingCompleted = localStorage.getItem("onboardingCompleted") === "true";

    if (isControlPanel && !onboardingCompleted) {
      setShowOnboarding(true);
    }

    if (isDictationPanel && !onboardingCompleted) {
      const rawStep = parseInt(localStorage.getItem("onboardingCurrentStep") || "0");
      const currentStep = Math.max(0, Math.min(rawStep, 5));
      if (currentStep < 4) {
        window.electronAPI?.hideWindow?.();
      }
    }

    setIsLoading(false);
  }, [isControlPanel, isDictationPanel]);

  const handleOnboardingComplete = () => {
    setShowOnboarding(false);
    localStorage.setItem("onboardingCompleted", "true");
  };

  if (isLoading) {
    return <LoadingFallback />;
  }

  if (isControlPanel && showOnboarding) {
    return (
      <Suspense fallback={<LoadingFallback />}>
        <OnboardingFlow onComplete={handleOnboardingComplete} />
      </Suspense>
    );
  }

  return isControlPanel ? (
    <Suspense fallback={<LoadingFallback />}>
      <ControlPanel />
    </Suspense>
  ) : (
    <Suspense fallback={<LoadingFallback />}>
      <App />
    </Suspense>
  );
}

function LoadingFallback({ message }) {
  const { t } = useTranslation();
  const fallbackMessage = message || t("common.loading");
  const [stuck, setStuck] = useState(false);

  // If we're still here after 15s something went wrong — give the user a way
  // out instead of an infinite spinner.
  useEffect(() => {
    const timer = setTimeout(() => setStuck(true), 15000);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="min-h-screen bg-background flex items-center justify-center">
      <div className="flex flex-col items-center gap-4 animate-[scale-in_300ms_ease-out]">
        <div className="text-2xl font-bold text-primary">SS2</div>
        <div className="w-7 h-7 rounded-full border-[2.5px] border-transparent border-t-primary animate-[spinner-rotate_0.8s_cubic-bezier(0.4,0,0.2,1)_infinite] motion-reduce:animate-none motion-reduce:border-t-muted-foreground motion-reduce:opacity-50" />
        {fallbackMessage && (
          <p className="text-[13px] font-medium text-muted-foreground dark:text-foreground/60 tracking-[-0.01em]">
            {stuck
              ? t("common.loadingStuck", {
                  defaultValue: "Still loading — something may be wrong.",
                })
              : fallbackMessage}
          </p>
        )}
        {stuck && (
          <button
            onClick={() => window.location.reload()}
            className="press-tactile text-xs font-medium text-primary border border-border rounded-full px-4 py-1.5 hover:bg-muted/50"
          >
            {t("common.reload", { defaultValue: "Reload" })}
          </button>
        )}
      </div>
    </div>
  );
}

function mountApp() {
  if (!root) {
    root = ReactDOM.createRoot(document.getElementById("root"));
  }
  root.render(
    <React.StrictMode>
      <ErrorBoundary>
        <I18nextProvider i18n={i18n}>
          <SettingsProvider>
            <ToastProvider>
              <SpeechProvider>
                <AppRouter />
              </SpeechProvider>
            </ToastProvider>
          </SettingsProvider>
        </I18nextProvider>
      </ErrorBoundary>
    </React.StrictMode>
  );
}

if (import.meta.hot) {
  import.meta.hot.accept();
}
