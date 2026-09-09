import React, { useEffect, useState } from "react";
import {
  Home,
  NotebookPen,
  BookOpen,
  Scissors,
  Paintbrush,
  Settings,
  HelpCircle,
  Headphones,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "./lib/utils";
import SupportDropdown from "./ui/SupportDropdown";

export type ControlPanelView =
  | "home"
  | "personal-notes"
  | "meetings"
  | "dictionary"
  | "snippets"
  | "style";

interface ControlPanelSidebarProps {
  activeView: ControlPanelView;
  onViewChange: (view: ControlPanelView) => void;
  onOpenSettings: () => void;
  updateAction?: React.ReactNode;
}

export default function ControlPanelSidebar({
  activeView,
  onViewChange,
  onOpenSettings,
  updateAction,
}: ControlPanelSidebarProps) {
  const { t } = useTranslation();
  const [callRecording, setCallRecording] = useState(false);
  useEffect(() => {
    let mounted = true;
    const refresh = () =>
      window.electronAPI.meetings
        ?.captureStatus()
        .then((result) => {
          if (mounted && result.success) setCallRecording(!!result.data.id);
        })
        .catch(() => {});
    refresh();
    const timer = setInterval(refresh, 1500);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, []);

  const navItems: {
    id: ControlPanelView;
    label: string;
    icon: React.ComponentType<{ size?: number; className?: string }>;
  }[] = [
    { id: "home", label: t("sidebar.home"), icon: Home },
    { id: "dictionary", label: t("sidebar.dictionary"), icon: BookOpen },
    { id: "snippets", label: "Snippets", icon: Scissors },
    { id: "style", label: "Style", icon: Paintbrush },
    { id: "meetings", label: t("meetings.title"), icon: Headphones },
    { id: "personal-notes", label: t("sidebar.notes"), icon: NotebookPen },
  ];

  return (
    <div className="w-48 shrink-0 border-r border-border/15 dark:border-white/6 flex flex-col bg-surface-1/60 dark:bg-surface-1">
      <div className="h-4 shrink-0" aria-hidden="true" />

      {/* App title */}
      <div className="select-none px-3 pb-4">
        <span
          className="text-sm font-semibold text-foreground tracking-tight"
          style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}
        >
          SS2
        </span>
      </div>

      <nav className="flex flex-col gap-0.5 px-2 pb-2">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = activeView === item.id;

          return (
            <button
              key={item.id}
              onClick={() => onViewChange(item.id)}
              className={cn(
                "group relative flex items-center gap-2.5 w-full h-8 px-2.5 rounded-md outline-none transition-colors duration-150 text-left",
                "focus-visible:ring-1 focus-visible:ring-primary/30",
                isActive
                  ? "bg-primary/8 dark:bg-primary/10"
                  : "hover:bg-foreground/4 dark:hover:bg-white/4 active:bg-foreground/6"
              )}
            >
              {isActive && (
                <div className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-3.5 rounded-r-full bg-primary" />
              )}
              <Icon
                size={15}
                className={cn(
                  "shrink-0 transition-colors duration-150",
                  isActive
                    ? "text-primary"
                    : "text-foreground/60 group-hover:text-foreground/75 dark:text-foreground/55 dark:group-hover:text-foreground/70"
                )}
              />
              <span
                className={cn(
                  "text-xs transition-colors duration-150",
                  isActive
                    ? "text-foreground font-medium"
                    : "text-foreground/80 group-hover:text-foreground dark:text-foreground/75 dark:group-hover:text-foreground/90"
                )}
              >
                {item.label}
              </span>
            </button>
          );
        })}
      </nav>

      {callRecording && (
        <button
          type="button"
          onClick={() => onViewChange("meetings")}
          className="mx-2 flex items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-left text-xs text-foreground"
          aria-live="polite"
        >
          <span className="size-2 shrink-0 rounded-full bg-destructive" />
          {t("meetings.recordingBadge")}
        </button>
      )}
      <div className="flex-1" />

      <div className="px-2 pb-2 space-y-0.5">
        {updateAction && (
          <div className="px-1 pb-1" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
            {updateAction}
          </div>
        )}

        <button
          onClick={onOpenSettings}
          aria-label={t("sidebar.settings")}
          className="group flex items-center gap-2.5 w-full h-8 px-2.5 rounded-md text-left outline-none hover:bg-foreground/4 dark:hover:bg-white/4 focus-visible:ring-1 focus-visible:ring-primary/30 transition-colors duration-150"
        >
          <Settings
            size={15}
            className="shrink-0 text-foreground/60 group-hover:text-foreground/75 dark:text-foreground/50 dark:group-hover:text-foreground/65 transition-colors duration-150"
          />
          <span className="text-xs text-foreground/80 group-hover:text-foreground dark:text-foreground/70 dark:group-hover:text-foreground/85 transition-colors duration-150">
            {t("sidebar.settings")}
          </span>
        </button>

        <SupportDropdown
          trigger={
            <button
              aria-label={t("sidebar.support")}
              className="group flex items-center gap-2.5 w-full h-8 px-2.5 rounded-md text-left outline-none hover:bg-foreground/4 dark:hover:bg-white/4 focus-visible:ring-1 focus-visible:ring-primary/30 transition-colors duration-150"
            >
              <HelpCircle
                size={15}
                className="shrink-0 text-foreground/60 group-hover:text-foreground/75 dark:text-foreground/50 dark:group-hover:text-foreground/65 transition-colors duration-150"
              />
              <span className="text-xs text-foreground/80 group-hover:text-foreground dark:text-foreground/70 dark:group-hover:text-foreground/85 transition-colors duration-150">
                {t("sidebar.support")}
              </span>
            </button>
          }
        />
      </div>
    </div>
  );
}
