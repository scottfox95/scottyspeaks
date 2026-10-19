const fs = require("fs");
const path = require("path");
const os = require("os");
const net = require("net");
const crypto = require("crypto");
const MAX_REQUEST = 256 * 1024;
const MAX_RESPONSE = 5 * 1024 * 1024;
function privateDirectory(root) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || stat.mode & 0o077)
    throw Error("Agent directory must be private and owned by this user");
  return fs.realpathSync(root);
}
function descriptor(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 4096 || stat.uid !== process.getuid?.() || stat.mode & 0o077)
      throw Error("Invalid private agent endpoint");
    const data = JSON.parse(fs.readFileSync(fd, "utf8"));
    if (
      typeof data.socket !== "string" ||
      !path.isAbsolute(data.socket) ||
      typeof data.token !== "string" ||
      !/^[a-f0-9]{64}$/.test(data.token)
    )
      throw Error("Invalid agent endpoint");
    return data;
  } finally {
    fs.closeSync(fd);
  }
}
function argumentsFor(method, args) {
  const allowed = {
    speak_update: ["callId", "text"],
    list_shared_calls: [],
    read_call: ["callId"],
    submit_draft: ["callId", "grantId", "sourceVersion", "title", "body", "citations"],
  };
  if (!Object.hasOwn(allowed, method)) throw Error("Unsupported agent tool");
  if (
    !args ||
    typeof args !== "object" ||
    Array.isArray(args) ||
    Object.keys(args).some((k) => !allowed[method].includes(k)) ||
    allowed[method].some((k) => !Object.hasOwn(args, k))
  )
    throw Error("Invalid tool arguments");
  return args;
}
class CallAgentBridge {
  constructor({ root, store, localSpeech }) {
    if (process.platform === "win32" || typeof process.getuid !== "function")
      throw Error("Selected-call socket is not supported on this platform");
    this.root = privateDirectory(root);
    this.store = store;
    this.localSpeech = localSpeech;
    this.discoveryPath = path.join(this.root, "endpoint.json");
    this.lastConnectedAt = null;
    this.ready = false;
    this.sockets = new Set();
  }
  async start() {
    if (process.platform === "win32")
      throw Error("Selected-call socket is supported on macOS and Linux");
    // A short private temporary directory avoids macOS Unix socket path limits.
    this.socketDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "ss2-agent-"));
    fs.chmodSync(this.socketDirectory, 0o700);
    this.socketPath = path.join(this.socketDirectory, "bridge.sock");
    this.token = crypto.randomBytes(32).toString("hex");
    this.server = net.createServer((socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
      socket.on("error", () => {});
      socket.setTimeout(5000, () => socket.destroy());
      let buffer = Buffer.alloc(0),
        done = false;
      socket.on("data", async (chunk) => {
        if (done) return;
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length > MAX_REQUEST) {
          done = true;
          socket.destroy();
          return;
        }
        const end = buffer.indexOf(10);
        if (end < 0) return;
        done = true;
        let response;
        try {
          const request = JSON.parse(buffer.subarray(0, end).toString("utf8"));
          if (
            typeof request.token !== "string" ||
            request.token.length !== this.token.length ||
            !crypto.timingSafeEqual(Buffer.from(request.token), Buffer.from(this.token))
          )
            throw Error("Agent authentication failed");
          const args = argumentsFor(request.method, request.args);
          this.lastConnectedAt = new Date().toISOString();
          const data =
            request.method === "speak_update"
              ? await this.speakUpdate(args)
              : request.method === "list_shared_calls"
                ? this.store.list()
                : request.method === "read_call"
                  ? this.store.read(args.callId)
                  : this.store.submitDraft(args);
          response = { success: true, data };
        } catch (error) {
          response = {
            success: false,
            error: /ENOENT|EACCES|ELOOP/.test(error.code || "")
              ? "Selected-call data unavailable"
              : String(error.message).slice(0, 250),
          };
        }
        const output = JSON.stringify(response);
        socket.end(
          Buffer.byteLength(output) <= MAX_RESPONSE
            ? output + "\n"
            : JSON.stringify({ success: false, error: "Agent response too large" }) + "\n"
        );
      });
    });
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.socketPath, resolve);
    });
    fs.chmodSync(this.socketPath, 0o600);
    const temp = path.join(this.root, crypto.randomUUID() + ".tmp");
    fs.writeFileSync(temp, JSON.stringify({ socket: this.socketPath, token: this.token }), {
      mode: 0o600,
      flag: "wx",
    });
    fs.renameSync(temp, this.discoveryPath);
    this.ready = true;
  }
  async speakUpdate(args) {
    if (!this.localSpeech) throw Error("speech-unavailable");
    const grant = this.store.permission(args.callId);
    const authorize = () => {
      if (this.store.permission(args.callId).id !== grant.id)
        throw Error("Call sharing permission changed");
    };
    await this.localSpeech.speak({
      text: args.text,
      owner: "agent:" + args.callId,
      source: "agent",
      authorize,
    });
    return { speaking: true };
  }
  status() {
    return { ready: this.ready, lastConnectedAt: this.lastConnectedAt };
  }
  close() {
    if (this.closing) return this.closing;
    this.closing = this.closeOnce();
    return this.closing;
  }
  async closeOnce() {
    this.ready = false;
    for (const socket of this.sockets) socket.destroy();
    if (this.server) await new Promise((resolve) => this.server.close(resolve));
    try {
      if (descriptor(this.discoveryPath).token === this.token) fs.unlinkSync(this.discoveryPath);
    } catch {}
    if (this.socketDirectory) fs.rmSync(this.socketDirectory, { recursive: true, force: true });
  }
}
function requestBridge(file, method, args) {
  return new Promise((resolve, reject) => {
    let info;
    try {
      info = descriptor(file);
    } catch {
      return reject(Error("Open SS2 to use selected-call access"));
    }
    const payload = JSON.stringify({ ...info, socket: undefined, method, args });
    if (Buffer.byteLength(payload) > MAX_REQUEST) return reject(Error("Agent request too large"));
    const socket = net.createConnection(info.socket);
    let buffer = Buffer.alloc(0);
    socket.setTimeout(5000, () => socket.destroy(Error("SS2 request timed out")));
    socket.on("error", () => reject(Error("SS2 connection unavailable")));
    socket.on("connect", () => socket.write(payload + "\n"));
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_RESPONSE) {
        socket.destroy();
        reject(Error("Agent response too large"));
      }
    });
    socket.on("end", () => {
      try {
        const result = JSON.parse(buffer.toString("utf8"));
        if (!result.success) reject(Error(result.error));
        else resolve(result.data);
      } catch {
        reject(Error("Invalid SS2 response"));
      }
    });
  });
}
module.exports = { CallAgentBridge, requestBridge, argumentsFor };
