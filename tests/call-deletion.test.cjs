const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { MeetingStore } = require("../src/helpers/meetingStore");
const { CallAgentStore } = require("../src/helpers/callAgentStore");
const { createCallReader } = require("../src/helpers/callAgentReader");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ss-delete-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new MeetingStore(path.join(root, "calls"));
  return { root, store };
}
test("deletes only registered call data; preserves exports, pins, key and other calls; rejects stale saves", (t) => {
  const { root, store } = fixture(t);
  const a = store.create(),
    b = store.create();
  const folder = store.pinFolder(root);
  const exported = store.file(a.id, folder.id).path;
  fs.writeFileSync(path.join(store.root, "openrouter-key.enc"), "secret");
  fs.writeFileSync(path.join(store.directory(a.id), "audio.caf"), "audio");
  store.delete(a.id);
  assert.deepEqual(
    store.list().map((x) => x.id),
    [b.id]
  );
  assert.equal(fs.existsSync(store.directory(a.id)), false);
  assert.equal(fs.existsSync(exported), true);
  assert.equal(fs.readFileSync(path.join(store.root, "openrouter-key.enc"), "utf8"), "secret");
  assert.equal(store.folders()[0].id, folder.id);
  assert.throws(() => store.save(a.id, { notes: "stale" }, a.revision));
  assert.throws(() => store.get(a.id));
  assert.throws(() => createCallReader(store.root)(a.id));
});
test("rejects invalid IDs, active states and symlink call directories without touching targets", (t) => {
  const { root, store } = fixture(t);
  for (const id of ["../", null, {}, ""]) assert.throws(() => store.delete(id));
  for (const status of ["recording", "queued", "transcribing"]) {
    const a = store.create();
    store.update(a.id, { status });
    assert.throws(() => store.delete(a.id));
  }
  const a = store.create(),
    external = path.join(root, "outside");
  fs.renameSync(store.directory(a.id), external);
  fs.symlinkSync(external, store.directory(a.id));
  assert.throws(() => store.delete(a.id));
  assert.equal(fs.existsSync(path.join(external, "session.json")), true);
});
test("call deletion removes its agent grants and drafts, preserves other grants and rejects stale access", (t) => {
  const { root, store } = fixture(t),
    a = store.create(),
    b = store.create();
  store.save(a.id, { notes: "Evidence" }, a.revision);
  const agent = new CallAgentStore(path.join(root, "agents"), {
    readCall: createCallReader(store.root),
  });
  agent.grant(a.id);
  agent.grant(b.id);
  const evidence = agent.read(a.id);
  const args = {
    callId: a.id,
    grantId: evidence.grantId,
    sourceVersion: evidence.sourceVersion,
    title: "Draft",
    body: "Body",
    citations: [evidence.evidence[0].id],
  };
  const draft = agent.submitDraft(args);
  store.beforeDelete = (id) => agent.deleteCall(id);
  store.delete(a.id);
  assert.throws(() => agent.permission(a.id));
  assert.throws(() => agent.getDraft(draft.id));
  assert.throws(() => agent.submitDraft(args));
  assert.equal(agent.permission(b.id).callId, b.id);
});
function handlersFixture(t, overrides = {}) {
  const { root } = fixture(t),
    { EventEmitter } = require("node:events");
  const app = new EventEmitter();
  app.getPath = () => root;
  const handlers = new Map(),
    sender = { id: 123, mainFrame: {} },
    released = [];
  const service = require("../src/helpers/meetingHandlers").registerMeetingHandlers({
    app,
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    dialog: {},
    shell: {},
    safeStorage: {},
    systemPreferences: {},
    whisperManager: {},
    parakeetManager: {},
    databaseManager: { getDictionary: () => [] },
    windowManager: { controlPanelWindow: { webContents: sender } },
    localSpeech: { stopOwner: async (owner) => released.push(owner) },
    ...overrides,
  });
  const invoke = (name, args, event = { sender, senderFrame: sender.mainFrame }) =>
    handlers.get("meetings:" + name)(event, args);
  return { service, invoke, sender, released, root };
}
test("delete IPC requires trusted main frame and exact ID payload; recorder work blocks removal", async (t) => {
  const { service, invoke, sender, released } = handlersFixture(t),
    a = service.store.create();
  for (const event of [{ sender }, { sender, senderFrame: {} }, { sender: {}, senderFrame: {} }])
    assert.equal((await invoke("delete", { id: a.id }, event)).success, false);
  for (const args of [null, [], { id: a.id, path: "/tmp" }, { id: "../" }, { id: 3 }])
    assert.equal((await invoke("delete", args)).success, false);
  service.recorder.active = { id: a.id, startedAt: Date.now() };
  assert.equal((await invoke("delete", { id: a.id })).success, false);
  service.recorder.active = null;
  assert.equal((await invoke("delete", { id: a.id })).success, true);
  assert.deepEqual(released, [sender.id]);
  assert.equal(
    (await invoke("save", { id: a.id, revision: a.revision, patch: { notes: "stale" } })).success,
    false
  );
});
test("pending permission and native startup protect call deletion", async (t) => {
  let permission, started;
  const a = handlersFixture(t, {
    systemPreferences: {
      askForMediaAccess: () => new Promise((resolve) => (permission = resolve)),
    },
  });
  const item = a.service.store.create();
  const config = await a.invoke("getConfig");
  if (!config.data.captureAvailable) {
    t.skip("native capture is unavailable on this platform");
    return;
  }
  a.service.recorder.start = () => new Promise((resolve) => (started = resolve));
  const pending = a.invoke("startCapture", { id: item.id });
  assert.equal((await a.invoke("delete", { id: item.id })).success, false);
  permission(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await a.invoke("delete", { id: item.id })).success, false);
  started({ id: item.id });
  await pending;
  assert.equal((await a.invoke("delete", { id: item.id })).success, true);
});
test("pending playback blocks deletion and issued playback fails after call removal", async (t) => {
  let prepared, resolver;
  const a = handlersFixture(t, {
    audioEvidence: {
      prepare: () => new Promise((resolve) => (prepared = resolve)),
      issue: (fn) => {
        resolver = fn;
        return "synthetic-url";
      },
    },
  });
  const item = a.service.store.create(),
    file = path.join(a.service.store.directory(item.id), "playback.mp3");
  fs.writeFileSync(file, "audio");
  a.service.store.update(item.id, { audio: [{ file: "playback.mp3", source: "audio" }] });
  const pending = a.invoke("playback", { id: item.id });
  assert.equal((await a.invoke("delete", { id: item.id })).success, false);
  prepared(file);
  assert.equal((await pending).success, true);
  assert.equal(resolver(), file);
  assert.equal((await a.invoke("delete", { id: item.id })).success, true);
  assert.throws(resolver);
});
test("folder chooser is parented, cancel leaves pins unchanged and repeated selection reuses the pin", async (t) => {
  let cancelled = true,
    parent;
  const a = handlersFixture(t, {
    dialog: {
      showOpenDialog: async (window, options) => {
        parent = window;
        assert.ok(options.properties.includes("openDirectory"));
        return { canceled: cancelled, filePaths: [a.root] };
      },
    },
  });
  assert.equal((await a.invoke("pinFolder")).data, null);
  assert.equal(a.service.store.folders().length, 0);
  cancelled = false;
  const pin = (await a.invoke("pinFolder")).data;
  assert.ok(parent.webContents);
  assert.equal((await a.invoke("pinFolder")).data.id, pin.id);
  assert.equal(a.service.store.folders().length, 1);
});
