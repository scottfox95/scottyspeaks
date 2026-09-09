const crypto = require("crypto");
const { StringDecoder } = require("string_decoder");
const { spawn } = require("child_process");

// A token owns a live native AX reference; it is never a persisted app/window hint.
class RecordingTargetManager {
  constructor({ binary, spawn: spawnProcess = spawn, timeoutMs = 2500, lifetimeMs = 6 * 3600000 }) {
    this.binary = binary;
    this.spawn = spawnProcess;
    this.timeoutMs = timeoutMs;
    this.lifetimeMs = lifetimeMs;
    this.targets = new Map();
  }
  async capture(owner) {
    if (!Number.isSafeInteger(owner) || owner < 1)
      return { available: false, reason: "invalid-owner", token: null };
    if (!this.binary) return { available: false, reason: "helper-unavailable", token: null };
    if ([...this.targets.values()].filter((entry) => entry.owner === owner).length >= 8)
      return { available: false, reason: "too-many-targets", token: null };
    const token = crypto.randomUUID();
    let entry;
    try {
      const child = this.spawn(this.binary, [], { stdio: ["pipe", "pipe", "pipe"] });
      entry = {
        owner,
        token,
        child,
        pending: null,
        buffer: "",
        decoder: new StringDecoder("utf8"),
        consumed: false,
        closed: false,
      };
      this.targets.set(token, entry);
      child.stdout.on("data", (data) => {
        entry.buffer += entry.decoder.write(data);
        if (entry.buffer.length > 1_000_000) {
          this.release(token, owner);
          return;
        }
        let newline;
        while ((newline = entry.buffer.indexOf("\n")) >= 0) {
          const line = entry.buffer.slice(0, newline);
          entry.buffer = entry.buffer.slice(newline + 1);
          try {
            const response = JSON.parse(line);
            // A caller may have timed out/cancelled already. Only the native
            // transaction acknowledgement or actual process close ends exclusion.
            if (entry.consumed && response.event === "transaction-complete")
              this.finishTransaction(entry);
            entry.pending?.(response);
          } catch {
            this.release(token, owner);
            return;
          }
        }
      });
      child.stderr.resume(); // Never log native output or request content.
      const closed = () => {
        entry.closed = true;
        this.finishTransaction(entry);
        entry.pending?.({ ok: false, reason: "helper-closed" });
        clearTimeout(entry.lifetime);
        this.targets.delete(token);
      };
      child.once("close", closed);
      const failed = () => {
        entry.pending?.({ ok: false, reason: "helper-failed" });
        this.release(token, owner);
      };
      // A pipe/spawn/kill error is not evidence that the child has exited.
      child.once("error", failed);
      child.stdin.on("error", failed);
      const ready = await this.wait(entry);
      if (!ready.ok || ready.event !== "ready" || !Number.isSafeInteger(ready.pid)) {
        this.release(token, owner);
        return { available: false, token: null, reason: this.reason(ready) };
      }
      entry.pid = ready.pid;
      entry.lifetime = setTimeout(() => this.release(token, owner), this.lifetimeMs);
      entry.lifetime.unref?.();
      return {
        available: true,
        token,
        pid: ready.pid,
        appName: typeof ready.appName === "string" ? ready.appName.slice(0, 200) : "",
      };
    } catch {
      if (entry) this.release(token, owner);
      return { available: false, token: null, reason: "helper-unavailable" };
    }
  }
  reason(result) {
    return typeof result?.reason === "string" && /^[a-z-]{1,80}$/.test(result.reason)
      ? result.reason
      : "unverifiable-target";
  }
  wait(entry, request) {
    if (entry.closed) return Promise.resolve({ ok: false, reason: "helper-closed" });
    if (entry.pending) return Promise.resolve({ ok: false, reason: "target-busy" });
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => finish({ ok: false, reason: "target-timeout" }),
        this.timeoutMs
      );
      const finish = (value) => {
        clearTimeout(timer);
        if (entry.pending !== finish) return;
        entry.pending = null;
        resolve(value);
      };
      entry.pending = finish;
      if (request) {
        try {
          entry.child.stdin.write(JSON.stringify(request) + "\n");
        } catch {
          finish({ ok: false, reason: "helper-closed" });
        }
      }
    });
  }
  async verify(token, owner) {
    const entry = this.targets.get(token);
    if (!entry || entry.owner !== owner || entry.consumed)
      return { success: false, reason: "stale-target" };
    const result = await this.wait(entry, { op: "verify" });
    if (!result.ok) {
      this.release(token, owner);
      return { success: false, reason: this.reason(result) };
    }
    return { success: true, pid: entry.pid };
  }
  async selection(token, owner) {
    const entry = this.targets.get(token);
    if (!entry || entry.owner !== owner || entry.consumed)
      return { text: null, error: "stale-target" };
    const result = await this.wait(entry, { op: "selection" });
    if (!result.ok) {
      this.release(token, owner);
      return { text: null, error: this.reason(result) };
    }
    return {
      text:
        typeof result.text === "string" && Buffer.byteLength(result.text) <= 200000
          ? result.text
          : null,
    };
  }
  async paste(token, owner, text, expected) {
    const entry = this.targets.get(token);
    if (!entry || entry.owner !== owner || entry.consumed)
      return { success: false, reason: "stale-target" };
    if (
      typeof text !== "string" ||
      !text ||
      Buffer.byteLength(text) > 200000 ||
      (expected !== undefined &&
        (typeof expected !== "string" || Buffer.byteLength(expected) > 200000))
    ) {
      this.release(token, owner);
      return { success: false, reason: "invalid-text" };
    }
    if (this.pasting) {
      this.release(token, owner);
      return { success: false, reason: "paste-busy" };
    }
    this.pasting = entry;
    entry.consumed = true;
    try {
      const result = await this.wait(
        entry,
        expected === undefined ? { op: "paste", text } : { op: "replace", text, expected }
      );
      return result.ok
        ? { success: true, pid: entry.pid }
        : { success: false, reason: this.reason(result) };
    } finally {
      this.release(token, owner);
    }
  }
  finishTransaction(entry) {
    if (this.pasting === entry) this.pasting = null;
  }
  release(token, owner) {
    const entry = this.targets.get(token);
    if (!entry || entry.owner !== owner) return;
    this.targets.delete(token);
    clearTimeout(entry.lifetime);
    entry.released = true;
    entry.pending?.({ ok: false, reason: "target-released" });
    try {
      entry.child.stdin.end();
    } catch {}
    try {
      entry.child.kill("SIGTERM");
    } catch {}
  }
  releaseOwner(owner) {
    for (const [token, entry] of this.targets)
      if (entry.owner === owner) this.release(token, owner);
  }
  close() {
    for (const [token, entry] of this.targets) this.release(token, entry.owner);
  }
}
module.exports = { RecordingTargetManager };
