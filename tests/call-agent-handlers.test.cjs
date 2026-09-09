const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os");
const { MeetingStore } = require("../src/helpers/meetingStore");
const { registerCallAgentHandlers } = require("../src/helpers/callAgentHandlers");
test("control-panel sharing, handoff and separate filing reject outsiders and arbitrary paths", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ss2-agent-handlers-"));
  const calls = new MeetingStore(path.join(root, "calls"));
  const call = calls.create();
  calls.save(call.id, { notes: "Synthetic evidence" }, 1);
  const sender = { mainFrame: { url: "file://app", parent: null } },
    handlers = {};
  const app = { getPath: () => root, getAppPath: () => path.resolve("."), on() {} };
  const bridge = {
    discoveryPath: path.join(root, "endpoint.json"),
    start: async () => {},
    status: () => ({ ready: true, lastConnectedAt: null }),
    close: async () => {},
  };
  const service = registerCallAgentHandlers({
    app,
    ipcMain: { handle: (name, fn) => (handlers[name] = fn) },
    windowManager: { controlPanelWindow: { webContents: sender } },
    meetingStore: calls,
    bridgeFactory: () => bridge,
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const invoke = (name, args = {}, who = sender) =>
    handlers["callAgent:" + name]({ sender: who, senderFrame: who.mainFrame }, args);
  assert.equal((await invoke("grant", { callId: call.id }, {})).success, false);
  assert.equal((await invoke("handoff", { callId: call.id }, {})).success, false);
  assert.equal((await invoke("handoff", { callId: "../session.json" })).success, false);
  assert.equal(
    (await invoke("handoff", { callId: require("crypto").randomUUID() })).success,
    false
  );
  assert.equal((await invoke("handoff", { callId: call.id, path: "/etc/passwd" })).success, false);
  assert.equal(
    (
      await handlers["callAgent:grant"](
        { sender, senderFrame: { parent: null } },
        { callId: call.id }
      )
    ).success,
    false
  );
  assert.equal((await invoke("handoff", { callId: call.id })).success, true);
  assert.throws(() => service.store.read(call.id), /not shared/);
  assert.equal((await invoke("grant", { callId: call.id, path: "/etc/passwd" })).success, false);
  assert.equal((await invoke("grant", { callId: call.id })).success, true);
  const source = service.store.read(call.id);
  const draft = service.store.submitDraft({
    callId: call.id,
    grantId: source.grantId,
    sourceVersion: source.sourceVersion,
    title: "Action",
    body: "Prepare review.",
    citations: [source.evidence[0].id],
  });
  assert.match((await invoke("handoff", { callId: call.id })).data, /Synthetic evidence/);
  const list = (await invoke("state", { callId: call.id })).data.drafts;
  assert.equal(list[0].body, undefined);
  assert.equal((await invoke("getDraft", { draftId: draft.id })).data.body, "Prepare review.");
  const dest = path.join(root, "folder");
  fs.mkdirSync(dest);
  const folder = calls.pinFolder(dest);
  assert.equal((await invoke("fileDraft", { draftId: draft.id, folderId: "/etc" })).success, false);
  const filed = (await invoke("fileDraft", { draftId: draft.id, folderId: folder.id })).data;
  fs.writeFileSync(filed.path, "External changes");
  const copy = (await invoke("fileDraft", { draftId: draft.id, folderId: folder.id })).data;
  assert.notEqual(filed.path, copy.path);
  assert.equal(fs.readFileSync(filed.path, "utf8"), "External changes");
  assert.match(fs.readFileSync(copy.path, "utf8"), /Evidence/);
  assert.equal(calls.get(call.id).notes, "Synthetic evidence");
  await invoke("revoke", { callId: call.id });
  assert.equal((await invoke("state", { callId: call.id })).data.drafts.length, 1);
  assert.equal((await invoke("handoff", { callId: call.id })).success, true);
  assert.throws(() => service.store.read(call.id), /not shared/);
});
test("optional bridge construction and startup failures preserve human handlers and unavailable status", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ss2-agent-unavailable-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const meetings = new MeetingStore(path.join(root, "calls"));
  const call = meetings.create();
  for (const bridgeFactory of [
    () => {
      throw Error("private runtime unavailable");
    },
    () => ({
      start() {
        throw Error("synchronous startup failure");
      },
      close: async () => {},
    }),
    () => ({
      start: async () => {
        throw Error("listen unavailable");
      },
      close: async () => {},
    }),
  ]) {
    const sender = { mainFrame: {} },
      handlers = {};
    const service = registerCallAgentHandlers({
      app: { getPath: () => root, getAppPath: () => path.resolve("."), on() {} },
      ipcMain: { handle: (name, fn) => (handlers[name] = fn) },
      windowManager: { controlPanelWindow: { webContents: sender } },
      meetingStore: meetings,
      bridgeFactory,
    });
    await service.startup;
    const invoke = (name, args) =>
      handlers["callAgent:" + name]({ sender, senderFrame: sender.mainFrame }, args);
    const state = await invoke("state", { callId: call.id });
    assert.equal(state.success, true);
    assert.equal(state.data.ready, false);
    assert.equal((await invoke("grant", { callId: call.id })).success, true);
    assert.equal((await invoke("revoke", { callId: call.id })).success, true);
    assert.equal((await invoke("handoff", { callId: call.id })).success, true);
    assert.throws(() => service.store.read(call.id), /not shared/);
  }
});
