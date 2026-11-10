const test = require("node:test");
const assert = require("node:assert/strict");
const { folderLabels, withFolderLabels } = require("../src/helpers/folderLabels");

test("pinned folders show their parent so several docs folders differ", () => {
  assert.deepEqual(
    folderLabels([
      "/Users/scott/Projects/Personal/TenenbaumAI/docs",
      "/Users/scott/Projects/Personal/ScottySpeaks/docs",
      "/Users/scott/Obsidian/ScottsMind",
    ]),
    ["TenenbaumAI / docs", "ScottySpeaks / docs", "Obsidian / ScottsMind"]
  );
});

test("more parents are added only where two labels still collide", () => {
  assert.deepEqual(
    folderLabels([
      "/Users/scott/Projects/Personal/Aravo/docs",
      "/Users/scott/Projects/Work/Aravo/docs",
      "/Users/scott/Projects/Personal/TenenbaumAI/docs",
    ]),
    ["Personal / Aravo / docs", "Work / Aravo / docs", "TenenbaumAI / docs"]
  );
});

test("short paths and a single pin stay readable", () => {
  assert.deepEqual(folderLabels(["/Volumes"]), ["Volumes"]);
  assert.deepEqual(folderLabels(["/"]), ["/"]);
  assert.deepEqual(folderLabels(["/Users/scott/Documents"]), ["scott / Documents"]);
});

test("withFolderLabels keeps the pin fields and adds a label", () => {
  const [pin] = withFolderLabels([{ id: "a", name: "docs", path: "/x/TenenbaumAI/docs" }]);
  assert.deepEqual(pin, {
    id: "a",
    name: "docs",
    path: "/x/TenenbaumAI/docs",
    label: "TenenbaumAI / docs",
  });
});
