const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { MeetingStore } = require("../src/helpers/meetingStore");

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ss-call-search-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new MeetingStore(directory);
  const create = (patch) => store.update(store.create().id, patch);
  return { store, create };
}

test("call search finds notes and deep transcript text with literal case-insensitive terms", (t) => {
  const { store, create } = fixture(t);
  const notes = create({ title: "Planning", notes: "Owner: Morgan — follow up on ZEBRA." });
  const transcript = create({
    title: "Team sync",
    notes: "Short agenda",
    transcript: "Opening remarks. ".repeat(100) + "Ship the Orion release on Friday.",
  });
  const literal = create({ title: "C++ [v2]", notes: "Keep foo.bar exactly." });
  assert.deepEqual(
    store.list({ query: "  zebra  MORGAN " }).map((m) => m.id),
    [notes.id]
  );
  assert.deepEqual(
    store.list({ query: "orion FRIDAY" }).map((m) => m.id),
    [transcript.id]
  );
  assert.deepEqual(
    store.list({ query: "[v2] foo.bar" }).map((m) => m.id),
    [literal.id]
  );
  assert.deepEqual(store.list({ query: "orion zebra" }), []);
  assert.equal(store.list({ query: "   " }).length, 3);
  assert.equal(store.list().length, 3);
});

test("call summaries include bounded preview and duration without copying entire private text", (t) => {
  const { store, create } = fixture(t);
  const call = create({
    notes: "A".repeat(250),
    transcript: "Full transcript",
    recordedDuration: 185,
  });
  const summary = store.list().find((item) => item.id === call.id);
  assert.equal(summary.preview, "A".repeat(160));
  assert.equal(summary.recordedDuration, 185);
  for (const omitted of ["notes", "transcript", "segments", "audio", "speakers"])
    assert.equal(Object.hasOwn(summary, omitted), false);
  store.update(call.id, { notes: " \n", transcript: "  Transcript fallback  " });
  assert.equal(store.list()[0].preview, "Transcript fallback");
  store.update(call.id, { notes: "new note" });
  assert.equal(store.list({ query: "new note" })[0].preview, "new note");
});

test("invalid call queries fail clearly and damaged entries do not hide healthy results", (t) => {
  const { store, create } = fixture(t);
  const healthy = create({ notes: "Still searchable" });
  const broken = create({ notes: "broken" });
  fs.writeFileSync(path.join(store.directory(broken.id), "session.json"), "not json");
  assert.deepEqual(
    store.list({ query: "searchable" }).map((m) => m.id),
    [healthy.id]
  );
  assert.throws(() => store.list({ query: [] }), /Invalid call search/);
  assert.throws(() => store.list({ query: "x".repeat(1001) }), /Invalid call search/);
});
