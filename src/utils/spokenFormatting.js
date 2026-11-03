/**
 * Deterministic spoken-form normalization for dictated text.
 *
 * The recognizer (and sometimes the polish model) writes numbers the way they
 * were said ("six oh six", "fifteen K") and spells out spoken symbols
 * ("and slash or"). This pass turns them into what the person would have
 * typed ("606", "15K", "and/or"). It runs on the final text in `paste-text`,
 * after polish, so it also covers short dictations that skip polish.
 *
 * It is deliberately conservative: a lone "one" through "nine" stays a word
 * ("one of them", "two things") unless a unit makes it a number ("five
 * percent", "three pm"), and a run of single digits is only joined when it
 * clearly is a code ("six oh six") or a phone number (7+ digits).
 */

const UNITS = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
};
const TEENS = {
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};
const TENS = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};
const MULTIPLIERS = { hundred: 100, thousand: 1e3, million: 1e6, billion: 1e9 };
const ZERO_WORDS = new Set(["oh", "o"]);
const TIME_PREFIXES = new Set(["at"]);

function kindOf(word) {
  if (word in UNITS) return "unit";
  if (word in TEENS) return "teen";
  if (word in TENS) return "tens";
  if (word in MULTIPLIERS) return "mult";
  return null;
}

function valueOf(word) {
  return UNITS[word] ?? TEENS[word] ?? TENS[word];
}

const isValueWord = (w) => w in UNITS || w in TEENS || w in TENS;
const isDigitWord = (w) => w in UNITS || ZERO_WORDS.has(w);

/** Standard English cardinal ("six hundred and six", "twenty five thousand"). */
function parseCardinal(words) {
  if (words.length === 1 && words[0] === "zero") return 0;
  let total = 0;
  let current = 0;
  let last = null; // unit | teen | tens | hundred | big
  let lastBig = Infinity;
  for (const w of words) {
    const kind = kindOf(w);
    if (w === "zero" || !kind) return null;
    if (kind === "unit") {
      if (last === "unit" || last === "teen") return null;
      if (last === "tens" && current % 10 !== 0) return null;
      current += UNITS[w];
      last = "unit";
    } else if (kind === "teen" || kind === "tens") {
      if (last === "unit" || last === "teen" || last === "tens") return null;
      if (current % 100 !== 0) return null;
      current += valueOf(w);
      last = kind;
    } else if (w === "hundred") {
      if (current === 0 || current >= 100 || last === "hundred") return null;
      current *= 100;
      last = "hundred";
    } else {
      const mult = MULTIPLIERS[w];
      if (current === 0 || mult >= lastBig) return null;
      total += current * mult;
      current = 0;
      lastBig = mult;
      last = "big";
    }
  }
  return total + current;
}

/**
 * Digit-group form: "six oh six" → "606", "twenty twenty six" → "2026",
 * "six twenty five" → "625". Returns the groups, or null when the words are
 * not a sequence of 1–2 digit groups.
 */
function parseGroups(words) {
  const groups = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (ZERO_WORDS.has(w) || w === "zero") groups.push({ text: "0", zero: true });
    else if (w in UNITS) groups.push({ text: String(UNITS[w]) });
    else if (w in TEENS) groups.push({ text: String(TEENS[w]) });
    else if (w in TENS) {
      const next = words[i + 1];
      if (next && next in UNITS && next !== "zero") {
        groups.push({ text: String(TENS[w] + UNITS[next]) });
        i++;
      } else groups.push({ text: String(TENS[w]) });
    } else return null;
  }
  return groups;
}

function withCommas(digits) {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatPhone(digits) {
  if (digits.length === 7) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
  if (digits.length === 10) return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  if (digits.length === 11 && digits[0] === "1")
    return `1-${digits.slice(1, 4)}-${digits.slice(4, 7)}-${digits.slice(7)}`;
  return digits;
}

/**
 * Interprets a run of number words. Returns { text, small } or null to leave
 * the words untouched. `small` marks a bare one-word 0–9, which callers keep
 * as a word unless a unit follows.
 */
function interpretInteger(words, { money, timeHint }) {
  const cardinal = parseCardinal(words);
  if (cardinal !== null) {
    if (words.length === 1 && words[0] in UNITS)
      return { text: String(cardinal), small: true, value: cardinal };
    const last = words[words.length - 1];
    if ((last === "million" || last === "billion") && words.length > 1) {
      const lead = parseCardinal(words.slice(0, -1));
      if (lead !== null && lead < 1000) return { text: `${lead} ${last}`, value: cardinal };
    }
    let text = String(cardinal);
    if (cardinal >= 10000 || (cardinal >= 1000 && (money || cardinal % 100 === 0)))
      text = withCommas(text);
    return { text, value: cardinal };
  }

  // Digit groups, optionally followed by one multiplier ("six twenty five thousand").
  let trailing = null;
  let body = words;
  const tail = words[words.length - 1];
  if (tail === "thousand" || tail === "million" || tail === "billion") {
    trailing = tail;
    body = words.slice(0, -1);
  }
  if (body.length < 2) return null;
  const groups = parseGroups(body);
  if (!groups) return null;
  const hasZero = groups.some((g) => g.zero);
  const allSingle = groups.every((g) => g.text.length === 1);
  const laterPair = groups.slice(1).some((g) => g.text.length === 2);
  const digits = groups.map((g) => g.text).join("");
  if (!hasZero && !laterPair && !(allSingle && digits.length >= 7)) return null;

  // Clock time: "three thirty pm", "at six fifteen", "six oh five am".
  if (!trailing && timeHint) {
    const hour = Number(groups[0].text);
    const rest = groups
      .slice(1)
      .map((g) => g.text)
      .join("");
    const minuteOk = rest.length === 2 && Number(rest) < 60;
    if (
      hour >= 1 &&
      hour <= 12 &&
      minuteOk &&
      (timeHint === "suffix" || ["15", "30", "45"].includes(rest) || rest[0] === "0")
    )
      return { text: `${hour}:${rest}`, time: true };
  }

  if (trailing === "thousand") return { text: withCommas(String(Number(digits) * 1000)) };
  if (trailing) return { text: `${Number(digits)} ${trailing}` };
  if (allSingle && digits.length >= 7) return { text: formatPhone(digits) };
  return { text: digits };
}

const WORD_RE = /[A-Za-z]+(?:['’][A-Za-z]+)?/g;

function tokenize(text) {
  const tokens = [];
  let m;
  WORD_RE.lastIndex = 0;
  while ((m = WORD_RE.exec(text)))
    tokens.push({ word: m[0].toLowerCase(), start: m.index, end: m.index + m[0].length });
  return tokens;
}

/** True when only spaces (or the hyphen in "twenty-five") separate two tokens. */
function joined(text, a, b, allowHyphen = true) {
  const gap = text.slice(a.end, b.start);
  return /^ +$/.test(gap) || (allowHyphen && gap === "-" && a.word in TENS && b.word in UNITS);
}

const AMPM_RE = /^ +([ap])\.? ?m\.?(?![A-Za-z])/i;

function normalizeSpokenNumbers(text) {
  if (typeof text !== "string" || !text) return text;
  const tokens = tokenize(text);
  let out = "";
  let cursor = 0;
  let i = 0;
  while (i < tokens.length) {
    const first = tokens[i];
    if (!isValueWord(first.word)) {
      i++;
      continue;
    }
    // Collect the run of number words.
    const words = [first.word];
    let j = i + 1;
    let decimals = null;
    while (j < tokens.length && joined(text, tokens[j - 1], tokens[j])) {
      const w = tokens[j].word;
      const next = tokens[j + 1];
      const nextJoined = next && joined(text, tokens[j], next);
      if (isValueWord(w) || w in MULTIPLIERS) words.push(w);
      else if (ZERO_WORDS.has(w) && nextJoined && isDigitWord(next.word)) words.push(w);
      else if (
        w === "and" &&
        words[words.length - 1] in MULTIPLIERS &&
        nextJoined &&
        isValueWord(next.word)
      )
        words.push(w);
      else if (w === "point" && nextJoined && isDigitWord(next.word)) {
        decimals = "";
        let k = j + 1;
        while (
          k < tokens.length &&
          joined(text, tokens[k - 1], tokens[k]) &&
          isDigitWord(tokens[k].word)
        ) {
          decimals += ZERO_WORDS.has(tokens[k].word) ? "0" : String(UNITS[tokens[k].word]);
          k++;
        }
        j = k;
        break;
      } else break;
      j++;
    }
    // A trailing "million"/"billion" after decimals ("two point three million").
    let scale = null;
    if (decimals !== null && j < tokens.length && joined(text, tokens[j - 1], tokens[j], false)) {
      const w = tokens[j].word;
      if (w === "million" || w === "billion" || w === "thousand") {
        scale = w;
        j++;
      }
    }
    const intWords = words.filter((w) => w !== "and");
    let end = tokens[j - 1].end;

    // Units that follow the run.
    let suffix = "";
    let prefix = "";
    let unit = false;
    let timeHint = null;
    const after = tokens[j];
    const afterJoined = after && joined(text, tokens[j - 1], after, false);
    const ampm = AMPM_RE.exec(text.slice(end));
    const money = afterJoined && ["dollars", "dollar", "bucks"].includes(after.word);
    if (ampm) timeHint = "suffix";
    else if (afterJoined && (after.word === "o'clock" || after.word === "o’clock"))
      timeHint = "suffix";
    else if (
      i > 0 &&
      TIME_PREFIXES.has(tokens[i - 1].word) &&
      joined(text, tokens[i - 1], first, false)
    )
      timeHint = "prefix";

    const result = interpretInteger(intWords, { money, timeHint });
    if (!result) {
      i = j;
      continue;
    }
    let number = result.text;
    if (decimals !== null) {
      if (result.time || /\D/.test(result.text.replace(/,/g, ""))) {
        i = j;
        continue;
      }
      number = `${result.text}.${decimals}`;
      unit = true;
    }
    if (scale) number = `${number} ${scale}`;

    if (
      afterJoined &&
      (after.word === "percent" || (after.word === "per" && tokens[j + 1]?.word === "cent"))
    ) {
      suffix = "%";
      end = after.word === "per" ? tokens[j + 1].end : after.end;
      unit = true;
    } else if (money) {
      prefix = "$";
      end = after.end;
      unit = true;
    } else if (
      afterJoined &&
      after.word === "k" &&
      /^ +[Kk](?![A-Za-z])/.test(text.slice(tokens[j - 1].end))
    ) {
      suffix = "K";
      end = after.end;
      unit = true;
    } else if (timeHint === "suffix") unit = true;

    if (result.small && !unit) {
      i = j;
      continue;
    }
    out += text.slice(cursor, first.start) + prefix + number + suffix;
    cursor = end;
    i = j;
    while (i < tokens.length && tokens[i].start < end) i++;
  }
  return out + text.slice(cursor);
}

const TLDS =
  "com|org|net|io|ai|dev|app|co|us|edu|gov|js|ts|tsx|jsx|json|md|py|txt|pdf|csv|html|css|sh|yml|yaml";
const SMALL = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };

/**
 * Spoken symbols: "slash" → "/", "backslash" → "\", "underscore" → "_", and
 * "dot" only inside a path/URL ("app dot js", "openai dot com"). The symbol
 * is joined to its neighbours, so "and slash or" → "and/or".
 */
function normalizeSpokenSymbols(text) {
  if (typeof text !== "string" || !text) return text;
  let s = text;
  s = s.replace(/ *\b(?:back ?slash)\b */gi, "\\");
  s = s.replace(/ *\b(?:forward )?slash\b */gi, "/");
  s = s.replace(/ *\bunderscore\b */gi, "_");
  s = s.replace(new RegExp(`([A-Za-z0-9])\\s+dot\\s+(${TLDS})\\b`, "gi"), "$1.$2");
  s = s.replace(/([A-Za-z0-9]*[/\\_][A-Za-z0-9/\\_.]*)\s+dot\s+([A-Za-z0-9]+)/gi, "$1.$2");
  // "24/seven" → "24/7" once a neighbour is already a digit.
  s = s.replace(
    /(\d)\/(one|two|three|four|five|six|seven|eight|nine)\b/gi,
    (_, d, w) => `${d}/${SMALL[w.toLowerCase()]}`
  );
  s = s.replace(
    /\b(one|two|three|four|five|six|seven|eight|nine)\/(\d)/gi,
    (_, w, d) => `${SMALL[w.toLowerCase()]}/${d}`
  );
  return s;
}

/** Numbers first, so "twenty four slash seven" can see "24" before the slash joins. */
function normalizeSpokenForm(text) {
  if (typeof text !== "string" || !text) return text;
  return normalizeSpokenSymbols(normalizeSpokenNumbers(text));
}

module.exports = { normalizeSpokenForm, normalizeSpokenNumbers, normalizeSpokenSymbols };
