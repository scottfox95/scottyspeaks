const assert = require("node:assert/strict");
const test = require("node:test");

const { normalizeSpokenForm } = require("../src/utils/spokenFormatting");

const cases = (rows) => {
  for (const [input, expected] of rows)
    assert.equal(normalizeSpokenForm(input), expected, `input: ${input}`);
};

test("digit-by-digit numbers become digits", () => {
  cases([
    ["The address is six oh six Main Street.", "The address is 606 Main Street."],
    ["Six oh six", "606"],
    ["room six o six", "room 606"],
    ["the code is zero zero seven", "the code is 007"],
    ["six twenty five", "625"],
    ["we closed on six twenty five", "we closed on 625"],
    ["back in nineteen ninety nine", "back in 1999"],
    ["by twenty twenty six", "by 2026"],
    ["in twenty oh five", "in 2005"],
  ]);
});

test("standard cardinals", () => {
  cases([
    ["six hundred six", "606"],
    ["six hundred and six units", "606 units"],
    ["twenty five people", "25 people"],
    ["twenty-five people", "25 people"],
    ["fifteen hundred", "1,500"],
    ["five thousand", "5,000"],
    ["two thousand twenty six", "2026"],
    ["one hundred twenty three thousand four hundred fifty six", "123,456"],
    ["ten minutes", "10 minutes"],
  ]);
});

test("money, K, decimals, percentages", () => {
  cases([
    ["six hundred twenty five thousand dollars", "$625,000"],
    ["six twenty five thousand", "625,000"],
    ["it listed at six twenty five K", "it listed at 625K"],
    ["fifteen K", "15K"],
    ["fifteen k over budget", "15K over budget"],
    ["fifteen hundred dollars", "$1,500"],
    ["five dollars", "$5"],
    ["two point three", "2.3"],
    ["two point three million", "2.3 million"],
    ["two point three million dollars", "$2.3 million"],
    ["zero point five", "0.5"],
    ["three point one four", "3.14"],
    ["fifty percent", "50%"],
    ["two point five percent", "2.5%"],
    ["five percent", "5%"],
    ["two million", "2 million"],
    ["four hundred million dollars", "$400 million"],
  ]);
});

test("times", () => {
  cases([
    ["see you at three thirty pm", "see you at 3:30 pm"],
    ["call at three p.m. please", "call at 3 p.m. please"],
    ["six oh five AM", "6:05 AM"],
    ["meet at six thirty", "meet at 6:30"],
    ["lunch at twelve fifteen", "lunch at 12:15"],
    ["three o'clock", "3 o'clock"],
  ]);
});

test("phone numbers", () => {
  cases([
    ["call four one five five five five one two one two", "call 415-555-1212"],
    ["five five five one two one two", "555-1212"],
    ["it's six oh two five five five one two one two", "it's 602-555-1212"],
  ]);
});

test("ordinary prose keeps its words", () => {
  cases([
    ["one of them", "one of them"],
    ["One thing I'd say", "One thing I'd say"],
    ["Two things before Friday", "Two things before Friday"],
    ["I have three kids", "I have three kids"],
    ["one two three go", "one two three go"],
    ["oh I see", "oh I see"],
    ["six, oh wait, seven", "six, oh wait, seven"],
    ["the point is", "the point is"],
    ["a hundred times", "a hundred times"],
    ["thousands of people", "thousands of people"],
    ["first, second and third", "first, second and third"],
    ["at six", "at six"],
    ["someone", "someone"],
    ["Fifty-Fifty", "50-50"],
  ]);
});

test("already-written digits are left alone (idempotent)", () => {
  for (const s of ["606", "$625,000", "2.3", "3:30pm", "15K", "1. Send the invoice."])
    assert.equal(normalizeSpokenForm(s), s);
  const once = normalizeSpokenForm("six twenty five K and two point three percent");
  assert.equal(normalizeSpokenForm(once), once);
});

test("spoken slash and backslash become symbols", () => {
  cases([
    ["and slash or", "and/or"],
    ["the A slash B test", "the A/B test"],
    ["twenty four slash seven", "24/7"],
    ["src slash components slash app dot tsx", "src/components/app.tsx"],
    ["forward slash", "/"],
    ["slash help", "/help"],
    ["C colon backslash users", "C colon\\users"],
    ["back slash n", "\\n"],
    ["my underscore file", "my_file"],
    ["go to openai dot com", "go to openai.com"],
  ]);
});

test("dot is only a symbol inside a path or URL", () => {
  cases([
    ["a polka dot dress", "a polka dot dress"],
    ["dot your i's", "dot your i's"],
  ]);
});
