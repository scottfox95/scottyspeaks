const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("fs"),
  path = require("path"),
  os = require("os"),
  assert = require("assert/strict");
const root = path.resolve(__dirname, ".."),
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "ss2-agent-ui-"));
app.setPath("userData", path.join(temp, "profile"));
const html = path.join(root, "src/.agent-smoke.html"),
  entry = path.join(root, "src/.agent-smoke.tsx");
let window, server, service;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const js = (code) => window.webContents.executeJavaScript(code, true);
async function wait(check, label) {
  for (let i = 0; i < 100; i++) {
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
  await js(
    `Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(label)}&&!b.disabled).click()`
  );
}
app.whenReady().then(async () => {
  try {
    fs.writeFileSync(
      html,
      '<html><body><div id="root"></div><script type="module" src="/.agent-smoke.tsx"></script></body></html>'
    );
    const { MeetingStore } = require("../src/helpers/meetingStore");
    const calls = new MeetingStore(path.join(temp, "calls"));
    const call = calls.create();
    calls.save(call.id, { title: "Synthetic review", notes: "Review the tests." }, 1);
    const folder = path.join(temp, "exports");
    fs.mkdirSync(folder);
    const pin = calls.pinFolder(folder);
    fs.writeFileSync(
      entry,
      `import React from 'react';import {createRoot} from 'react-dom/client';import {I18nextProvider} from 'react-i18next';import i18n from './i18n';import {CallAgentPanel} from './components/meetings/CallAgentPanel';import './index.css';createRoot(document.getElementById('root')!).render(<I18nextProvider i18n={i18n}><CallAgentPanel callId=${JSON.stringify(call.id)} folderId=${JSON.stringify(pin.id)} flush={async()=>{}}/></I18nextProvider>);`
    );
    const { createServer } = await import("vite");
    server = await createServer({
      root: path.join(root, "src"),
      server: { host: "127.0.0.1", port: 5199, strictPort: true },
    });
    await server.listen();
    window = new BrowserWindow({
      width: 1000,
      height: 900,
      show: false,
      webPreferences: {
        preload: path.join(root, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    service = require("../src/helpers/callAgentHandlers").registerCallAgentHandlers({
      app,
      ipcMain,
      windowManager: { controlPanelWindow: window },
      meetingStore: calls,
      ...(process.env.SS2_TEST_BRIDGE_UNAVAILABLE === "1"
        ? {
            bridgeFactory: () => {
              throw Error("Synthetic unavailable bridge");
            },
          }
        : {}),
    });
    await service.startup;
    await window.loadURL("http://127.0.0.1:5199/.agent-smoke.html");
    await wait(
      () => js(`document.body.textContent.includes('No agent requests yet')`),
      "truthful request status"
    );
    if (process.env.SS2_TEST_BRIDGE_UNAVAILABLE === "1")
      await wait(
        () => js(`document.body.textContent.includes('Connection unavailable')`),
        "unavailable status"
      );
    await click("Preview Markdown handoff");
    await wait(
      () => js(`document.body.textContent.includes('Review the tests.')`),
      "unshared human handoff"
    );
    assert.throws(() => service.store.read(call.id), /not shared/);
    await click("Share this call");
    assert.ok(service.store.permission(call.id));
    await click("Preview Markdown handoff");
    await wait(() => js(`document.body.textContent.includes('Review the tests.')`), "handoff");
    const view = service.store.read(call.id);
    service.store.submitDraft({
      callId: call.id,
      grantId: view.grantId,
      sourceVersion: view.sourceVersion,
      title: "Synthetic follow-up",
      body: "Prepare test review.",
      citations: [view.evidence[0].id],
    });
    await click("Refresh");
    await click("Review draft");
    await wait(() => js(`document.body.textContent.includes('Prepare test review.')`), "draft");
    await click("Save reviewed Markdown copy");
    await wait(() => fs.readdirSync(folder).length === 1, "file");
    assert.match(
      fs.readFileSync(path.join(folder, fs.readdirSync(folder)[0]), "utf8"),
      /Review the tests/
    );
    await click("Revoke access");
    assert.throws(() => service.store.read(call.id), /not shared/);
    await wait(
      () =>
        js(
          `Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='Share this call'&&!b.disabled)`
        ),
      "revocation UI settled"
    );
    await click("Preview Markdown handoff");
    await wait(
      () => js(`document.body.textContent.includes('Review the tests.')`),
      "revoked human handoff"
    );
    assert.throws(() => service.store.read(call.id), /not shared/);
    await click("Review draft");
    await wait(() => js(`document.body.textContent.includes('Cited evidence')`), "review visible");
    assert.equal(
      await js(
        `document.querySelector('article').textContent.includes('Evidence saved with this draft:')`
      ),
      true
    );
    assert.equal(
      await js(
        `document.querySelector('article').textContent.includes(${JSON.stringify(view.sourceVersion)})`
      ),
      false
    );
    await js(`document.querySelector('article').scrollIntoView({block:'start'})`);
    await sleep(100);
    assert.equal(calls.get(call.id).notes, "Review the tests.");
    assert.equal(await js("document.documentElement.scrollWidth>innerWidth"), false);
    const screenshot = path.join(temp, "agent-review.png");
    fs.writeFileSync(screenshot, (await window.webContents.capturePage()).toPNG());
    console.log(
      JSON.stringify({
        success: true,
        checks: [
          "real renderer/preload/IPC",
          "explicit share/revoke",
          "handoff preview",
          "draft citation review",
          "exclusive Markdown filing",
          "source unchanged",
          "no overflow",
        ],
        screenshot,
      })
    );
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    await service?.bridge.close();
    window?.destroy();
    await server?.close();
    for (const file of [html, entry]) if (fs.existsSync(file)) fs.unlinkSync(file);
    app.exit(process.exitCode || 0);
  }
});
