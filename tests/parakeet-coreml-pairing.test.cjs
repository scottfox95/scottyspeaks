const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("module");

// parakeetCoremlServer pulls in electron-aware helpers; stub the ones it needs.
const stubs = {
  "./debugLogger": { debug() {}, info() {}, warn() {}, error() {} },
  "../utils/serverUtils": { resolveBinaryPath: () => null, gracefulStopProcess: async () => {} },
  "./modelDirUtils": { getModelsDirForService: () => "/tmp" },
  "./safeTempDir": { getSafeTempDir: () => "/tmp" },
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent?.filename?.endsWith("parakeetCoremlServer.js") && stubs[request]) return stubs[request];
  return originalLoad.call(this, request, parent, isMain);
};
const ParakeetCoremlServer = require("../src/helpers/parakeetCoremlServer");
Module._load = originalLoad;

function fakeServer() {
  const server = new ParakeetCoremlServer();
  const written = [];
  server.ready = true;
  server.process = { stdin: { write: (buf, cb) => { written.push(buf); cb?.(); } } };
  const reply = (obj) => server._onStdout(Buffer.from(JSON.stringify(obj) + "\n"), () => {});
  const idOf = (buf) => JSON.parse(buf.subarray(8, 8 + buf.readUInt32LE(0)).toString()).id;
  return { server, written, reply, idOf };
}

const pcm = Buffer.alloc(16);

test("a late reply to a timed-out request is never given to the next dictation (old helper, no ids)", async () => {
  const { server, reply } = fakeServer();
  const first = server.transcribe(pcm, 16000, { timeoutMs: 10 });
  await assert.rejects(first, /timed out/);
  const second = server.transcribe(pcm, 16000);
  reply({ type: "result", text: "first dictation" });
  reply({ type: "result", text: "second dictation" });
  assert.equal((await second).text, "second dictation");
  assert.equal(server.pending.length, 0);
});

test("replies are matched by echoed id", async () => {
  const { server, written, reply, idOf } = fakeServer();
  const first = server.transcribe(pcm, 16000, { timeoutMs: 10 });
  await assert.rejects(first, /timed out/);
  const second = server.transcribe(pcm, 16000);
  const [firstId, secondId] = written.map(idOf);
  assert.notEqual(firstId, secondId);
  reply({ type: "result", text: "first dictation", id: firstId });
  reply({ type: "result", text: "second dictation", id: secondId });
  assert.equal((await second).text, "second dictation");
});

test("an error reply is routed to its own request", async () => {
  const { server, written, reply, idOf } = fakeServer();
  const a = server.transcribe(pcm, 16000);
  const b = server.transcribe(pcm, 16000);
  reply({ type: "error", message: "boom", id: idOf(written[0]) });
  reply({ type: "result", text: "ok", id: idOf(written[1]) });
  await assert.rejects(a, /boom/);
  assert.equal((await b).text, "ok");
});
