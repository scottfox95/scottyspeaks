const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { SpeechActivity } = require("./speechActivity");
// Level windows arrive every 0.5s per track. A larger jump in the shared clock
// means the capture stream delivered nothing for a while (display sleep, screen
// lock, a stream restart) and the helper filled the hole with silence.
const LEVEL_WINDOW_SECONDS = 0.5;
const CAPTURE_GAP_SECONDS = 2;
class MeetingRecorder {
  constructor(store, options = {}) {
    this.store = store;
    this.spawn = options.spawn || spawn;
    this.binary = options.binary;
    this.active = null;
    this.speech = options.localSpeech;
    // Returns a release function. Calls run for hours, often with the display
    // asleep, so the Mac must not idle-sleep underneath them.
    this.keepAwake = options.keepAwake || (() => () => {});
  }
  status() {
    return this.active
      ? {
          id: this.active.id,
          startedAt: this.active.startedAt,
          stopping: this.active.stopping,
          autoStopSeconds: this.active.autoStopSeconds,
          lastSpeech: this.active.lastSpeech,
          interrupted: this.active.interrupted,
          interruptions: this.active.interruptions,
        }
      : { id: null };
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
      // Seconds since lastSpeech during which the stream delivered no audio.
      unheard: 0,
      interrupted: false,
      interruptions: 0,
      release: null,
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
          lastErrorCode: null,
          lastErrorStatus: null,
          autoStopped: !error && active.autoStopped,
          ...(active.autoStopped ? { autoStopSeconds: active.autoStopSeconds } : {}),
          captureInterruptions: active.interruptions,
        });
      } finally {
        active.release?.();
        active.release = null;
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
      active.release = this.keepAwake();
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
          // The helper restarts ScreenCaptureKit itself when the stream drops
          // (display sleep, screen lock); the recording keeps its files.
          if (event.event === "interrupted") {
            active.interrupted = true;
            active.interruptions++;
          }
          if (event.event === "resumed") active.interrupted = false;
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
  level(active, event) {
    const detector = active.activity[event.source];
    if (!detector || !Number.isFinite(event.t)) return;
    // Time the stream was not delivering audio is unknown, not silence: it must
    // not count toward auto-stop, or the first window after waking would end the
    // call immediately.
    const gap = event.t - active.clock - LEVEL_WINDOW_SECONDS;
    if (active.clock > 0 && gap > CAPTURE_GAP_SECONDS) active.unheard += gap;
    active.clock = Math.max(active.clock, event.t);
    if (detector.push(event.t, event.db)) {
      active.lastSpeech = Math.max(active.lastSpeech ?? 0, event.t);
      active.unheard = 0;
    }
    if (
      active.autoStopSeconds &&
      active.lastSpeech != null &&
      !active.stopping &&
      !active.interrupted &&
      active.clock - active.lastSpeech - active.unheard >= active.autoStopSeconds
    ) {
      active.autoStopped = true;
      this.stop(active.id).catch(() => {});
    }
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
