const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("module");

const { PasteOutcomeLog } = require("../src/helpers/pasteOutcomes");
const { PasteLastManager, DEFAULT_PASTE_LAST_HOTKEY } = require("../src/helpers/pasteLast");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ss2-paste-"));

test("paste outcomes record app, role and reason but never text", () => {
  const file = path.join(tmp(), "paste-outcomes.jsonl");
  const log = new PasteOutcomeLog(file);
  log.record({ success: false, reason: "secure-input", appName: "Slack", role: "AXTextArea", onClipboard: true, text: "secret words" });
  log.record({ success: true, appName: "Notes", role: "AXTextArea", chars: 12 });
  log.record({ success: false, reason: "Not A Safe Reason!" });
  const raw = fs.readFileSync(file, "utf8");
  assert.ok(!raw.includes("secret words"));
  const [last, second, first] = new PasteOutcomeLog(file).list(10);
  assert.equal(first.app, "Slack");
  assert.equal(first.reason, "secure-input");
  assert.equal(first.onClipboard, true);
  assert.equal(second.ok, true);
  assert.equal(last.reason, "unknown");
});

test("paste outcome log keeps the newest 200", () => {
  const file = path.join(tmp(), "paste-outcomes.jsonl");
  const log = new PasteOutcomeLog(file);
  for (let i = 0; i < 230; i++) log.record({ success: true, appName: `app${i}` });
  const entries = new PasteOutcomeLog(file).list(500);
  assert.equal(entries.length, 200);
  assert.equal(entries[0].app, "app229");
});

function fakeShortcuts(taken = []) {
  const registered = new Map();
  return {
    registered,
    register: (accel, cb) => (taken.includes(accel) ? false : (registered.set(accel, cb), true)),
    unregister: (accel) => registered.delete(accel),
  };
}

test("paste last registers ⌃⌥V by default, can be changed or turned off", () => {
  const shortcuts = fakeShortcuts();
  const env = {};
  const m = new PasteLastManager({ globalShortcut: shortcuts, env });
  assert.equal(m.register().success, true);
  assert.ok(shortcuts.registered.has(DEFAULT_PASTE_LAST_HOTKEY));
  assert.equal(m.set("Control+Alt+P").success, true);
  assert.ok(!shortcuts.registered.has(DEFAULT_PASTE_LAST_HOTKEY));
  assert.equal(env.PASTE_LAST_HOTKEY, "Control+Alt+P");
  assert.equal(m.set("").success, true);
  assert.equal(shortcuts.registered.size, 0);
  assert.equal(m.getHotkey(), "");
});

test("a taken shortcut is refused and the previous one stays", () => {
  const shortcuts = fakeShortcuts(["Command+Space"]);
  const env = {};
  const m = new PasteLastManager({ globalShortcut: shortcuts, env });
  m.register();
  assert.equal(m.set("Command+Space").success, false);
  assert.ok(shortcuts.registered.has(DEFAULT_PASTE_LAST_HOTKEY));
  assert.equal(env.PASTE_LAST_HOTKEY, undefined);
});

test("paste last pastes the latest dictation at the current focus, and leaves it on the clipboard on refusal", async () => {
  const pasted = [];
  const recorded = [];
  let refuse = false;
  const clipboard = { leaveOnClipboard: (text) => (pasted.push(["clipboard", text]), true), recordPasteOutcome: (o) => recorded.push(o) };
  const targets = {
    capture: async () => ({ token: "t", appName: "Slack", role: "AXTextArea" }),
    paste: async (token, owner, text) => (refuse ? { success: false, reason: "secure-input" } : (pasted.push(["paste", text]), { success: true })),
  };
  const notes = [];
  const m = new PasteLastManager({ globalShortcut: fakeShortcuts(), recordingTargets: targets, clipboardManager: clipboard,
    getLastText: () => "Last one.", getOwner: () => 7, notify: (n) => notes.push(n) });
  assert.equal((await m.run()).success, true);
  assert.deepEqual(pasted, [["paste", "Last one."]]);
  refuse = true;
  const r = await m.run();
  assert.equal(r.success, false);
  assert.equal(r.onClipboard, true);
  assert.deepEqual(pasted.at(-1), ["clipboard", "Last one."]);
  assert.equal(recorded.at(-1).source, "paste-last");
  assert.equal(recorded.at(-1).appName, "Slack");
  assert.equal(notes.at(-1).reason, "secure-input");
});

test("paste last with no history says so", async () => {
  const notes = [];
  const m = new PasteLastManager({ globalShortcut: fakeShortcuts(), getLastText: () => "", notify: (n) => notes.push(n) });
  assert.equal((await m.run()).reason, "nothing-to-paste");
  assert.equal(notes[0].reason, "nothing-to-paste");
});

test("the problem log scrubs dictation text and rotates", () => {
  const dir = tmp();
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "electron") return { app: { isReady: () => true, getPath: () => dir } };
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[require.resolve("../src/helpers/debugLogger")];
  const logger = require("../src/helpers/debugLogger");
  Module._load = originalLoad;
  const origWarn = console.warn;
  const origError = console.error;
  console.warn = () => {};
  console.error = () => {};
  try {
    logger.warn("Paste refused", { app: "Slack", text: "my private dictation", nested: { rawText: "also private" } });
    logger.info("not a problem", { x: 1 });
    logger.error("Polish failed", { error: "timeout", prompt: "private prompt" });
    const file = path.join(dir, "logs", "ss2.log");
    const body = fs.readFileSync(file, "utf8");
    assert.match(body, /Paste refused/);
    assert.match(body, /Polish failed/);
    assert.ok(!body.includes("not a problem"));
    assert.ok(!body.includes("private"));
    fs.appendFileSync(file, "x".repeat(1024 * 1024 + 10));
    logger.warn("after rotation");
    assert.ok(fs.existsSync(`${file}.1`));
    assert.match(fs.readFileSync(file, "utf8"), /after rotation/);
  } finally {
    console.warn = origWarn;
    console.error = origError;
  }
});
