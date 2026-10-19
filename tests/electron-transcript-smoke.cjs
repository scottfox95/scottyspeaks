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
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ss-transcript-ui-"));
app.setPath("userData", path.join(temp, "profile"));
const html = path.join(root, "src/.transcript-smoke.html"),
  entry = path.join(root, "src/.transcript-smoke.tsx");
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
  assert.equal(
    await js(
      `document.elementFromPoint(${point.x},${point.y})?.closest('button')?.textContent.trim()===${JSON.stringify(text)}`
    ),
    true,
    "Unobscured button: " + text
  );
  window.webContents.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount: 1 });
  window.webContents.sendInputEvent({ type: "mouseUp", ...point, button: "left", clickCount: 1 });
  await sleep(100);
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
      '<html><body><div id="root"></div><script type="module" src="/.transcript-smoke.tsx"></script></body></html>'
    );
    fs.writeFileSync(
      entry,
      `import React from 'react';import {createRoot} from 'react-dom/client';import {I18nextProvider} from 'react-i18next';import i18n from './i18n';import ControlPanel from './components/ControlPanel';import {ToastProvider} from './components/ui/Toast';import {SpeechProvider} from './hooks/useSpeech';import {SettingsProvider} from './hooks/useSettings';import './index.css';createRoot(document.getElementById('root')!).render(<I18nextProvider i18n={i18n}><ToastProvider><SettingsProvider><SpeechProvider><ControlPanel/></SpeechProvider></SettingsProvider></ToastProvider></I18nextProvider>);`
    );
    // Real ControlPanel, with inert host services. Meeting persistence and media IPC remain real.
    const defaults = {
      "db-get-usage-stats": {},
      "check-local-reasoning-available": { available: false },
      "sync-startup-preferences": {},
      "get-log-level": "error",
      "app-log": null,
      "db-set-dictionary": [],
      "db-get-transcriptions": [],
      "db-query-transcriptions": { items: [], hasMore: false, nextCursor: null },
      "db-get-dictionary-aliases": [],
      "db-get-dictionary": [],
      "get-update-status": { isDevelopment: true },
      "get-update-info": null,
      "get-app-version": "synthetic",
      "get-ui-language": "en",
      "get-dictation-key": "F8",
      "get-activation-mode": "tap",
      "speech:voices": [],
      "speech:status": {
        available: true,
        recording: false,
        speaking: false,
        starting: false,
        settings: { rate: 200 },
      },
    };
    for (const key of [
      "openai",
      "anthropic",
      "gemini",
      "groq",
      "mistral",
      "custom-transcription",
      "custom-reasoning",
    ])
      defaults[`get-${key}-key`] = "";
    for (const [channel, value] of Object.entries(defaults)) ipcMain.handle(channel, () => value);
    let spoken = "";
    ipcMain.handle("speech:speak", (_event, args) => {
      spoken = args.text;
      return {};
    });
    const { createServer } = await import("vite");
    server = await createServer({
      root: path.join(root, "src"),
      server: { host: "127.0.0.1", port: 5199, strictPort: true },
    });
    await server.listen();
    window = new BrowserWindow({
      ...require("../src/helpers/windowConfig").CONTROL_PANEL_CONFIG,
      width: 1180,
      height: 850,
      show: process.env.SS_TITLEBAR_PROBE === "1",
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
    const service = require("../src/helpers/meetingHandlers").registerMeetingHandlers({
      app,
      ipcMain,
      safeStorage,
      systemPreferences,
      audioEvidence: media,
      windowManager: { controlPanelWindow: window },
      dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
      shell: { showItemInFolder() {} },
      databaseManager: { getDictionary: () => [] },
    });
    const call = service.store.create();
    const dir = service.store.directory(call.id);
    fs.writeFileSync(path.join(dir, "synthetic.wav"), wave(20));
    const segments = Array.from({ length: 240 }, (_, i) => ({
      start: i / 20,
      end: (i + 1) / 20,
      speaker: i < 180 ? `part-0-0:${i % 2}` : `part-1-0:${i % 2}`,
      text: `Synthetic line ${i + 1}. We are reviewing the project schedule and agreeing on the next useful step. This is generated test content only.`,
    }));
    service.store.update(call.id, {
      title: "Synthetic long call",
      status: "ready",
      provider: "openrouter",
      audio: [{ file: "synthetic.wav", source: "audio", offset: 0 }],
      transcript: segments.map((s) => s.text).join("\n"),
      segments,
      speakers: { "part-0-0:0": "", "part-0-0:1": "", "part-1-0:0": "", "part-1-0:1": "" },
    });
    const destination = path.join(temp, "Project");
    fs.mkdirSync(destination);
    service.store.pinFolder(destination);
    const errors = [];
    window.webContents.on("console-message", (_event, level, message) => {
      if (level >= 3) {
        errors.push(message);
        console.error("Renderer:", message);
      }
    });
    await window.loadURL("http://127.0.0.1:5199/.transcript-smoke.html");
    const titlebar = await js(
      `(()=>{const h=document.querySelector('[data-window-titlebar]'),s=h.querySelector('aside'),b=h.querySelector('button');return {height:h.getBoundingClientRect().height,left:s.getBoundingClientRect().left,drag:getComputedStyle(h).getPropertyValue('-webkit-app-region'),buttonDrag:getComputedStyle(b).getPropertyValue('-webkit-app-region')}})()`
    );
    assert.ok(titlebar.height >= 40);
    assert.equal(titlebar.drag, process.platform === "darwin" ? "no-drag" : "drag");
    assert.equal(titlebar.buttonDrag, "no-drag");
    if (process.platform === "darwin") {
      assert.equal(require("../src/helpers/windowConfig").CONTROL_PANEL_CONFIG.frame, true);
      assert.equal(require("../src/helpers/windowConfig").CONTROL_PANEL_CONFIG.titleBarStyle, "default");
    }
    await click("Voice settings");
    await waitFor(
      () => js("!!document.querySelector('#speech-voice')"),
      "titlebar settings clickable"
    );
    await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await waitFor(() => js("!document.querySelector('[role=dialog]')"), "settings dismissed");
    await click("Call notes");
    await waitFor(() => js("!!document.querySelector('#meeting-title')"), "full shell call");
    await click("Transcript");
    await waitFor(
      () => js("document.querySelectorAll('[data-transcript-segment]').length===240"),
      "long transcript"
    );
    assert.equal(await js("document.body.innerText.includes('part-0-0:')"), false);
    assert.equal(
      await js("document.querySelectorAll('input[aria-label^=\"Name Speaker\"]').length"),
      4
    );
    const screenshots = [];
    for (const [width, height] of [
      [1180, 850],
      [900, 650],
      [760, 560],
    ]) {
      window.setSize(width, height);
      await waitFor(() => js(`Math.abs(innerWidth-${width})<=2`), "resize");
      for (const mode of ["read", "edit"]) {
        if (mode === "edit") {
          await click("Edit transcript");
          await waitFor(
            () => js("!!document.querySelector('textarea[aria-label=\"Transcript\"]')"),
            "edit mode rendered"
          );
        }
        for (const position of [0, 0.5, 1]) {
          await js(
            `(()=>{const e=document.querySelector('[data-call-content]');e.scrollTop=(e.scrollHeight-e.clientHeight)*${position};})()`
          );
          await sleep(60);
          const layout = await js(
            `(()=>{const e=document.querySelector('[data-call-content]'),f=document.querySelector('[data-call-footer]'),r=e.getBoundingClientRect(),fr=f.getBoundingClientRect(),b=[...f.querySelectorAll('button')].find(b=>b.textContent.trim()==='Save Markdown'),br=b.getBoundingClientRect();return {bounded:r.bottom<=fr.top+1,footerVisible:fr.top>=0&&fr.bottom<=innerHeight+1,hit:document.elementFromPoint(br.x+br.width/2,br.y+br.height/2)?.closest('button')===b,overflow:document.documentElement.scrollWidth>innerWidth,scroll:e.scrollHeight>e.clientHeight,folderWidth:document.querySelector('#meeting-destination').getBoundingClientRect().width,contentHeight:r.height};})()`
          );
          assert.equal(
            layout.bounded,
            true,
            JSON.stringify({ width, height, mode, position, layout })
          );
          assert.equal(
            layout.footerVisible,
            true,
            JSON.stringify({ width, height, mode, position, layout })
          );
          assert.ok(layout.folderWidth >= 160, JSON.stringify({ width, height, mode, layout }));
          assert.ok(layout.contentHeight > 80, JSON.stringify({ width, height, mode, layout }));
          assert.equal(layout.hit, true, JSON.stringify({ width, height, mode, position, layout }));
          assert.equal(
            layout.overflow,
            false,
            JSON.stringify({ width, height, mode, position, layout })
          );
          const file = path.join(temp, `long-${width}-${mode}-${position}.png`);
          fs.writeFileSync(file, (await window.webContents.capturePage()).toPNG());
          screenshots.push(file);
        }
        if (mode === "edit") {
          assert.equal(service.store.get(call.id).transcriptEdited, false);
          await click("Read transcript");
        }
      }
    }
    window.setSize(1180, 850);
    await sleep(80);
    await js("document.querySelector('[data-call-content]').scrollTop=0");
    await js("document.querySelector('[data-speaker-editor]').open=false");
    await click("Speaker 3");
    assert.equal(await js("document.activeElement.dataset.speakerId"), "part-1-0:0");
    assert.equal(await js("document.querySelector('[data-speaker-editor]').open"), true);
    await js("document.documentElement.classList.add('dark'); document.body.classList.add('dark')");
    await sleep(150);
    const speakerScreenshot = path.join(temp, "speaker-cards-dark.png");
    fs.writeFileSync(speakerScreenshot, (await window.webContents.capturePage()).toPNG());
    screenshots.push(speakerScreenshot);
    await js(
      "document.documentElement.classList.remove('dark'); document.body.classList.remove('dark')"
    );
    await type('input[aria-label="Name Speaker 1"]', "Alex");
    await waitFor(
      () => service.store.get(call.id).speakers["part-0-0:0"] === "Alex",
      "rename persisted"
    );
    assert.equal(
      await js(
        "[...document.querySelectorAll('[data-transcript-segment]')].filter(e=>e.querySelector('button[aria-label^=\"Name\"]').textContent==='Alex').length"
      ),
      90
    );
    assert.equal(
      await js(
        "[...document.querySelectorAll('[data-transcript-segment]')][180].querySelector('button[aria-label^=\"Name\"]').textContent"
      ),
      "Speaker 3"
    );
    await js("document.querySelector('audio').muted=true");
    await waitFor(
      () => js("document.querySelector('audio').readyState>=1"),
      "synthetic audio ready"
    );
    await click("Listen at 00:09");
    await waitFor(
      () => js("!document.querySelector('audio').paused"),
      "listen autoplays synthetic excerpt"
    );
    assert.ok(
      await js(
        "document.querySelector('audio').currentTime>=9 && document.querySelector('audio').currentTime<10"
      )
    );
    await js("document.querySelector('audio').pause()");
    await click("Read all: Transcript");
    assert.match(spoken, /Alex: Synthetic line 1/);
    assert.doesNotMatch(spoken, /part-0-0/);
    await click("Save Markdown");
    await waitFor(() => !!service.store.get(call.id).exportPath, "friendly export");
    assert.match(fs.readFileSync(service.store.get(call.id).exportPath, "utf8"), /Speaker 3/);
    await window.reload();
    await click("Call notes");
    await waitFor(() => js("!!document.querySelector('#meeting-title')"), "reload call");
    await click("Transcript");
    await waitFor(
      () => js("document.querySelector('input[aria-label=\"Name Speaker 1\"]')?.value==='Alex'"),
      "renamed voice after restart"
    );
    await click("Edit transcript");
    const prose = "My corrected prose. Speaker part-0-0:0 is literal here.\n\nKeep every word.";
    await type('textarea[aria-label="Transcript"]', prose);
    await waitFor(() => service.store.get(call.id).transcript === prose, "edited prose saved");
    await click("Read transcript");
    await click("Read all: Transcript");
    assert.equal(spoken, prose);
    await click("Save Markdown");
    await waitFor(
      () => fs.readFileSync(service.store.get(call.id).exportPath, "utf8").includes(prose),
      "edited export"
    );
    await window.reload();
    await click("Call notes");
    await waitFor(() => js("!!document.querySelector('#meeting-title')"), "reload edited call");
    await click("Transcript");
    await waitFor(
      () => js(`document.body.innerText.includes(${JSON.stringify(prose)})`),
      "edited prose preserved after restart"
    );
    assert.equal(errors.length, 0, errors.join("\n"));
    if (process.env.SS_TITLEBAR_PROBE === "1") {
      window.setSize(1000, 700);
      window.setPosition(100, 100);
      window.show();
      const probe = path.join(root, ".superpowers/titlebar-0.3.3/drag-probe.json");
      const record = () => fs.writeFileSync(probe, JSON.stringify(window.getBounds()));
      window.on("move", record);
      record();
      const pollBounds = setInterval(record, 200);
      console.log("TITLEBAR_DRAG_PROBE_READY");
      await new Promise((resolve) => {
        const timer = setInterval(() => {
          if (fs.existsSync(path.join(root, ".superpowers/titlebar-0.3.3/finish-probe"))) {
            clearInterval(timer);
            clearTimeout(deadline);
            resolve();
          }
        }, 200);
        const deadline = setTimeout(() => {
          clearInterval(timer);
          resolve();
        }, 120000);
      });
    }

    console.log(
      JSON.stringify(
        {
          success: true,
          temp,
          screenshots,
          checks: [
            "actual ControlPanel shell",
            "240 multipart segments",
            "three sizes/read and edit/top-middle-end/footer hit tests",
            "friendly speaker labels and distinct chunk identities",
            "name persistence and all matching occurrences",
            "synthetic muted listen autoplay",
            "read-aloud/export labels",
            "edited prose preserved through reload and export",
          ],
          errors,
        },
        null,
        2
      )
    );
  } catch (error) {
    console.error(error);
    if (window && !window.isDestroyed()) {
      console.error(await js("document.body.innerText"));
      fs.writeFileSync(
        path.join(temp, "failure.png"),
        (await window.webContents.capturePage()).toPNG()
      );
    }
    process.exitCode = 1;
  } finally {
    if (window && !window.isDestroyed()) window.destroy();
    if (server) await server.close();
    for (const file of [html, entry]) if (fs.existsSync(file)) fs.unlinkSync(file);
    app.exit(process.exitCode || 0);
  }
});
