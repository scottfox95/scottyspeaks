const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { DatabaseSync } = require("node:sqlite");
const test = require("node:test");

// Exercise the production query against real SQLite without replacing the
// Electron-targeted better-sqlite3 binary or opening the user's database.
const box = {
  module: { exports: {} },
  require(name) {
    if (name === "better-sqlite3") return DatabaseSync;
    if (name === "electron") return { app: {} };
    if (name === "./debugLogger") return { error() {} };
    return require(name);
  },
};
vm.runInNewContext(
  fs.readFileSync(path.join(__dirname, "../src/helpers/database.js"), "utf8"),
  box
);
const DatabaseManager = box.module.exports;

function history(t) {
  const manager = Object.create(DatabaseManager.prototype);
  manager.db = new DatabaseSync(":memory:");
  manager.db.exec(`CREATE TABLE transcriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    raw_text TEXT,
    timestamp TEXT NOT NULL DEFAULT '2026-09-24 12:00:00',
    created_at TEXT DEFAULT '2026-09-24 12:00:00'
  )`);
  t.after(() => manager.db.close());
  return manager;
}

test("history pages reach beyond 50 with stable ordering when timestamps tie", (t) => {
  const manager = history(t);
  for (let n = 1; n <= 126; n++) manager.saveTranscription(`Dictation ${n}`);
  const first = manager.queryTranscriptions();
  assert.equal(first.items.length, 50);
  assert.equal(first.items[0].id, 126);
  assert.equal(first.items[49].id, 77);
  assert.equal(first.hasMore, true);

  // New dictation and a removed row must not shift the cursor into duplicates/skips.
  manager.saveTranscription("New while browsing");
  manager.db.prepare("DELETE FROM transcriptions WHERE id = ?").run(110);
  const second = manager.queryTranscriptions({ cursor: first.nextCursor });
  const last = manager.queryTranscriptions({ cursor: second.nextCursor });
  assert.equal(second.items[0].id, 76);
  assert.equal(last.items.length, 26);
  assert.equal(last.items[25].id, 1);
  assert.equal(last.hasMore, false);
  assert.equal(last.nextCursor, null);
  assert.equal(
    new Set([...first.items, ...second.items, ...last.items].map((i) => i.id)).size,
    126
  );
});

test("search finds older final, original and corrected words outside the recent cache", (t) => {
  const manager = history(t);
  const saved = manager.saveTranscription("Schedule Aravo review", "schedule a rah vo review");
  for (let n = 0; n < 60; n++) manager.saveTranscription(`Unrelated recent dictation ${n}`);
  assert.equal(
    manager.getTranscriptions().some((i) => i.id === saved.id),
    false
  );
  for (const query of ["ARAVO", "  a rah vo  "]) {
    const page = manager.queryTranscriptions({ query });
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].id, saved.id);
  }
  manager.updateTranscription(saved.id, "Schedule supplier review");
  assert.equal(manager.queryTranscriptions({ query: "supplier" }).items[0].id, saved.id);
  assert.equal(manager.queryTranscriptions({ query: "a rah vo" }).items[0].id, saved.id);
  assert.equal(manager.queryTranscriptions({ query: "Aravo" }).items.length, 0);
});

test("search treats percent, underscore, backslash and SQL syntax as literal text", (t) => {
  const manager = history(t);
  manager.saveTranscription("ordinary words and 25 percent");
  const samples = ["25%", "snake_case", "C:\\notes", "x' OR 1=1 --", "你好"];
  for (const sample of samples) {
    const saved = manager.saveTranscription(`Keep ${sample} exactly`);
    const result = manager.queryTranscriptions({ query: sample });
    assert.equal(result.items.length, 1, sample);
    assert.equal(result.items[0].id, saved.id, sample);
  }
  assert.equal(manager.queryTranscriptions({ query: "%" }).items.length, 1);
  assert.equal(manager.queryTranscriptions({ query: "_" }).items.length, 1);
  assert.equal(manager.queryTranscriptions({ query: "\\" }).items.length, 1);
});

test("search pagination returns every match and handles empty or bounded queries", (t) => {
  const manager = history(t);
  for (let n = 0; n < 130; n++) manager.saveTranscription(n % 2 ? "match" : "other");
  let cursor = null;
  const ids = new Set();
  do {
    const page = manager.queryTranscriptions({ query: "match", limit: 17, cursor });
    assert.ok(page.items.length <= 17);
    for (const item of page.items) ids.add(item.id);
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(ids.size, 65);
  assert.equal(manager.queryTranscriptions({ query: "missing" }).items.length, 0);
  assert.equal(manager.queryTranscriptions({ query: "   ", limit: 100 }).items.length, 100);
  for (const options of [
    null,
    [],
    { query: 7 },
    { query: "x".repeat(501) },
    { limit: -1 },
    { limit: 101 },
    { limit: 1.5 },
    { cursor: { timestamp: "now", id: "1" } },
    { cursor: { timestamp: "x".repeat(65), id: 1 } },
  ]) {
    assert.throws(() => manager.queryTranscriptions(options));
  }
});
