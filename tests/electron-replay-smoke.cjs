// Run with Electron. Real renderer, preload, IPC, draft store and filesystem;
// only native dialogs and inference are replaced with synthetic fixtures.
const {
  app,
  BrowserWindow,
  ipcMain,
  safeStorage,
  systemPreferences,
  protocol,
} = require("electron");
const fs = require("fs");
const path = require("path");
const os = require("os");
const assert = require("assert/strict");
const root = path.resolve(__dirname, "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ss-replay-ui-"));
app.setPath("userData", path.join(temp, "profile"));
const html = path.join(root, "src/.replay-smoke.html"),
  entry = path.join(root, "src/.replay-smoke.tsx");
let server, window;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, label) {
  for (let n = 0; n < 160; n++) {
    if (await check()) return;
    await sleep(50);
  }
  throw Error("Timed out: " + label);
}
async function js(code) {
  try {
    return await window.webContents.executeJavaScript(code, true);
  } catch (error) {
    console.error("UI evaluation failed:", code);
    throw error;
  }
}
async function click(text) {
  await waitFor(
    () =>
      js(
        `Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()===${JSON.stringify(text)}&&!b.disabled)`
      ),
    "enabled button " + text
  );
  const point = await js(
    `(()=>{const b=Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(text)}&&!b.disabled);b.scrollIntoView({block:'nearest'});const r=b.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`
  );
  window.webContents.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount: 1 });
  window.webContents.sendInputEvent({ type: "mouseUp", ...point, button: "left", clickCount: 1 });
}
async function type(selector, value) {
  await js(
    `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing input');const proto=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`
  );
}
protocol.registerSchemesAsPrivileged([
  {
    scheme: "ss2-audio",
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);
function wave(seconds = 5) {
  const samples = 16000 * seconds,
    out = Buffer.alloc(44 + samples * 2);
  out.write("RIFF");
  out.writeUInt32LE(out.length - 8, 4);
  out.write("WAVEfmt ", 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(16000, 24);
  out.writeUInt32LE(32000, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36);
  out.writeUInt32LE(samples * 2, 40);
  for (let n = 0; n < samples; n++)
    out.writeInt16LE(Math.round(1200 * Math.sin((n * 2 * Math.PI * 440) / 16000)), 44 + n * 2);
  return out;
}
app.whenReady().then(async () => {
  try {
    fs.writeFileSync(
      html,
      '<html><body><div id="root"></div><script type="module" src="/.replay-smoke.tsx"></script></body></html>'
    );
    fs.writeFileSync(
      entry,
      `import React from 'react';import {createRoot} from 'react-dom/client';import {I18nextProvider} from 'react-i18next';import i18n from './i18n';import CaptureReplay from './components/captures/CaptureReplay';import MeetingsView from './components/meetings/MeetingsView';import './index.css';const replay=location.hash!=='#calls';createRoot(document.getElementById('root')!).render(<I18nextProvider i18n={i18n}>{replay?<CaptureReplay/>:<MeetingsView/>}</I18nextProvider>);`
    );
    const { createServer } = await import("vite");
    server = await createServer({
      root: path.join(root, "src"),
      server: { host: "127.0.0.1", port: 5198, strictPort: true },
    });
    await server.listen();
    window = new BrowserWindow({
      width: 1180,
      height: 900,
      show: false,
      webPreferences: {
        preload: path.join(root, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    window.webContents.setAudioMuted(true);
    const { AudioEvidence } = require("../src/helpers/audioEvidence");
    const media = new AudioEvidence();
    protocol.handle("ss2-audio", (request) => media.handle(request));
    const managers = {
      whisperManager: {
        transcribeLocalWhisper: async () => ({
          success: true,
          text: "Retry words from synthetic model.",
        }),
      },
      parakeetManager: {
        transcribeLocalParakeet: async () => ({ success: true, text: "Parakeet retry." }),
      },
    };
    const windowManager = { controlPanelWindow: window };
    const captures = require("../src/helpers/captureHandlers").registerCaptureHandlers({
      app,
      ipcMain,
      windowManager,
      audioEvidence: media,
      ...managers,
    });
    const cap = captures.store.create({
      audio: wave(),
      mimeType: "audio/wav",
      durationSeconds: 5,
      settings: { provider: "whisper", model: "tiny", language: "en", cleanup: { exact: true } },
    });
    captures.store.complete(cap.id, {
      rawText: "raw synthetic words",
      finalText: "Original delivered words.",
      historyId: 7,
    });
    const expired = captures.store.create({
      audio: wave(1),
      mimeType: "audio/wav",
      durationSeconds: 1,
      settings: { provider: "whisper", model: "tiny" },
    });
    captures.store.complete(expired.id, {
      rawText: "Expired recording text",
      finalText: "Expired recording text",
    });
    captures.store.persist({
      ...captures.store.get(expired.id),
      createdAt: new Date(Date.now() - 8 * 86400000).toISOString(),
    });
    ipcMain.handle("list-whisper-models", () => ({
      success: true,
      models: [
        { model: "tiny", downloaded: true },
        { model: "large", downloaded: false },
      ],
    }));
    ipcMain.handle("list-parakeet-models", () => ({ success: true, models: [] }));
    ipcMain.handle("write-clipboard", () => ({ success: true }));
    const calls = require("../src/helpers/meetingHandlers").registerMeetingHandlers({
      app,
      ipcMain,
      windowManager,
      audioEvidence: media,
      safeStorage,
      systemPreferences,
      ...managers,
      dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
      shell: { showItemInFolder() {} },
      databaseManager: { getDictionary: () => [] },
    });
    const call = calls.store.create();
    const dir = calls.store.directory(call.id);
    fs.mkdirSync(path.join(dir, "take-one"));
    fs.mkdirSync(path.join(dir, "take-two"));
    fs.writeFileSync(path.join(dir, "take-two/system.wav"), wave(1));
    fs.writeFileSync(path.join(dir, "take-one/microphone.wav"), wave());
    fs.writeFileSync(path.join(dir, "take-one/system.wav"), wave());
    calls.store.update(call.id, {
      title: "Synthetic call playback",
      status: "ready",
      provider: "local",
      audio: [
        { file: "take-one/microphone.wav", source: "microphone", offset: 2 },
        { file: "take-one/system.wav", source: "system", offset: 2 },
        { file: "take-two/system.wav", source: "system", offset: 8 },
      ],
      transcript: "Timed synthetic words",
      segments: [
        { start: 3, end: 4, text: "Timed synthetic words", speaker: "microphone" },
        { start: 8.3, end: 9, text: "Second take words", speaker: "system" },
      ],
      speakers: { microphone: "Scott" },
    });
    const textOnly = calls.store.create();
    calls.store.update(textOnly.id, {
      title: "Text only example",
      status: "ready",
      provider: "import",
      transcript: "Imported text without audio",
    });
    await window.loadURL("http://127.0.0.1:5198/.replay-smoke.html");
    await click("Replay & repair");
    await waitFor(
      () =>
        js(`!!document.querySelector('audio') && document.querySelector('audio').readyState>=1`),
      "dictation audio metadata"
    );
    assert.equal(
      await js(
        `document.body.textContent.includes('raw synthetic words') && document.body.textContent.includes('Original delivered words.')`
      ),
      true
    );
    assert.equal(
      await js(
        `Array.from(document.querySelectorAll('option')).some(o=>o.value==='whisper:large')`
      ),
      false
    );
    await js(`(()=>{const a=document.querySelector('audio');a.currentTime=2;return a.play()})()`);
    await waitFor(
      () =>
        js(
          `document.querySelector('audio').currentTime>=2 && !document.querySelector('audio').paused`
        ),
      "real dictation playback and seek"
    );
    await js(`document.querySelector('audio').pause()`);
    await click("Create preview");
    await waitFor(
      () => js(`document.body.textContent.includes('Retry words from synthetic model.')`),
      "retry preview"
    );
    assert.equal(captures.store.get(cap.id).finalText, "Original delivered words.");
    await click("Keep this retry");
    await waitFor(
      () => captures.store.get(cap.id).acceptedText === "Retry words from synthetic model.",
      "accepted separate retry"
    );
    await type("textarea", "Corrected synthetic words.");
    await js(`document.querySelector('input[type="checkbox"]').click()`);
    await click("Save correction example");
    await waitFor(
      () => captures.store.get(cap.id).fixtureIds?.length === 1,
      "saved correction fixture"
    );
    assert.equal(captures.store.get(cap.id).rawText, "raw synthetic words");
    await js(
      `(()=>{const e=document.querySelector('select[aria-label="Recording"]');e.value=${JSON.stringify(expired.id)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`
    );
    await waitFor(
      () =>
        js(
          `document.body.textContent.includes('This audio has expired')&&!document.querySelector('audio')`
        ),
      "expired audio state"
    );
    await js(
      `(()=>{const e=document.querySelector('select[aria-label="Recording"]');e.value=${JSON.stringify(cap.id)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`
    );
    await waitFor(() => js(`!!document.querySelector('audio')`), "restore original capture");

    await js(
      `(()=>{const e=document.querySelector('select[aria-label="Keep dictation audio"]');e.value='0';e.dispatchEvent(new Event('change',{bubbles:true}));})()`
    );
    await waitFor(
      () =>
        js(
          `document.body.textContent.includes('Audio retention was turned off')&&!document.querySelector('audio')`
        ),
      "retention off removes player"
    );
    assert.equal(captures.store.get(cap.id).audioAvailable, false);
    // Permanent examples remain user-removable after original retention expires.
    await js(`document.querySelector('details summary').click()`);
    await waitFor(
      () => js(`document.body.textContent.includes('Delete example')`),
      "example management"
    );
    await click("Delete example");
    await waitFor(() => captures.store.listFixtures().length === 0, "example audio deletion");
    await click("Delete saved recording");
    await waitFor(
      () => captures.store.list().every((item) => item.id !== cap.id),
      "explicit capture deletion"
    );
    const screenshot = path.join(temp, "replay.png");
    fs.writeFileSync(screenshot, (await window.webContents.capturePage()).toPNG());
    await window.loadURL("http://127.0.0.1:5198/.replay-smoke.html?view=calls#calls");
    await waitFor(
      () => js(`document.body.textContent.includes('Synthetic call playback')`),
      "call list"
    );
    await js(
      `Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('Synthetic call playback')).click()`
    );
    await click("Transcript");
    await waitFor(
      () => js(`!!document.querySelector('audio')&&document.querySelector('audio').readyState>=1`),
      "call audio metadata"
    );
    await js(`document.querySelector('button[aria-label="Play from 00:03"]').click()`);
    await waitFor(
      () =>
        js(
          `!!document.querySelector('audio')&&document.querySelector('audio').currentTime>=3&&!document.querySelector('audio').paused`
        ),
      "timestamp starts real call playback"
    );
    await js(`document.querySelector('audio').pause()`);
    const oldUrl = await js(`document.querySelector('audio').src`);
    await js(
      `(()=>{const e=document.querySelector('select[aria-label="Listen to"]');e.value='system';e.dispatchEvent(new Event('change',{bubbles:true}));})()`
    );
    await waitFor(
      () =>
        js(
          `!!document.querySelector('audio')&&document.querySelector('audio').src!==${JSON.stringify(oldUrl)}&&document.querySelector('audio').readyState>=1`
        ),
      "system source switched"
    );
    assert.ok(await js(`document.querySelector('audio').duration>=9`));
    await js(`document.querySelector('button[aria-label="Play from 00:03"]').click()`);
    await waitFor(
      () =>
        js(
          `document.querySelector('select[aria-label="Listen to"]').value==='microphone' && !!document.querySelector('audio') && document.querySelector('audio').currentTime>=3 && !document.querySelector('audio').paused`
        ),
      "timestamp restores microphone source"
    );
    await js(`document.querySelector('audio').pause()`);

    await js(`document.querySelector('button[aria-label="Play from 00:08"]').click()`);
    await waitFor(
      () =>
        js(
          `!!document.querySelector('audio')&&document.querySelector('audio').currentTime>=8.3&&!document.querySelector('audio').paused`
        ),
      "second recording take timestamp"
    );
    await js(`document.querySelector('audio').pause()`);
    fs.writeFileSync(
      path.join(temp, "call-playback.png"),
      (await window.webContents.capturePage()).toPNG()
    );
    await js(
      `Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('Text only example')).click()`
    );
    await click("Transcript");
    await waitFor(
      () =>
        js(
          `document.body.textContent.includes('This is a text-only transcript')&&!document.querySelector('audio')`
        ),
      "text-only import"
    );
    console.log(
      JSON.stringify({
        success: true,
        checks: [
          "real dictation playback/seek",
          "installed model choices",
          "retry preview/accept",
          "correction example",
          "retention off/expired and explicit capture/example deletion",
          "call timestamp playback",
          "source selection and multiple take timestamps",
          "text-only import",
        ],
        screenshots: [screenshot, path.join(temp, "call-playback.png")],
      })
    );
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    if (window && !window.isDestroyed()) window.destroy();
    if (server) await server.close();
    for (const file of [html, entry]) if (fs.existsSync(file)) fs.unlinkSync(file);
    app.exit(process.exitCode || 0);
  }
});
