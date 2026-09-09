const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
class MeetingRecorder {
  constructor(store, options = {}) {
    this.store = store;
    this.spawn = options.spawn || spawn;
    this.binary = options.binary;
    this.active = null;
    this.speech = options.localSpeech;
  }
  status() {
    return this.active
      ? { id: this.active.id, startedAt: this.active.startedAt, stopping: this.active.stopping }
      : { id: null };
  }
  async start(id) {
    if (this.active) throw new Error("A call is already recording");
    const item = this.store.get(id);
    if (["queued", "transcribing"].includes(item.status))
      throw new Error("Wait for transcription to finish");
    if (
      item.audio?.length &&
      (item.status === "interrupted" || !Number.isFinite(item.recordedDuration))
    ) {
      throw new Error(
        "Recovered or imported audio can be transcribed. Start a new call to record more without overlapping its timestamps."
      );
    }
    const take = `take-${crypto.randomUUID()}`;
    const directory = path.join(this.store.directory(id), take);
    fs.mkdirSync(directory, { mode: 0o700 });
    const offset = item.recordedDuration || 0;
    const audio = [
      ...(item.audio || []),
      ...["microphone", "system"].map((source) => ({
        file: `${take}/${source}.caf`,
        source,
        offset,
      })),
    ];
    this.store.update(id, {
      status: "recording",
      audio,
      needsTranscription: true,
      lastError: null,
    });
    let resolveStart, rejectStart, resolveDone;
    const started = new Promise((resolve, reject) => {
      resolveStart = resolve;
      rejectStart = reject;
    });
    const done = new Promise((resolve) => {
      resolveDone = resolve;
    });
    const active = {
      id,
      startedAt: Date.now(),
      stopping: false,
      done,
      child: null,
      error: null,
      duration: 0,
    };
    this.active = active;
    let settled = false,
      finished = false,
      pending = "";
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(active.startTimer);
      clearTimeout(active.stopTimer);
      clearTimeout(active.limitTimer);
      const error = active.error || (!settled ? "Call recording stopped before it started" : null);
      if (!settled) {
        settled = true;
        rejectStart(new Error(error));
      }
      try {
        this.store.update(id, {
          status: error ? "interrupted" : "recorded",
          recordedDuration:
            offset + (active.duration || Math.max(0, (Date.now() - active.startedAt) / 1000)),
          lastError: error,
        });
      } finally {
        if (active.speechToken) this.speech.endRecording(active.speechToken, "native-call");
        if (this.active === active) this.active = null;
        resolveDone(this.store.get(id));
      }
    };
    try {
      if (this.speech) active.speechToken = await this.speech.beginRecording("native-call", "call");
      if (active.stopping) throw new Error("Call recording stopped before it started");
      const child = this.spawn(this.binary, [directory], { stdio: ["pipe", "pipe", "pipe"] });
      active.child = child;
      child.stdout.on("data", (chunk) => {
        pending += chunk.toString();
        if (pending.length > 65536) {
          active.error = "Invalid capture response";
          child.kill();
          return;
        }
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
          if (event.event === "error")
            active.error = String(event.message || "Call capture failed").slice(0, 500);
          if (event.event === "stopped" && Number.isFinite(event.duration))
            active.duration = Math.max(0, Math.min(event.duration, 6 * 3600));
        }
      });
      // Consume stderr to prevent a full pipe blocking the audio process. Never log audio.
      child.stderr.on("data", () => {});
      child.stdin.on("error", () => {
        active.error = "The audio recorder connection closed";
        child.kill("SIGKILL");
      });
      child.on("error", (error) => {
        active.error = error.message;
      });
      child.on("close", (code, signal) => {
        if ((code && code !== 0) || signal)
          active.error ||= "Call capture was interrupted; saved audio can be retried.";
        finish();
      });
      active.startTimer = setTimeout(() => {
        active.error =
          "Call capture did not start. Check microphone and Screen & System Audio Recording permissions.";
        child.kill("SIGKILL");
      }, 30000);
      active.limitTimer = setTimeout(
        () => {
          this.stop(id).catch(() => {});
        },
        6 * 3600 * 1000
      );
    } catch (error) {
      active.error = error.message;
      finish();
    }
    return started;
  }
  async stop(id) {
    const active = this.active;
    if (!active || active.id !== id) throw new Error("This call is not recording");
    if (!active.stopping) {
      active.stopping = true;
      active.child?.stdin.write("stop\n");
      active.stopTimer = setTimeout(() => {
        active.error = "Capture stopped unexpectedly; saved audio is retained.";
        active.child?.kill("SIGKILL");
      }, 10000);
    }
    return active.done;
  }
}
module.exports = { MeetingRecorder };
