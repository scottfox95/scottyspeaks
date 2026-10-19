const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  { EventEmitter } = require("node:events"),
  { PassThrough } = require("node:stream");
const { CallAgentBridge, requestBridge } = require("../src/helpers/callAgentBridge");
const { LocalSpeech } = require("../src/helpers/localSpeech");
test("authenticated speech tool requires call grant and opt-in, rejects recording and cancels revoked startup", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ss2-speech-agent-"));
  let granted = true;
  const speech = new LocalSpeech({
    platform: "darwin",
    spawn: () => {
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => queueMicrotask(() => child.emit("close", 0));
      return child;
    },
  });
  speech.voices = async () => [];
  const store = {
    permission: () => {
      if (!granted) throw Error("not shared");
      return { id: "grant" };
    },
  };
  const bridge = new CallAgentBridge({ root, store, localSpeech: speech });
  await bridge.start();
  t.after(async () => {
    await speech.close();
    await bridge.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const request = () =>
    requestBridge(bridge.discoveryPath, "speak_update", {
      callId: "call",
      text: "Synthetic progress update.",
    });
  await assert.rejects(request(), /disabled/);
  await speech.configure({ agentEnabled: true });
  granted = false;
  await assert.rejects(request(), /not shared/);
  granted = true;
  const token = await speech.beginRecording("native", "call");
  await assert.rejects(request(), /recording/);
  speech.endRecording(token, "native");
  await request();
  assert.equal(speech.status().source, "agent");
  await speech.stop();
  let voices;
  speech.voices = () => new Promise((r) => (voices = r));
  const pending = request();
  while (!voices) await new Promise(setImmediate);
  granted = false;
  voices([]);
  await assert.rejects(pending, /not shared/);
  assert.equal(speech.status().speaking, false);
});
