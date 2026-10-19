const { spawn } = require("child_process");
const fs = require("fs");
const debugLogger = require("./debugLogger");
const { resolveBinaryPath } = require("../utils/serverUtils");
const { getModelsDirForService } = require("./modelDirUtils");
const { getSafeTempDir } = require("./safeTempDir");

// One-shot NVIDIA Nemotron 3 speaker diarization on the Neural Engine
// (resources/parakeet-coreml/Sources/call-diarizer). Runs per call rather than
// persistently so the model is only resident while a call is transcribed.
// A 22-minute call diarizes in ~3s; the first run also downloads ~190MB of
// CoreML weights and compiles them (~25s).

const BINARY_NAME = "call-diarizer-darwin-arm64";
const TIMEOUT_MS = 15 * 60 * 1000;

class CallDiarizer {
  constructor() {
    this.cachedBinaryPath = null;
  }

  getBinaryPath() {
    if (this.cachedBinaryPath) return this.cachedBinaryPath;
    const resolved = resolveBinaryPath(BINARY_NAME);
    if (resolved) this.cachedBinaryPath = resolved;
    return resolved;
  }

  isAvailable() {
    if (process.platform !== "darwin" || process.arch !== "arm64") return false;
    return this.getBinaryPath() !== null;
  }

  getModelsDir() {
    return getModelsDirForService("nemotron3-diarization");
  }

  /// Returns `{ probabilities, frames, speakers, frameSeconds }`, where
  /// `probabilities[frame * speakers + speaker]` is that speaker's activity.
  diarize(inputPath, outputPath, { signal } = {}) {
    const binary = this.getBinaryPath();
    if (!binary) return Promise.reject(new Error("call-diarizer binary not found"));
    fs.mkdirSync(this.getModelsDir(), { recursive: true });

    return new Promise((resolve, reject) => {
      const child = spawn(
        binary,
        ["--models-dir", this.getModelsDir(), "--input", inputPath, "--output", outputPath],
        { stdio: ["ignore", "pipe", "pipe"], cwd: getSafeTempDir() }
      );
      let stdout = "";
      let stderrTail = "";
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve(value);
      };
      const abort = () => {
        child.kill("SIGKILL");
        finish(new Error("Diarization cancelled"));
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(new Error(`call-diarizer did not finish within ${TIMEOUT_MS}ms`));
      }, TIMEOUT_MS);
      if (signal?.aborted) return abort();
      signal?.addEventListener("abort", abort, { once: true });

      child.stdout.on("data", (data) => (stdout += data));
      child.stderr.on("data", (data) => {
        const text = data.toString();
        stderrTail = (stderrTail + text).slice(-2000);
        debugLogger.debug("call-diarizer stderr", { data: text.trim() });
      });
      child.on("error", (error) => finish(error));
      child.on("close", (code) => {
        let message = null;
        try {
          message = JSON.parse(stdout.trim().split("\n").pop() || "null");
        } catch {}
        if (code !== 0 || message?.type !== "result") {
          const detail = message?.message || stderrTail.trim().slice(-300) || `exit code ${code}`;
          return finish(new Error(`call-diarizer failed: ${detail}`));
        }
        try {
          const raw = fs.readFileSync(outputPath);
          const probabilities = new Float32Array(
            raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)
          );
          const { frames, speakers } = message;
          if (probabilities.length !== frames * speakers)
            throw new Error(
              `expected ${frames * speakers} probabilities, read ${probabilities.length}`
            );
          debugLogger.info("call-diarizer finished", {
            frames,
            ms: message.ms,
            loadMs: message.loadMs,
          });
          // The helper reports float32 0.01 widened to double.
          const frameSeconds = Math.round(message.frameSeconds * 1e6) / 1e6;
          finish(null, { probabilities, frames, speakers, frameSeconds });
        } catch (error) {
          finish(new Error(`call-diarizer output unreadable: ${error.message}`));
        }
      });
    });
  }
}

module.exports = { CallDiarizer };
