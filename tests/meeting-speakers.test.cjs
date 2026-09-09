const test = require("node:test");
const assert = require("node:assert/strict");
const { renderMarkdown } = require("../src/helpers/meetingStore");
const { buildCallEvidence } = require("../src/helpers/callAgentStore");
const { describeSpeakers, speakerLabels } = require("../src/utils/meetingSpeakers.mjs");
const call = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "Synthetic",
  notes: "",
  transcript: "Original",
  createdAt: "2026-09-07",
  revision: 1,
  speakers: {},
  segments: [
    "part-0-0:1",
    "part-0-0:0",
    "part-0-0:1",
    "part-1-0:0",
    "microphone",
    "system",
    "Morgan",
  ].map((speaker, i) => ({ speaker, start: i, end: i + 1, text: `Line ${i}` })),
};
test("exports assign friendly first-occurrence labels without merging chunk identities", () => {
  const markdown = renderMarkdown(call);
  assert.match(markdown, /Speaker 1:\*\* Line 0/);
  assert.match(markdown, /Speaker 2:\*\* Line 1/);
  assert.match(markdown, /Speaker 1:\*\* Line 2/);
  assert.match(markdown, /Speaker 3:\*\* Line 3/);
  assert.match(markdown, /Microphone:\*\* Line 4/);
  assert.match(markdown, /Call audio:\*\* Line 5/);
  assert.match(markdown, /Morgan:\*\* Line 6/);
  assert.doesNotMatch(markdown, /part-0/);
});
test("rename affects matching evidence labels and exports, preserving stable evidence identity and edited prose", () => {
  const renamed = {
    ...call,
    speakers: { "part-0-0:1": "Alex" },
    transcriptEdited: true,
    transcript: "My corrected prose: part-0-0:1 stays literal.",
  };
  const before = buildCallEvidence(call.id, call);
  const after = buildCallEvidence(call.id, renamed);
  assert.deepEqual(
    after.evidence.slice(0, 7).map((e) => e.id.split(":")[1]),
    before.evidence.map((e) => e.id.split(":")[1])
  );
  assert.equal(after.evidence[0].speaker, "Alex");
  assert.equal(after.evidence[2].speaker, "Alex");
  assert.equal(after.evidence[3].speaker, "Speaker 3");
  assert.equal(after.evidence[0].speakerId, "part-0-0:1");
  assert.match(renderMarkdown(renamed), /My corrected prose: part-0-0:1 stays literal\./);
});

test("speaker samples retain exact timing and source identity, with distinct legacy chunk IDs", () => {
  const meeting = { speakers: {}, segments: [
    { speaker: "chunk:0", start: 2, text: "Yes." },
    { speaker: "chunk:0", start: 7, text: "This is the first useful excerpt for identifying this voice." },
    { speaker: "chunk-2:0", start: 12, text: "Another audio part with a separate voice identity." },
    { speaker: "Morgan", start: 18, text: "An imported named participant." },
    { speaker: "audio", start: 20, text: "Unlabeled audio." },
  ] };
  const entries = describeSpeakers(meeting);
  assert.equal(entries[0].sample.start, 7);
  assert.equal(entries[0].sample.text, meeting.segments[1].text);
  const labels = speakerLabels(meeting);
  assert.equal(labels.get("chunk:0"), "Speaker 1");
  assert.equal(labels.get("chunk-2:0"), "Speaker 2");
  assert.equal(labels.get("Morgan"), "Morgan");
  assert.equal(labels.get("audio"), "Speaker");
  assert.deepEqual(meeting.speakers, {});
});
test("a locally mixed track is displayed as call audio while retaining a distinct identity", () => {
  const meeting = {
    segments: [{ start: 0, end: 10, text: "Combined conversation", speaker: "combined" }],
    speakers: { combined: "" },
  };
  assert.equal(describeSpeakers(meeting)[0].kind, "system");
  assert.equal(speakerLabels(meeting).get("combined"), "Call audio");
});
