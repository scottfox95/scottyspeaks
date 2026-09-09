const { EventEmitter } = require("events");
const { spawn } = require("child_process");
const { StringDecoder } = require("string_decoder");
const crypto = require("crypto");
function validOwner(owner) {
  return (
    (Number.isSafeInteger(owner) && owner > 0) ||
    (typeof owner === "string" && owner.length > 0 && owner.length <= 100)
  );
}
class LocalSpeech extends EventEmitter {
  constructor({
    spawn: spawnProcess = spawn,
    platform = process.platform,
    config = {},
    persist = () => {},
    stopTimeoutMs = 3000,
  } = {}) {
    super();
    this.spawn = spawnProcess;
    this.platform = platform;
    this.persist = persist;
    this.stopTimeoutMs = stopTimeoutMs;
    this.config = {
      voice: typeof config.voice === "string" && config.voice.length <= 200 ? config.voice : "",
      rate:
        Number.isInteger(config.rate) && config.rate >= 100 && config.rate <= 350
          ? config.rate
          : 180,
      agentEnabled: config.agentEnabled === true,
    };
    this.recordings = new Map();
    this.active = null;
    this.starting = null;
    this.generation = 0;
    this.error = null;
    this.voicePromise = null;
  }
  status() {
    return {
      ...this.config,
      available: this.platform === "darwin",
      speaking: !!this.active,
      starting: !!this.starting,
      source: this.active?.source || null,
      text: this.active?.text || "",
      recording: this.recordings.size > 0,
      recordingCount: this.recordings.size,
      error: this.error,
    };
  }
  changed() {
    this.emit("change", this.status());
  }
  async voices() {
    if (this.platform !== "darwin") return [];
    if (this.voicePromise) return this.voicePromise;
    this.voicePromise = new Promise((resolve, reject) => {
      let child,
        timer,
        output = "",
        settled = false;
      const decoder = new StringDecoder("utf8");
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          reject(new Error("voices-unavailable"));
          return;
        }
        const voices = output.split(/\r?\n/).flatMap((line) => {
          const match = line.match(/^(.*?)\s+([a-z]{2,3}[_-][A-Z]{2})\s+#/);
          return match && match[1].length <= 200
            ? [{ name: match[1].trim(), language: match[2] }]
            : [];
        });
        resolve([...new Map(voices.slice(0, 500).map((voice) => [voice.name, voice])).values()]);
      };
      try {
        child = this.spawn("/usr/bin/say", ["-v", "?"], { stdio: ["ignore", "pipe", "pipe"] });
        timer = setTimeout(() => {
          child.kill("SIGKILL");
          finish(true);
        }, 5000);
        timer.unref?.();
        child.stdout.on("data", (data) => {
          output += decoder.write(data);
          if (Buffer.byteLength(output) > 256 * 1024) {
            child.kill("SIGKILL");
            finish(true);
          }
        });
        child.stderr.resume();
        child.once("error", () => finish(true));
        child.once("close", (code) => {
          output += decoder.end();
          finish(code !== 0);
        });
      } catch {
        finish(true);
      }
    });
    try {
      return await this.voicePromise;
    } catch (error) {
      this.voicePromise = null;
      throw error;
    }
  }
  async configure(patch) {
    if (
      !patch ||
      typeof patch !== "object" ||
      Array.isArray(patch) ||
      Object.keys(patch).some((key) => !["voice", "rate", "agentEnabled"].includes(key))
    )
      throw new Error("invalid-speech-settings");
    if (
      patch.voice !== undefined &&
      (typeof patch.voice !== "string" ||
        (patch.voice !== "" && !(await this.voices()).some((voice) => voice.name === patch.voice)))
    )
      throw new Error("invalid-voice");
    if (
      patch.rate !== undefined &&
      (!Number.isInteger(patch.rate) || patch.rate < 100 || patch.rate > 350)
    )
      throw new Error("invalid-rate");
    if (patch.agentEnabled !== undefined && typeof patch.agentEnabled !== "boolean")
      throw new Error("invalid-agent-setting");
    const next = { ...this.config, ...patch };
    this.persist(next);
    this.config = next;
    if (
      !next.agentEnabled &&
      (this.active?.source === "agent" || this.starting?.source === "agent")
    )
      await this.stop();
    this.changed();
    return this.status();
  }
  async speak({ text, owner, source = "user", authorize = () => {} }) {
    if (this.platform !== "darwin") throw new Error("speech-unavailable");
    if (!validOwner(owner) || !["user", "agent"].includes(source))
      throw new Error("invalid-speech-owner");
    if (
      typeof text !== "string" ||
      !text.trim() ||
      text.includes("\0") ||
      Buffer.byteLength(text) > (source === "agent" ? 3000 : 20000)
    )
      throw new Error("invalid-speech-text");
    if (source === "agent" && !this.config.agentEnabled) throw new Error("agent-speech-disabled");
    if (this.recordings.size) throw new Error("recording-active");
    if (this.starting) throw new Error("speech-busy");
    const pending = { owner, source, generation: this.generation };
    this.starting = pending;
    this.changed();
    try {
      const voices = await this.voices();
      if (this.config.voice && !voices.some((voice) => voice.name === this.config.voice))
        throw new Error("invalid-voice");
      await this.stop(false);
      if (this.generation !== pending.generation) throw new Error("speech-cancelled");
      if (this.recordings.size) throw new Error("recording-active");
      if (source === "agent" && !this.config.agentEnabled) throw new Error("agent-speech-disabled");
      authorize();
      const args = [
        ...(this.config.voice ? ["-v", this.config.voice] : []),
        "-r",
        String(this.config.rate),
      ];
      const child = this.spawn("/usr/bin/say", args, { stdio: ["pipe", "pipe", "pipe"] });
      let resolveDone;
      const active = {
        child,
        owner,
        source,
        text: text.slice(0, 500),
        done: new Promise((resolve) => {
          resolveDone = resolve;
        }),
        stopping: false,
      };
      this.active = active;
      this.error = null;
      const finish = (code) => {
        if (active.finished) return;
        active.finished = true;
        clearTimeout(active.killTimer);
        if (this.active === active) {
          this.active = null;
          if (code !== 0 && !active.stopping) this.error = "speech-failed";
        }
        resolveDone();
        this.changed();
      };
      child.stdout.resume();
      child.stderr.resume();
      child.once("close", (code) => finish(code));
      child.once("error", () => {
        this.error = "speech-failed";
        this.changed();
      });
      child.stdin.on("error", () => {
        this.error = "speech-failed";
        this.stop(false).catch(() => {});
      });
      child.stdin.end(text + "\n");
      this.changed();
    } finally {
      if (this.starting === pending) this.starting = null;
      this.changed();
    }
    return this.status();
  }
  async stop(cancelPending = true) {
    if (cancelPending) this.generation++;
    const active = this.active;
    if (!active) return;
    if (!active.stopping) {
      active.stopping = true;
      active.child.kill("SIGTERM");
      if (!active.finished) {
        active.killTimer = setTimeout(
          () => active.child.kill("SIGKILL"),
          Math.min(1500, this.stopTimeoutMs / 2)
        );
        active.killTimer.unref?.();
      }
    }
    let timer;
    try {
      await Promise.race([
        active.done,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("speech-stop-timeout")), this.stopTimeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  async beginRecording(owner, kind) {
    if (!validOwner(owner) || !["dictation", "call", "notes"].includes(kind))
      throw new Error("invalid-recording-owner");
    if (
      this.recordings.size >= 32 ||
      [...this.recordings.values()].filter((entry) => entry.owner === owner).length >= 8
    )
      throw new Error("too-many-recordings");
    const token = crypto.randomUUID();
    this.recordings.set(token, { owner, kind });
    this.changed();
    try {
      await this.stop();
      if (!this.recordings.has(token)) throw new Error("recording-cancelled");
      return token;
    } catch (error) {
      this.recordings.delete(token);
      this.changed();
      throw error;
    }
  }
  endRecording(token, owner) {
    if (this.recordings.get(token)?.owner === owner) {
      this.recordings.delete(token);
      this.changed();
    }
  }
  releaseOwner(owner) {
    for (const [token, entry] of this.recordings)
      if (entry.owner === owner) this.recordings.delete(token);
    this.changed();
    return this.stopOwner(owner);
  }
  stopOwner(owner) {
    if (this.starting?.owner === owner || this.active?.owner === owner) return this.stop();
    return Promise.resolve();
  }
  async close() {
    this.recordings.clear();
    await this.stop();
    this.changed();
  }
}
module.exports = { LocalSpeech };
