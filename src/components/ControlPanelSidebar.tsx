import React, { useEffect, useState } from "react";
import {
  AudioLines,
  NotebookPen,
  BookOpen,
  Scissors,
  Paintbrush,
  Settings,
  Headphones,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "./lib/utils";

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

  const navGroups = [
    {
      label: t("workspace.workspace"),
      items: [
        { id: "home", label: t("workspace.dictation"), icon: AudioLines },
        { id: "meetings", label: t("meetings.title"), icon: Headphones },
        { id: "personal-notes", label: t("sidebar.notes"), icon: NotebookPen },
      ],
    },
    {
      label: t("workspace.personalize"),
      items: [
        { id: "dictionary", label: t("sidebar.dictionary"), icon: BookOpen },
        { id: "snippets", label: t("workspace.snippets"), icon: Scissors },
        { id: "style", label: t("workspace.style"), icon: Paintbrush },
      ],
    },
  ];

  return (
    <div className="flex w-48 shrink-0 flex-col border-r border-border bg-surface-1/60 max-[700px]:w-14">
      <div className="h-4 shrink-0" aria-hidden="true" />

      {/* App title */}
      <div className="select-none px-5 pb-7 max-[700px]:px-3">
        <span
          className="text-xl font-semibold text-foreground tracking-tight"
          style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}
        >
          SS2
        </span>
      </div>

      <nav className="flex flex-col gap-6 px-2 pb-4" aria-label={t("workspace.navigation")}>
        {navGroups.map((group) => (
          <div key={group.label} className="flex flex-col gap-1">
            <span className="mb-1 px-3 text-[10px] font-medium uppercase tracking-widest text-muted-foreground max-[700px]:sr-only">
              {group.label}
            </span>
            {group.items.map((item) => {
              const Icon = item.icon;
              const active = activeView === item.id;
              return (
                <button
                  key={item.id}
                  title={item.label}
                  aria-label={item.label}
                  aria-current={active ? "page" : undefined}
                  onClick={() => onViewChange(item.id as ControlPanelView)}
                  className={cn(
                    "press-tactile flex min-h-10 w-full items-center gap-3 rounded-lg px-3 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring max-[700px]:justify-center max-[700px]:px-0",
                    active
                      ? "bg-card font-medium text-foreground shadow-[var(--shadow-card)]"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  )}
                >
                  <Icon size={17} className="shrink-0" />
                  <span className="max-[700px]:hidden">{item.label}</span>
                  {item.id === "meetings" && callRecording && (
                    <span className="size-1.5 rounded-full bg-destructive" />
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      {callRecording && (
        <button
          type="button"
          onClick={() => onViewChange("meetings")}
          className="press-tactile mx-2 flex items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-left text-xs text-foreground max-[700px]:hidden"
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
          className="press-tactile flex min-h-10 w-full items-center gap-3 rounded-lg px-3 text-left text-muted-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring max-[700px]:justify-center max-[700px]:px-0"
        >
          <Settings
            size={15}
            className="shrink-0 text-foreground/60 group-hover:text-foreground/75 dark:text-foreground/50 dark:group-hover:text-foreground/65 transition-colors duration-150"
          />
          <span className="text-sm max-[700px]:hidden">{t("sidebar.settings")}</span>
        </button>
      </div>
    </div>
  );
}
