// D21 / D22 / D11: dictation overlay feedback.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const hookSource = fs.readFileSync(path.join(root, "src/hooks/useAudioRecording.js"), "utf8");

function delivery(audio, api, extras) {
  const start =
    hookSource.indexOf("onTranscriptionComplete: async (result) => {") + "onTranscriptionComplete: ".length;
  const end = hookSource.indexOf("    });\n\n    audioManagerRef.current.setContext", start);
  const callback = hookSource
    .slice(start, end)
    .trim()
    .replace(/,$/, "")
    .replace('await import("../services/polish/voiceCommand")', "({applyVoiceCommand: command})");
  return vm.runInNewContext(`(${callback})`, {
    audioManagerRef: { current: audio },
    window: { electronAPI: api },
    getSettings: () => ({}),
    performance,
    setTranscript() {},
    t: (key) => key,
    logger: { info() {} },
    ...extras,
  });
}

function voiceCommandRun({ pasteSucceeds }) {
  const toasts = [];
  const audio = {
    lastPastedText: "",
    // The real safePaste raises its own PASTE_FAILED toast via onError.
    safePaste: async () => {
      if (!pasteSucceeds) toasts.push("paste-failed (from safePaste)");
      return pasteSucceeds ? { success: true, text: "edited" } : { success: false, text: "edited", manualCopy: true };
    },
    saveTranscription: async () => ({ success: true, transcription: { id: 1 } }),
  };
  const fn = delivery(
    audio,
    {},
    {
      commandModeRef: { current: true },
      toast: (options) => toasts.push(options.title),
      command: async () => ({ ok: true, text: "edited", usedSelection: true }),
    }
  );
  return { run: () => fn({ success: true, text: "make it shorter", rawText: "make it shorter" }), toasts };
}

test("D21: a failed voice-command paste shows one toast, not two", async () => {
  const { run, toasts } = voiceCommandRun({ pasteSucceeds: false });
  await run();
  assert.deepEqual(toasts, ["paste-failed (from safePaste)"]);
});

test("D21: a successful voice-command replacement still confirms once", async () => {
  const { run, toasts } = voiceCommandRun({ pasteSucceeds: true });
  await run();
  assert.equal(toasts.length, 1);
  assert.match(toasts[0], /make it shorter/);
});

test("D22: the dictation engine effect does not depend on t, toast or onToggle identity", () => {
  const match = hookSource.match(/audioManagerRef\.current\.cleanup\(\);\n\s*\}\n\s*\};\n\s*\}, \[([^\]]*)\]\);/);
  assert.ok(match, "engine effect found");
  const deps = match[1].split(",").map((dep) => dep.trim());
  assert.deepEqual(deps, ["performStartRecording", "performStopRecording"]);
});

test("D11: Escape cancels a live recording instead of hiding the overlay", () => {
  const app = fs.readFileSync(path.join(root, "src/App.jsx"), "utf8");
  const escape = app.slice(app.indexOf('if (e.key === "Escape")'), app.indexOf('document.addEventListener("keydown"'));
  assert.ok(escape.indexOf("cancelRecording()") !== -1);
  assert.ok(escape.indexOf("cancelRecording()") < escape.indexOf("handleClose()"));
  // ...and an explicit hide while recording waits for idle.
  assert.match(app, /if \(isRecording \|\| isProcessing\) \{\s*setHideWhenIdle\(true\);/);
});

test("D12: a toast alone no longer makes the whole overlay window capture clicks", () => {
  const app = fs.readFileSync(path.join(root, "src/App.jsx"), "utf8");
  assert.doesNotMatch(app, /isCommandMenuOpen \|\| toastCount > 0\) \{\s*setWindowInteractivity\(true\)/);
  assert.match(app, /closest\("\.toast-surface"\)/);
});
