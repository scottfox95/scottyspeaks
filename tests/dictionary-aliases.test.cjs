const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { DatabaseSync } = require("node:sqlite");
const test = require("node:test");

const learner = require("../src/utils/correctionLearner");

// --- text substitution -------------------------------------------------------

const aliases = [
  { word: "Aravo", alias: "bravo" },
  { word: "Aravo", alias: "a rather" },
  { word: "Echad", alias: "a chod" },
];

test("aliases are replaced as whole words, keeping surrounding punctuation", () => {
  assert.equal(
    learner.applyDictionaryAliases("I work at bravo. Bravo, said a rather!", aliases),
    "I work at Aravo. Aravo, said Aravo!"
  );
});

test("aliases never match inside other words and the longest alias wins", () => {
  assert.equal(learner.applyDictionaryAliases("bravos and a   rather long day", aliases), "bravos and Aravo long day");
  assert.equal(
    learner.applyDictionaryAliases("rather than a chod", [...aliases, { word: "Echad", alias: "rather" }]),
    "Echad than Echad"
  );
});

test("empty or malformed alias lists leave text alone", () => {
  assert.equal(learner.applyDictionaryAliases("bravo", []), "bravo");
  assert.equal(learner.applyDictionaryAliases("bravo", [{ word: "Aravo", alias: "" }, null]), "bravo");
  assert.equal(learner.applyDictionaryAliases("bravo", [{ word: "Aravo", alias: "aravo" }]), "bravo");
});

// --- learning from edits -----------------------------------------------------

const dictionary = ["Aravo", "Echad", "Six Points Homes"];

test("a single-word mishearing replaced by a dictionary word becomes an alias", () => {
  assert.deepEqual(
    learner.extractAliasCorrections("send it to bravo today", "send it to Aravo today", dictionary),
    [{ word: "Aravo", alias: "bravo" }]
  );
});

test("multi-word mishearings and multi-word dictionary entries are learned", () => {
  assert.deepEqual(
    learner.extractAliasCorrections(
      "I told a rather and six point tombs about it",
      "I told Aravo and Six Points Homes about it",
      dictionary
    ),
    [
      { word: "Aravo", alias: "a rather" },
      { word: "Six Points Homes", alias: "six point tombs" },
    ]
  );
});

test("edits that are not dictionary words, rewrites and known aliases are ignored", () => {
  assert.deepEqual(
    learner.extractAliasCorrections("send it to bravo today", "send it to Bob today", dictionary),
    []
  );
  assert.deepEqual(
    learner.extractAliasCorrections("send it to bravo today", "Aravo needs the contract by Friday", dictionary),
    []
  );
  assert.deepEqual(
    learner.extractAliasCorrections("send it to bravo", "send it to Aravo", dictionary, [
      { word: "Aravo", alias: "bravo" },
    ]),
    []
  );
  // Casing-only corrections are the dictionary's job, not an alias.
  assert.deepEqual(learner.extractAliasCorrections("send it to aravo", "send it to Aravo", dictionary), []);
});

// --- storage -----------------------------------------------------------------

const box = {
  module: { exports: {} },
  require(name) {
    if (name === "better-sqlite3") return DatabaseSync;
    if (name === "electron") return { app: {} };
    if (name === "./debugLogger") return { error() {}, warn() {}, info() {} };
    return require(name);
  },
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/helpers/database.js"), "utf8"), box);
const DatabaseManager = box.module.exports;

function store(t) {
  const manager = Object.create(DatabaseManager.prototype);
  manager.db = new DatabaseSync(":memory:");
  manager.db.exec(`CREATE TABLE custom_dictionary (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    word TEXT NOT NULL UNIQUE
  )`);
  manager.db.exec(`CREATE TABLE dictionary_aliases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    word TEXT NOT NULL,
    alias TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual',
    created_at TEXT
  )`);
  manager.db.exec(
    "CREATE UNIQUE INDEX idx_dictionary_aliases_alias_nocase ON dictionary_aliases (alias COLLATE NOCASE)"
  );
  manager.db.prepare("INSERT INTO custom_dictionary (word) VALUES (?)").run("Aravo");
  manager.db.prepare("INSERT INTO custom_dictionary (word) VALUES (?)").run("Echad");
  t.after(() => manager.db.close());
  return manager;
}

// Objects built inside the vm sandbox have that realm's prototypes.
const plain = (value) => JSON.parse(JSON.stringify(value));

test("aliases are normalized, owned by one word, and never a dictionary word", (t) => {
  const db = store(t);
  let list = plain(db.setWordAliases("aravo", [" Bravo! ", "a  rather", "Aravo", "Echad", ""], "teach"));
  assert.deepEqual(list, [
    { word: "Aravo", alias: "bravo", source: "teach" },
    { word: "Aravo", alias: "a rather", source: "teach" },
  ]);
  list = db.addDictionaryAliases("Echad", ["BRAVO"]);
  assert.deepEqual(
    list.map((entry) => [entry.word, entry.alias]),
    [
      ["Aravo", "a rather"],
      ["Echad", "bravo"],
    ]
  );
  list = db.removeDictionaryAlias("Bravo");
  assert.deepEqual(list.map((entry) => entry.alias), ["a rather"]);
  assert.throws(() => db.setWordAliases("Unknown", ["x"]), /dictionary word/);
});

test("replacing a word's aliases is atomic and dropping the word drops them", (t) => {
  const db = store(t);
  db.setWordAliases("Aravo", ["bravo"]);
  db.setWordAliases("Aravo", ["a rather", "arava"]);
  assert.deepEqual(db.getDictionaryAliases().map((entry) => entry.alias), ["a rather", "arava"]);
  // setDictionary uses better-sqlite3's transaction helper; emulate it for node:sqlite.
  db.db.transaction = (fn) => fn;
  db.setDictionary(["Echad"]);
  assert.deepEqual(db.getDictionaryAliases(), []);
});
