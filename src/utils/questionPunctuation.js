// Question-mark repair for dictation.
//
// Parakeet punctuates from the audio and often ends a long question with "."
// ("Can you walk me through … stuff like that."). The polish model only sees
// text and keeps that period, and dictations under 8 words skip polish
// entirely. In Scott's last 600 dictations, 17 of 108 sentences built like a
// question ended with "." this way.
//
// This repairs those by sentence *form* only: "is this…", "can you…", "what time
// does…", "…, right.". It only ever turns a final "." into "?"; it never adds or
// removes words.
//
// Measured and rejected: a final-pitch-rise check. On Scott's 127 saved
// dictations it caught one statement-shaped question and wrongly flipped about
// eight statements, because he often ends statements with a rise.

const AUX = String.raw`is|are|was|were|am|does|did|can|could|will|would|should|shall|has|isn't|aren't|wasn't|weren't|doesn't|didn't|can't|couldn't|won't|wouldn't|shouldn't|hasn't|haven't|don't`;
// "do"/"have" are also imperatives ("Do the dishes.", "Have a good one."), so
// they count only with a personal-pronoun subject.
const SUBJECT = String.raw`i|you|we|they|he|she|it|this|that|these|those|there|the|a|an|my|your|our|their|his|her|its|any|anyone|anybody|someone|somebody|everyone|everybody|anything|something|all|some|y'all`;
const WH = String.raw`what|why|how|when|where|who|which|whose|whom`;
const LEAD = String.raw`(?:(?:so|okay|ok|and|but|also|hey|hi|well|oh|quick question|sorry|actually|then|now|and so|real quick)[,—–-]?\s+)*`;

const INVERTED = new RegExp(
  String.raw`^${LEAD}(?:(?:${AUX})\s+(?:${SUBJECT})\b|(?:do|have)\s+(?:i|you|we|they)\b)`,
  "i"
);
// wh-word, optionally one or two non-subject words ("what time", "how much
// longer"), then an auxiliary. "What we did was…" has a subject next, so it
// doesn't match.
const WH_QUESTION = new RegExp(
  String.raw`^${LEAD}(?:${WH})(?:\s+(?!(?:${SUBJECT}|${AUX}|do|have)\b)[\w']+){0,2}?\s+(?:${AUX}|do|have)\b`,
  "i"
);
const WH_CONTRACTION = new RegExp(
  String.raw`^${LEAD}(?:what|where|who|how|why|when)'(?:s|re)\b`,
  "i"
);
const SHORT_WH = new RegExp(
  String.raw`^${LEAD}(?:how come|why not|what about|how about|what if)\b`,
  "i"
);
const TAG = new RegExp(
  String.raw`,\s*(?:right|correct|yeah|okay|ok|isn't it|aren't you|don't you think|does that make sense|make sense|sound good|sounds good)\s*$`,
  "i"
);
// Sentences built around an embedded question are statements: "I wonder what time it is."
const EMBEDDED =
  /^(?:i|we|they|he|she|you)\s+(?:wonder|asked|don't know|do not know|know|knew|forgot|forget|remember|told)\b/i;

/** True when a sentence (without its final punctuation) is built like a question. */
function looksLikeQuestion(sentence) {
  const s = String(sentence || "")
    .trim()
    .replace(/[.!?]+$/, "");
  // A lowercase start is a continuation fragment ("which has…", "who is…"),
  // i.e. a relative clause, not a new question.
  if (!s || !/^[A-Z"“'‘(]/.test(s) || EMBEDDED.test(s)) return false;
  return (
    INVERTED.test(s) ||
    WH_QUESTION.test(s) ||
    WH_CONTRACTION.test(s) ||
    SHORT_WH.test(s) ||
    TAG.test(s)
  );
}

/** Turn sentence-final "." into "?" for sentences that are questions by form. */
function fixQuestionPunctuation(text) {
  if (typeof text !== "string" || !text.trim()) return text;
  // Sentence chunks keep their terminator and trailing whitespace; newlines and
  // list markers pass through untouched.
  return text.replace(/(?<=^|[.!?:]\s+|\n\s*)([^.!?\n]+)\.(?!\.)(?=\s|$)/g, (match, body) =>
    looksLikeQuestion(body) ? `${body}?` : match
  );
}

module.exports = { fixQuestionPunctuation, looksLikeQuestion };
