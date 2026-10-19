// Real React workspace + preload + IPC + MeetingStore. Only native capture and
// dialogs are synthetic; deferred replies exercise user-visible race handling.
const { app, BrowserWindow, ipcMain } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { MeetingStore } = require("../src/helpers/meetingStore");

const root = path.resolve(__dirname, "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ss-workspace-ui-"));
const name = `.workspace-smoke-${process.pid}`;
const html = path.join(root, "src", name + ".html");
const entry = path.join(root, "src", name + ".tsx");
app.setPath("userData", path.join(temp, "profile"));
let window, server;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve, started: false };
};
const js = (source) => window.webContents.executeJavaScript(source, true);
async function waitFor(check, label) {
  for (let attempt = 0; attempt < 160; attempt++) {
    if (await check()) return;
    await sleep(50);
  }
  throw Error("Timed out: " + label);
}
async function clickExpression(expression, label) {
  await waitFor(
    () => js(`(()=>{const b=${expression};return !!b&&!b.disabled})()`),
    "enabled " + label
  );
  const point = await js(
    `(()=>{const b=${expression};b.scrollIntoView({block:'center'});const r=b.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`
  );
  assert.equal(
    await js(
      `document.elementFromPoint(${point.x},${point.y})?.closest('button') === (${expression})`
    ),
    true,
    "Unobscured " + label
  );
  window.webContents.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount: 1 });
  window.webContents.sendInputEvent({ type: "mouseUp", ...point, button: "left", clickCount: 1 });
}
const click = (key) =>
  clickExpression(
    `[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===window.testT(${JSON.stringify(key)}))`,
    key
  );
const openCall = (title) =>
  clickExpression(
    `[...document.querySelectorAll('[data-call-list-item]')].find(b=>b.textContent.includes(${JSON.stringify(title)}))`,
    title
  );
async function type(selector, value) {
  await js(
    `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw Error('Input unavailable');const p=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`
  );
}
const notes = () => js("document.querySelector('textarea')?.value");

app.whenReady().then(async () => {
  try {
    const store = new MeetingStore(path.join(temp, "calls"));
    const seed = (patch) => store.update(store.create().id, patch);
    const notesCall = seed({ title: "Notes call", notes: "Follow up with the zebra team." });
    const transcriptCall = seed({
      title: "Transcript call",
      notes: "Existing notes.",
      transcript: "Orion release is ready.",
      segments: [{ start: 42, end: 47, speaker: "Morgan", text: "Orion release is ready." }],
    });
    const resumeCall = seed({
      title: "Resume call",
      notes: "Earlier discussion.",
      status: "recorded",
      recordedDuration: 120,
      audio: [{ file: "synthetic.wav", source: "system", offset: 0 }],
    });
    const folderPath = path.join(temp, "Destination");
    fs.mkdirSync(folderPath);
    store.pinFolder(folderPath);
    let capture = { id: null };
    let stoppedCount = 0;
    let pinGate, getGate, saveGate;
    let nextGetAfterStop = false;
    const methods = {
      list: (args) => store.list(args),
      create: () => store.create(),
      get: async ({ id }) => {
        const value = store.get(id);
        if (getGate && (!nextGetAfterStop || !capture.id)) {
          const gate = getGate;
          getGate = null;
          gate.started = true;
          await gate.promise;
        }
        return value;
      },
      save: async ({ id, patch, revision }) => {
        if (saveGate) {
          const gate = saveGate;
          saveGate = null;
          gate.started = true;
          await gate.promise;
        }
        return store.save(id, patch, revision);
      },
      folders: () => store.folders(),
      getConfig: () => ({
        provider: "local",
        localEngine: "nvidia",
        localModel: "synthetic",
        hasKey: false,
        captureAvailable: true,
      }),
      captureStatus: () => ({ ...capture }),
      startCapture: ({ id }) => {
        assert.equal(capture.id, null);
        const item = store.get(id);
        store.update(id, {
          status: "recording",
          audio: [
            ...item.audio,
            { file: "synthetic-next.wav", source: "system", offset: item.recordedDuration || 0 },
          ],
        });
        capture = { id, startedAt: Date.now() - 65000 };
        return { ...capture };
      },
      stopCapture: ({ id }) => {
        assert.equal(capture.id, id);
        stoppedCount++;
        const duration = (Date.now() - capture.startedAt) / 1000;
        capture = { id: null };
        return store.update(id, {
          status: "recorded",
          recordedDuration: (store.get(id).recordedDuration || 0) + duration,
        });
      },
      pinFolder: async () => {
        if (pinGate) {
          const gate = pinGate;
          pinGate = null;
          gate.started = true;
          await gate.promise;
        }
        return null;
      },
      file: ({ id, folderId, asCopy }) => store.file(id, folderId, { asCopy }),
      playback: () => ({ url: "", durationSeconds: 120 }),
      releasePlayback: () => null,
    };
    for (const [method, handler] of Object.entries(methods)) {
      ipcMain.handle(`meetings:${method}`, async (_event, args) => {
        try {
          return { success: true, data: await handler(args) };
        } catch (error) {
          return { success: false, error: error.message };
        }
      });
    }
    fs.writeFileSync(
      html,
      `<html><body><div id="root"></div><script type="module" src="/${name}.tsx"></script></body></html>`
    );
    fs.writeFileSync(
      entry,
      `import React from 'react';import {createRoot} from 'react-dom/client';import {I18nextProvider} from 'react-i18next';import i18n,{i18nReady} from './i18n';import MeetingsView from './components/meetings/MeetingsView';import './index.css';Object.defineProperty(document,'hidden',{get:()=>false});i18nReady.then(()=>{window.testT=(key)=>i18n.t(key);createRoot(document.getElementById('root')!).render(<I18nextProvider i18n={i18n}><div style={{height:'100vh'}}><MeetingsView/></div></I18nextProvider>)});`
    );
    const { createServer } = await import("vite");
    server = await createServer({
      root: path.join(root, "src"),
      server: { host: "127.0.0.1", port: 0 },
      logLevel: "error",
    });
    await server.listen();
    window = new BrowserWindow({
      width: 1280,
      height: 900,
      show: process.env.SS_SHOW_TEST === "1",
      webPreferences: {
        preload: path.join(root, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    const runtimeErrors = [];
    window.webContents.on("console-message", (_event, level, message) => {
      if (level >= 3) runtimeErrors.push(message);
    });
    const port = server.httpServer.address().port;
    await window.loadURL(`http://127.0.0.1:${port}/${name}.html`);
    await waitFor(() => js("!!document.querySelector('#call-search')"), "call workspace");
    await waitFor(
      () =>
        js(
          "!!document.querySelector('#meeting-title')&&!document.querySelector('#meeting-title').disabled"
        ),
      "initial call"
    );

    await type("#call-search", "zebra");
    await waitFor(
      () =>
        js(
          "document.querySelectorAll('[data-call-list-item]').length===1 && document.querySelector('[data-call-list-item]').textContent.includes('Notes call')"
        ),
      "search by persisted notes"
    );
    await type("#call-search", "Orion");
    await waitFor(
      () =>
        js(
          "document.querySelectorAll('[data-call-list-item]').length===1 && document.querySelector('[data-call-list-item]').textContent.includes('Transcript call')"
        ),
      "search by persisted transcript"
    );
    await type("#call-search", "");
    await openCall("Transcript call");
    await click("meetings.transcript");
    await click("workspace.addToNotes");
    await waitFor(
      () =>
        store.get(transcriptCall.id).notes.includes("> [00:42] Morgan: Orion release is ready."),
      "quote autosave"
    );
    assert.match(store.get(transcriptCall.id).notes, /^Existing notes\./);

    await click("workspace.recordNew");
    await waitFor(() => capture.id !== null, "new recording");
    const newId = capture.id;
    assert.ok(![notesCall.id, transcriptCall.id, resumeCall.id].includes(newId));
    await click("workspace.markMoment");
    await waitFor(() => /\[01:0[5-9]\]/.test(store.get(newId).notes), "timestamped moment saves");
    await type("#meeting-title", "Marked call");
    await click("meetings.file");
    await waitFor(() => !!store.get(newId).exportPath, "Markdown file saves");
    assert.match(fs.readFileSync(store.get(newId).exportPath, "utf8"), /\[01:0[5-9]\]/);

    const pendingPin = deferred();
    pinGate = pendingPin;
    await click("meetings.addFolder");
    await waitFor(() => pendingPin.started, "folder action pending");
    await click("meetings.stop");
    await waitFor(() => stoppedCount === 1, "stop bypasses pending action");
    assert.equal(capture.id, null);
    pendingPin.resolve();
    await waitFor(
      () => js("!document.querySelector('#meeting-title').disabled"),
      "pending action completes"
    );

    await openCall("Resume call");
    await click("meetings.resume");
    await waitFor(() => capture.id === resumeCall.id, "resumed recording");
    await click("workspace.markMoment");
    await waitFor(
      () => /\[03:0[5-9]\]/.test(store.get(resumeCall.id).notes),
      "resumed marker includes previous duration"
    );
    await click("meetings.stop");
    await waitFor(() => stoppedCount === 2 && capture.id === null, "resume stops");
    await sleep(150);

    const stalePoll = deferred();
    getGate = stalePoll;
    await waitFor(() => stalePoll.started, "poll held with old snapshot");
    await type("textarea", "Newer notes survive an old poll.");
    await waitFor(
      () => store.get(resumeCall.id).notes === "Newer notes survive an old poll.",
      "newer notes save"
    );
    stalePoll.resolve();
    await sleep(150);
    assert.equal(await notes(), "Newer notes survive an old poll.");

    await click("meetings.resume");
    await waitFor(() => capture.id === resumeCall.id, "last recording starts");
    const stopReload = deferred();
    getGate = stopReload;
    nextGetAfterStop = true;
    await click("meetings.stop");
    await waitFor(() => stopReload.started, "post-stop snapshot held");
    const pendingSave = deferred();
    saveGate = pendingSave;
    await type("textarea", "Edit made while stop refresh is pending.");
    stopReload.resolve();
    await sleep(100);
    assert.equal(
      await notes(),
      "Edit made while stop refresh is pending.",
      "Late stop refresh cannot discard a new edit"
    );
    pendingSave.resolve();
    await waitFor(
      () => store.get(resumeCall.id).notes === "Edit made while stop refresh is pending.",
      "post-stop edit saved"
    );

    assert.deepEqual(runtimeErrors, [], "Renderer has no runtime errors");
    console.log(
      "Workspace smoke passed: real-store search, new recording, timed notes, transcript quote, Markdown export, resumed offsets, independent stop, stale poll and stop-refresh edit preservation."
    );
  } catch (error) {
    console.error(error);
    if (window && !window.isDestroyed())
      console.error(await js("document.body.innerText").catch(() => "Renderer unavailable"));
    process.exitCode = 1;
  } finally {
    window?.destroy();
    await server?.close();
    fs.rmSync(html, { force: true });
    fs.rmSync(entry, { force: true });
    fs.rmSync(temp, { recursive: true, force: true });
    app.exit(process.exitCode || 0);
  }
});
