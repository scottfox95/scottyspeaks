const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const debugLogger = require("./debugLogger");
const { resolveBinaryPath, gracefulStopProcess } = require("../utils/serverUtils");
const { getModelsDirForService } = require("./modelDirUtils");
const { getSafeTempDir } = require("./safeTempDir");

// Persistent CoreML/Neural Engine transcription backend.
//
// Runs the same Parakeet TDT 0.6B v3 model as the sherpa-onnx path, but through
// CoreML with the encoder pinned to the ANE. The ANE is a separate compute unit
// from the GPU, so transcription no longer competes with the llama.cpp polish
// model on Metal.
//
// Mirrors the ParakeetWsServer interface so ParakeetServerManager can hold
// either backend interchangeably.

const BINARY_NAME = "parakeet-coreml-darwin-arm64";
const REPO_FOLDER = "parakeet-tdt-0.6b-v3";
const STARTUP_TIMEOUT_MS = 900000; // first run downloads ~470MB of CoreML models
const TRANSCRIPTION_TIMEOUT_MS = 300000;

class ParakeetCoremlServer {
  constructor() {
    this.process = null;
    this.ready = false;
    this.modelName = null;
    this.startupPromise = null;
    this.pending = [];
    this.stdoutBuffer = "";
    this.cachedBinaryPath = null;
  }

  getBinaryPath() {
    if (this.cachedBinaryPath) return this.cachedBinaryPath;
    const resolved = resolveBinaryPath(BINARY_NAME);
    if (resolved) this.cachedBinaryPath = resolved;
    return resolved;
  }

  isAvailable() {
    // The Neural Engine only exists on Apple Silicon.
    if (process.platform !== "darwin" || process.arch !== "arm64") return false;
    return this.getBinaryPath() !== null;
  }

  /// FluidAudio resolves its cache as `dirname(passedPath)/<repoFolderName>`,
  /// so the leaf we pass is discarded. Passing the full final path makes the
  /// location predictable instead of depending on that quirk.
  getModelDir() {
    return path.join(getModelsDirForService("parakeet-coreml"), REPO_FOLDER);
  }

  isModelDownloaded() {
    const dir = this.getModelDir();
    // Preprocessor + encoder + decoder + joint + vocab are what load() requires.
    const required = [
      "Preprocessor.mlmodelc",
      "Encoder.mlmodelc",
      "Decoder.mlmodelc",
      "JointDecisionv3.mlmodelc",
      "parakeet_v3_vocab.json",
    ];
    return required.every((entry) => fs.existsSync(path.join(dir, entry)));
  }

  async start(modelName = REPO_FOLDER) {
    if (this.startupPromise) return this.startupPromise;
    if (this.ready && this.process) return;
    if (this.process) await this.stop();

    this.startupPromise = this._doStart(modelName);
    try {
      await this.startupPromise;
    } finally {
      this.startupPromise = null;
    }
  }

  async _doStart(modelName) {
    const binary = this.getBinaryPath();
    if (!binary) throw new Error("parakeet-coreml binary not found");

    const modelDir = this.getModelDir();
    fs.mkdirSync(path.dirname(modelDir), { recursive: true });

    debugLogger.debug("Starting parakeet-coreml", { binary, modelDir, modelName });

    this.process = spawn(binary, ["--models-dir", modelDir], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: getSafeTempDir(),
    });

    this.modelName = modelName;
    this.stdoutBuffer = "";

    let stderrTail = "";
    let settle = null;
    const readySignal = new Promise((resolve) => {
      settle = resolve;
    });

    this.process.stdout.on("data", (chunk) => this._onStdout(chunk, settle));

    this.process.stderr.on("data", (data) => {
      const text = data.toString();
      stderrTail = (stderrTail + text).slice(-2000);
      debugLogger.debug("parakeet-coreml stderr", { data: text.trim() });
    });

    this.process.on("error", (error) => {
      debugLogger.error("parakeet-coreml process error", { error: error.message });
      this.ready = false;
      settle({ ok: false, reason: error.message });
    });

    this.process.on("close", (code) => {
      debugLogger.debug("parakeet-coreml exited", { code });
      this.ready = false;
      this.process = null;
      this._rejectAllPending(new Error(`parakeet-coreml exited with code ${code}`));
      settle({ ok: false, reason: `exit code ${code}` });
    });

    const timeout = new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`parakeet-coreml failed to start within ${STARTUP_TIMEOUT_MS}ms`)),
        STARTUP_TIMEOUT_MS
      )
    );

    const outcome = await Promise.race([readySignal, timeout]);
    if (!outcome.ok) {
      const detail = stderrTail.trim().slice(-200);
      throw new Error(
        `parakeet-coreml died during startup: ${outcome.reason}${detail ? ` — ${detail}` : ""}`
      );
    }

    this.ready = true;
    debugLogger.info("parakeet-coreml ready", { loadMs: outcome.loadMs, modelDir });
  }

  _onStdout(chunk, settle) {
    this.stdoutBuffer += chunk.toString();

    let index;
    while ((index = this.stdoutBuffer.indexOf("\n")) !== -1) {
      const line = this.stdoutBuffer.slice(0, index).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
      if (!line) continue;

      let message;
      try {
        message = JSON.parse(line);
      } catch {
        debugLogger.warn("parakeet-coreml emitted non-JSON stdout", { line: line.slice(0, 200) });
        continue;
      }

      if (message.type === "ready") {
        settle({ ok: true, loadMs: message.loadMs });
        continue;
      }

      const request = this.pending.shift();
      if (!request) {
        debugLogger.warn("parakeet-coreml response with no pending request", { message });
        continue;
      }

      clearTimeout(request.timer);
      if (message.type === "error") {
        request.reject(new Error(message.message || "parakeet-coreml transcription failed"));
      } else {
        request.resolve({
          text: (message.text || "").trim(),
          elapsed: message.ms || 0,
          confidence: message.confidence,
          rtf: message.rtf,
        });
      }
    }
  }

  _rejectAllPending(error) {
    const pending = this.pending;
    this.pending = [];
    for (const request of pending) {
      clearTimeout(request.timer);
      request.reject(error);
    }
  }

  /// `samplesBuffer` is raw little-endian float32 mono PCM. Unlike the
  /// sherpa-onnx path this needs no manual 15s segmentation — FluidAudio
  /// windows long audio internally and merges on the overlap.
  transcribe(samplesBuffer, sampleRate = 16000, options = {}) {
    if (!this.ready || !this.process) {
      return Promise.reject(new Error("parakeet-coreml server is not running"));
    }
    if (sampleRate !== 16000) {
      return Promise.reject(
        new Error(`parakeet-coreml expects 16kHz audio, received ${sampleRate}Hz`)
      );
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.pending.findIndex((entry) => entry.timer === timer);
        if (index !== -1) this.pending.splice(index, 1);
        reject(new Error("parakeet-coreml transcription timed out"));
      }, TRANSCRIPTION_TIMEOUT_MS);

      this.pending.push({ resolve, reject, timer });

      const meta = Buffer.from(JSON.stringify({ language: options.language || "auto" }), "utf8");
      const header = Buffer.alloc(8);
      header.writeUInt32LE(meta.length, 0);
      header.writeUInt32LE(samplesBuffer.length, 4);

      this.process.stdin.write(Buffer.concat([header, meta, samplesBuffer]), (err) => {
        if (err) {
          clearTimeout(timer);
          const index = this.pending.findIndex((entry) => entry.timer === timer);
          if (index !== -1) this.pending.splice(index, 1);
          reject(new Error(`parakeet-coreml write failed: ${err.message}`));
        }
      });
    });
  }

  async stop() {
    if (!this.process) {
      this.ready = false;
      return;
    }

    debugLogger.debug("Stopping parakeet-coreml");
    this._rejectAllPending(new Error("parakeet-coreml stopped"));

    try {
      this.process.stdin.end();
      await gracefulStopProcess(this.process);
    } catch (error) {
      debugLogger.error("Error stopping parakeet-coreml", { error: error.message });
    }

    this.process = null;
    this.ready = false;
    this.modelName = null;
  }

  getStatus() {
    return {
      available: this.isAvailable(),
      running: this.ready && this.process !== null,
      engine: "coreml",
      modelName: this.modelName,
      modelDir: this.getModelDir(),
      modelDownloaded: this.isModelDownloaded(),
    };
  }
}

module.exports = ParakeetCoremlServer;
