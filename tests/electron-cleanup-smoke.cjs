// Isolated UI controls -> real store -> recording snapshot -> actual processing request.
// No microphone, native models, cloud or installed userData is used.
const { app, BrowserWindow } = require("electron");
const fs = require("fs"),
  path = require("path"),
  os = require("os"),
  assert = require("assert/strict");
const root = path.resolve(__dirname, ".."),
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "ss2-cleanup-ui-"));
app.setPath("userData", path.join(temp, "profile"));
const entry = path.join(root, "src/.cleanup-smoke.tsx"),
  html = path.join(root, "src/.cleanup-smoke.html");
let server, win;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  try {
    fs.writeFileSync(
      html,
      '<div id="root"></div><script type="module" src="/.cleanup-smoke.tsx"></script>'
    );
    fs.writeFileSync(
      entry,
      `
import React from 'react'; import {createRoot} from 'react-dom/client';
import './index.css'; import './i18n';
import {DictationCleanupControls} from './components/SettingsPage';
import {useSettingsStore} from './stores/settingsStore';
import AudioManager from './helpers/audioManager';
import ReasoningService from './services/ReasoningService';
window.electronAPI={getActiveStyleProfile:async()=>({id:7,name:'Synthetic style',rules:JSON.stringify({aiPolish:true,formality:'formal',greeting:'Hello'})}),getFrontmostApp:async()=>({name:'Synthetic'}),getStyleExamples:async()=>[]};
localStorage.setItem('agentName','Scotty');
const manager=new AudioManager(); const requests=[];
ReasoningService.processText=async(text,model,agent,config)=>{requests.push({text,model,config}); return text;};
useSettingsStore.setState({useReasoningModel:true,reasoningModel:'qwen-test',reasoningProvider:'local',cloudReasoningMode:'byok',dictationExact:false,dictationRemoveFillers:true,dictationResolveCorrections:false,dictationPreserveTechnical:true});
window.runCleanup=async(text,change=false)=>{requests.length=0; await manager.snapshotCaptureSettings(); if(change)useSettingsStore.setState({reasoningModel:'changed-model',dictationRemoveFillers:true}); const evidence={snapshot:manager.captureSnapshot}; const result=await manager.processTranscription(text,'synthetic',evidence);return {result,requests,snapshot:{context:manager.captureSnapshot.context,cleanup:manager.captureSnapshot.cleanup},evidence:{rawText:evidence.rawText}};};
createRoot(document.getElementById('root')).render(<div style={{padding:30,maxWidth:700}}><DictationCleanupControls/></div>);
`
    );
    const { createServer } = await import("vite");
    server = await createServer({
      root: path.join(root, "src"),
      configFile: path.join(root, "src/vite.config.mjs"),
      server: { host: "127.0.0.1", port: 5199, strictPort: true },
    });
    await server.listen();
    win = new BrowserWindow({
      show: false,
      width: 850,
      height: 800,
      webPreferences: { contextIsolation: false, nodeIntegration: false },
    });
    win.webContents.on("console-message", (_e, _l, message) => {
      if (message.includes("Error")) console.error(message);
    });
    await win.loadURL("http://127.0.0.1:5199/.cleanup-smoke.html");
    for (let i = 0; i < 150; i++) {
      if (
        await win.webContents.executeJavaScript(
          `!!window.runCleanup && document.querySelectorAll('[role="switch"]').length===4`
        )
      )
        break;
      await wait(50);
    }
    const run = (code) => win.webContents.executeJavaScript(code, true);
    assert.equal(await run(`document.querySelectorAll('[role="switch"]').length`), 4);
    async function click(label) {
      await run(`document.querySelector('[aria-label="${label}"]').click()`);
      await wait(30);
    }
    await click("Remove hesitations");
    let result = await run(
      `runCleanup('Um, keep SS2_API_KEY and these exact words in this paragraph.',true)`
    );
    assert.equal(result.requests[0].model, "qwen-test");
    assert.match(result.requests[0].config.systemPrompt, /Hesitation removal: disabled/);
    assert.ok(result.result.startsWith("Um,"));
    assert.equal(result.snapshot.context.styleId, "7");
    await click("Resolve numeric self-corrections");
    result = await run(`runCleanup('Set the limit to 15, sorry, 50. Keep 20 backups.')`);
    assert.equal(result.result, "Set the limit to 50. Keep 20 backups.");
    assert.equal(result.evidence.rawText, "Set the limit to 15, sorry, 50. Keep 20 backups.");
    await click("Exact wording");
    assert.equal(await run(`document.querySelectorAll('[role="switch"]:disabled').length`), 3);
    result = await run(`runCleanup('Um, set the limit to 15, sorry, 50. Keep 20 backups.')`);
    assert.equal(result.requests.length, 0);
    assert.equal(result.result, "Um, set the limit to 15, sorry, 50. Keep 20 backups.");
    assert.equal(await run(`localStorage.getItem('polishStyle')`), "verbatim");
    result = await run(`runCleanup('Hey Scotty, rewrite this as a friendly email.')`);
    assert.equal(result.requests.length, 1);
    assert.ok(!result.requests[0].config.systemPrompt.includes("Hesitation removal:"));
    result = await run(`runCleanup('Ask Scotty and Jamie about the release.')`);
    assert.equal(result.requests.length, 0);
    console.log(
      "PASS cleanup controls -> persisted settings -> frozen capture -> actual AI request, exact bypass and numeric baseline"
    );
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    win?.destroy();
    await server?.close();
    for (const file of [entry, html]) fs.rmSync(file, { force: true });
    fs.rmSync(temp, { recursive: true, force: true });
    app.exit(process.exitCode || 0);
  }
});
