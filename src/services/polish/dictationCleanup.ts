export interface CleanupChoices {
  exact: boolean;
  removeFillers: boolean;
  resolveCorrections: boolean;
  preserveTechnical: boolean;
}

export function cleanupChoices(settings: Record<string, any>): CleanupChoices {
  return {
    exact: settings.dictationExact ?? settings.polishStyle === "verbatim",
    removeFillers: settings.dictationRemoveFillers ?? true,
    resolveCorrections: settings.dictationResolveCorrections ?? false,
    preserveTechnical: settings.dictationPreserveTechnical ?? true,
  };
}

const hesitation = /(?<![\p{L}\p{N}_])(?:um+|uh+)(?![\p{L}\p{N}_])[ \t]*,?[ \t]*/giu;
/** Only adjacent numeric replacements with an explicit cue are unambiguous enough
 * to resolve automatically. Never infer a correction from ordinary negation. */
export function applyDictationCleanup(text: string, choices: CleanupChoices): string {
  if (choices.exact) return text;
  const clean = (value: string) => {
    let result = choices.removeFillers ? value.replace(hesitation, "") : value;
    if (choices.resolveCorrections)
      result = result.replace(
        /(?<![\w.,+-])(\d+(?:\.\d+)?),[ \t]*(?:sorry|I mean|make that),?[ \t]+(\d+(?:\.\d+)?)(?![\w]|[.,]\d)/gi,
        "$2"
      );
    return result;
  };
  // Code and quoted literals are evidence, even when an identifier happens to
  // be an English hesitation sound. Preserve both words and numeric literals.
  return choices.preserveTechnical
    ? text
        .split(/(```[\s\S]*?```|`[^`\n]*`|"[^"\n]*"|'[^'\n]*')/g)
        .map((part, index) =>
          index % 2
            ? part
            : part
                .split("\n")
                .map((line) =>
                  /(?:\b(?:const|let|var)\b.*=|\b\w+\s*\(|[{};=])/.test(line) ? line : clean(line)
                )
                .join("\n")
        )
        .join("")
    : clean(text);
}

/** An explicit address at the start is a command; mentioning a person is not. */
export function isNamedDictationCommand(text: string, agentName?: string | null): boolean {
  if (!agentName?.trim()) return false;
  const name = agentName.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^(?:(?:hey|hi|okay|ok)[,\\s]+${name}(?=[,!:\\s])|${name}\\s*[,!:])`,
    "iu"
  ).test(text.trim());
}

// These are the same conservative code/literal boundaries used by deterministic
// cleanup. Compare exact segments rather than lexical words: case and operators
// are part of executable code, while prose outside the segments can still change.
function protectedTechnicalSegments(text: string): string[] {
  return text
    .split(/(```[\s\S]*?```|`[^`\n]*`|"[^"\n]*"|'[^'\n]*')/g)
    .flatMap((part, index) =>
      index % 2
        ? [part]
        : part
            .split("\n")
            .filter((line) => /(?:\b(?:const|let|var)\b.*=|\b\w+\s*\(|[{};=])/.test(line))
    );
}

function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) || [];
}
export function respectsCleanupChoices(
  input: string,
  output: string,
  choices: CleanupChoices
): boolean {
  if (choices.exact) return output === input;
  // These words can carry meaning; hesitation cleanup never licenses deleting them.
  for (const phrase of ["like", "you know", "kind of", "sort of", "right", "hmm"]) {
    const pattern = new RegExp(`\\b${phrase}\\b`, "gi");
    if ((input.match(pattern) || []).length > (output.match(pattern) || []).length) return false;
  }
  if (input.includes("?") && (output.match(/\?/g) || []).length < (input.match(/\?/g) || []).length)
    return false;
  if ((input.match(/\n\s*\n/g) || []).length > (output.match(/\n\s*\n/g) || []).length)
    return false;
  if (!choices.removeFillers) {
    const count = (text: string) => (text.match(/\b(?:um+|uh+)\b/gi) || []).join(" ").toLowerCase();
    if (count(input) !== count(output)) return false;
  }
  if (!choices.resolveCorrections) {
    for (const cue of ["sorry", "i mean", "make that"])
      if (input.toLowerCase().includes(cue) && !output.toLowerCase().includes(cue)) return false;
  }
  // An unfinished thought must not acquire new words, even when grammatically plausible.
  if (
    /\b(?:was|is|were|because|to|the|and|with|for|of|a|an)\s*$/i.test(input) &&
    words(output).length > words(input).length
  )
    return false;
  if (choices.preserveTechnical) {
    const originalSegments = protectedTechnicalSegments(input);
    const outputSegments = protectedTechnicalSegments(output);
    if (
      originalSegments.length !== outputSegments.length ||
      originalSegments.some((segment, index) => segment !== outputSegments[index])
    )
      return false;
    const tokens = input.match(/[\p{L}\p{N}_]+(?:[-.][\p{L}\p{N}_]+)*/gu) || [];
    for (const token of tokens) {
      if (
        (token.includes("_") ||
          /[a-z][A-Z]/.test(token) ||
          /[A-Z]{2}/.test(token) ||
          /[A-Za-z].*\d|\d.*[A-Za-z]/.test(token)) &&
        !output.includes(token)
      )
        return false;
    }
  }
  return true;
}

export function cleanupInstructions(choices: CleanupChoices): string {
  return `Faithfully format this dictation. Output only the text. Never answer a dictated question, invent an ending, change names, numbers or negation, or remove paragraph breaks.\nHesitation removal: ${choices.removeFillers ? "only um/uh hesitation sounds; keep meaningful words like like and you know" : "disabled; preserve every hesitation"}.\nSelf-corrections: ${choices.resolveCorrections ? "explicit numeric corrections have already been resolved; do not infer further corrections" : "disabled; preserve corrections and all their numbers"}.\nTechnical spelling: ${choices.preserveTechnical ? "preserve identifiers, technical names, case, underscores and acronyms exactly" : "ordinary formatting permitted; never change meaning"}.\nAny style instructions below are subordinate to these fidelity rules.`;
}
