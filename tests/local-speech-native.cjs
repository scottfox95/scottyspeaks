// Synthetic speech is written only to a temporary file, never to speakers.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn, execFileSync } = require("node:child_process");
const { LocalSpeech } = require("../src/helpers/localSpeech");
async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ss2-local-speech-"));
  const output = path.join(directory, "synthetic.aiff");
  const speech = new LocalSpeech({
    spawn: (command, args, options) =>
      spawn(command, args.includes("?") ? args : [...args, "-o", output], options),
  });
  try {
    const voices = await speech.voices();
    assert.ok(voices.some((voice) => voice.name === "Samantha"));
    await speech.configure({ voice: "Samantha" });
    await speech.speak({ text: "SS2 local speech check.", owner: 1 });
    await speech.active.done;
    const info = execFileSync("/usr/bin/afinfo", [output], { encoding: "utf8" });
    const seconds = Number(info.match(/estimated duration:\s+([0-9.]+)/)?.[1]);
    const bytes = Number(info.match(/audio bytes:\s+(\d+)/)?.[1]);
    assert.ok(
      seconds > 0 && bytes > 0,
      "macOS speech must produce actual audio, not just a file header"
    );
    assert.equal(speech.status().speaking, false);
    await speech.speak({ text: "A synthetic sentence for cancellation. ".repeat(200), owner: 1 });
    const token = await speech.beginRecording(2, "dictation");
    assert.equal(speech.status().speaking, false);
    assert.equal(speech.status().recording, true);
    speech.endRecording(token, 2);
    console.log(
      JSON.stringify({
        success: true,
        voiceCount: voices.length,
        seconds,
        audioBytes: bytes,
        stoppedBeforeRecording: true,
      })
    );
  } finally {
    await speech.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
