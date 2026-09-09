// Run with Electron. Real renderer, preload, IPC, draft store and filesystem;
// only native dialogs and inference are replaced with synthetic fixtures.
const { app, BrowserWindow, ipcMain, safeStorage, systemPreferences } = require("electron");
const fs = require("fs");
const path = require("path");
const os = require("os");
const assert = require("assert/strict");
const root = path.resolve(__dirname, "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ss-meeting-ui-"));
app.setPath("userData", path.join(temp, "profile"));
const html = path.join(root, "src/.meeting-smoke.html"),
  entry = path.join(root, "src/.meeting-smoke.tsx");
let server, window;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function wav(seconds = 1) {
  const samples = seconds * 16000;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write("RIFF");
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16000, 24);
  buffer.writeUInt32LE(32000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++)
    buffer.writeInt16LE(
      Math.round(Math.sin((index * 2 * Math.PI * 440) / 16000) * 6000),
      44 + index * 2
    );
  return buffer;
}
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
}
async function type(selector, value) {
  await js(
    `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing input');const proto=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`
  );
}
app.whenReady().then(async () => {
  try {
    fs.writeFileSync(
      html,
      '<html><body><div id="root"></div><script type="module" src="/.meeting-smoke.tsx"></script></body></html>'
    );
    fs.writeFileSync(
      entry,
      `import React from 'react';import {createRoot} from 'react-dom/client';import {I18nextProvider} from 'react-i18next';import i18n from './i18n';import MeetingsView from './components/meetings/MeetingsView';import './index.css';createRoot(document.getElementById('root')!).render(<I18nextProvider i18n={i18n}><div style={{height:'100vh'}}><MeetingsView/></div></I18nextProvider>);`
    );
    const { createServer } = await import("vite");
    server = await createServer({
      root: path.join(root, "src"),
      server: { host: "127.0.0.1", port: 5197, strictPort: true },
    });
    await server.listen();
    window = new BrowserWindow({
      width: 1180,
      height: 850,
      show: process.env.SS_SHOW_TEST === "1",
      webPreferences: {
        preload: path.join(root, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    const fixture = path.join(temp, "synthetic.vtt");
    fs.writeFileSync(
      fixture,
      "WEBVTT\n\n00:00:01.200 --> 00:00:03.000\n<v Morgan>We should review on Friday.</v>\n\n00:00:04.000 --> 00:00:06.000\nScott: I will prepare the draft."
    );
    const destination = path.join(temp, "Project");
    fs.mkdirSync(destination);
    const { registerMeetingHandlers } = require("../src/helpers/meetingHandlers");
    const { AudioEvidence } = require("../src/helpers/audioEvidence");
    let cancelFolder = true;
    let folderDialogParent = null;
    const exportedAudio = path.join(temp, "shared-call-audio.mp3");
    let localTranscriptions = 0;
    const service = registerMeetingHandlers({
      app,
      ipcMain,
      safeStorage,
      systemPreferences,
      dialog: {
        showOpenDialog: async (parentOrOptions, options = parentOrOptions) => {
          const isFolder = options.properties.includes("openDirectory");
          if (isFolder) folderDialogParent = parentOrOptions;
          return {
            canceled: isFolder && cancelFolder,
            filePaths: [isFolder ? destination : fixture],
          };
        },
        showSaveDialog: async () => ({ canceled: false, filePath: exportedAudio }),
      },
      shell: { showItemInFolder() {} },
      databaseManager: { getDictionary: () => [] },
      windowManager: { controlPanelWindow: window },
      whisperManager: {
        transcribeLocalWhisper: async () => ({
          success: true,
          text: `Synthetic retry ${++localTranscriptions}`,
        }),
      },
      parakeetManager: {
        transcribeLocalParakeet: async () => ({
          success: true,
          text: `Synthetic retry ${++localTranscriptions}`,
        }),
      },
      audioEvidence: new AudioEvidence(),
    });
    const agents = require("../src/helpers/callAgentHandlers").registerCallAgentHandlers({
      app,
      ipcMain,
      windowManager: { controlPanelWindow: window },
      meetingStore: service.store,
      bridgeFactory: () => ({
        discoveryPath: path.join(temp, "endpoint.json"),
        start: async () => {},
        close: async () => {},
        status: () => ({ ready: false, lastConnectedAt: null }),
      }),
    });
    const runtimeErrors = [];
    window.webContents.on("console-message", (_event, level, message) => {
      if (level >= 3) {
        runtimeErrors.push(message);
        console.error("Renderer:", message);
      }
    });
    await window.loadURL("http://127.0.0.1:5197/.meeting-smoke.html");
    await waitFor(
      () => js(`document.body.textContent.includes('A notebook for your conversations')`),
      "empty view"
    );
    window.setSize(760, 560);
    await waitFor(() => js("innerWidth < 800"), "small window");
    assert.equal(
      await js(
        `(()=>{const b=[...document.querySelectorAll('header button')].find(b=>b.textContent.trim()==='Add folder…');const r=b.getBoundingClientRect();return r.x>=0&&r.right<=innerWidth&&r.y>=0&&r.bottom<=innerHeight;})()`
      ),
      true
    );
    await click("Add folder…");
    await sleep(100);
    assert.equal(service.store.folders().length, 0);
    cancelFolder = false;
    await click("Add folder…");
    await waitFor(() => service.store.folders().length === 1, "pin from empty view");
    assert.equal(folderDialogParent, window);
    await waitFor(
      () => js("document.body.textContent.includes('Pinned folders: Project')"),
      "empty view pin summary"
    );
    await click("New call");
    await waitFor(() => js(`!!document.querySelector('#meeting-title')`), "new editor");
    await type("#meeting-title", "Synthetic planning call");
    await type("textarea", "## My notes\n\n- Verify the release.");
    await waitFor(
      () =>
        service.store.list().length === 1 &&
        service.store.get(service.store.list()[0].id).notes.includes("Verify the release"),
      "autosave"
    );
    await waitFor(
      () => js(`document.querySelector('#meeting-destination').value!==''`),
      "folder pin"
    );
    await click("Save Markdown");
    await waitFor(() => !!service.store.list()[0].exportPath, "file note");
    const filed = service.store.list()[0];
    assert.match(fs.readFileSync(filed.exportPath, "utf8"), /Verify the release/);
    fs.writeFileSync(filed.exportPath, "External edit survives");
    await click("Save Markdown");
    await waitFor(
      () => js(`document.body.textContent.includes('changed outside')`),
      "external conflict"
    );
    assert.equal(fs.readFileSync(filed.exportPath, "utf8"), "External edit survives");
    await click("Import transcript");
    await waitFor(() => service.store.list().length === 2, "import");
    await click("Transcript");
    await waitFor(
      () => js(`document.body.textContent.includes('We should review on Friday.')`),
      "speaker transcript"
    );
    const imported = service.store.list()[0];
    assert.equal(service.store.get(imported.id).segments[0].start, 1.2);
    fs.writeFileSync(path.join(service.store.directory(imported.id), "call.wav"), wav());
    service.store.update(imported.id, {
      audio: [{ file: "call.wav", source: "system", offset: 0 }],
      status: "ready",
    });
    await waitFor(
      () => js(`document.body.textContent.includes('Transcribe again')`),
      "retranscribe control"
    );
    await waitFor(
      () =>
        js(
          `[...document.querySelectorAll('button')].some(button=>button.textContent.trim()==='Export audio…'&&!button.disabled)`
        ),
      "prepared retained audio"
    );
    await click("Export audio…");
    await waitFor(() => fs.existsSync(exportedAudio), "audio export");
    assert.ok(fs.statSync(exportedAudio).size > 100);
    await click("Transcribe again");
    await waitFor(() => js("!!document.querySelector('[role=dialog]')"), "retry confirmation");
    assert.equal(
      await js(
        "document.querySelector('[role=dialog]').textContent.includes('kept unless the new transcription succeeds')"
      ),
      true
    );
    await click("Cancel");
    assert.equal(localTranscriptions, 0);
    await click("Transcribe again");
    await click("Replace transcript");
    await waitFor(
      () => service.store.get(imported.id).transcript === "Synthetic retry 1",
      "forced retranscription"
    );
    service.store.update(imported.id, {
      lastError: "internal provider error",
      lastErrorCode: "openrouterAuth",
      lastErrorStatus: 401,
    });
    await waitFor(
      () => js(`document.body.textContent.includes('OpenRouter rejected the API key')`),
      "localized provider error"
    );
    assert.equal(await js(`document.body.textContent.includes('internal provider error')`), false);
    service.store.update(imported.id, {
      lastError: null,
      lastErrorCode: null,
      lastErrorStatus: null,
    });
    const rejected = await new Promise((resolve) => {
      const outsider = new BrowserWindow({
        show: false,
        webPreferences: { preload: path.join(root, "preload.js"), contextIsolation: true },
      });
      outsider.loadURL("about:blank").then(async () => {
        resolve(await outsider.webContents.executeJavaScript("window.electronAPI.meetings.list()"));
        outsider.destroy();
      });
    });
    assert.equal(rejected.success, false);
    // Use a fake key in the isolated profile; exercise real save and reload.
    await js("window.electronAPI.meetings.setConfig({provider:'openrouter'})");
    await window.reload();
    await waitFor(
      () => js(`!!document.querySelector('button[aria-label="Call note settings"]')`),
      "settings button"
    );
    await js(`document.querySelector('button[aria-label="Call note settings"]').click()`);
    await waitFor(() => js(`!!document.querySelector('input[type="password"]')`), "key input");
    await type('input[type="password"]', "synthetic-test-key-not-a-real-credential");
    await click("Save key");
    await waitFor(
      () => js(`document.body.textContent.includes('API key saved on this Mac')`),
      "saved key confirmation"
    );
    assert.equal(await js(`!!document.querySelector('input[type="password"]')`), false);
    assert.equal(
      await js(`document.body.textContent.includes('synthetic-test-key-not-a-real-credential')`),
      false
    );
    await window.reload();
    await waitFor(
      () => js(`!!document.querySelector('button[aria-label="Call note settings"]')`),
      "reloaded settings"
    );
    await js(`document.querySelector('button[aria-label="Call note settings"]').click()`);
    await waitFor(
      () => js(`document.body.textContent.includes('API key saved on this Mac')`),
      "key persists after reload"
    );
    await click("Replace key");
    await waitFor(
      () => js(`!!document.querySelector('input[type="password"]')`),
      "replacement input"
    );
    await type('input[type="password"]', "discard-this-replacement");
    await click("Cancel");
    await waitFor(
      () => js(`!document.querySelector('input[type="password"]')`),
      "cancelled replacement"
    );
    assert.equal(await js(`!!document.querySelector('input[type="password"]')`), false);
    assert.equal(
      safeStorage.decryptString(
        fs.readFileSync(path.join(temp, "profile/call-notes/openrouter-key.enc"))
      ),
      "synthetic-test-key-not-a-real-credential"
    );
    // Delete only synthetic fixtures, preserving the original imported file,
    // filed Markdown, key, pin and the other call. Cancel must not mutate either call.
    await js(`document.querySelector('button[aria-label="Call note settings"]').click()`);
    const selectedId = service.store.list()[0].id;
    service.store.update(selectedId, { status: "recording" });
    await waitFor(
      () =>
        js(
          `[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Delete call'&&b.disabled)`
        ),
      "recording deletion disabled"
    );
    service.store.update(selectedId, { status: "ready" });
    await waitFor(
      () =>
        js(
          `[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Delete call'&&!b.disabled)`
        ),
      "idle deletion enabled"
    );
    agents.store.grant(selectedId);
    const evidence = agents.store.read(selectedId);
    const agentDraft = agents.store.submitDraft({
      callId: selectedId,
      grantId: evidence.grantId,
      sourceVersion: evidence.sourceVersion,
      title: "Synthetic agent draft",
      body: "Follow up",
      citations: [evidence.evidence[0].id],
    });
    const selectedScreenshot = path.join(temp, "call-selected-small.png");
    fs.writeFileSync(selectedScreenshot, (await window.webContents.capturePage()).toPNG());
    const originalImported = fs.readFileSync(fixture, "utf8");
    const encryptedKey = fs.readFileSync(path.join(temp, "profile/call-notes/openrouter-key.enc"));
    await click("Delete call");
    await waitFor(() => js("!!document.querySelector('[role=dialog]')"), "delete confirmation");
    assert.equal(await js("document.activeElement.id"), "cancel-call-deletion");
    const confirmationScreenshot = path.join(temp, "call-delete-confirmation.png");
    fs.writeFileSync(confirmationScreenshot, (await window.webContents.capturePage()).toPNG());
    await click("Cancel");
    assert.equal(service.store.list().length, 2);
    assert.ok(service.store.get(selectedId));
    await type("textarea", "Pending unsaved synthetic edit");
    await click("Delete call");
    await click("Delete permanently");
    await waitFor(() => service.store.list().length === 1, "confirmed deletion");
    assert.throws(() => service.store.get(selectedId));
    assert.throws(() => agents.store.permission(selectedId));
    assert.throws(() => agents.store.getDraft(agentDraft.id));
    await sleep(700);
    assert.throws(() => service.store.get(selectedId));
    assert.equal(fs.readFileSync(fixture, "utf8"), originalImported);
    assert.equal(fs.readFileSync(filed.exportPath, "utf8"), "External edit survives");
    assert.deepEqual(
      fs.readFileSync(path.join(temp, "profile/call-notes/openrouter-key.enc")),
      encryptedKey
    );
    assert.equal(service.store.folders().length, 1);
    assert.equal(await js(`localStorage.getItem('call-note-draft:${selectedId}')`), null);
    await waitFor(() => js("!document.querySelector('[role=dialog]')"), "dialog closed");
    assert.equal(
      await js(
        `(()=>{const b=[...document.querySelectorAll('footer button')].find(b=>b.textContent.trim()==='Save Markdown');const r=b.getBoundingClientRect();return r.x>=0&&r.right<=innerWidth&&r.y>=0&&r.bottom<=innerHeight;})()`
      ),
      true
    );
    await click("Delete call");
    await click("Delete permanently");
    await waitFor(
      () => js("document.body.textContent.includes('A notebook for your conversations')"),
      "empty after final deletion"
    );
    assert.equal(service.store.list().length, 0);
    assert.equal(await js("document.documentElement.scrollWidth > innerWidth"), false);
    const image = await window.webContents.capturePage();
    const screenshot = path.join(temp, "call-notes.png");
    fs.writeFileSync(screenshot, image.toPNG());
    assert.equal(await js("document.documentElement.scrollWidth > innerWidth"), false);
    console.log(
      JSON.stringify({
        success: true,
        checks: [
          "real UI + preload + IPC",
          "autosave",
          "parented folder picker, cancel and pin from empty view",
          "small window visible Add folder and filing actions",
          "delete confirmation, cancel and permanent deletion of synthetic calls",
          "deletion preserves external files, key and pins; removes recovery journal",
          "Markdown filing",
          "external edit conflict",
          "VTT speakers and timing",
          "selected audio MP3 export",
          "confirmed forced retranscription with cancel safeguard",
          "localized provider errors",
          "unauthorized renderer rejected",
          "no horizontal overflow",
          "key save/reload confirmation and safe replacement cancellation",
        ],
        screenshot,
        selectedScreenshot,
        confirmationScreenshot,
        runtimeErrors,
      })
    );
  } catch (error) {
    console.error(error);
    if (window && !window.isDestroyed()) {
      console.error(await window.webContents.executeJavaScript("document.body.innerText"));
      fs.writeFileSync(
        "/tmp/ss-meeting-failure.png",
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
