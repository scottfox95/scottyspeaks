const test = require("node:test");
const assert = require("node:assert/strict");
const {
  attributeWords,
  buildSegments,
  frameLevels,
  microphoneSpeaker,
} = require("../src/helpers/meetingDiarization");

// Builds a diarization result from [startSeconds, endSeconds, speaker, probability] spans.
function diarization(seconds, spans, speakers = 8) {
  const frames = Math.round(seconds * 100);
  const probabilities = new Float32Array(frames * speakers);
  for (const [start, end, speaker, probability = 0.9] of spans)
    for (let frame = Math.round(start * 100); frame < Math.round(end * 100); frame++)
      probabilities[frame * speakers + speaker] = probability;
  return { probabilities, frames, speakers, frameSeconds: 0.01 };
}

test("words go to the speaker with the most activity across their span", () => {
  const d = diarization(4, [
    [0, 2.05, 0],
    [1.9, 4, 1],
  ]);
  const words = [
    { word: "Hello", start: 0.2, end: 0.6 },
    { word: "there.", start: 0.7, end: 1.0 },
    // Mostly inside speaker 1 even though speaker 0 lingers into it.
    { word: "Hi,", start: 1.95, end: 2.4 },
    { word: "Scott.", start: 2.5, end: 2.9 },
  ];
  assert.deepEqual(attributeWords(words, d), [0, 0, 1, 1]);
});

test("attribution honours the group offset and fills silent-frame words from neighbours", () => {
  const d = diarization(3, [
    [0, 1, 0],
    [2, 3, 1],
  ]);
  const words = [
    { word: "one", start: 100.2, end: 100.5 },
    { word: "gap", start: 101.3, end: 101.5 },
    { word: "two", start: 102.2, end: 102.5 },
  ];
  assert.deepEqual(attributeWords(words, d, 100), [0, 0, 1]);
  assert.deepEqual(attributeWords([{ word: "x", start: 1.2, end: 1.4 }], d), [null]);
});

test("segments break on speaker changes and on pauses after finished sentences", () => {
  const segments = buildSegments([
    { word: "Can", start: 0, end: 0.2, speaker: "a" },
    { word: "you", start: 0.2, end: 0.4, speaker: "a" },
    { word: "hear?", start: 0.4, end: 0.8, speaker: "a" },
    { word: "Yes.", start: 1.0, end: 1.3, speaker: "b" },
    { word: "Good.", start: 1.5, end: 1.8, speaker: "b" },
    // Long pause after a full stop starts a new paragraph for the same speaker.
    { word: "Next", start: 4.0, end: 4.3, speaker: "b" },
    // Long pause mid-sentence does not.
    { word: "item", start: 6.0, end: 6.3, speaker: "b" },
  ]);
  assert.deepEqual(segments, [
    { text: "Can you hear?", start: 0, end: 0.8, speaker: "a" },
    { text: "Yes. Good.", start: 1.0, end: 1.8, speaker: "b" },
    { text: "Next item", start: 4.0, end: 6.3, speaker: "b" },
  ]);
});

test("frame levels report dBFS per frame with a silence floor", () => {
  const pcm = Buffer.alloc(160 * 2 * 2);
  for (let i = 0; i < 160; i++) pcm.writeInt16LE(i % 2 ? 16384 : -16384, i * 2);
  const levels = frameLevels(pcm, 160);
  assert.equal(levels.length, 2);
  assert.ok(Math.abs(levels[0] - -6.02) < 0.05, `level ${levels[0]}`);
  assert.equal(levels[1], -90);
});

function levels(seconds, spans, background) {
  const out = new Float32Array(Math.round(seconds * 100)).fill(background);
  for (const [start, end, db] of spans)
    for (let frame = Math.round(start * 100); frame < Math.round(end * 100); frame++)
      out[frame] = db;
  return out;
}

test("the speaker dominant on the microphone is found despite far-side bleed", () => {
  const d = diarization(20, [
    [0, 10, 0],
    [10, 20, 1],
  ]);
  // Local talker: loud on the mic, silent on the call track. Remote talker:
  // loud on the call track and bleeding into the mic 25dB down.
  const microphone = levels(
    20,
    [
      [0, 10, -20],
      [10, 20, -45],
    ],
    -90
  );
  const system = levels(20, [[10, 20, -20]], -90);
  assert.equal(microphoneSpeaker(d, microphone, system), 0);
});

test("microphone attribution declines ambiguous or overlapped evidence", () => {
  const shared = diarization(20, [
    [0, 10, 0],
    [10, 20, 1],
  ]);
  // Two people in the room share the microphone.
  const both = levels(20, [[0, 20, -20]], -90);
  assert.equal(microphoneSpeaker(shared, both, levels(20, [], -90)), null);
  // Only overlapped speech: no frame has a single active speaker.
  const overlapped = diarization(20, [
    [0, 20, 0],
    [0, 20, 1],
  ]);
  assert.equal(microphoneSpeaker(overlapped, both, levels(20, [], -90)), null);
  // Everyone is louder on the call track than on the microphone.
  const remoteOnly = diarization(20, [[0, 20, 0]]);
  assert.equal(microphoneSpeaker(remoteOnly, levels(20, [], -60), levels(20, [], -20)), null);
});
