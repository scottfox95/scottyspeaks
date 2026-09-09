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

module.exports = {
  extractCorrections,
  applyDictionaryCorrections,
  mergeDictionaryCorrections,
  undoDictionaryCorrections,
};
