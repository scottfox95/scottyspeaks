const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const box = { exports: {} };
vm.runInNewContext(
  ts.transpileModule(fs.readFileSync("src/components/meetings/meetingDraft.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText,
  box
);
test("typing during a save preserves new notes without reverting a newly generated transcript", () => {
  const initial = { title: "Call", notes: "first", transcript: "old", speakers: {} };
  const saved = { ...initial, transcript: "new server transcript", revision: 4 };
  const typing = { ...initial, notes: "first and second" };
  const rebased = box.exports.rebaseDraft(saved, initial, typing);
  assert.equal(rebased.notes, "first and second");
  assert.equal(rebased.transcript, "new server transcript");
  assert.equal(rebased.revision, 4);
});
