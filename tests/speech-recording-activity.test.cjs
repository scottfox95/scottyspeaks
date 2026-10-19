const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  vm = require("node:vm");
function load(api, getUserMedia) {
  const context = {
    window: { electronAPI: api },
    navigator: { mediaDevices: { getUserMedia } },
    document: { querySelectorAll: () => [] },
    module: { exports: {} },
  };
  vm.runInNewContext(
    fs.readFileSync("src/helpers/recordingActivity.js", "utf8").replace(/export /g, "") +
      "\nmodule.exports={openRecordingMicrophone};",
    context
  );
  return context.module.exports;
}
test("mic acquisition waits for authoritative speech stop and releases only after track stop", async () => {
  let begin;
  const events = [];
  const api = {
    speech: {
      beginRecording: () => new Promise((r) => (begin = r)),
      endRecording: async (token) => events.push("release:" + token),
    },
  };
  const { openRecordingMicrophone } = load(api, async () => {
    events.push("mic");
    return { getTracks: () => [{ stop: () => events.push("stop") }] };
  });
  const pending = openRecordingMicrophone({}, "dictation");
  assert.deepEqual(events, []);
  begin("lease");
  const lease = await pending;
  assert.deepEqual(events, ["mic"]);
  await lease.release();
  assert.deepEqual(events, ["mic", "stop", "release:lease"]);
  await lease.release();
  assert.equal(events.length, 3);
});
test("cancel during pending mic keeps reservation until late stream is stopped", async () => {
  let mic,
    cancelled = false;
  const events = [];
  const { openRecordingMicrophone } = load(
    {
      speech: {
        beginRecording: async () => "lease",
        endRecording: async () => events.push("release"),
      },
    },
    () => new Promise((r) => (mic = r))
  );
  const pending = openRecordingMicrophone({}, "notes", () => cancelled);
  while (!mic) await new Promise(setImmediate);
  cancelled = true;
  assert.deepEqual(events, []);
  mic({ getTracks: () => [{ stop: () => events.push("stop") }] });
  await assert.rejects(pending, /cancelled/);
  assert.deepEqual(events, ["stop", "release"]);
});
test("failed microphone acquisition releases reservation and failed speech stop never opens mic", async () => {
  const events = [];
  let failed = false;
  const { openRecordingMicrophone } = load(
    {
      speech: {
        beginRecording: async () => {
          if (failed) throw Error("speech-stop-timeout");
          return "lease";
        },
        endRecording: async () => events.push("release"),
      },
    },
    async () => {
      events.push("mic");
      throw Error("permission");
    }
  );
  await assert.rejects(openRecordingMicrophone({}, "dictation"), /permission/);
  assert.deepEqual(events, ["mic", "release"]);
  failed = true;
  await assert.rejects(openRecordingMicrophone({}, "dictation"), /speech-stop-timeout/);
  assert.deepEqual(events, ["mic", "release"]);
});
