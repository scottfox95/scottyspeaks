const fs = require("fs");
const path = require("path");
const { spawn, execFile } = require("child_process");

// Starting needs room for a few hours; a running recording stops itself before
// the disk fills so the file can still be finalized.
const MIN_FREE_TO_START = 2 * 1024 ** 3;
const MIN_FREE_WHILE_RECORDING = 1024 ** 3;
const DISK_CHECK_MS = 30000;
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov"]);

function ffmpegPath() {
  return require("ffmpeg-static").replace("app.asar/", "app.asar.unpacked/");
}

function freeBytes(directory) {
  const stats = fs.statfsSync(directory);
  return stats.bavail * stats.bsize;
}

function timestampName(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `Screen Recording ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    ` at ${pad(date.getHours())}.${pad(date.getMinutes())}.${pad(date.getSeconds())}`
  );
}

// ffmpeg arguments that turn the recorder's .mov (HEVC + one AAC track per
// audio source) into a single-audio-track .mp4. Video is copied, never re-encoded.
function finalizeArgs(input, output, audioTracks) {
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    input,
    "-map",
    "0:v:0",
    "-c:v",
    "copy",
  ];
  if (audioTracks === 1) args.push("-map", "0:a:0", "-c:a", "copy");
  if (audioTracks === 2)
    args.push(
      "-filter_complex",
      "[0:a:0]aresample=async=1:first_pts=0[s];[0:a:1]aresample=async=1:first_pts=0[m];" +
        "[s][m]amix=inputs=2:duration=longest:normalize=0[a]",
      "-map",
      "[a]",
      "-c:a",
      "aac",
      "-b:a",
      "128k"
    );
  args.push("-tag:v", "hvc1", output);
  return args;
}

class ScreenRecorder {
  constructor(options) {
    this.directory = options.directory;
    this.binary = options.binary;
    this.spawn = options.spawn || spawn;
    this.freeBytes = options.freeBytes || freeBytes;
    this.convert =
      options.convert ||
      ((args) =>
        new Promise((resolve, reject) =>
          execFile(ffmpegPath(), args, { timeout: 30 * 60000 }, (error) =>
            error ? reject(error) : resolve()
          )
        ));
    this.keepAwake = options.keepAwake || (() => () => {});
    this.active = null;
    this.finalizing = new Set();
    this.lastResult = null;
  }
  available() {
    return process.platform === "darwin" && fs.existsSync(this.binary);
  }
  status() {
    const active = this.active;
    return active
      ? {
          recording: true,
          stopping: active.stopping,
          startedAt: active.startedAt,
          name: active.name,
          bytes: this.size(active.file),
          finalizing: this.finalizing.size > 0,
          last: this.lastResult,
        }
      : { recording: false, finalizing: this.finalizing.size > 0, last: this.lastResult };
  }
  size(file) {
    try {
      return fs.statSync(file).size;
    } catch {
      return 0;
    }
  }
  sources() {
    return new Promise((resolve, reject) => {
      const child = this.spawn(this.binary, ["--list"], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      child.stderr.on("data", () => {});
      child.on("error", reject);
      child.on("close", () => {
        const line = out.trim().split("\n").pop();
        try {
          const data = JSON.parse(line);
          if (data.event === "error")
            reject(Object.assign(new Error(data.message), { code: data.code }));
          else resolve({ displays: data.displays || [], windows: data.windows || [] });
        } catch {
          reject(new Error("Could not list screens"));
        }
      });
    });
  }
  async start({ source = { type: "display" }, systemAudio = true, microphone = true } = {}) {
    if (this.active) throw new Error("A screen recording is already running");
    fs.mkdirSync(this.directory, { recursive: true });
    if (this.freeBytes(this.directory) < MIN_FREE_TO_START)
      throw Object.assign(new Error("Less than 2 GB of disk space is free"), { code: "disk" });
    const name = timestampName(new Date());
    const file = path.join(this.directory, `${name}.mov`);
    const args = [file];
    if (source.type === "window" && Number.isInteger(source.id))
      args.push("--window", String(source.id));
    else if (Number.isInteger(source.id)) args.push("--display", String(source.id));
    if (systemAudio) args.push("--system-audio");
    if (microphone) args.push("--microphone");
    const audioTracks = (systemAudio ? 1 : 0) + (microphone ? 1 : 0);

    let resolveStart, rejectStart, resolveDone;
    const started = new Promise((resolve, reject) => {
      resolveStart = resolve;
      rejectStart = reject;
    });
    const done = new Promise((resolve) => (resolveDone = resolve));
    const active = {
      name,
      file,
      audioTracks,
      startedAt: Date.now(),
      stopping: false,
      done,
      error: null,
      code: null,
      reason: null,
      duration: 0,
      hasVideo: true,
    };
    this.active = active;
    const release = this.keepAwake();
    let settled = false,
      pending = "";
    const child = this.spawn(this.binary, args, { stdio: ["pipe", "pipe", "pipe"] });
    active.child = child;
    child.stdout.on("data", (chunk) => {
      pending += chunk.toString();
      let newline;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.event === "started" && !settled) {
          settled = true;
          clearTimeout(active.startTimer);
          resolveStart(this.status());
        }
        if (event.event === "error") {
          active.error = String(event.message || "Screen recording failed").slice(0, 500);
          active.code = event.code === "permission" ? "permission" : "capture";
        }
        if (event.event === "stopped") {
          if (Number.isFinite(event.duration)) active.duration = event.duration;
          active.hasVideo = event.hasVideo !== false;
        }
      }
    });
    // Drain stderr so a chatty framework can never block the recorder on a full pipe.
    child.stderr.on("data", () => {});
    child.stdin.on("error", () => {});
    child.on("error", (error) => {
      active.error = error.message;
    });
    child.on("close", () => {
      clearTimeout(active.startTimer);
      clearTimeout(active.stopTimer);
      clearInterval(active.diskTimer);
      release();
      if (this.active === active) this.active = null;
      if (!settled) {
        settled = true;
        rejectStart(
          Object.assign(new Error(active.error || "Screen recording stopped before it started"), {
            code: active.code,
          })
        );
        fs.rmSync(file, { force: true });
        resolveDone(null);
        return;
      }
      this.finish(active).then(resolveDone);
    });
    active.startTimer = setTimeout(() => {
      active.error ||= "Screen recording did not start. Check the Screen Recording permission.";
      child.kill("SIGKILL");
    }, 30000);
    active.diskTimer = setInterval(() => {
      try {
        if (this.freeBytes(this.directory) < MIN_FREE_WHILE_RECORDING) {
          active.reason = "disk";
          this.stop().catch(() => {});
        }
      } catch {}
    }, DISK_CHECK_MS);
    return started;
  }
  async stop() {
    const active = this.active;
    if (!active) throw new Error("No screen recording is running");
    if (!active.stopping) {
      active.stopping = true;
      active.child.stdin.write("stop\n");
      active.stopTimer = setTimeout(() => active.child.kill("SIGKILL"), 60000);
    }
    return active.done;
  }
  // Mixes the recording down to a single-audio-track .mp4. Any failure keeps
  // the .mov, which is already a complete, playable recording.
  async finish(active) {
    const result = {
      name: active.name,
      file: active.file,
      duration: active.duration,
      error: active.error,
      reason: active.reason,
    };
    if (!active.hasVideo || !this.size(active.file)) {
      fs.rmSync(active.file, { force: true });
      result.file = null;
      result.error ||= "Nothing was captured";
      this.lastResult = result;
      return result;
    }
    const output = active.file.replace(/\.mov$/, ".mp4");
    this.finalizing.add(active.file);
    try {
      if (this.freeBytes(this.directory) < this.size(active.file) + 256 * 1024 ** 2)
        throw new Error("Not enough disk space to convert");
      await this.convert(finalizeArgs(active.file, output, active.audioTracks));
      if (!this.size(output)) throw new Error("Conversion produced no file");
      fs.rmSync(active.file, { force: true });
      result.file = output;
    } catch (error) {
      fs.rmSync(output, { force: true });
      result.convertError = error.message;
    } finally {
      this.finalizing.delete(active.file);
    }
    this.lastResult = result;
    return result;
  }
  list() {
    let names = [];
    try {
      names = fs.readdirSync(this.directory);
    } catch {
      return [];
    }
    const busy = new Set([this.active?.file, ...this.finalizing].filter(Boolean));
    return names
      .filter(
        (name) => VIDEO_EXTENSIONS.has(path.extname(name).toLowerCase()) && !name.startsWith(".")
      )
      .map((name) => path.join(this.directory, name))
      .filter((file) => !busy.has(file))
      .flatMap((file) => {
        try {
          const stats = fs.statSync(file);
          if (!stats.isFile()) return [];
          return [{ name: path.basename(file), bytes: stats.size, modifiedAt: stats.mtimeMs }];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.modifiedAt - a.modifiedAt);
  }
  // Resolves a listed file name to its path, refusing anything outside the folder.
  resolve(name) {
    if (typeof name !== "string" || name !== path.basename(name) || name.startsWith("."))
      throw new Error("Invalid recording");
    if (!VIDEO_EXTENSIONS.has(path.extname(name).toLowerCase()))
      throw new Error("Invalid recording");
    const file = path.join(this.directory, name);
    if (!fs.existsSync(file)) throw new Error("Recording not found");
    if (file === this.active?.file || this.finalizing.has(file))
      throw new Error("Recording is still being saved");
    return file;
  }
}

module.exports = { ScreenRecorder, finalizeArgs, timestampName, MIN_FREE_TO_START };
