// Isolated synthetic renderer + real preload/IPC; fake speech process means no speaker output.
const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("fs"),
  path = require("path"),
  os = require("os"),
  assert = require("assert/strict"),
  { EventEmitter } = require("events"),
  { PassThrough } = require("stream");
const root = path.resolve(__dirname, ".."),
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "ss2-speech-ui-"));
app.setPath("userData", path.join(temp, "profile"));
const html = path.join(root, "src/.speech-smoke.html"),
  entry = path.join(root, "src/.speech-smoke.tsx");
let server, window, overlay, speech;
const text = [],
  sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const js = (code) => window.webContents.executeJavaScript(code, true);
async function wait(check, label) {
  for (let i = 0; i < 120; i++) {
    if (await check()) return;
    await sleep(50);
  }
  throw Error("Timeout " + label);
}
async function click(label) {
  await wait(
    () =>
      js(
        `Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()===${JSON.stringify(label)}&&!b.disabled)`
      ),
    label
  );
  const p = await js(
    `(()=>{const b=Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(label)}&&!b.disabled);const r=b.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`
  );
  window.webContents.sendInputEvent({ type: "mouseDown", ...p, button: "left", clickCount: 1 });
  window.webContents.sendInputEvent({ type: "mouseUp", ...p, button: "left", clickCount: 1 });
}
app.whenReady().then(async () => {
  try {
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    fs.writeFileSync(
      html,
      '<html><body><div id="root"></div><script type="module" src="/.speech-smoke.tsx"></script></body></html>'
    );
    fs.writeFileSync(
      entry,
      `import React from 'react';import {createRoot} from 'react-dom/client';import {I18nextProvider} from 'react-i18next';import i18n from './i18n';import {SpeechProvider} from './hooks/useSpeech';import {SpeechControls} from './components/speech/SpeechControls';import {ReadAloud} from './components/speech/ReadAloud';import './index.css';const compact=location.search.includes('compact');createRoot(document.getElementById('root')!).render(<I18nextProvider i18n={i18n}><SpeechProvider>{compact?<SpeechControls compact/>:<><SpeechControls/><section data-speech-source><textarea aria-label="Synthetic notes" defaultValue="Synthetic notes for local reading."/><ReadAloud text="Synthetic notes for local reading." label="Notes"/><audio controls muted loop/></section></>}</SpeechProvider></I18nextProvider>);`
    );
    const { createServer } = await import("vite");
    server = await createServer({
      root: path.join(root, "src"),
      server: { host: "127.0.0.1", port: 5201, strictPort: true },
    });
    await server.listen();
    const prefs = {
      preload: path.join(root, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    };
    window = new BrowserWindow({ width: 1000, height: 750, show: false, webPreferences: prefs });
    overlay = new BrowserWindow({
      width: 96,
      height: 96,
      show: false,
      frame: false,
      webPreferences: prefs,
    });
    const { createLocalSpeech, registerSpeechHandlers } = require("../src/helpers/speechHandlers");
    speech = createLocalSpeech(app);
    speech.platform = "darwin";
    speech.spawn = (_command, args) => {
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {
        queueMicrotask(() => child.emit("close", 0));
        return true;
      };
      if (args.includes("?"))
        queueMicrotask(() => {
          child.stdout.write("Samantha en_US # Synthetic voice\n");
          child.emit("close", 0);
        });
      else {
        let content = "";
        child.stdin.on("data", (chunk) => (content += chunk));
        child.stdin.on("finish", () => text.push(content.trim()));
      }
      return child;
    };
    registerSpeechHandlers({
      app,
      ipcMain,
      windowManager: { mainWindow: overlay, controlPanelWindow: window },
      manager: speech,
    });
    await window.loadURL("http://127.0.0.1:5201/.speech-smoke.html");
    await overlay.loadURL("http://127.0.0.1:5201/.speech-smoke.html?compact");
    await wait(() => js(`document.body.textContent.includes('Local read-aloud ready')`), "ready");
    await js(
      `(()=>{const el=document.querySelector('textarea');el.focus();el.setSelectionRange(0,9)})()`
    );
    await click("Read selection");
    await wait(() => text.length === 1, "selected speech");
    assert.equal(text[0], "Synthetic");
    assert.equal(overlay.isVisible(), true);
    assert.equal(overlay.isFocused(), false);
    await wait(
      () =>
        overlay.webContents.executeJavaScript(
          `!!document.querySelector('button[aria-label="Stop reading"]')`
        ),
      "compact Stop"
    );
    const bounds = await overlay.webContents.executeJavaScript(
      `(()=>{const r=document.querySelector('button').getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom}})()`
    );
    assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.right <= 96 && bounds.bottom <= 96);
    await click("Stop reading");
    await wait(() => !speech.status().speaking, "stopped");
    await click("Voice settings");
    await wait(
      () => js(`!!document.querySelector('#speech-voice option[value="Samantha"]')`),
      "voices"
    );
    await js(
      `(()=>{const e=document.querySelector('#speech-voice');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,'Samantha');e.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('input[type=checkbox]').click()})()`
    );
    await wait(
      () => speech.config.agentEnabled && speech.config.voice === "Samantha",
      "persisted settings"
    );
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(temp, "profile/local-speech.json"), "utf8"))
        .agentEnabled,
      true
    );
    await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    await wait(() => js(`!document.querySelector('[role=dialog]')`), "close settings");
    await click("Read all: Notes");
    await wait(() => text.length === 2, "whole field");
    assert.equal(text[1], "Synthetic notes for local reading.");
    const wav = Buffer.alloc(44 + 16000 * 2);
    wav.write("RIFF");
    wav.writeUInt32LE(wav.length - 8, 4);
    wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(16000, 24);
    wav.writeUInt32LE(32000, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write("data", 36);
    wav.writeUInt32LE(wav.length - 44, 40);
    await js(
      `(()=>{const a=document.querySelector('audio');a.src='data:audio/wav;base64,${wav.toString("base64")}';a.volume=0;return a.play()})()`
    );
    await wait(() => js(`!document.querySelector('audio').paused`), "silent playback");
    const token = await js(`window.electronAPI.speech.beginRecording('notes')`);
    assert.equal(speech.status().speaking, false);
    await wait(() => js(`document.querySelector('audio').paused`), "global audio pause");
    assert.equal(
      await js(
        `Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Read selection').disabled`
      ),
      true
    );
    await js(`document.querySelector('audio').play().catch(()=>{})`);
    await wait(() => js(`document.querySelector('audio').paused`), "future replay blocked");
    await assert.rejects(
      speech.speak({ owner: "agent:synthetic", source: "agent", text: "Synthetic progress" }),
      /recording/
    );
    await js(`window.electronAPI.speech.endRecording(${JSON.stringify(token)})`);
    await speech.speak({ owner: "agent:synthetic", source: "agent", text: "Synthetic progress" });
    await wait(
      () => js(`document.body.textContent.includes('Agent update speaking')`),
      "agent update visible"
    );
    await click("Stop reading");
    assert.equal(await js("document.documentElement.scrollWidth>innerWidth"), false);
    const screenshot = path.join(temp, "speech-controls.png");
    fs.writeFileSync(screenshot, (await window.webContents.capturePage()).toPNG());
    console.log(
      JSON.stringify({
        success: true,
        checks: [
          "real renderer/preload/IPC",
          "selected and whole field text",
          "installed voice selection and persisted opt-in",
          "global visible Stop without focus activation",
          "96px compact Stop bounds",
          "recording stops speech and current/future replay",
          "visible agent source",
          "no overflow",
        ],
        screenshot,
      })
    );
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    await speech?.close();
    window?.destroy();
    overlay?.destroy();
    await Promise.race([server?.close(), sleep(3000)]);
    for (const file of [html, entry])
      try {
        fs.unlinkSync(file);
      } catch {}
    // All resources are explicitly closed above. Electron’s Cocoa exit route
    // can stall on this host after an inactive overlay was shown.
    process.reallyExit(process.exitCode || 0);
  }
});
