import { useState, useCallback, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { BookOpen, X, CornerDownLeft, Info, Mic } from "lucide-react";
import { Input } from "./ui/input";
import { ConfirmDialog } from "./ui/dialog";
import TeachWordDialog from "./TeachWordDialog";
import { useSettings } from "../hooks/useSettings";
import { getAgentName } from "../utils/agentName";
import type { DictionaryAlias } from "../types/electron";

export default function DictionaryView() {
  const { t } = useTranslation();
  const { customDictionary, setCustomDictionary } = useSettings();
  const agentName = getAgentName();
  const [newWord, setNewWord] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [aliases, setAliases] = useState<DictionaryAlias[]>([]);
  const [teaching, setTeaching] = useState<string | null>(null);

  const isEmpty = customDictionary.length === 0;

  // "Sounds like" aliases live in SQLite; the main process is the source of truth.
  useEffect(() => {
    const api = window.electronAPI;
    let active = true;
    api?.getDictionaryAliases?.()
      .then((list) => {
        if (active && Array.isArray(list)) setAliases(list);
      })
      .catch(() => {});
    const unsubscribe = api?.onDictionaryAliasesUpdated?.((list) => {
      if (Array.isArray(list)) setAliases(list);
    });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, []);

  const aliasesByWord = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const entry of aliases) {
      const key = entry.word.toLocaleLowerCase();
      map.set(key, [...(map.get(key) || []), entry.alias]);
    }
    return map;
  }, [aliases]);
  const aliasesFor = (word: string) => aliasesByWord.get(word.toLocaleLowerCase()) || [];

  const handleAdd = useCallback(() => {
    const words = newWord
      .split(",")
      .map((w) => w.trim())
      .filter((w) => w && !customDictionary.includes(w));
    if (words.length > 0) {
      setCustomDictionary([...customDictionary, ...words]);
      setNewWord("");
    }
  }, [newWord, customDictionary, setCustomDictionary]);

  const handleRemove = useCallback(
    (word: string) => {
      if (word === agentName) return;
      setCustomDictionary(customDictionary.filter((w) => w !== word));
    },
    [customDictionary, setCustomDictionary, agentName]
  );

  const removeAlias = async (alias: string) => {
    try {
      const list = await window.electronAPI.removeDictionaryAlias(alias);
      if (Array.isArray(list)) setAliases(list);
    } catch {}
  };

  const saveAliases = async (word: string, next: string[]) => {
    const list = await window.electronAPI.setWordAliases(word, next);
    if (Array.isArray(list)) setAliases(list);
  };

  const wordsWithAliases = customDictionary.filter((word) => aliasesFor(word).length > 0);

  return (
    <div className="flex flex-col h-full">
      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title={t("dictionary.clearTitle")}
        description={t("dictionary.clearDescription")}
        onConfirm={() => setCustomDictionary(customDictionary.filter((w) => w === agentName))}
        variant="destructive"
      />
      <TeachWordDialog
        word={teaching}
        aliases={teaching ? aliasesFor(teaching) : []}
        dictionary={customDictionary}
        onOpenChange={(open) => {
          if (!open) setTeaching(null);
        }}
        onSave={saveAliases}
      />

      {isEmpty ? (
        /* ─── Empty state ─── */
        <div className="flex-1 flex flex-col items-center justify-center px-8 -mt-4">
          <div className="w-10 h-10 rounded-[10px] bg-gradient-to-b from-primary/8 to-primary/4 dark:from-primary/12 dark:to-primary/6 border border-primary/10 dark:border-primary/15 flex items-center justify-center mb-4">
            <BookOpen
              size={17}
              strokeWidth={1.5}
              className="text-primary/50 dark:text-primary/60"
            />
          </div>

          <h2 className="text-xs font-semibold text-foreground mb-1">{t("dictionary.title")}</h2>
          <p className="text-xs text-foreground/30 text-center leading-relaxed max-w-[240px] mb-6">
            {t("dictionary.description")}
          </p>

          <div className="w-full max-w-[260px] relative">
            <Input
              placeholder={t("dictionary.addPlaceholder")}
              value={newWord}
              onChange={(e) => setNewWord(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleAdd();
              }}
              className="w-full h-8 text-xs pr-8 placeholder:text-foreground/20"
            />
            {newWord.trim() ? (
              <button
                onClick={handleAdd}
                aria-label={t("dictionary.addWord")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-primary/50 hover:text-primary transition-colors"
              >
                <CornerDownLeft size={11} />
              </button>
            ) : (
              <kbd className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-foreground/12 font-mono select-none pointer-events-none">
                ⏎
              </kbd>
            )}
          </div>

          <div className="flex items-center gap-1.5 mt-3">
            {["ScottySpeaks", "Dr. Smith", "gRPC"].map((ex) => (
              <span
                key={ex}
                className="text-xs text-foreground/12 px-1.5 py-0.5 rounded-[4px] border border-dashed border-foreground/6 dark:border-white/5"
              >
                {ex}
              </span>
            ))}
          </div>

          <div className="mt-8 w-full max-w-[260px]">
            <button
              onClick={() => setShowInfo(!showInfo)}
              aria-expanded={showInfo}
              aria-label={t("dictionary.howItWorks")}
              className="flex items-center gap-1 text-xs text-foreground/15 hover:text-foreground/30 transition-colors mx-auto"
            >
              <Info size={9} />
              {t("dictionary.howItWorks")}
            </button>
            {showInfo && (
              <div className="mt-2.5 rounded-md bg-foreground/[0.02] dark:bg-white/[0.02] border border-foreground/5 dark:border-white/4 px-3 py-2.5">
                <p className="text-xs text-foreground/25 leading-[1.6]">
                  {t("dictionary.howItWorksDetail")}
                </p>
              </div>
            )}
          </div>
        </div>
      ) : (
        /* ─── Populated state ─── */
        <>
          <div className="px-5 pt-4 pb-2.5 flex items-baseline justify-between">
            <div className="flex items-baseline gap-2">
              <h2 className="text-xs font-semibold text-foreground">{t("dictionary.title")}</h2>
              <span className="text-xs text-foreground/15 font-mono tabular-nums">
                {customDictionary.length}
              </span>
            </div>
            <button
              onClick={() => setConfirmClear(true)}
              aria-label={t("dictionary.clearAll")}
              className="text-xs text-foreground/15 hover:text-destructive/70 transition-colors"
            >
              {t("dictionary.clearAll")}
            </button>
          </div>

          <div className="px-5 pb-3">
            <div className="relative">
              <Input
                placeholder={t("dictionary.addPlaceholder")}
                value={newWord}
                onChange={(e) => setNewWord(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleAdd();
                }}
                className="w-full h-7 text-xs pr-8 placeholder:text-foreground/20"
              />
              {newWord.trim() ? (
                <button
                  onClick={handleAdd}
                  aria-label={t("dictionary.addWord")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-primary/50 hover:text-primary transition-colors"
                >
                  <CornerDownLeft size={10} />
                </button>
              ) : (
                <kbd className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-foreground/12 font-mono select-none pointer-events-none">
                  ⏎
                </kbd>
              )}
            </div>
          </div>

          <div className="mx-5 h-px bg-border/8 dark:bg-white/3" />

          <div className="flex-1 overflow-y-auto px-5 py-3">
            <div className="flex flex-wrap gap-1.5">
              {customDictionary.map((word) => {
                const isAgentName = word === agentName;
                const taught = aliasesFor(word).length;
                return (
                  <span
                    key={word}
                    className={`group inline-flex items-center gap-1 py-[3px]
                      rounded-[5px] text-xs
                      border transition-colors duration-150
                      ${
                        isAgentName
                          ? "pl-2.5 pr-2.5 bg-primary/10 dark:bg-primary/15 text-primary border-primary/20 dark:border-primary/30"
                          : "pl-2.5 pr-1 bg-foreground/[0.02] dark:bg-white/[0.03] text-foreground/60 dark:text-foreground/50 border-foreground/8 dark:border-white/6 hover:border-foreground/15 dark:hover:border-white/12 hover:bg-foreground/[0.04] dark:hover:bg-white/[0.06] hover:text-foreground/80 dark:hover:text-foreground/70"
                      }`}
                    title={isAgentName ? t("dictionary.autoManaged") : undefined}
                  >
                    {word}
                    {!isAgentName && (
                      <>
                        <button
                          onClick={() => setTeaching(word)}
                          aria-label={t("dictionary.teachWord", { word })}
                          title={t("dictionary.teachWord", { word })}
                          className={`p-0.5 rounded-sm transition-colors duration-150 hover:!text-primary ${
                            taught
                              ? "text-primary/60"
                              : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 text-foreground/25"
                          }`}
                        >
                          <Mic size={10} strokeWidth={2} />
                        </button>
                        <button
                          onClick={() => handleRemove(word)}
                          aria-label={t("dictionary.removeWord", { word })}
                          className="p-0.5 rounded-sm
                            opacity-0 group-hover:opacity-100 group-focus-within:opacity-100
                            text-foreground/25 hover:!text-destructive/70
                            transition-colors duration-150"
                        >
                          <X size={10} strokeWidth={2} />
                        </button>
                      </>
                    )}
                  </span>
                );
              })}
            </div>

            {wordsWithAliases.length > 0 && (
              <section className="mt-5 flex flex-col gap-2" aria-label={t("dictionary.soundsLike")}>
                <h3 className="text-xs font-semibold text-foreground">{t("dictionary.soundsLike")}</h3>
                <ul className="flex flex-col gap-1.5">
                  {wordsWithAliases.map((word) => (
                    <li key={word} className="flex flex-wrap items-center gap-1.5 text-xs">
                      <button
                        onClick={() => setTeaching(word)}
                        className="font-medium text-foreground hover:text-primary"
                        title={t("dictionary.teachWord", { word })}
                      >
                        {word}
                      </button>
                      <span className="text-foreground/30" aria-hidden="true">
                        ←
                      </span>
                      {aliasesFor(word).map((alias) => (
                        <span
                          key={alias}
                          className="inline-flex items-center gap-1 rounded-[5px] border border-foreground/8 dark:border-white/6 bg-foreground/[0.02] dark:bg-white/[0.03] py-[2px] pl-2 pr-1 text-foreground/60"
                        >
                          {alias}
                          <button
                            onClick={() => void removeAlias(alias)}
                            aria-label={t("dictionary.removeAlias", { alias })}
                            className="p-0.5 rounded-sm text-foreground/25 hover:!text-destructive/70 transition-colors duration-150"
                          >
                            <X size={10} strokeWidth={2} />
                          </button>
                        </span>
                      ))}
                    </li>
                  ))}
                </ul>
                <p className="text-xs text-foreground/25 leading-relaxed">
                  {t("dictionary.soundsLikeHint")}
                </p>
              </section>
            )}
          </div>

          <div className="px-5 pb-3 flex items-start gap-1.5">
            <Info size={9} className="text-foreground/10 mt-px shrink-0" />
            <p className="text-xs text-foreground/12 leading-relaxed">
              {t("dictionary.inputHint")}
            </p>
          </div>
        </>
      )}
    </div>
  );
}
