/**
 * Voice commands: the third pedal switch (or any "command" trigger) records a
 * spoken instruction ("make that more formal", "turn this into bullet
 * points") and applies it to the currently selected text — or, with nothing
 * selected, to the user's last dictation.
 */
import ReasoningService from "../ReasoningService";
import { getEffectiveReasoningModel } from "../../stores/settingsStore";

const COMMAND_PROMPT = `You are a text-editing engine inside a dictation app. The user spoke an INSTRUCTION describing how to transform the TEXT.

- Output ONLY the transformed text. No commentary, no preamble, no quotes around it.
- Apply the instruction faithfully but minimally — change only what it asks for.
- Preserve the text's meaning and any parts the instruction doesn't touch.
- If the instruction asks a question about the text instead of a transformation, output the text unchanged.`;

export interface VoiceCommandResult {
  ok: boolean;
  text?: string;
  /** The text the instruction was applied to (used to replace it in place) */
  target?: string;
  usedSelection?: boolean;
  error?: "no-target" | "no-model" | "failed";
}

export async function applyVoiceCommand(
  instruction: string,
  lastPastedText?: string | null,
  targetToken?: string | null
): Promise<VoiceCommandResult> {
  const api = (window as any).electronAPI;
  if (!instruction?.trim()) return { ok: false, error: "no-target" };

  let target: string | null = null;
  let usedSelection = false;

  try {
    const selection = await api.captureSelectedText?.(targetToken);
    if (selection?.text?.trim()) {
      target = selection.text;
      usedSelection = true;
    }
  } catch {
    // fall through to the last dictation
  }

  // Prefer what we actually pasted (post snippet/style processing) over the
  // stored transcription — it's what's really on screen.
  if (!target && lastPastedText?.trim()) {
    target = lastPastedText;
  }

  if (!target) {
    try {
      const rows = await api.getTranscriptions?.(1);
      target = rows?.[0]?.text || null;
    } catch {
      target = null;
    }
  }

  if (!target?.trim()) return { ok: false, error: "no-target" };

  const model = getEffectiveReasoningModel();
  if (!model) return { ok: false, error: "no-model" };

  try {
    const user = `INSTRUCTION: ${instruction.trim()}\n\nTEXT:\n${target}`;
    const result = await ReasoningService.processText(user, model, null, {
      systemPrompt: COMMAND_PROMPT,
      temperature: 0.2,
    });
    const text = (result || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    if (!text) return { ok: false, error: "failed" };
    return { ok: true, text, target, usedSelection };
  } catch {
    return { ok: false, error: "failed" };
  }
}
