const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { SpeechActivity } = require("./speechActivity");
// Seconds of warning before an auto-stop, so a person can keep the recording.
const AUTO_STOP_WARNING_SECONDS = 30;
// The capture files must keep growing while recording; a stall this long is a
// failure the person has to hear about.
const HEALTH_CHECK_MS = 2000;
const STALL_MS = 20000;
// Calls are ~460 MB an hour. Starting needs room for a few hours; a running
// call stops itself before the disk fills so its files can still be finalized.
const MIN_FREE_TO_START = 2 * 1024 ** 3;
const MIN_FREE_WHILE_RECORDING = 1024 ** 3;
const DISK_CHECK_MS = 30000;

function freeBytes(directory) {
  const stats = fs.statfsSync(directory);
  return stats.bavail * stats.bsize;
}

function nonEmptyFile(file) {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

function captureBytes(directory) {
  let total = 0;
  for (const name of ["microphone.caf", "system.caf"])
    try {
      total += fs.statSync(path.join(directory, name)).size;
    } catch {}
  return total;
}

class MeetingRecorder {
  constructor(store, options = {}) {
    this.store = store;
    this.spawn = options.spawn || spawn;
    this.binary = options.binary;
    this.active = null;
    this.speech = options.localSpeech;
    // Resolves to the meeting app that still holds a call open, or null.
    this.meetingActive = options.meetingActive || null;
    // Receives { source: "call", reason, message, id } for every stop or
    // failure the person did not ask for, and for the auto-stop warning.
    this.onAlert = options.onAlert || (() => {});
    this.captureBytes = options.captureBytes || captureBytes;
    this.healthCheckMs = options.healthCheckMs || HEALTH_CHECK_MS;
    this.stallMs = options.stallMs || STALL_MS;
    this.now = options.now || Date.now;
    this.freeBytes = options.freeBytes || freeBytes;
    this.diskCheckMs = options.diskCheckMs || DISK_CHECK_MS;
  }
  status() {
    const active = this.active;
    if (!active) return { id: null };
    return {
      id: active.id,
      startedAt: active.startedAt,
      stopping: active.stopping,
      autoStopSeconds: active.autoStopSeconds,
      lastSpeech: active.lastSpeech,
      // "verifying" until the capture files are seen growing, then "ok";
      // "stalled" when they stop growing.
      health: active.health,
      autoStopWarning: active.warning
        ? { secondsLeft: Math.max(0, Math.ceil(active.warning.stopsAt - active.clock)) }
        : null,
      heldBy: active.heldBy || null,
    };
  }
  // "Keep recording": treats now as the last activity, cancelling a pending auto-stop.
  keepRecording(id) {
    const active = this.active;
    if (!active || active.id !== id) throw new Error("This call is not recording");
    active.lastSpeech = active.clock;
    active.warning = null;
    return this.status();
  }
  // autoStopSeconds: stop once no speech has been heard on either track for this
  // long. Armed only after the first speech, so waiting in a lobby never stops.
  async start(id, { autoStopSeconds = 0 } = {}) {
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
    if (this.freeBytes(this.store.directory(id)) < MIN_FREE_TO_START)
      throw Object.assign(new Error("Less than 2 GB of disk space is free"), { code: "disk" });
    const take = `take-${crypto.randomUUID()}`;
    const directory = path.join(this.store.directory(id), take);
    fs.mkdirSync(directory, { mode: 0o700 });
    const offset = item.recordedDuration || 0;
    const isTakeFile = (entry) => entry.file?.startsWith(`${take}/`);
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
      lastErrorCode: null,
      lastErrorStatus: null,
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
      autoStopSeconds: autoStopSeconds > 0 ? autoStopSeconds : 0,
      autoStopped: false,
      lastSpeech: null,
      activity: { microphone: new SpeechActivity(), system: new SpeechActivity() },
      clock: 0,
      warning: null,
      guarding: false,
      heldBy: null,
      health: "verifying",
      stopReason: null,
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
      clearInterval(active.healthTimer);
      clearInterval(active.diskTimer);
      const started = settled;
      const error = active.error || (!started ? "Call recording stopped before it started" : null);
      if (!started) {
        settled = true;
        rejectStart(Object.assign(new Error(error), active.code ? { code: active.code } : {}));
      }
      try {
        const current = this.store.get(id).audio || [];
        if (!started) {
          // The recorder never confirmed capture, so this take holds no
          // recording. Unregister it and put the call back as it was, so
          // playback, export, trim and later takes are unaffected.
          fs.rmSync(directory, { recursive: true, force: true });
          this.store.update(id, {
            status: item.status,
            audio: current.filter((entry) => !isTakeFile(entry)),
            needsTranscription: item.needsTranscription,
            lastError: error,
            lastErrorCode: null,
            lastErrorStatus: null,
          });
        } else {
          this.store.update(id, {
            status: error ? "interrupted" : "recorded",
            // A track the recorder never wrote (for example no call audio) is
            // not registered.
            audio: current.filter(
              (entry) =>
                !isTakeFile(entry) || nonEmptyFile(path.join(directory, path.basename(entry.file)))
            ),
            recordedDuration:
              offset + (active.duration || Math.max(0, (Date.now() - active.startedAt) / 1000)),
            lastError: error,
            lastErrorCode: null,
            lastErrorStatus: null,
            autoStopped: !error && active.autoStopped,
            ...(active.autoStopped ? { autoStopSeconds: active.autoStopSeconds } : {}),
          });
        }
      } finally {
        if (active.speechToken) this.speech.endRecording(active.speechToken, "native-call");
        if (this.active === active) this.active = null;
        resolveDone(this.store.get(id));
        this.alertForFinish(active, error, started);
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
            this.watchGrowth(active, directory);
            resolveStart(this.status());
          }
          if (event.event === "error")
            active.error = String(event.message || "Call capture failed").slice(0, 500);
          if (event.event === "level") this.level(active, event);
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
          active.stopReason ||= "limit";
          this.stop(id).catch(() => {});
        },
        6 * 3600 * 1000
      );
      active.diskTimer = setInterval(() => {
        try {
          if (this.active !== active || active.stopping) return;
          if (this.freeBytes(directory) < MIN_FREE_WHILE_RECORDING) {
            active.stopReason ||= "disk";
            this.stop(id).catch(() => {});
          }
        } catch {}
      }, this.diskCheckMs);
      active.diskTimer.unref?.();
    } catch (error) {
      active.error = error.message;
      finish();
    }
    return started;
  }
  // Alerts for every ending the person did not ask for.
  alertForFinish(active, error, started) {
    const base = { source: "call", id: active.id };
    if (active.stopReason === "user" && !error) return;
    if (!started) return this.onAlert({ ...base, reason: "startFailed", message: error });
    if (error) return this.onAlert({ ...base, reason: "failed", message: error });
    if (active.autoStopped)
      return this.onAlert({ ...base, reason: "autoStopped", seconds: active.autoStopSeconds });
    if (active.stopReason === "disk") return this.onAlert({ ...base, reason: "disk" });
    if (active.stopReason === "limit") return this.onAlert({ ...base, reason: "limit" });
  }
  // Polls the capture files; "Recording" is shown only once they grow, and a
  // stall is raised loudly (the recorder keeps running, in case it recovers).
  watchGrowth(active, directory) {
    let bytes = this.captureBytes(directory);
    let grewAt = this.now();
    active.healthTimer = setInterval(() => {
      if (this.active !== active || active.stopping) return;
      const next = this.captureBytes(directory);
      if (next > bytes) {
        bytes = next;
        grewAt = this.now();
        active.health = "ok";
      } else if (this.now() - grewAt >= this.stallMs && active.health !== "stalled") {
        active.health = "stalled";
        this.onAlert({ source: "call", id: active.id, reason: "stalled" });
      }
    }, this.healthCheckMs);
    active.healthTimer.unref?.();
  }
  level(active, event) {
    const detector = active.activity[event.source];
    if (!detector || !Number.isFinite(event.t)) return;
    active.clock = Math.max(active.clock, event.t);
    if (detector.push(event.t, event.db)) {
      active.lastSpeech = Math.max(active.lastSpeech ?? 0, event.t);
      if (active.warning) this.onAlert({ source: "call", id: active.id, reason: "warningCleared" });
      active.warning = null;
      active.heldBy = null;
    }
    if (!active.autoStopSeconds || active.lastSpeech == null || active.stopping || active.guarding)
      return;
    const quiet = active.clock - active.lastSpeech;
    const warnAt = Math.max(
      active.autoStopSeconds - AUTO_STOP_WARNING_SECONDS,
      active.autoStopSeconds / 2
    );
    if (quiet < warnAt || (quiet < active.autoStopSeconds && active.warning)) return;
    // A meeting app holding a call open overrides what the audio looks like.
    active.guarding = true;
    Promise.resolve(this.meetingActive ? this.meetingActive().catch(() => null) : null).then(
      (app) => {
        active.guarding = false;
        if (this.active !== active || active.stopping) return;
        if (app) {
          if (active.warning)
            this.onAlert({ source: "call", id: active.id, reason: "warningCleared" });
          active.lastSpeech = active.clock;
          active.warning = null;
          active.heldBy = app;
          return;
        }
        // Speech may have arrived while the check ran.
        const quietNow = active.clock - active.lastSpeech;
        if (quietNow < warnAt) return;
        if (quietNow >= active.autoStopSeconds) {
          active.autoStopped = true;
          active.stopReason = "auto";
          this.stop(active.id).catch(() => {});
          return;
        }
        if (!active.warning) {
          active.warning = { stopsAt: active.lastSpeech + active.autoStopSeconds };
          this.onAlert({
            source: "call",
            id: active.id,
            reason: "autoStopWarning",
            seconds: Math.ceil(active.warning.stopsAt - active.clock),
          });
        }
      }
    );
  }
  async stop(id, { requestedBy = null } = {}) {
    const active = this.active;
    if (!active || active.id !== id) throw new Error("This call is not recording");
    if (!active.stopping) {
      if (requestedBy) active.stopReason ||= requestedBy;
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
module.exports = {
  MeetingRecorder,
  AUTO_STOP_WARNING_SECONDS,
  captureBytes,
  MIN_FREE_TO_START,
  MIN_FREE_WHILE_RECORDING,
};
