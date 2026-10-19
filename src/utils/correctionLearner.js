/**
 * Extracts transcription corrections by diffing original text against
 * the edited field value. Returns corrected words to add to the custom dictionary.
 */

// The 250 most frequent English words. A custom dictionary exists to bias
// recognition toward names and jargon; adding ordinary words dilutes that
// signal in the prompt and makes the genuinely rare terms matter less.
const COMMON_WORDS = new Set(
  `the be to of and a in that have i it for not on with he as you do at this but his by from they we
   say her she or an will my one all would there their what so up out if about who get which go me
   when make can like time no just him know take people into year your good some could them see other
   than then now look only come its over think also back after use two how our work first well way
   even new want because any these give day most us is are was were been being has had did does said
   made made find here thing many where much before great little own under while should must may might
   through same too very still such last long own right down off again few both between another around
   during without within always never sometimes often really quite pretty maybe actually basically
   thanks thank hey hi hello yes yeah yea okay ok sure please sorry going gonna got getting went come
   coming making taking looking trying doing having saying telling told tell asked ask need needed
   needs let lets put set keep keeping start started stop stopped run running open opening close
   closed read reading write writing send sent sending call called calling talk talked talking
   question questions answer answers thing things stuff lot lots bit kind sort type kinds sorts types
   today tomorrow yesterday morning afternoon evening night week month year years months weeks days
   day hour hours minute minutes second seconds file files folder folders email emails message
   messages number numbers list lists name names word words line lines page pages part parts end
   ends side sides place places case cases point points fact facts idea ideas reason reasons problem
   problems issue issues change changes update updates check checks help helps team teams company
   companies project projects work works job jobs meeting meetings call calls client clients customer
   customers user users know knew known think thought thinking say says said see saw seen let land
   loose lose their there theyre share sharing shared command commands compliance`
    .split(/\s+/)
    .filter(Boolean)
);

/**
 * True when a corrected word is worth storing in the custom dictionary —
 * i.e. it looks like a name, brand, or piece of jargon rather than an
 * ordinary word or a tokenizer artifact.
 */
function isDictionaryWorthy(word) {
  const clean = word.trim();
  if (clean.length < 3) return false;

  // Tokenizer artifacts: two sentences glued together. A period followed by
  // a capital ("background.Keep") is glue; followed by lowercase it's a real
  // name ("whisper.cpp", "node.js"). ?!,;: are never valid inside a word.
  if (/\p{Ll}\.\p{Lu}/u.test(clean)) return false;
  if (/\p{L}[?!,;:]\p{L}/u.test(clean)) return false;
  // Lowercase after a dot is ambiguous: "whisper.cpp" is a real name,
  // "friend.which" is two glued words. Real suffixes are short (cpp, js, io).
  if (clean.includes(".")) {
    const [, ...rest] = clean.replace(/\.$/, "").split(".");
    if (rest.some((seg) => seg.length > 4)) return false;
  }

  // Must contain letters, and can't be mostly punctuation/digits
  if (!/\p{L}/u.test(clean)) return false;
  const letters = (clean.match(/\p{L}/gu) || []).length;
  if (letters < clean.length * 0.6) return false;

  const bare = clean.replace(/[^\p{L}\p{N}'.’-]/gu, "").toLocaleLowerCase();
  if (!bare) return false;

  // Distinctive shapes are always worth keeping: internal capitals
  // (OpenWhispr), dotted terms (whisper.cpp), hyphenated compounds.
  const hasInternalCaps = /\p{Ll}\p{Lu}/u.test(clean);
  const hasDotOrHyphen = /[.-]/.test(clean.slice(1, -1));
  if (hasInternalCaps || hasDotOrHyphen) return true;

  // Otherwise reject ordinary vocabulary
  if (COMMON_WORDS.has(bare)) return false;

  return true;
}

/** Levenshtein edit distance between two strings */
function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }
  return dp[m][n];
}

/** Tokenize text into words, stripping punctuation from edges */
function tokenize(text) {
  return text
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}_]+|[^\p{L}\p{N}_]+$/gu, ""))
    .filter((w) => w.length > 0);
}

/**
 * Find the region in fieldValue that corresponds to the pasted originalText.
 * If the field only contains the pasted text, returns fieldValue as-is.
 */
function findEditedRegion(originalText, fieldValue) {
  const idx = fieldValue.indexOf(originalText);
  if (idx !== -1) {
    return originalText;
  }

  // Sliding window: find the region with highest word overlap
  const origWords = tokenize(originalText);
  const fieldWords = tokenize(fieldValue);
  const windowSize = origWords.length;

  if (fieldWords.length <= windowSize) {
    return fieldValue;
  }

  let bestStart = 0;
  let bestScore = -1;

  for (let i = 0; i <= fieldWords.length - windowSize; i++) {
    let matches = 0;
    for (let j = 0; j < windowSize; j++) {
      if (fieldWords[i + j].toLocaleLowerCase() === origWords[j].toLocaleLowerCase()) {
        matches++;
      }
    }
    if (matches > bestScore) {
      bestScore = matches;
      bestStart = i;
    }
  }

  // A loose match can mistake edits elsewhere in the application for changes
  // to the paste. Require most of the original words to remain anchored.
  if (bestScore < Math.ceil(windowSize * 0.7)) {
    return fieldValue;
  }

  return fieldWords.slice(bestStart, bestStart + windowSize).join(" ");
}

/** Position-preserving [originalWord, editedWord] substitution pairs. */
function findSubstitutions(origWords, editedWords) {
  if (origWords.length !== editedWords.length) return [];
  return origWords.flatMap((word, index) =>
    word === editedWords[index] ? [] : [[word, editedWords[index]]]
  );
}

/**
 * Extract corrected words from a user's edits to pasted transcription text.
 *
 * @param {string} originalText - The text that was originally pasted (from transcription)
 * @param {string} fieldValue - The current value of the text field (after user edits)
 * @param {string[]} existingDictionary - Words already in the custom dictionary
 * @returns {string[]} Array of corrected words to add to the dictionary
 */
function extractCorrections(originalText, fieldValue, existingDictionary) {
  if (!originalText || !fieldValue) return [];
  if (originalText === fieldValue) return [];

  const editedRegion = findEditedRegion(originalText, fieldValue);
  if (editedRegion === originalText) return [];

  const origWords = tokenize(originalText);
  const editedWords = tokenize(editedRegion);

  if (origWords.length === 0 || editedWords.length === 0) return [];
  // Insertions and deletions are often unrelated edits elsewhere in the target
  // application. Only learn isolated, position-preserving word corrections.
  if (origWords.length !== editedWords.length) return [];

  const stableWords = origWords.filter(
    (word, index) => word.toLocaleLowerCase() === editedWords[index].toLocaleLowerCase()
  ).length;
  if (origWords.length > 1 && stableWords < Math.ceil(origWords.length * 0.5)) return [];

  // If more than 50% of words changed, this is a rewrite, not corrections
  const subs = findSubstitutions(origWords, editedWords);
  if (subs.length > origWords.length * 0.5) return [];

  const dictSet = new Set(normalizeDictionaryWords(existingDictionary));
  const seenCorrections = new Set();
  const results = [];

  for (const [origWord, correctedWord] of subs) {
    const normalizedCorrected = correctedWord.toLocaleLowerCase();

    if (dictSet.has(correctedWord)) continue;
    if (seenCorrections.has(normalizedCorrected)) continue;
    if (origWord === correctedWord) continue;
    if (correctedWord.length < 3) continue;

    // A custom dictionary is for names and jargon the recognizer gets wrong.
    // Ordinary English words add no signal and dilute the ones that matter,
    // so an unfiltered learner slowly poisons its own dictionary.
    if (!isDictionaryWorthy(correctedWord)) continue;

    // 0.65 threshold allows phonetic corrections like "Shunade" → "Sinead" (dist 4/7 = 0.57)
    // while filtering out unrelated word replacements.
    const dist = editDistance(origWord.toLocaleLowerCase(), correctedWord.toLocaleLowerCase());
    const maxLen = Math.max(origWord.length, correctedWord.length);
    if (dist / maxLen > 0.65) continue;

    results.push(correctedWord);
    seenCorrections.add(normalizedCorrected);
  }

  return results;
}

function normalizeDictionaryWords(words) {
  return Array.isArray(words)
    ? words
        .filter((word) => typeof word === "string")
        .map((word) => word.trim())
        .filter(Boolean)
    : [];
}

function applyDictionaryCorrections(text, dictionary) {
  if (typeof text !== "string" || !text) return text;

  const canonicalByLower = new Map();
  for (const word of normalizeDictionaryWords(dictionary)) {
    const normalized = word.toLocaleLowerCase();
    if (!canonicalByLower.has(normalized)) canonicalByLower.set(normalized, word);
  }
  if (canonicalByLower.size === 0) return text;

  const alternatives = [...canonicalByLower.keys()]
    .sort((a, b) => b.length - a.length)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}\\p{M}_])(?:${alternatives.join("|")})(?![\\p{L}\\p{N}\\p{M}_])`,
    "giu"
  );

  return text.replace(pattern, (match) => canonicalByLower.get(match.toLocaleLowerCase()) || match);
}

function mergeDictionaryCorrections(existingDictionary, corrections) {
  let dictionary = normalizeDictionaryWords(existingDictionary);
  const undoEntries = [];
  const learned = [];

  for (const correction of normalizeDictionaryWords(corrections)) {
    const normalized = correction.toLocaleLowerCase();
    const matches = dictionary
      .map((word, index) => ({ word, index }))
      .filter(({ word }) => word.toLocaleLowerCase() === normalized);
    if (matches.length === 1 && matches[0].word === correction) continue;

    const insertionIndex = matches.length > 0 ? matches[0].index : dictionary.length;
    dictionary = dictionary.filter((word) => word.toLocaleLowerCase() !== normalized);
    dictionary.splice(Math.min(insertionIndex, dictionary.length), 0, correction);
    undoEntries.push({ word: correction, previous: matches, index: insertionIndex });
    learned.push(correction);
  }

  return { dictionary, learned, undoEntries };
}

function undoDictionaryCorrections(currentDictionary, undoEntries) {
  let dictionary = normalizeDictionaryWords(currentDictionary);
  for (const entry of Array.isArray(undoEntries) ? undoEntries : []) {
    if (!entry || typeof entry.word !== "string") continue;
    const normalized = entry.word.toLocaleLowerCase();
    dictionary = dictionary.filter((word) => word !== entry.word);
    if (dictionary.some((word) => word.toLocaleLowerCase() === normalized)) continue;

    const previous = Array.isArray(entry.previous) ? entry.previous : [];
    for (const prior of [...previous].sort((a, b) => a.index - b.index)) {
      if (!prior || typeof prior.word !== "string") continue;
      dictionary.splice(Math.min(Math.max(prior.index, 0), dictionary.length), 0, prior.word);
    }
  }
  return dictionary;
}

// ---------------------------------------------------------------------------
// "Sounds like" aliases
//
// The local recognizer cannot be taught a pronunciation, so names it keeps
// mishearing ("Aravo" → "bravo", "a rather") are fixed at the text level: each
// dictionary word may carry aliases, and any whole-word match of an alias is
// replaced by the word's exact spelling before polish and again before paste.
// Aliases are learned from the user's edits and from the "teach it" recorder.
// ---------------------------------------------------------------------------

const ALIAS_MAX_WORDS = 4;

/** Lowercase, punctuation-free, single-spaced form used to match an alias. */
function normalizeAlias(value) {
  if (typeof value !== "string") return "";
  return value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}'’\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeAliasEntries(aliases) {
  const seen = new Set();
  const entries = [];
  for (const entry of Array.isArray(aliases) ? aliases : []) {
    if (!entry || typeof entry.word !== "string") continue;
    const word = entry.word.trim();
    const alias = normalizeAlias(entry.alias);
    if (!word || !alias || alias === word.toLocaleLowerCase() || seen.has(alias)) continue;
    seen.add(alias);
    entries.push({ word, alias });
  }
  return entries;
}

/**
 * Replaces every whole-word occurrence of an alias with its dictionary word.
 * Longer aliases win over shorter ones ("a rather" before "rather").
 */
function applyDictionaryAliases(text, aliases) {
  if (typeof text !== "string" || !text) return text;
  const entries = normalizeAliasEntries(aliases);
  if (entries.length === 0) return text;

  const wordByAlias = new Map(entries.map(({ word, alias }) => [alias, word]));
  const alternatives = [...wordByAlias.keys()]
    .sort((a, b) => b.length - a.length)
    .map((alias) =>
      alias
        .split(" ")
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("\\s+")
    );
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}\\p{M}_])(?:${alternatives.join("|")})(?![\\p{L}\\p{N}\\p{M}_])`,
    "giu"
  );
  return text.replace(pattern, (match) => wordByAlias.get(normalizeAlias(match)) ?? match);
}

/** Word-level diff hunks: consecutive removed/added tokens between equal runs. */
function diffHunks(before, after) {
  const m = before.length;
  const n = after.length;
  const lcs = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      lcs[i][j] = before[i] === after[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const hunks = [];
  let current = null;
  let i = 0;
  let j = 0;
  const flush = () => {
    if (current) hunks.push(current);
    current = null;
  };
  while (i < m || j < n) {
    if (i < m && j < n && before[i] === after[j]) {
      flush();
      i++;
      j++;
    } else {
      if (!current) current = { removed: [], added: [] };
      if (j >= n || (i < m && lcs[i + 1][j] >= lcs[i][j + 1])) current.removed.push(i++);
      else current.added.push(j++);
    }
  }
  flush();
  return hunks;
}

/**
 * Finds spans the user replaced with a dictionary word, e.g. "a rather" →
 * "Aravo", and returns them as `{ word, alias }` pairs to store. Only learns
 * when the replacement is a known dictionary word, so unrelated edits never
 * become substitutions.
 */
function extractAliasCorrections(originalText, editedText, dictionary, existingAliases = []) {
  if (typeof originalText !== "string" || typeof editedText !== "string") return [];
  if (!originalText.trim() || !editedText.trim() || originalText === editedText) return [];

  const words = normalizeDictionaryWords(dictionary);
  if (words.length === 0) return [];
  const canonicalByLower = new Map();
  for (const word of words) {
    const key = normalizeAlias(word);
    if (key && !canonicalByLower.has(key)) canonicalByLower.set(key, word);
  }
  const known = new Set(normalizeAliasEntries(existingAliases).map((entry) => entry.alias));

  const original = tokenize(originalText);
  const edited = tokenize(editedText);
  if (original.length === 0 || edited.length === 0) return [];
  const hunks = diffHunks(
    original.map((token) => normalizeAlias(token)),
    edited.map((token) => normalizeAlias(token))
  );
  const changed = hunks.reduce((sum, hunk) => sum + hunk.removed.length, 0);
  // A wholesale rewrite is not a set of pronunciation fixes.
  if (original.length > 1 && changed > original.length * 0.5) return [];

  const results = [];
  const seen = new Set();
  const span = (tokens, from, to) =>
    normalizeAlias(tokens.slice(from, to).map((token) => token).join(" "));
  for (const hunk of hunks) {
    if (!hunk.removed.length || !hunk.added.length) continue;
    if (hunk.removed.length > ALIAS_MAX_WORDS || hunk.added.length > ALIAS_MAX_WORDS) continue;
    // "six point tombs" → "Six Points Homes" aligns "six" as unchanged, so the
    // hunk alone is "point tombs" → "points homes". Grow the hunk over the
    // unchanged neighbours (identical on both sides) until the edited span is
    // a dictionary word.
    let match = null;
    const removedStart = hunk.removed[0];
    const removedEnd = hunk.removed[hunk.removed.length - 1] + 1;
    const addedStart = hunk.added[0];
    const addedEnd = hunk.added[hunk.added.length - 1] + 1;
    for (let left = 0; left <= ALIAS_MAX_WORDS && !match; left++) {
      if (removedStart - left < 0 || addedStart - left < 0) break;
      for (let right = 0; right <= ALIAS_MAX_WORDS; right++) {
        if (removedEnd + right > original.length || addedEnd + right > edited.length) break;
        if (addedEnd - addedStart + left + right > ALIAS_MAX_WORDS) break;
        const replacement = span(edited, addedStart - left, addedEnd + right);
        const word = canonicalByLower.get(replacement);
        if (word) {
          match = { word, replacement, alias: span(original, removedStart - left, removedEnd + right) };
          break;
        }
      }
    }
    if (!match) continue;
    const { word, replacement, alias } = match;
    if (!alias || alias === replacement || seen.has(alias) || known.has(alias)) continue;
    if ((alias.match(/\p{L}/gu) || []).length < 3) continue;
    if (canonicalByLower.has(alias)) continue;
    if (alias.split(" ").includes(replacement)) continue;
    seen.add(alias);
    results.push({ word, alias });
  }
  return results;
}

module.exports = {
  extractCorrections,
  applyDictionaryCorrections,
  mergeDictionaryCorrections,
  undoDictionaryCorrections,
  normalizeAlias,
  applyDictionaryAliases,
  extractAliasCorrections,
};
