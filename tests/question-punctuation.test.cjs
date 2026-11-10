const assert = require("node:assert/strict");
const test = require("node:test");

const { fixQuestionPunctuation, looksLikeQuestion } = require("../src/utils/questionPunctuation");

const cases = (rows) => {
  for (const [input, expected] of rows)
    assert.equal(fixQuestionPunctuation(input), expected, `input: ${input}`);
};

test("questions that the recognizer ended with a period get a question mark", () => {
  cases([
    ["Is this a question.", "Is this a question?"],
    ["Can you send me the invoice by Friday.", "Can you send me the invoice by Friday?"],
    ["Could we just have it save from where we leave off.", "Could we just have it save from where we leave off?"],
    ["Do you think we should fix it, or should we keep it.", "Do you think we should fix it, or should we keep it?"],
    ["What time does the meeting start.", "What time does the meeting start?"],
    ["How much longer will it take.", "How much longer will it take?"],
    ["Okay, so can you draft a reply.", "Okay, so can you draft a reply?"],
    ["What's the plan.", "What's the plan?"],
    ["We ship Friday, right.", "We ship Friday, right?"],
    ["How about Thursday.", "How about Thursday?"],
    ["Did the payment go through.", "Did the payment go through?"],
  ]);
});

test("only the question sentence changes in a multi-sentence dictation", () => {
  cases([
    [
      "I looked at the draft. Can you tighten the intro. The rest is fine.",
      "I looked at the draft. Can you tighten the intro? The rest is fine.",
    ],
    ["Thanks for the update.\nAre we still on for lunch.", "Thanks for the update.\nAre we still on for lunch?"],
  ]);
});

test("statements stay statements", () => {
  cases([
    ["Do the dishes.", "Do the dishes."],
    ["Have a good one.", "Have a good one."],
    ["Do it now.", "Do it now."],
    ["What we did was great.", "What we did was great."],
    ["How we got here is a long story.", "How we got here is a long story."],
    ["I wonder what time it is.", "I wonder what time it is."],
    ["I don't know where he is.", "I don't know where he is."],
    ["Send the invoice to Dana today.", "Send the invoice to Dana today."],
    ["It was a really nice afternoon.", "It was a really nice afternoon."],
    ["We picked up the kids, which is great.", "We picked up the kids, which is great."],
    ["The total is 3.5 hours.", "The total is 3.5 hours."],
    ["Is this a question?", "Is this a question?"],
    ["Can you believe it!", "Can you believe it!"],
    ["Wait...", "Wait..."],
  ]);
});

test("relative-clause fragments are not questions", () => {
  assert.equal(looksLikeQuestion("which has pictures of the original house"), false);
  assert.equal(looksLikeQuestion("who is an associate of Joel's"), false);
});

test("list markers and newlines pass through untouched", () => {
  cases([
    ["Three things:\n1. Send the invoice.\n2. Can you call Dana.", "Three things:\n1. Send the invoice.\n2. Can you call Dana?"],
    ["", ""],
  ]);
});
