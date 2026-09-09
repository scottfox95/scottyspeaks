const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough, Writable } = require("node:stream");
const { RecordingTargetManager } = require("../src/helpers/recordingTarget");
function fakeSpawn(response = { ok: true, event: "pasted" }) {
  const children = [];
  function spawn() {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.sent = [];
    child.killed = false;
    child.stdin = new Writable({
      write(data, _encoding, done) {
        child.sent.push(JSON.parse(data));
        queueMicrotask(() => child.stdout.write(JSON.stringify(response) + "\n"));
        done();
      },
    });
    child.kill = () => {
      child.killed = true;
      queueMicrotask(() => child.emit("close", 0));
    };
    queueMicrotask(() =>
      child.stdout.write(
        JSON.stringify({ ok: true, event: "ready", pid: 123, appName: "Synthetic editor" }) + "\n"
      )
    );
    children.push(child);
    return child;
  }
  return { spawn, children };
}
test("recording targets are distinct, sender-scoped and consumed once", async () => {
  const fake = fakeSpawn(),
    manager = new RecordingTargetManager({ binary: "/synthetic/helper", spawn: fake.spawn });
  const a = await manager.capture(1),
    b = await manager.capture(1);
  assert.notEqual(a.token, b.token);
  assert.equal(a.appName, "Synthetic editor");
  assert.equal((await manager.paste(a.token, 2, "text")).success, false);
  assert.equal(fake.children[0].sent.length, 0);
  assert.equal((await manager.paste(a.token, 1, "literal $(never execute)")).success, true);
  assert.deepEqual(fake.children[0].sent, [{ op: "paste", text: "literal $(never execute)" }]);
  assert.equal((await manager.paste(a.token, 1, "again")).success, false);
  assert.equal(fake.children[1].killed, false);
  manager.releaseOwner(1);
  assert.equal(fake.children[1].killed, true);
});
test("changed or stale targets fail closed without another paste method", async () => {
  const fake = fakeSpawn({ ok: false, reason: "selection-changed" }),
    manager = new RecordingTargetManager({ binary: "/synthetic/helper", spawn: fake.spawn });
  const capture = await manager.capture(8);
  const result = await manager.paste(capture.token, 8, "recoverable text");
  assert.equal(result.success, false);
  assert.equal(result.reason, "selection-changed");
  assert.equal(fake.children[0].sent.length, 1);
  assert.equal(fake.children[0].killed, true);
});
test("bounded startup timeout kills the native helper and releases ownership", async () => {
  let child;
  const manager = new RecordingTargetManager({
    binary: "/synthetic/helper",
    timeoutMs: 10,
    spawn: () => {
      child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.kill = () => {
        child.killed = true;
      };
      return child;
    },
  });
  const result = await manager.capture(1);
  assert.equal(result.available, false);
  assert.equal(child.killed, true);
  assert.equal(manager.targets.size, 0);
});
test("rejects oversized text and renderer-loss cleanup is scoped", async () => {
  const fake = fakeSpawn(),
    manager = new RecordingTargetManager({ binary: "/synthetic/helper", spawn: fake.spawn });
  const a = await manager.capture(1),
    b = await manager.capture(2);
  assert.equal((await manager.paste(a.token, 1, "x".repeat(200001))).success, false);
  assert.equal(fake.children[0].sent.length, 0);
  manager.releaseOwner(1);
  assert.equal(fake.children[1].killed, false);
  manager.release(b.token, 2);
  assert.equal(fake.children[1].killed, true);
});

test("selection is owner scoped, does not consume a token, and replacement is one verified request", async () => {
  const fake = fakeSpawn({ ok: true, text: "synthetic selection" });
  const manager = new RecordingTargetManager({ binary: "/synthetic/helper", spawn: fake.spawn });
  const a = await manager.capture(1);
  assert.equal((await manager.selection(a.token, 2)).text, null);
  assert.equal(fake.children[0].sent.length, 0);
  assert.equal((await manager.selection(a.token, 1)).text, "synthetic selection");
  assert.equal((await manager.paste(a.token, 1, "replacement", "expected")).success, true);
  assert.deepEqual(fake.children[0].sent, [
    { op: "selection" },
    { op: "replace", text: "replacement", expected: "expected" },
  ]);
});

test("native clipboard operations cannot overlap across owners", async () => {
  const fake = fakeSpawn();
  const manager = new RecordingTargetManager({ binary: "/synthetic/helper", spawn: fake.spawn });
  const a = await manager.capture(1),
    b = await manager.capture(2);
  const first = manager.paste(a.token, 1, "one");
  const second = await manager.paste(b.token, 2, "two");
  assert.equal(second.reason, "paste-busy");
  assert.equal(fake.children[1].sent.length, 0);
  assert.equal((await first).success, true);
});

test("target IPC rejects foreign frames and releases handles on navigation, crash and quit", async () => {
  const { registerRecordingTargetHandlers } = require("../src/helpers/recordingTargetHandlers");
  const fake = fakeSpawn(),
    manager = new RecordingTargetManager({ binary: "/synthetic/helper", spawn: fake.spawn });
  const handlers = {},
    app = new EventEmitter(),
    sender = new EventEmitter();
  sender.id = 1;
  sender.mainFrame = {};
  sender.isDestroyed = () => false;
  registerRecordingTargetHandlers({
    ipcMain: {
      handle: (name, fn) => {
        handlers[name] = fn;
      },
    },
    app,
    manager,
    windowManager: { mainWindow: { webContents: sender } },
  });
  assert.equal(
    (await handlers["recording-target:capture"]({ sender, senderFrame: {} })).reason,
    "untrusted-sender"
  );
  assert.equal(
    (await handlers["recording-target:capture"]({ sender: { id: 2 } })).available,
    false
  );
  for (const name of ["did-start-navigation", "render-process-gone", "destroyed"]) {
    const result = await handlers["recording-target:capture"]({
      sender,
      senderFrame: sender.mainFrame,
    });
    assert.equal(result.available, true);
    sender.emit(name);
    assert.equal(manager.targets.size, 0);
  }
  await handlers["recording-target:capture"]({ sender });
  app.emit("before-quit");
  assert.equal(manager.targets.size, 0);
});

test("macOS clipboard adapter declines without touching clipboard or invoking legacy paste/copy", async () => {
  const fs = require("node:fs"),
    vm = require("node:vm");
  const source = fs.readFileSync(require.resolve("../src/helpers/clipboard"), "utf8");
  const module = { exports: {} };
  const forbidden = () => {
    throw new Error("unexpected OS/clipboard access");
  };
  vm.runInNewContext(source, {
    module,
    exports: module.exports,
    process: { platform: "darwin" },
    require: (name) =>
      name === "electron"
        ? { clipboard: new Proxy({}, { get: () => forbidden }), systemPreferences: {} }
        : name === "child_process"
          ? { spawn: forbidden, spawnSync: forbidden }
          : name === "./debugLogger"
            ? {}
            : name === "../utils/process"
              ? {}
              : require(name),
  });
  const adapter = new module.exports();
  assert.equal((await adapter.pasteText("retained")).manualCopy, true);
  adapter.recordingTargets = {
    paste: async () => ({ success: false, reason: "target-changed" }),
    selection: async () => ({ text: "explicit selection" }),
  };
  assert.equal(
    (await adapter.pasteText("retained", { targetToken: "x", webContents: { id: 1 } })).reason,
    "target-changed"
  );
  assert.equal(
    (await adapter.replaceLastPaste("new", "old", { targetToken: "x", webContents: { id: 1 } }))
      .replaced,
    false
  );
  assert.equal((await adapter.captureSelection("x", 1)).text, "explicit selection");
});

test("paste IPC retains canonical text on manual fallback and never starts auto-learn", async () => {
  const fs = require("node:fs"),
    vm = require("node:vm");
  const source = fs.readFileSync(require.resolve("../src/helpers/ipcHandlers"), "utf8");
  const start = source.indexOf('    ipcMain.handle("paste-text",');
  const end = source.indexOf("    // Voice command", start);
  let handler,
    calls = 0,
    monitors = 0,
    pastes = 0;
  const sender = { id: 5, mainFrame: {} };
  const ctx = {
    windowManager: { mainWindow: { webContents: sender } },
    _getDictionarySafe: () => [],
    _autoLearnEnabled: true,
    textEditMonitor: { startMonitoring: () => monitors++ },
    clipboardManager: {
      pasteText: async (text, options) => {
        pastes++;
        assert.equal(options.webContents, sender);
        assert.equal(options.targetToken, "owned");
        return { success: false, manualCopy: true, reason: "target-changed" };
      },
    },
  };
  vm.runInNewContext(`(function(){${source.slice(start, end)}}).call(context)`, {
    context: ctx,
    ipcMain: {
      handle: (_name, fn) => {
        handler = fn;
      },
    },
    process: { platform: "darwin" },
    Buffer,
    trustedTargetSender: require("../src/helpers/recordingTargetHandlers").trustedTargetSender,
    applyDictionaryCorrections: (text) => {
      calls++;
      return text.toUpperCase();
    },
    debugLogger: { debug() {} },
    setTimeout: () => {
      throw new Error("manual delivery cannot schedule auto-learn");
    },
  });
  const declined = await handler({ sender }, "literal", { targetToken: "owned", exact: true });
  assert.equal(declined.text, "literal");
  assert.equal(declined.manualCopy, true);
  assert.equal(calls, 0);
  const canonical = await handler({ sender }, "literal", { targetToken: "owned" });
  assert.equal(canonical.text, "LITERAL");
  assert.equal(calls, 1);
  assert.equal(monitors, 0);
  await handler({ sender, senderFrame: {} }, "foreign", { targetToken: "owned" });
  assert.equal(pastes, 2);
});

function deferredTransaction() {
  const fake = fakeSpawn();
  const originalSpawn = fake.spawn;
  fake.spawn = () => {
    const child = originalSpawn();
    // Real helper stays alive to restore its owned clipboard after SIGTERM.
    child.kill = () => {
      child.killed = true;
    };
    child.stdin = new Writable({
      write(data, _encoding, done) {
        child.sent.push(JSON.parse(data));
        done();
      },
    });
    return child;
  };
  return fake;
}
for (const boundary of ["release", "timeout", "stdin-error"]) {
  test(`clipboard transaction stays excluded after ${boundary} until actual native close`, async () => {
    const fake = deferredTransaction();
    const manager = new RecordingTargetManager({
      binary: "/synthetic",
      spawn: fake.spawn,
      timeoutMs: 15,
    });
    const a = await manager.capture(1),
      b = await manager.capture(2);
    const first = manager.paste(a.token, 1, "A");
    if (boundary === "release") manager.release(a.token, 1);
    if (boundary === "stdin-error")
      fake.children[0].stdin.emit("error", new Error("pipe closed, process alive"));
    assert.equal((await first).success, false);
    const second = await manager.paste(b.token, 2, "B");
    assert.equal(second.reason, "paste-busy");
    assert.equal(fake.children[1].sent.length, 0);
    fake.children[0].emit("close", 0);
    const c = await manager.capture(3);
    const third = manager.paste(c.token, 3, "C");
    assert.equal(fake.children[2].sent.length, 1);
    fake.children[2].stdout.write(
      JSON.stringify({ ok: true, event: "transaction-complete" }) + "\n"
    );
    assert.equal((await third).success, true);
    manager.close();
  });
}
test("late native transaction acknowledgement unlocks after caller release without waiting for exit", async () => {
  const fake = deferredTransaction(),
    manager = new RecordingTargetManager({ binary: "/synthetic", spawn: fake.spawn });
  const a = await manager.capture(1);
  const first = manager.paste(a.token, 1, "A");
  manager.release(a.token, 1);
  await first;
  assert.ok(manager.pasting);
  fake.children[0].stdout.write(
    JSON.stringify({ ok: false, event: "transaction-complete", reason: "cancelled" }) + "\n"
  );
  assert.ok(!manager.pasting);
  manager.close();
});
