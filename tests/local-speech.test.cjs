const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough, Writable } = require("node:stream");
const { LocalSpeech } = require("../src/helpers/localSpeech");
function setup(options = {}) {
  const children = [];
  const spawn = (command, args, settings) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.input = "";
    child.stdin = new Writable({
      write(chunk, encoding, done) {
        child.input += chunk;
        done();
      },
    });
    child.kills = [];
    child.kill = (signal) => {
      child.kills.push(signal);
      return true;
    };
    child.args = args;
    child.command = command;
    child.settings = settings;
    children.push(child);
    if (args.includes("?"))
      queueMicrotask(() => {
        child.stdout.end("Samantha en_US # synthetic voice\nDaniel en_GB # synthetic voice\n");
        child.emit("close", 0, null);
      });
    return child;
  };
  const speech = new LocalSpeech({ spawn, platform: "darwin", ...options });
  return { speech, children };
}
test("system speech uses installed voices and bounded stdin without putting text in argv", async () => {
  const { speech, children } = setup();
  assert.equal(speech.status().agentEnabled, false);
  await speech.configure({ voice: "Samantha", rate: 180 });
  const started = await speech.speak({ text: "Synthetic `$(text)`", owner: 1 });
  assert.equal(started.starting, false);
  const child = children.at(-1);
  assert.equal(child.command, "/usr/bin/say");
  assert.deepEqual(child.args, ["-v", "Samantha", "-r", "180"]);
  assert.equal(child.input, "Synthetic `$(text)`\n");
  assert.equal(speech.status().speaking, true);
  const stopped = speech.stop();
  assert.deepEqual(child.kills, ["SIGTERM"]);
  assert.equal(speech.status().speaking, true);
  child.emit("close", null, "SIGTERM");
  await stopped;
  assert.equal(speech.status().speaking, false);
  await assert.rejects(speech.configure({ voice: "not-installed" }), /voice/);
  await assert.rejects(speech.speak({ text: "x".repeat(20001), owner: 1 }), /text/);
});
test("recording blocks speech immediately and waits for actual speech exit before acquiring", async () => {
  const { speech, children } = setup();
  await speech.speak({ text: "Synthetic", owner: 1 });
  const child = children.at(-1);
  let acquired = false;
  const pending = speech.beginRecording(2, "dictation").then((token) => {
    acquired = true;
    return token;
  });
  assert.equal(speech.status().recording, true);
  await assert.rejects(speech.speak({ text: "Must not speak", owner: 1 }), /recording/);
  await new Promise(setImmediate);
  assert.equal(acquired, false);
  child.emit("close", null, "SIGTERM");
  const token = await pending;
  speech.endRecording(token, 1);
  assert.equal(speech.status().recording, true);
  speech.endRecording(token, 2);
  assert.equal(speech.status().recording, false);
});
test("agent speech requires opt-in and is rejected while any recording remains", async () => {
  const { speech, children } = setup();
  await assert.rejects(
    speech.speak({ text: "Synthetic update", source: "agent", owner: "agent" }),
    /disabled/
  );
  await speech.configure({ agentEnabled: true });
  const a = await speech.beginRecording(1, "dictation"),
    b = await speech.beginRecording("call:one", "call");
  speech.endRecording(a, 1);
  await assert.rejects(
    speech.speak({ text: "Synthetic update", source: "agent", owner: "agent" }),
    /recording/
  );
  speech.endRecording(b, "call:one");
  await speech.speak({ text: "Synthetic update", source: "agent", owner: "agent" });
  const disabling = speech.configure({ agentEnabled: false });
  assert.equal(children.at(-1).kills[0], "SIGTERM");
  children.at(-1).emit("close", null, "SIGTERM");
  await disabling;
  assert.equal(speech.status().speaking, false);
});
test("owner loss cancels pending recording acquisition and cannot leave a stale reservation", async () => {
  const { speech, children } = setup();
  await speech.speak({ text: "Synthetic", owner: 1 });
  const pending = speech.beginRecording(2, "dictation");
  speech.releaseOwner(2);
  children.at(-1).emit("close", null, "SIGTERM");
  await assert.rejects(pending, /cancelled/);
  assert.equal(speech.status().recording, false);
});
test("stop during voice discovery cancels pending speech and no later child speaks", async () => {
  const { speech, children } = setup();
  const pending = speech.speak({ text: "Synthetic", owner: 1 });
  await speech.stop();
  await assert.rejects(pending, /cancelled/);
  assert.equal(children.length, 1);
  assert.equal(speech.status().speaking, false);
});
test("failed speech shutdown never allows microphone startup and later real close recovers", async () => {
  const { speech, children } = setup({ stopTimeoutMs: 20 });
  await speech.speak({ text: "Synthetic", owner: 1 });
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(speech.beginRecording(2, "dictation"), /stop-timeout/);
    assert.equal(speech.status().speaking, true);
    assert.equal(speech.status().recording, false);
    assert.deepEqual(children.at(-1).kills, ["SIGTERM", "SIGKILL"]);
    children.at(-1).emit("close", null, "SIGKILL");
    const token = await speech.beginRecording(2, "dictation");
    assert.equal(speech.status().speaking, false);
    speech.endRecording(token, 2);
  } finally {
    clearTimeout(keepAlive);
  }
});
test("stopping call read-aloud does not release a concurrent recording lease", async () => {
  const { speech, children } = setup();
  await speech.speak({ text: "Synthetic call notes", owner: 1 });
  const recording = speech.beginRecording(1, "call");
  const stopped = speech.stopOwner(1);
  children.at(-1).emit("close", null, "SIGTERM");
  await stopped;
  const token = await recording;
  assert.equal(speech.status().recording, true);
  speech.endRecording(token, 1);
  assert.equal(speech.status().recording, false);
});
