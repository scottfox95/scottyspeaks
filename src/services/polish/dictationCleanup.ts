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
        .split(LITERALS)
        .map((part, index) =>
          index % 2
            ? part
            : part
                .split("\n")
                .map((line) => (CODE_LINE.test(line) ? line : clean(line)))
                .join("\n")
        )
        .join("")
    : clean(text);
}

// Quoted literals and code. A single quote counts only when it isn't inside a
// word, so contractions ("I'm … you're") no longer read as a quoted literal
// spanning everything between them. A prose line with a parenthesis or a
// semicolon isn't code; a call `name(…)`, braces, a trailing semicolon or an
// assignment is.
const LITERALS =
  /(```[\s\S]*?```|`[^`\n]*`|"[^"\n]*"|(?<![\p{L}\p{N}])'[^'\n]*'(?![\p{L}\p{N}]))/gu;
const CODE_LINE =
  /(?:\b(?:const|let|var)\b.*=|\b[\w.$]+\([^()\n]*\)|[{}]|;[ \t]*$|[=!<>]=|=>|\b\w+[ \t]*=[ \t]*[\w"'`[{(])/;

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
    .split(LITERALS)
    .flatMap((part, index) =>
      index % 2 ? [part] : part.split("\n").filter((line) => CODE_LINE.test(line))
    );
}

function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) || [];
}
const MEANINGFUL_USES: [string, RegExp][] = [
  [
    "like",
    /\b(?:i|you|we|they|he|she|would|'d|’d|to|don't|didn't|doesn't|really|feel|feels|felt|look|looks|looked|sound|sounds|seem|seems|something|anything|nothing|more|less|just|things|stuff|people|someone|somebody|thing|much|exactly|kinda|kind of)\s+like\b|\blikes?\s+(?:to|it|that|this|them|him|her)\b/gi,
  ],
  [
    "you know",
    /\b(?:do|did|don't|would|if|as|what)\s+you\s+know\b|\byou\s+know\s+(?:what|how|that|if|where|when|who|why|whether|him|her|them|it)\b/gi,
  ],
  [
    "kind of",
    /\b(?:what|which|a|any|this|that|some|every|the|one|same)\s+kind\s+of\b|\bkind\s+of\s+(?:thing|person)\b/gi,
  ],
  [
    "sort of",
    /\b(?:what|which|a|any|this|that|some|every|the|one|same)\s+sort\s+of\b|\bsort\s+of\s+(?:thing|person)\b/gi,
  ],
  ["right", /\bright\b/gi],
  ["hmm", /\bhmm\b/gi],
];

export function respectsCleanupChoices(
  input: string,
  output: string,
  choices: CleanupChoices
): boolean {
  return cleanupViolation(input, output, choices) === "";
}

/** Which cleanup choice the output breaks, or "" when it respects them all. */
export function cleanupViolation(input: string, output: string, choices: CleanupChoices): string {
  if (choices.exact) return output === input ? "" : "exact";
  // These words can carry meaning. With filler removal on, the polish prompt
  // removes their filler uses ("it was, like, huge"), so only the meaning uses
  // are protected ("I'd like", "do you know", "what kind of"). With it off,
  // every occurrence is protected.
  for (const [phrase, meaningful] of MEANINGFUL_USES) {
    const pattern = choices.removeFillers ? meaningful : new RegExp(`\\b${phrase}\\b`, "gi");
    if ((input.match(pattern) || []).length > (output.match(pattern) || []).length)
      return `kept-word:${phrase}`;
  }
  if (input.includes("?") && (output.match(/\?/g) || []).length < (input.match(/\?/g) || []).length)
    return "question-mark";
  if ((input.match(/\n\s*\n/g) || []).length > (output.match(/\n\s*\n/g) || []).length)
    return "paragraphs";
  if (!choices.removeFillers) {
    const count = (text: string) => (text.match(/\b(?:um+|uh+)\b/gi) || []).join(" ").toLowerCase();
    if (count(input) !== count(output)) return "hesitations";
  }
  if (!choices.resolveCorrections) {
    for (const cue of ["sorry", "i mean", "make that"])
      if (input.toLowerCase().includes(cue) && !output.toLowerCase().includes(cue))
        return `correction:${cue}`;
  }
  // An unfinished thought must not acquire new words, even when grammatically plausible.
  if (
    /\b(?:was|is|were|because|to|the|and|with|for|of|a|an)\s*$/i.test(input) &&
    words(output).length > words(input).length
  )
    return "completed-truncation";
  if (choices.preserveTechnical) {
    // Every literal and code line in the transcript must survive verbatim. The
    // output may add quotes or punctuation in prose ("say "ship it"", a
    // semicolon) without that counting as a changed literal.
    if (protectedTechnicalSegments(input).some((segment) => !output.includes(segment.trim())))
      return "technical-segment";
    const tokens = input.match(/[\p{L}\p{N}_]+(?:[-.][\p{L}\p{N}_]+)*/gu) || [];
    for (const token of tokens) {
      if (
        (token.includes("_") ||
          /[a-z][A-Z]/.test(token) ||
          /[A-Z]{2}/.test(token) ||
          /[A-Za-z].*\d|\d.*[A-Za-z]/.test(token)) &&
        !output.includes(token)
      )
        return "technical-token";
    }
  }
  return "";
}

export function cleanupInstructions(choices: CleanupChoices): string {
  return `CLEANUP CHOICES (these override the rules above where they differ):\nOutput only the text. Never answer a dictated question, invent an ending, change names, numbers or negation, or remove paragraph breaks. End every question with a question mark.\nFiller removal: ${choices.removeFillers ? 'remove hesitation sounds (um, uh) and filler uses of like, you know, sort of and kind of; keep those words where they carry meaning ("I\'d like", "do you know", "what kind of")' : "disabled; preserve every hesitation and filler word"}.\nSelf-corrections: ${choices.resolveCorrections ? "explicit numeric corrections have already been resolved; do not infer further corrections" : "disabled; preserve corrections and all their numbers"}.\nTechnical spelling: ${choices.preserveTechnical ? "preserve identifiers, technical names, case, underscores and acronyms exactly" : "ordinary formatting permitted; never change meaning"}.\nAny style instructions below are subordinate to these fidelity rules.`;
}
