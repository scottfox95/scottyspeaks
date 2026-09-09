const assert = require("node:assert/strict");
const test = require("node:test");

const learner = require("../src/utils/correctionLearner");

test("learns a casing-only correction", () => {
  assert.deepEqual(learner.extractCorrections("I work at aravo", "I work at Aravo", []), ["Aravo"]);
});

test("a corrected canonical case replaces an existing dictionary casing", () => {
  assert.deepEqual(learner.extractCorrections("I work at aravo", "I work at Aravo", ["aravo"]), [
    "Aravo",
  ]);
});

test("does not learn words from an unrelated rewrite", () => {
  assert.deepEqual(
    learner.extractCorrections(
      "Schedule the aravo compliance review",
      "Please send the revised contract tomorrow",
      []
    ),
    []
  );
});

test("does not learn appended application text", () => {
  assert.deepEqual(
    learner.extractCorrections(
      "I work at aravo",
      "I work at aravo Zylophone was appended elsewhere",
      []
    ),
    []
  );
});

test("learns a correction inside an otherwise unchanged destination field", () => {
  assert.deepEqual(
    learner.extractCorrections(
      "I work at aravo",
      "Earlier notes remain. I work at Aravo Later text remains.",
      []
    ),
    ["Aravo"]
  );
});

test("learns corrections next to punctuation and preserves Unicode", () => {
  assert.deepEqual(
    learner.extractCorrections("Please call jose tomorrow.", "Please call José tomorrow.", []),
    ["José"]
  );
  assert.deepEqual(
    learner.extractCorrections("Contact aravo, today.", "Contact Aravo, today.", []),
    ["Aravo"]
  );
});

test("canonical dictionary spelling uses whole-term boundaries and longer terms first", () => {
  assert.equal(typeof learner.applyDictionaryCorrections, "function");
  assert.equal(
    learner.applyDictionaryCorrections("new york met york; aravo met aravon and bobaravo.", [
      "York",
      "New York",
      "Aravo",
    ]),
    "New York met York; Aravo met aravon and bobaravo."
  );
});

test("dictionary merge replaces casing safely and undo restores prior entries", () => {
  assert.equal(typeof learner.mergeDictionaryCorrections, "function");
  assert.equal(typeof learner.undoDictionaryCorrections, "function");

  const merged = learner.mergeDictionaryCorrections(["aravo", "Existing"], ["Aravo", "Sinéad"]);
  assert.deepEqual(merged.dictionary, ["Aravo", "Existing", "Sinéad"]);
  assert.deepEqual(merged.learned, ["Aravo", "Sinéad"]);

  assert.deepEqual(
    learner.undoDictionaryCorrections([...merged.dictionary, "Later"], merged.undoEntries),
    ["aravo", "Existing", "Later"]
  );
});

test('learns a correction with a short prefix and suffix around a long dictation',()=>{
 const before='We need to review the aravo implementation details with the entire project team tomorrow morning';
 const after='FYI '+before.replace('aravo','Aravo')+' Thanks';
 assert.deepEqual(learner.extractCorrections(before,after,[]),['Aravo']);
});
