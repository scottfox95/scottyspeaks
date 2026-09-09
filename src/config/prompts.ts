import promptData from "./promptData.json";
import i18n, { normalizeUiLanguage } from "../i18n";
import { en as enPrompts, type PromptBundle } from "../locales/prompts";
import { getLanguageInstruction } from "../utils/languageSupport";
import { cleanupInstructions, type CleanupChoices } from "../services/polish/dictationCleanup";
import type { PolishContext } from "../services/polish/polishContext";
import { getPolishContextBlocks } from "../services/polish/polishContext";

export const CLEANUP_PROMPT = promptData.CLEANUP_PROMPT;
export const FULL_PROMPT = promptData.FULL_PROMPT;
/** @deprecated Use FULL_PROMPT instead — kept for PromptStudio backwards compat */
export const UNIFIED_SYSTEM_PROMPT = promptData.FULL_PROMPT;
export const LEGACY_PROMPTS = promptData.LEGACY_PROMPTS;

function getPromptBundle(uiLanguage?: string): PromptBundle {
  const locale = normalizeUiLanguage(uiLanguage || "en");
  const t = i18n.getFixedT(locale, "prompts");

  return {
    cleanupPrompt: t("cleanupPrompt", { defaultValue: enPrompts.cleanupPrompt }),
    verbatimPrompt: t("verbatimPrompt", { defaultValue: enPrompts.verbatimPrompt }),
    fullPrompt: t("fullPrompt", { defaultValue: enPrompts.fullPrompt }),
    dictionarySuffix: t("dictionarySuffix", { defaultValue: enPrompts.dictionarySuffix }),
  };
}

/**
 * Verbatim is a separate prompt rather than an instruction appended to the
 * cleanup prompt: layering "keep the filler" on top of "remove the filler"
 * measured as barely different from default (53% vs 41% filler kept), whereas
 * a standalone prompt with no removal contract keeps 100%.
 */
function getPolishStyle(): "verbatim" | "balanced" {
  if (typeof window === "undefined" || !window.localStorage) return "balanced";
  return window.localStorage.getItem("polishStyle") === "verbatim" ? "verbatim" : "balanced";
}

function detectAgentName(transcript: string, agentName: string): boolean {
  const lower = transcript.toLowerCase();
  const name = agentName.toLowerCase();

  if (lower.includes(name)) return true;

  const variants: string[] = [];

  return variants.some((v) => lower.includes(v));
}

export function getSystemPrompt(
  agentName: string | null,
  customDictionary?: string[],
  language?: string,
  transcript?: string,
  uiLanguage?: string,
  capture?: { cleanup: CleanupChoices; context: PolishContext; command?: boolean }
): string {
  const name = agentName?.trim() || "Assistant";
  const prompts = getPromptBundle(uiLanguage);

  if (capture && !capture.command) {
    // Dictation capture uses an explicit immutable contract; commands use their own service.
    let prompt = cleanupInstructions(capture.cleanup);
    const instruction = getLanguageInstruction(language);
    if (instruction) prompt += "\n\n" + instruction;
    if (customDictionary?.length) prompt += prompts.dictionarySuffix + customDictionary.join(", ");
    return prompt + getPolishContextBlocks(capture.context);
  }
  let promptTemplate: string | null = null;
  if (typeof window !== "undefined" && window.localStorage) {
    const customPrompt = window.localStorage.getItem("customUnifiedPrompt");
    if (customPrompt) {
      try {
        promptTemplate = JSON.parse(customPrompt);
      } catch {
        // Use default if parsing fails
      }
    }
  }

  let prompt: string;
  if (promptTemplate) {
    prompt = promptTemplate.replace(/\{\{agentName\}\}/g, name);
  } else {
    const useFullPrompt = capture?.command || !transcript || detectAgentName(transcript, name);
    // Agent-addressed commands always use the full prompt — Verbatim only
    // governs how plain dictation is cleaned up.
    const base = useFullPrompt
      ? prompts.fullPrompt
      : getPolishStyle() === "verbatim"
        ? prompts.verbatimPrompt
        : prompts.cleanupPrompt;
    prompt = base.replace(/\{\{agentName\}\}/g, name);
  }

  const langInstruction = getLanguageInstruction(language);
  if (langInstruction) {
    prompt += "\n\n" + langInstruction;
  }

  if (customDictionary && customDictionary.length > 0) {
    prompt += prompts.dictionarySuffix + customDictionary.join(", ");
  }

  // Style profile, target app, and learned corrections (cached async, read sync)
  if (!capture?.command) prompt += getPolishContextBlocks(capture?.context);

  return prompt;
}

export function getWordBoost(customDictionary?: string[]): string[] {
  if (!customDictionary || customDictionary.length === 0) return [];
  return customDictionary.filter((w) => w.trim());
}

export default {
  CLEANUP_PROMPT,
  FULL_PROMPT,
  UNIFIED_SYSTEM_PROMPT,
  getSystemPrompt,
  getWordBoost,
  LEGACY_PROMPTS,
};
