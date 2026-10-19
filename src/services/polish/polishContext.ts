/**
 * Synchronous context cache for the dictation polish pass.
 *
 * getSystemPrompt() is synchronous, but the context it needs (active style
 * profile, frontmost app, learned style examples) comes from async IPC.
 * This module refreshes that context at recording start / profile change and
 * exposes it synchronously at prompt-build time.
 */

export interface PolishExample {
  before: string;
  after: string;
}

export interface PolishContext {
  styleId?: string;
  styleRules?: Record<string, any>;
  styleName: string;
  styleInstructions: string;
  appName: string;
  examples: PolishExample[];
  /** true when the active style profile opts out of AI polish (e.g. "Raw") */
  aiPolishDisabled: boolean;
}

const context: PolishContext = {
  styleName: "",
  styleInstructions: "",
  appName: "",
  examples: [],
  aiPolishDisabled: false,
};

const MAX_EXAMPLES = 4;
const MAX_EXAMPLE_CHARS = 420;

let refreshInFlight: Promise<void> | null = null;

/** Sync read used by getSystemPrompt(). */
export function getPolishContext(): PolishContext {
  return JSON.parse(JSON.stringify(context));
}

/** Formats the cached context as prompt blocks (empty string when nothing set). */
export function getPolishContextBlocks(contextOverride?: PolishContext): string {
  const context = contextOverride || getPolishContext();
  const blocks: string[] = [];

  if (context.appName) {
    blocks.push(
      `TARGET APP: The text will be typed into "${context.appName}". Match the writing conventions typical for that app (e.g. chat apps stay casual and compact; email apps get greetings/sign-offs only when spoken; code editors and terminals get plain text with no markdown).`
    );
  }

  if (context.styleInstructions) {
    const name = context.styleName ? ` ("${context.styleName}")` : "";
    blocks.push(`ACTIVE STYLE PROFILE${name}:\n${context.styleInstructions}`);
  }

  if (context.examples.length > 0) {
    const rendered = context.examples
      .map((ex) => `Input: ${ex.before}\nOutput: ${ex.after}`)
      .join("\n\n");
    blocks.push(
      `LEARNED PREFERENCES — the user previously corrected outputs like this; match their preferred style:\n\n${rendered}`
    );
  }

  return blocks.length ? "\n\n" + blocks.join("\n\n") : "";
}

/** Fire-and-forget refresh; safe to call often (coalesces concurrent calls). */
export function refreshPolishContext(options: { appName?: string } = {}): Promise<void> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = doRefresh(options.appName).finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function doRefresh(appName?: string): Promise<void> {
  const api = (window as any).electronAPI;
  if (!api) return;

  try {
    const [profile, appInfo, examples] = await Promise.all([
      api.getActiveStyleProfile?.().catch(() => null),
      // Native target capture already identified the destination. Reuse it to
      // avoid another process launch before the microphone can start.
      appName ? { name: appName } : api.getFrontmostApp?.().catch(() => null),
      api.getStyleExamples?.(MAX_EXAMPLES).catch(() => []),
    ]);

    if (profile) {
      context.styleId = String(profile.id);
      context.styleName = profile.name || "";
      try {
        const rules = JSON.parse(profile.rules || "{}");
        context.styleRules = rules;
        context.styleInstructions = (rules.instructions || "").trim();
        context.aiPolishDisabled = rules.aiPolish === false;
      } catch {
        context.styleRules = undefined;
        context.styleInstructions = "";
        context.aiPolishDisabled = false;
      }
    } else {
      context.styleId = undefined;
      context.styleRules = undefined;
      context.styleName = "";
      context.styleInstructions = "";
      context.aiPolishDisabled = false;
    }

    context.appName = appInfo?.name || "";

    context.examples = Array.isArray(examples)
      ? examples
          .filter(
            (ex: PolishExample) =>
              ex?.before && ex?.after && ex.before.length + ex.after.length <= MAX_EXAMPLE_CHARS
          )
          .slice(0, MAX_EXAMPLES)
      : [];
  } catch {
    // Keep last known context on failure
  }
}
