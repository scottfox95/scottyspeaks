const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { CallAgentStore } = require("../src/helpers/callAgentStore");
const { CallAgentBridge, requestBridge } = require("../src/helpers/callAgentBridge");
const { MeetingStore } = require("../src/helpers/meetingStore");
const { createCallReader } = require("../src/helpers/callAgentReader");
test("real stdio MCP forwards only granted evidence and isolated drafts through authenticated app socket", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ss2-mcp-"));
  const meetings = new MeetingStore(path.join(root, "calls"));
  const call = meetings.create();
  meetings.save(
    call.id,
    { title: "Synthetic", notes: "Prepare tests.", transcript: "Review Friday." },
    call.revision
  );
  const sender = { mainFrame: {} },
    handlers = {};
  const service = require("../src/helpers/callAgentHandlers").registerCallAgentHandlers({
    app: { getPath: () => root, getAppPath: () => path.resolve("."), on() {} },
    ipcMain: { handle: (name, handler) => (handlers[name] = handler) },
    windowManager: { controlPanelWindow: { webContents: sender } },
    meetingStore: meetings,
  });
  await service.startup;
  const { store, bridge } = service;
  const humanHandoff = () =>
    handlers["callAgent:handoff"]({ sender, senderFrame: sender.mainFrame }, { callId: call.id });
  t.after(async () => {
    await bridge.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  assert.equal(bridge.status().lastConnectedAt, null);
  assert.equal(fs.statSync(bridge.discoveryPath).mode & 0o777, 0o600);
  const child = spawn(
    process.env.SS2_MCP_RUNTIME || process.execPath,
    [
      process.env.SS2_MCP_SCRIPT || path.resolve("src/helpers/callAgentMcp.js"),
      "--endpoint",
      bridge.discoveryPath,
    ],
    { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } }
  );
  t.after(() => child.kill());
  let buf = "",
    serial = 0;
  const pending = new Map();
  let stderr = "";
  child.stderr.on("data", (b) => (stderr += b));
  child.stdout.on("data", (b) => {
    buf += b;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const x = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      pending.get(x.id)?.(x);
      pending.delete(x.id);
    }
  });
  const rpc = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++serial;
      const timeout = setTimeout(() => reject(Error("MCP timeout")), 5000);
      pending.set(id, (x) => {
        clearTimeout(timeout);
        resolve(x);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  assert.equal(
    (
      await rpc("initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      })
    ).result.protocolVersion,
    "2025-11-25"
  );
  child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  assert.equal((await rpc("tools/list")).result.tools.length, 4);
  assert.equal((await rpc("unknown")).error.code, -32601);
  const tool = async (name, args = {}) =>
    (await rpc("tools/call", { name, arguments: args })).result;
  const snapshot = await humanHandoff();
  assert.equal(snapshot.success, true);
  assert.match(snapshot.data, /Prepare tests/);
  assert.equal((await tool("read_call", { callId: call.id })).isError, true);
  assert.equal((await tool("read_call", { callId: "../openrouter-key.enc" })).isError, true);
  assert.equal((await tool("read_call", { callId: call.id, path: "/etc/passwd" })).isError, true);
  assert.equal((await tool("grant", { callId: call.id })).isError, true);
  store.grant(call.id);
  const read = JSON.parse((await tool("read_call", { callId: call.id })).content[0].text);
  assert.equal(read.title, "Synthetic");
  assert.ok(!JSON.stringify(read).includes("runtime"));
  const draftArgs = {
    callId: call.id,
    grantId: read.grantId,
    sourceVersion: read.sourceVersion,
    title: "Follow up",
    body: "Prepare tests.",
    citations: [read.evidence[0].id],
  };
  assert.equal((await tool("submit_draft", draftArgs)).isError, undefined);
  assert.equal(store.listDrafts(call.id).length, 1);
  assert.equal(meetings.get(call.id).transcript, "Review Friday.");
  assert.equal((await tool("submit_draft", { ...draftArgs, citations: ["fake"] })).isError, true);
  store.revoke(call.id);
  assert.equal((await humanHandoff()).success, true);

  assert.equal((await tool("submit_draft", draftArgs)).isError, true);
  assert.equal((await tool("read_call", { callId: call.id })).isError, true);
  assert.ok(bridge.status().lastConnectedAt);
  assert.equal(stderr, "");
  const descriptor = JSON.parse(fs.readFileSync(bridge.discoveryPath));
  assert.ok(descriptor.token);
  assert.ok(!JSON.stringify(read).includes(descriptor.token));
  await assert.rejects(
    requestBridge(bridge.discoveryPath, "grant", { callId: call.id }),
    /Unsupported/
  );
  child.stdin.end();
});
test("MCP framing rejects malformed requests and declares strict tool schemas", async () => {
  const { serve, tools } = require("../src/helpers/callAgentMcp");
  assert.equal((await serve([], "unused")).error.code, -32600);
  assert.equal(
    await serve({ jsonrpc: "2.0", method: "notifications/initialized" }, "unused"),
    null
  );
  assert.equal(
    (await serve({ jsonrpc: "2.0", id: {}, method: "ping" }, "unused")).error.code,
    -32600
  );
  assert.equal(
    (await serve({ jsonrpc: "2.0", id: 1, method: "ping" }, "unused")).result.constructor,
    Object
  );
  for (const tool of tools) assert.equal(tool.inputSchema.additionalProperties, false);
});
test("private socket rejects wrong authentication and oversized requests without exposing source", async (t) => {
  const net = require("node:net");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ss2-agent-auth-"));
  const bridge = new CallAgentBridge({
    root,
    store: {
      list: () => {
        throw Error("must not read");
      },
    },
  });
  await bridge.start();
  t.after(async () => {
    await bridge.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const info = JSON.parse(fs.readFileSync(bridge.discoveryPath));
  const raw = (payload) =>
    new Promise((resolve, reject) => {
      const socket = net.createConnection(info.socket);
      let result = "";
      socket.on("connect", () => socket.write(payload));
      socket.on("data", (chunk) => (result += chunk));
      socket.on("error", reject);
      socket.on("close", () => resolve(result));
    });
  const response = JSON.parse(
    await raw(
      JSON.stringify({ token: "0".repeat(64), method: "list_shared_calls", args: {} }) + "\n"
    )
  );
  assert.equal(response.success, false);
  assert.match(response.error, /authentication/);
  assert.equal(bridge.status().lastConnectedAt, null);
  assert.equal(await raw("x".repeat(270000)), "");
  const link = path.join(root, "link");
  fs.symlinkSync(bridge.discoveryPath, link);
  await assert.rejects(requestBridge(link, "list_shared_calls", {}), /Open SS2/);
});
test("unsupported POSIX ownership environment fails before touching runtime paths", () => {
  const original = process.getuid;
  process.getuid = undefined;
  try {
    assert.throws(
      () => new CallAgentBridge({ root: "/not-a-real-runtime/path", store: {} }),
      /not supported/
    );
  } finally {
    process.getuid = original;
  }
});
