// Main-process fixes from the Fable 5.2 review (D9, D14-D17, R11, §3, §4).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const http = require("node:http");
const EventEmitter = require("node:events");
const { spawn } = require("node:child_process");
const { WebSocketServer } = require("ws");

const root = path.resolve(__dirname, "..");
const ownedProcesses = require("../src/helpers/ownedProcesses");
const { isPortAvailable } = require("../src/utils/serverUtils");
const LlamaServerManager = require("../src/helpers/llamaServer");
const WhisperServerManager = require("../src/helpers/whisperServer");
const ParakeetWsServer = require("../src/helpers/parakeetWsServer");
const ParakeetServerManager = require("../src/helpers/parakeetServer");
const GlobeKeyManager = require("../src/helpers/globeKeyManager");
const EnvironmentManager = require("../src/helpers/environment");
const { convertToWav } = require("../src/helpers/ffmpegUtils");
const { ScreenRecorder } = require("../src/helpers/screenRecorder");

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "ss2-fixes-"));
const listen = (server, host = "127.0.0.1") =>
  new Promise((resolve) => server.listen(0, host, () => resolve(server.address().port)));
const flush = () => new Promise((resolve) => setImmediate(resolve));

// D15 ---------------------------------------------------------------------

test("D15: stale servers from a crashed run are stopped, unrelated pids are not", async () => {
  const dir = tempDir();
  const file = path.join(dir, "owned-processes.json");
  const orphan = spawn("/bin/sleep", ["30"]);
  const stranger = spawn("/bin/sleep", ["31"]);
  try {
    // A previous run recorded the orphan; the stranger is a pid recorded with
    // a different binary (pid reuse), which must never be signalled.
    fs.writeFileSync(
      file,
      JSON.stringify([
        { pid: orphan.pid, name: "llama-server", binary: "/bin/sleep" },
        { pid: stranger.pid, name: "whisper-server", binary: "/opt/ss2/whisper-server" },
      ])
    );
    const exited = new Promise((resolve) => orphan.once("exit", (_code, signal) => resolve(signal)));
    const reaped = ownedProcesses.reapStale({ filePath: file, graceMs: 0 });

    assert.deepEqual(reaped.map((entry) => entry.pid), [orphan.pid]);
    assert.equal(await exited, "SIGTERM");
    assert.equal(stranger.exitCode, null);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), []);
  } finally {
    orphan.kill("SIGKILL");
    stranger.kill("SIGKILL");
  }
});

test("D15: spawned servers are recorded until they exit", async () => {
  const dir = tempDir();
  const file = path.join(dir, "owned-processes.json");
  ownedProcesses._resetForTests();
  ownedProcesses.setRegistryPath(file);
  const child = spawn("/bin/sleep", ["30"]);
  try {
    ownedProcesses.track(child, { name: "sherpa-onnx-ws", binary: "/bin/sleep" });
    const recorded = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(
      recorded.map(({ pid, name, binary }) => ({ pid, name, binary })),
      [{ pid: child.pid, name: "sherpa-onnx-ws", binary: "/bin/sleep" }]
    );
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await exited;
    await flush();
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), []);
  } finally {
    child.kill("SIGKILL");
    ownedProcesses._resetForTests();
  }
});

// §3 port probing ---------------------------------------------------------

test("§3: the shared port probe sees servers bound to loopback and to the wildcard", async () => {
  const loopback = net.createServer();
  const wildcard = net.createServer();
  const loopbackPort = await listen(loopback, "127.0.0.1");
  const wildcardPort = await listen(wildcard, "0.0.0.0");
  try {
    assert.equal(await isPortAvailable(loopbackPort), false);
    assert.equal(await isPortAvailable(wildcardPort), false);
  } finally {
    loopback.close();
    wildcard.close();
  }
});

test("§3: llama and whisper use the shared port probe", () => {
  for (const file of ["src/helpers/llamaServer.js", "src/helpers/whisperServer.js"]) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    assert.match(source, /require\("\.\.\/utils\/serverUtils"\)/, file);
    assert.doesNotMatch(source, /isPortAvailable\(port\)\s*\{/, file);
  }
});

// D14 ---------------------------------------------------------------------

async function healthTick(manager, t, healthy) {
  manager.checkHealth = async () => healthy;
  manager.startHealthCheck();
  t.mock.timers.tick(5000);
  await flush();
  await flush();
}

test("D14: llama-server becomes ready again on the next good health check", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const manager = new LlamaServerManager();
  manager.process = new EventEmitter();
  manager.ready = false; // marked unready by earlier slow checks
  await healthTick(manager, t, true);
  assert.equal(manager.ready, true);
  manager.stopHealthCheck();
});

test("D14: whisper-server tolerates one slow check and recovers", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const manager = new WhisperServerManager();
  manager.process = new EventEmitter();
  manager.ready = true;
  await healthTick(manager, t, false);
  assert.equal(manager.ready, true, "a single failed check no longer drops the model");
  manager.stopHealthCheck();

  manager.ready = false;
  await healthTick(manager, t, true);
  assert.equal(manager.ready, true);
  manager.stopHealthCheck();
});

// D23 / R11: llama request abort ------------------------------------------

async function stuckLlama() {
  const closed = [];
  const server = http.createServer((req, res) => {
    if (req.url === "/health") return res.end("ok");
    req.on("close", () => closed.push(req.url));
    // never answers the completion
  });
  const port = await listen(server);
  const manager = new LlamaServerManager();
  manager.port = port;
  manager.ready = true;
  manager.process = new EventEmitter();
  return { server, manager, closed };
}

test("R11/D23: a llama inference timeout destroys the request so the server stops generating", async () => {
  const { server, manager, closed } = await stuckLlama();
  try {
    await assert.rejects(manager.inference([{ role: "user", content: "x" }], { timeoutMs: 100 }), /timed out/);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(closed, ["/v1/chat/completions"]);
    assert.equal(manager.inflight.size, 0);
  } finally {
    server.close();
  }
});

test("D23: abortInflight cancels a running polish request", async () => {
  const { server, manager, closed } = await stuckLlama();
  try {
    const pending = manager.inference([{ role: "user", content: "x" }]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(manager.abortInflight("Polish cancelled"), 1);
    await assert.rejects(pending, /Polish cancelled/);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(closed, ["/v1/chat/completions"]);
  } finally {
    server.close();
  }
});

// D16 ---------------------------------------------------------------------

async function wsServerThat(onConnection) {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((resolve) => wss.once("listening", resolve));
  wss.on("connection", onConnection);
  const server = new ParakeetWsServer();
  server.port = wss.address().port;
  server.ready = true;
  server.process = new EventEmitter();
  return { wss, server };
}

test("D16: sherpa-onnx dying mid-request is an error, not silence", async () => {
  const { wss, server } = await wsServerThat((socket) => {
    socket.once("message", () => socket.terminate());
  });
  try {
    await assert.rejects(server.transcribe(Buffer.alloc(64), 16000), (error) => {
      assert.equal(error.code, "PARAKEET_ENGINE_STOPPED");
      return true;
    });
    assert.equal(server.transcribing, false);
  } finally {
    wss.close();
  }
});

test("D16: a real empty result still reads as empty text", async () => {
  const { wss, server } = await wsServerThat((socket) => {
    socket.once("message", () => socket.send(JSON.stringify({ text: "" })));
    socket.on("message", (data) => {
      if (data.toString() === "Done") socket.close();
    });
  });
  try {
    const result = await server.transcribe(Buffer.alloc(64), 16000);
    assert.equal(result.text, "");
  } finally {
    wss.close();
  }
});

// D9 + §4 resident sherpa -------------------------------------------------

function coremlOnlyManager(start) {
  const manager = new ParakeetServerManager();
  manager.coremlServer.isAvailable = () => true;
  manager.coremlServer.ready = false;
  manager.coremlServer.start = start;
  manager.wsServer.isAvailable = () => false; // no ONNX fallback on this Mac
  return manager;
}

test("D9: without the ONNX model, a CoreML download/recompile fails the dictation fast", async () => {
  const manager = coremlOnlyManager(() => new Promise(() => {}));
  const started = Date.now();
  await assert.rejects(manager.transcribe(Buffer.alloc(64)), (error) => {
    assert.equal(error.code, "PARAKEET_WARMING_UP");
    assert.equal(error.startupError, undefined);
    return true;
  });
  assert.ok(Date.now() - started < 3000, "does not block on the provisioning");
});

test("D9: a CoreML start failure is reported with its reason", async () => {
  const manager = coremlOnlyManager(async () => {
    throw new Error("weights download failed");
  });
  await assert.rejects(manager.transcribe(Buffer.alloc(64)), (error) => {
    assert.equal(error.code, "PARAKEET_WARMING_UP");
    assert.equal(error.startupError, "weights download failed");
    return true;
  });
});

test("§4: the sherpa-onnx stand-in is stopped once CoreML is ready and it sits idle", async () => {
  const manager = new ParakeetServerManager();
  manager.coremlServer.isAvailable = () => true;
  manager.coremlServer.ready = true;
  manager.wsServer.process = new EventEmitter();
  let stopped = 0;
  manager.wsServer.stop = async () => {
    stopped++;
  };
  manager._scheduleOnnxIdleStop(10);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(stopped, 1);

  // Not while CoreML is still coming up: then sherpa is the only engine.
  manager.coremlServer.ready = false;
  manager._scheduleOnnxIdleStop(10);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(stopped, 1);
});

// D17 ---------------------------------------------------------------------

test("D17: restart backoff doubles and caps", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(GlobeKeyManager.restartDelayMs), [1000, 2000, 4000, 8000, 16000, 16000]);
});

test("D17: a crashed Globe listener (non-zero exit) is restarted", async () => {
  const manager = new GlobeKeyManager();
  manager.isSupported = true;
  manager.resolveListenerBinary = () => "/usr/bin/false";
  manager._checkArchMismatch = () => null;
  const errors = [];
  manager.on("error", (error) => errors.push(error));
  manager.start();
  await new Promise((resolve) => setTimeout(resolve, 300));
  try {
    assert.equal(manager._restartCount, 1);
    assert.ok(manager._restartTimer, "restart scheduled");
    assert.deepEqual(errors, []);
  } finally {
    manager.stop();
  }
  assert.equal(manager._restartTimer, null);
});

// D18 ---------------------------------------------------------------------

test("D18: compound push-to-talk no longer spawns python3", () => {
  const source = fs.readFileSync(path.join(root, "src/helpers/windowManager.js"), "utf8");
  assert.doesNotMatch(source, /spawn\("python3"/);
  assert.match(source, /--wait-release/);
  const swift = fs.readFileSync(path.join(root, "resources/macos-globe-listener.swift"), "utf8");
  assert.match(swift, /"--wait-release"/);
});

// §3 conflicting defaults -------------------------------------------------

test("§3: saving an unknown activation mode falls back to push, like reading does", () => {
  const saved = [];
  const env = {
    _saveKey: (key, value) => saved.push([key, value]),
    saveAllKeysToEnvFile: async () => {},
  };
  for (const mode of ["bogus", undefined, "push", "tap"]) {
    EnvironmentManager.prototype.saveActivationMode.call(env, mode);
  }
  assert.deepEqual(saved.map(([, value]) => value), ["push", "push", "push", "tap"]);
  const read = (value) => EnvironmentManager.prototype.getActivationMode.call({ _getKey: () => value });
  assert.equal(read("bogus"), "push");
  assert.equal(read(undefined), "push");
});

// §3 dead branch ----------------------------------------------------------

test("§3: paste handlers have no macOS branch inside a non-macOS guard", () => {
  const source = fs.readFileSync(path.join(root, "src/helpers/ipcHandlers.js"), "utf8");
  assert.doesNotMatch(source, /platform !== "darwin"[^\n]*\{\s*\n\s*if \(process\.platform === "darwin"\)/);
});

// R11 ---------------------------------------------------------------------

test("R11: ffmpeg conversion is killed when it exceeds its timeout", async () => {
  const dir = tempDir();
  const input = path.join(dir, "in.webm");
  fs.writeFileSync(input, Buffer.alloc(16));
  await assert.rejects(
    convertToWav(input, path.join(dir, "out.wav"), { timeoutMs: 1 }),
    /timed out/
  );
});

test("R11: the screen source picker gives up and kills a hung helper", async () => {
  let killed = null;
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = (signal) => {
    killed = signal;
  };
  const recorder = new ScreenRecorder({ directory: tempDir(), binary: "/nonexistent", spawn: () => child });
  await assert.rejects(recorder.sources({ timeoutMs: 20 }), /timed out/);
  assert.equal(killed, "SIGKILL");
});

// §4 polling --------------------------------------------------------------

test("§4: status polls pause while the window is hidden (and unfocused, where asked)", () => {
  const { isPollingPaused } = require("../src/utils/pollingGate.mjs");
  const visibleFocused = { hidden: false, hasFocus: () => true };
  const visibleBlurred = { hidden: false, hasFocus: () => false };
  const hidden = { hidden: true, hasFocus: () => false };
  assert.equal(isPollingPaused({}, visibleFocused), false);
  assert.equal(isPollingPaused({}, visibleBlurred), false);
  assert.equal(isPollingPaused({ whenUnfocused: true }, visibleBlurred), true);
  assert.equal(isPollingPaused({}, hidden), true);
  for (const file of [
    "src/components/ControlPanelSidebar.tsx",
    "src/components/WindowControls.tsx",
    "src/components/screen/ScreenRecordingsView.tsx",
  ]) {
    assert.match(fs.readFileSync(path.join(root, file), "utf8"), /startGatedPolling\(/, file);
  }
});

// i18n --------------------------------------------------------------------

test("new strings exist in every locale", () => {
  const locales = fs
    .readdirSync(path.join(root, "src/locales"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  assert.equal(locales.length, 10);
  const keys = [
    "hooks.audioRecording.speechModelPreparing",
    "hooks.audioRecording.speechModelFailed",
    "hooks.audioRecording.speechEngineStopped",
    "app.buttons.skipRefinement",
    "dictationCleanup.stages.cancelled",
  ];
  for (const locale of locales) {
    const data = JSON.parse(fs.readFileSync(path.join(root, "src/locales", locale, "translation.json"), "utf8"));
    for (const key of keys) {
      const value = key.split(".").reduce((node, part) => node?.[part], data);
      assert.equal(typeof value, "string", `${locale}: ${key}`);
    }
    assert.match(
      key("hooks.audioRecording.speechModelFailed", data),
      /\{\{error\}\}/,
      `${locale}: interpolation kept`
    );
  }
  function key(name, data) {
    return name.split(".").reduce((node, part) => node?.[part], data);
  }
});
