const { spawn } = require("child_process");

// Loudness windows are 0.5s. A fixed dBFS threshold cannot separate speech from
// room noise (a laptop mic's floor can sit near -50 dBFS while quiet remote
// voices peak only ~8 dB above it), so speech is measured against a rolling
// noise floor: the 20th percentile of the last 10 minutes of windows.
const WINDOW_SECONDS = 0.5;
const FLOOR_WINDOWS = 1200;
const MARGIN_DB = 8;
// Digital silence (an idle system-audio track) has no floor; ignore anything
// quieter than this so a notification blip on a dead track is not "speech".
const MIN_SPEECH_DB = -60;
// A single cough or door slam is one loud window. Speech is >=2s of loud
// windows within a 10s span.
const BURST_WINDOWS = 4;
const BURST_SPAN = 20;
// Speech detections closer than this are one continuous stretch of talking.
const SEGMENT_GAP_SECONDS = 60;

class SpeechActivity {
  constructor() {
    this.history = [];
    this.recent = [];
    this.lastSpeech = null;
    this.segments = [];
  }
  floor() {
    if (this.history.length < 20) return null;
    const sorted = [...this.history].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length * 0.2)];
  }
  // Feeds one window ending at `time` seconds. Returns true when speech is
  // detected at that moment.
  push(time, db) {
    if (!Number.isFinite(time) || !Number.isFinite(db)) return false;
    this.history.push(db);
    if (this.history.length > FLOOR_WINDOWS) this.history.shift();
    const floor = this.floor();
    const loud = floor != null && db > MIN_SPEECH_DB && db > floor + MARGIN_DB;
    this.recent.push(loud);
    if (this.recent.length > BURST_SPAN) this.recent.shift();
    if (!loud || this.recent.filter(Boolean).length < BURST_WINDOWS) return false;
    this.lastSpeech = time;
    const last = this.segments[this.segments.length - 1];
    if (last && time - last.end < SEGMENT_GAP_SECONDS) last.end = time;
    else
      this.segments.push({ start: Math.max(0, time - BURST_WINDOWS * WINDOW_SECONDS), end: time });
    return true;
  }
}

// Unions per-track speech segments onto one timeline.
function mergeSegments(segments) {
  const merged = [];
  for (const segment of [...segments].sort((a, b) => a.start - b.start)) {
    const last = merged[merged.length - 1];
    if (last && segment.start - last.end < SEGMENT_GAP_SECONDS)
      last.end = Math.max(last.end, segment.end);
    else merged.push({ ...segment });
  }
  return merged;
}

// Candidate trim points: the end of each stretch of speech followed by at least
// `minQuiet` seconds without speech (or the end of the recording). The first is
// where the conversation most likely ended.
function trimSuggestions(segments, duration, { minQuiet = 120, pad = 5 } = {}) {
  const suggestions = [];
  segments.forEach((segment, index) => {
    const next = segments[index + 1];
    const quiet = (next ? next.start : duration) - segment.end;
    if (quiet >= minQuiet)
      suggestions.push({
        end: Math.min(duration, segment.end + pad),
        quietSeconds: quiet,
        resumesAt: next ? next.start : null,
      });
  });
  return suggestions;
}

function ffmpegPath() {
  return require("ffmpeg-static").replace("app.asar/", "app.asar.unpacked/");
}

// Scans one saved audio file. Times are seconds relative to the file.
function analyzeFile(file, { spawnImpl = spawn, signal } = {}) {
  return new Promise((resolve, reject) => {
    const rate = 8000;
    const perWindow = rate * WINDOW_SECONDS;
    const child = spawnImpl(
      ffmpegPath(),
      ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", file].concat([
        "-vn",
        "-ac",
        "1",
        "-ar",
        String(rate),
        "-f",
        "s16le",
        "-",
      ]),
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    const activity = new SpeechActivity();
    let sum = 0,
      count = 0,
      windows = 0,
      leftover = null,
      stderr = "";
    const abort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => {
      const data = leftover ? Buffer.concat([leftover, chunk]) : chunk;
      const end = data.length - (data.length % 2);
      for (let i = 0; i < end; i += 2) {
        const v = data.readInt16LE(i) / 32768;
        sum += v * v;
        if (++count === perWindow) {
          windows++;
          activity.push(windows * WINDOW_SECONDS, 10 * Math.log10(sum / count + 1e-12));
          sum = 0;
          count = 0;
        }
      }
      leftover = end < data.length ? data.subarray(end) : null;
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 2000) stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) return reject(new Error("Speech analysis cancelled"));
      if (code !== 0) return reject(new Error(stderr.trim() || "Could not analyze the recording"));
      resolve({
        segments: activity.segments,
        duration: (windows * perWindow + count) / rate,
      });
    });
  });
}

module.exports = {
  SpeechActivity,
  analyzeFile,
  mergeSegments,
  trimSuggestions,
  WINDOW_SECONDS,
};
