export interface StyleRules {
  removeFillers: boolean;
  capitalization: "none" | "sentence" | "title";
  autoPunctuation: boolean;
  formality: "none" | "casual" | "formal";
  greeting?: string;
  signoff?: string;
}

const FILLER_WORDS = [
  "um",
  "uh",
  "uhh",
  "umm",
  "hmm",
  "like",
  "you know",
  "I mean",
  "sort of",
  "kind of",
  "basically",
  "literally",
  "actually",
  "right",
  "so yeah",
];

const FORMAL_SUBSTITUTIONS: Record<string, string> = {
  gonna: "going to",
  wanna: "want to",
  gotta: "got to",
  kinda: "kind of",
  sorta: "sort of",
  lemme: "let me",
  gimme: "give me",
  dunno: "don't know",
  yeah: "yes",
  yep: "yes",
  nope: "no",
  nah: "no",
  hey: "hello",
  hi: "hello",
  ok: "okay",
  "a lot": "significantly",
  stuff: "items",
  thing: "matter",
  things: "matters",
  "pretty much": "essentially",
  "a bunch of": "several",
};

function removeFillers(text: string): string {
  // Sort by length descending so multi-word fillers get matched first
  const sorted = [...FILLER_WORDS].sort((a, b) => b.length - a.length);
  let result = text;
  for (const filler of sorted) {
    // Match filler as a whole word/phrase, case-insensitive
    const regex = new RegExp(
      `\\b${filler.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b[,]?\\s*`,
      "gi"
    );
    result = result.replace(regex, "");
  }
  // Clean up double spaces
  return result.replace(/\s{2,}/g, " ").trim();
}

function applyCasualFormality(text: string): string {
  // No transformations needed for casual — just clean up
  return text;
}

function applyFormalFormality(text: string): string {
  let result = text;
  // Sort substitutions by key length descending for multi-word matches first
  const entries = Object.entries(FORMAL_SUBSTITUTIONS).sort(
    (a, b) => b[0].length - a[0].length
  );
  for (const [informal, formal] of entries) {
    const regex = new RegExp(
      `\\b${informal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
      "gi"
    );
    result = result.replace(regex, formal);
  }
  return result;
}

function applySentenceCapitalization(text: string): string {
  // Capitalize first letter and after sentence-ending punctuation
  return text.replace(/(^|[.!?]\s+)([a-z])/g, (_match, prefix, char) =>
    prefix + char.toUpperCase()
  );
}

function applyTitleCapitalization(text: string): string {
  const minorWords = new Set([
    "a", "an", "the", "and", "but", "or", "for", "nor",
    "on", "at", "to", "by", "in", "of", "up",
  ]);
  return text
    .split(" ")
    .map((word, i) => {
      if (i === 0 || !minorWords.has(word.toLowerCase())) {
        return word.charAt(0).toUpperCase() + word.slice(1);
      }
      return word;
    })
    .join(" ");
}

function applyAutoPunctuation(text: string): string {
  let result = text.trim();
  // Add period at end if no ending punctuation
  if (result && !/[.!?]$/.test(result)) {
    result += ".";
  }
  return result;
}

export function applyStyleRules(text: string, rules: StyleRules): string {
  if (!text || !rules) return text;

  let result = text;

  // 1. Remove filler words
  if (rules.removeFillers) {
    result = removeFillers(result);
  }

  // 2. Apply formality
  if (rules.formality === "formal") {
    result = applyFormalFormality(result);
  } else if (rules.formality === "casual") {
    result = applyCasualFormality(result);
  }

  // 3. Capitalization
  if (rules.capitalization === "sentence") {
    result = applySentenceCapitalization(result);
  } else if (rules.capitalization === "title") {
    result = applyTitleCapitalization(result);
  }

  // 4. Auto-punctuation
  if (rules.autoPunctuation) {
    result = applyAutoPunctuation(result);
  }

  // 5. Greeting/signoff
  if (rules.greeting) {
    result = `${rules.greeting}\n\n${result}`;
  }
  if (rules.signoff) {
    result = `${result}\n\n${rules.signoff}`;
  }

  return result;
}

export function previewStyle(text: string, rules: StyleRules): { before: string; after: string } {
  return {
    before: text,
    after: applyStyleRules(text, rules),
  };
}
