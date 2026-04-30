import { useState, useEffect, useCallback } from "react";
import { Check, Plus, Trash2, Pencil } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "./ui/dialog";
import { applyStyleRules, type StyleRules } from "../services/StyleProcessor";

interface StyleProfile {
  id: number;
  name: string;
  rules: string;
  is_active: number;
  created_at: string;
  updated_at: string;
}

const PREVIEW_TEXT =
  "um so basically I wanna tell you about this thing that happened yesterday like it was pretty crazy you know";

const DEFAULT_RULES: StyleRules = {
  removeFillers: true,
  capitalization: "sentence",
  autoPunctuation: true,
  formality: "none",
};

export default function StyleView() {
  const [profiles, setProfiles] = useState<StyleProfile[]>([]);
  const [showDialog, setShowDialog] = useState(false);
  const [editingProfile, setEditingProfile] = useState<StyleProfile | null>(null);
  const [name, setName] = useState("");
  const [rules, setRules] = useState<StyleRules>(DEFAULT_RULES);
  const [error, setError] = useState("");

  const loadProfiles = useCallback(async () => {
    const data = await window.electronAPI?.getStyleProfiles?.();
    if (data) setProfiles(data);
  }, []);

  useEffect(() => {
    loadProfiles();
  }, [loadProfiles]);

  const activeProfile = profiles.find((p) => p.is_active === 1);

  const setActive = async (id: number | null) => {
    await window.electronAPI?.setActiveStyleProfile?.(id);
    loadProfiles();
  };

  const openAddDialog = () => {
    setEditingProfile(null);
    setName("");
    setRules(DEFAULT_RULES);
    setError("");
    setShowDialog(true);
  };

  const openEditDialog = (profile: StyleProfile) => {
    setEditingProfile(profile);
    setName(profile.name);
    try {
      setRules(JSON.parse(profile.rules));
    } catch {
      setRules(DEFAULT_RULES);
    }
    setError("");
    setShowDialog(true);
  };

  const handleSave = async () => {
    setError("");
    if (!name.trim()) {
      setError("Profile name is required.");
      return;
    }

    if (editingProfile) {
      const result = await window.electronAPI?.updateStyleProfile?.(editingProfile.id, {
        name: name.trim(),
        rules,
      });
      if (result?.success) {
        setShowDialog(false);
        loadProfiles();
      } else {
        setError(result?.error || "Failed to update profile.");
      }
    } else {
      const result = await window.electronAPI?.createStyleProfile?.(name.trim(), rules);
      if (result?.success) {
        setShowDialog(false);
        loadProfiles();
      } else {
        setError(result?.error || "Failed to create profile.");
      }
    }
  };

  const handleDelete = async (id: number) => {
    await window.electronAPI?.deleteStyleProfile?.(id);
    loadProfiles();
  };

  const getParsedRules = (profile: StyleProfile): StyleRules => {
    try {
      return JSON.parse(profile.rules);
    } catch {
      return DEFAULT_RULES;
    }
  };

  const previewResult = applyStyleRules(PREVIEW_TEXT, rules);

  return (
    <div className="px-4 pt-4 pb-6">
      <div className="max-w-3xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-semibold text-foreground">Style</h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              {activeProfile
                ? `Active: ${activeProfile.name}`
                : "No style active — raw transcription"}
            </p>
          </div>
          <Button onClick={openAddDialog} size="sm" className="gap-1.5">
            <Plus size={14} />
            New profile
          </Button>
        </div>

        {/* Profiles list */}
        <div className="space-y-2">
          {profiles.map((profile) => {
            const parsed = getParsedRules(profile);
            const isActive = profile.is_active === 1;

            return (
              <div
                key={profile.id}
                className={`group relative rounded-lg border p-4 transition-colors ${
                  isActive
                    ? "border-primary/30 bg-primary/4 dark:bg-primary/6"
                    : "border-border/50 bg-card/50 dark:bg-card/60 hover:bg-card/80"
                }`}
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="text-sm font-medium text-foreground">{profile.name}</span>
                      {isActive && (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-primary/10 text-[10px] font-medium text-primary">
                          <Check size={10} />
                          Active
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {parsed.removeFillers && (
                        <Tag>No fillers</Tag>
                      )}
                      {parsed.capitalization !== "none" && (
                        <Tag>{parsed.capitalization} case</Tag>
                      )}
                      {parsed.autoPunctuation && (
                        <Tag>Auto-punctuation</Tag>
                      )}
                      {parsed.formality !== "none" && (
                        <Tag>{parsed.formality}</Tag>
                      )}
                      {parsed.greeting && <Tag>Greeting</Tag>}
                      {parsed.signoff && <Tag>Sign-off</Tag>}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 ml-3">
                    {!isActive && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => setActive(profile.id)}
                      >
                        Activate
                      </Button>
                    )}
                    {isActive && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs text-muted-foreground"
                        onClick={() => setActive(null)}
                      >
                        Deactivate
                      </Button>
                    )}
                    <button
                      onClick={() => openEditDialog(profile)}
                      className="p-1.5 rounded-md hover:bg-foreground/5 text-muted-foreground hover:text-foreground transition-colors opacity-0 group-hover:opacity-100"
                    >
                      <Pencil size={12} />
                    </button>
                    <button
                      onClick={() => handleDelete(profile.id)}
                      className="p-1.5 rounded-md hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors opacity-0 group-hover:opacity-100"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>

                {/* Preview */}
                {isActive && (
                  <div className="mt-3 pt-3 border-t border-border/30">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                          Before
                        </span>
                        <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                          {PREVIEW_TEXT}
                        </p>
                      </div>
                      <div>
                        <span className="text-[10px] font-medium text-primary uppercase tracking-wide">
                          After
                        </span>
                        <p className="text-xs text-foreground mt-1 leading-relaxed">
                          {applyStyleRules(PREVIEW_TEXT, parsed)}
                        </p>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {profiles.length === 0 && (
          <div className="rounded-lg border border-border bg-card/50 dark:bg-card/60 backdrop-blur-sm p-8 text-center">
            <h2 className="text-lg font-semibold text-foreground mb-2">
              Make ScottySpeaks sound like you.
            </h2>
            <p className="text-sm text-muted-foreground mb-4">
              Style profiles clean up your dictation automatically — remove filler words,
              fix capitalization, adjust formality, and more.
            </p>
            <Button onClick={openAddDialog} size="sm" className="gap-1.5">
              <Plus size={14} />
              Create your first profile
            </Button>
          </div>
        )}

        {/* Add/Edit dialog */}
        <Dialog open={showDialog} onOpenChange={setShowDialog}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>
                {editingProfile ? "Edit style profile" : "New style profile"}
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div>
                <label className="text-xs font-medium text-foreground mb-1.5 block">
                  Profile name
                </label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Work Email"
                  className="text-sm"
                />
              </div>

              <div className="space-y-3">
                <label className="text-xs font-medium text-foreground block">Rules</label>

                <ToggleRow
                  label="Remove filler words"
                  description="Removes um, uh, like, you know, etc."
                  checked={rules.removeFillers}
                  onChange={(v) => setRules({ ...rules, removeFillers: v })}
                />

                <SelectRow
                  label="Capitalization"
                  value={rules.capitalization}
                  options={[
                    { value: "none", label: "None" },
                    { value: "sentence", label: "Sentence case" },
                    { value: "title", label: "Title Case" },
                  ]}
                  onChange={(v) =>
                    setRules({ ...rules, capitalization: v as StyleRules["capitalization"] })
                  }
                />

                <ToggleRow
                  label="Auto-punctuation"
                  description="Adds period at end of text if missing"
                  checked={rules.autoPunctuation}
                  onChange={(v) => setRules({ ...rules, autoPunctuation: v })}
                />

                <SelectRow
                  label="Formality"
                  value={rules.formality}
                  options={[
                    { value: "none", label: "No change" },
                    { value: "casual", label: "Casual" },
                    { value: "formal", label: "Formal" },
                  ]}
                  onChange={(v) =>
                    setRules({ ...rules, formality: v as StyleRules["formality"] })
                  }
                />

                <div>
                  <label className="text-xs text-foreground/80 mb-1 block">
                    Greeting (optional)
                  </label>
                  <Input
                    value={rules.greeting || ""}
                    onChange={(e) =>
                      setRules({ ...rules, greeting: e.target.value || undefined })
                    }
                    placeholder='e.g. "Hi,"'
                    className="text-sm"
                  />
                </div>

                <div>
                  <label className="text-xs text-foreground/80 mb-1 block">
                    Sign-off (optional)
                  </label>
                  <Input
                    value={rules.signoff || ""}
                    onChange={(e) =>
                      setRules({ ...rules, signoff: e.target.value || undefined })
                    }
                    placeholder='e.g. "Best, Scott"'
                    className="text-sm"
                  />
                </div>
              </div>

              {/* Live preview */}
              <div className="rounded-md border border-border/50 bg-surface-1/50 p-3">
                <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                  Preview
                </span>
                <p className="text-xs text-foreground mt-1.5 leading-relaxed whitespace-pre-line">
                  {previewResult}
                </p>
              </div>

              {error && <p className="text-xs text-destructive">{error}</p>}
            </div>
            <DialogFooter>
              <Button variant="outline" size="sm" onClick={() => setShowDialog(false)}>
                Cancel
              </Button>
              <Button size="sm" onClick={handleSave}>
                {editingProfile ? "Save changes" : "Create profile"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="px-1.5 py-0.5 rounded-md bg-surface-1 dark:bg-white/6 border border-border/40 text-[10px] text-muted-foreground">
      {children}
    </span>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between">
      <div>
        <span className="text-xs text-foreground">{label}</span>
        {description && (
          <p className="text-[10px] text-muted-foreground">{description}</p>
        )}
      </div>
      <button
        onClick={() => onChange(!checked)}
        className={`relative w-8 h-4.5 rounded-full transition-colors ${
          checked ? "bg-primary" : "bg-foreground/15"
        }`}
      >
        <div
          className={`absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white shadow-sm transition-transform ${
            checked ? "translate-x-4" : "translate-x-0.5"
          }`}
        />
      </button>
    </div>
  );
}

function SelectRow({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs text-foreground">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="text-xs bg-transparent border border-border/50 rounded-md px-2 py-1 text-foreground outline-none focus:ring-1 focus:ring-primary/30"
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}
