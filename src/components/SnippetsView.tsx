import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Pencil, Trash2, ArrowRight, Search } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "./ui/dialog";

interface Snippet {
  id: number;
  keyword: string;
  expansion: string;
  use_count: number;
  created_at: string;
  updated_at: string;
}

export default function SnippetsView() {
  const { t } = useTranslation();
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [showDialog, setShowDialog] = useState(false);
  const [editingSnippet, setEditingSnippet] = useState<Snippet | null>(null);
  const [keyword, setKeyword] = useState("");
  const [expansion, setExpansion] = useState("");
  const [error, setError] = useState("");

  const loadSnippets = useCallback(async () => {
    const data = await window.electronAPI?.getSnippets?.();
    if (data) setSnippets(data);
  }, []);

  useEffect(() => {
    loadSnippets();
  }, [loadSnippets]);

  const filteredSnippets = searchQuery
    ? snippets.filter(
        (s) =>
          s.keyword.toLowerCase().includes(searchQuery.toLowerCase()) ||
          s.expansion.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : snippets;

  const openAddDialog = () => {
    setEditingSnippet(null);
    setKeyword("");
    setExpansion("");
    setError("");
    setShowDialog(true);
  };

  const openEditDialog = (snippet: Snippet) => {
    setEditingSnippet(snippet);
    setKeyword(snippet.keyword);
    setExpansion(snippet.expansion);
    setError("");
    setShowDialog(true);
  };

  const handleSave = async () => {
    setError("");
    if (!keyword.trim() || !expansion.trim()) {
      setError("Both keyword and expansion are required.");
      return;
    }

    if (editingSnippet) {
      const result = await window.electronAPI?.updateSnippet?.(editingSnippet.id, {
        keyword: keyword.trim(),
        expansion: expansion.trim(),
      });
      if (result?.success) {
        setShowDialog(false);
        loadSnippets();
      } else {
        setError(result?.error || "Failed to update snippet.");
      }
    } else {
      const result = await window.electronAPI?.createSnippet?.(keyword.trim(), expansion.trim());
      if (result?.success) {
        setShowDialog(false);
        loadSnippets();
      } else {
        setError(result?.error || "Failed to create snippet.");
      }
    }
  };

  const handleDelete = async (id: number) => {
    await window.electronAPI?.deleteSnippet?.(id);
    loadSnippets();
  };

  const examples = [
    { keyword: "my email", expansion: "scott.f.tenenbaum@gmail.com" },
    { keyword: "linkedin", expansion: "https://linkedin.com/in/..." },
    { keyword: "intro", expansion: "Hey, would love to find some time to chat..." },
  ];

  return (
    <div className="px-4 pt-4 pb-6">
      <div className="max-w-3xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-xl font-semibold text-foreground">Snippets</h1>
          <Button onClick={openAddDialog} size="sm" className="gap-1.5">
            <Plus size={14} />
            Add new
          </Button>
        </div>

        {/* Empty state */}
        {snippets.length === 0 && (
          <div className="rounded-lg border border-border bg-card/50 dark:bg-card/60 backdrop-blur-sm p-8 mb-4">
            <h2 className="text-lg font-semibold text-foreground mb-2" style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}>
              The stuff you shouldn't have to re-type.
            </h2>
            <p className="text-sm text-muted-foreground mb-4">
              Save shortcuts to speak the things you type all the time — emails, links, addresses,
              bios — anything.{" "}
              <strong>Just speak and ScottySpeaks expands them instantly</strong>, without retyping
              or hunting through old messages.
            </p>
            <div className="flex flex-wrap gap-2 mb-4">
              {examples.map((ex) => (
                <div
                  key={ex.keyword}
                  className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-surface-1 dark:bg-white/6 border border-border/50 text-xs"
                >
                  <span className="font-medium text-foreground">{ex.keyword}</span>
                  <ArrowRight size={12} className="text-muted-foreground" />
                  <span className="text-muted-foreground truncate max-w-[200px]">
                    {ex.expansion}
                  </span>
                </div>
              ))}
            </div>
            <Button onClick={openAddDialog} size="sm" className="gap-1.5">
              <Plus size={14} />
              Add new snippet
            </Button>
          </div>
        )}

        {/* Search (only show when there are snippets) */}
        {snippets.length > 0 && (
          <div className="relative mb-4">
            <Search
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search snippets..."
              className="pl-9 h-8 text-xs"
            />
          </div>
        )}

        {/* Snippet list */}
        {filteredSnippets.length > 0 && (
          <div className="space-y-1.5">
            {filteredSnippets.map((snippet) => (
              <div
                key={snippet.id}
                className="group flex items-center gap-3 p-3 rounded-lg border border-border/50 bg-card/50 dark:bg-card/60 hover:bg-card/80 transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-xs font-medium text-foreground">{snippet.keyword}</span>
                    <ArrowRight size={12} className="text-muted-foreground shrink-0" />
                    <span className="text-xs text-muted-foreground truncate">
                      {snippet.expansion}
                    </span>
                  </div>
                  {snippet.use_count > 0 && (
                    <span className="text-[10px] text-muted-foreground/60">
                      Used {snippet.use_count} time{snippet.use_count !== 1 ? "s" : ""}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => openEditDialog(snippet)}
                    className="p-1.5 rounded-md hover:bg-foreground/5 text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    onClick={() => handleDelete(snippet.id)}
                    className="p-1.5 rounded-md hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Add/Edit dialog */}
        <Dialog open={showDialog} onOpenChange={setShowDialog}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{editingSnippet ? "Edit snippet" : "Add new snippet"}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div>
                <label className="text-xs font-medium text-foreground mb-1.5 block">
                  Keyword trigger
                </label>
                <Input
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                  placeholder='e.g. "my email"'
                  className="text-sm"
                />
                <p className="text-[11px] text-muted-foreground mt-1">
                  Say this phrase to trigger the expansion
                </p>
              </div>
              <div>
                <label className="text-xs font-medium text-foreground mb-1.5 block">
                  Expansion text
                </label>
                <textarea
                  value={expansion}
                  onChange={(e) => setExpansion(e.target.value)}
                  placeholder="e.g. scott.f.tenenbaum@gmail.com"
                  rows={3}
                  className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                />
                <p className="text-[11px] text-muted-foreground mt-1">
                  This text will be pasted when you say the keyword
                </p>
              </div>
              {error && <p className="text-xs text-destructive">{error}</p>}
            </div>
            <DialogFooter>
              <Button variant="outline" size="sm" onClick={() => setShowDialog(false)}>
                Cancel
              </Button>
              <Button size="sm" onClick={handleSave}>
                {editingSnippet ? "Save changes" : "Add snippet"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
