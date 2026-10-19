const fs = require("fs");
const path = require("path");
const debugLogger = require("./debugLogger");
const { getModelsDirForService } = require("./modelDirUtils");
const {
  getFFmpegPath,
  isWavFormat,
  convertToWav,
  wavToFloat32Samples,
  computeFloat32RMS,
} = require("./ffmpegUtils");
const { getSafeTempDir } = require("./safeTempDir");
const ParakeetWsServer = require("./parakeetWsServer");
const ParakeetCoremlServer = require("./parakeetCoremlServer");

const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 4; // float32
const MAX_SEGMENT_SECONDS = 15;
const MAX_SEGMENT_BYTES = MAX_SEGMENT_SECONDS * SAMPLE_RATE * BYTES_PER_SAMPLE;
const SILENCE_RMS_THRESHOLD = 0.001;

const ENGINE_COREML = "coreml";
const ENGINE_ONNX = "onnx";
// Comfortably covers a healthy CoreML start (~150-220ms) while bailing out of
// a weights download or an ANE recompile.
const COREML_READY_BUDGET_MS = 1500;

class ParakeetServerManager {
  constructor() {
    this.wsServer = new ParakeetWsServer();
    this.coremlServer = new ParakeetCoremlServer();
    this.engine = null; // null = auto-select
    this._coremlProvisioning = null;
  }

  /// Explicit preference wins; otherwise prefer the Neural Engine backend,
  /// which measured ~4x lower transcription latency and a ~15x faster cold
  /// start than the sherpa-onnx CPU path on Apple Silicon.
  getEngine() {
    const preferred = this.engine || process.env.PARAKEET_ENGINE || null;

    if (preferred === ENGINE_ONNX) return ENGINE_ONNX;
    if (preferred === ENGINE_COREML) {
      return this.coremlServer.isAvailable() ? ENGINE_COREML : ENGINE_ONNX;
    }

    return this.coremlServer.isAvailable() ? ENGINE_COREML : ENGINE_ONNX;
  }

  setEngine(engine) {
    if (engine && engine !== ENGINE_COREML && engine !== ENGINE_ONNX) {
      throw new Error(`Unknown parakeet engine: ${engine}`);
    }
    this.engine = engine || null;
  }

  isCoreml() {
    return this.getEngine() === ENGINE_COREML;
  }

  _active() {
    return this.isCoreml() ? this.coremlServer : this.wsServer;
  }

  getBinaryPath() {
    return this.isCoreml() ? this.coremlServer.getBinaryPath() : this.wsServer.getWsBinaryPath();
  }

  isAvailable() {
    return this._active().isAvailable();
  }

  getModelsDir() {
    return getModelsDirForService("parakeet");
  }

  isOnnxModelDownloaded(modelName) {
    const modelDir = path.join(this.getModelsDir(), modelName);
    const requiredFiles = [
      "encoder.int8.onnx",
      "decoder.int8.onnx",
      "joiner.int8.onnx",
      "tokens.txt",
    ];

    if (!fs.existsSync(modelDir)) return false;

    for (const file of requiredFiles) {
      if (!fs.existsSync(path.join(modelDir, file))) {
        return false;
      }
    }

    return true;
  }

  isModelDownloaded(modelName) {
    if (this.isCoreml()) return this.coremlServer.isModelDownloaded();
    return this.isOnnxModelDownloaded(modelName);
  }

  /// True when sherpa-onnx could handle a request right now, making it a
  /// usable stand-in while CoreML is still coming up.
  _onnxCanServe(modelName) {
    return this.wsServer.isAvailable() && this.isOnnxModelDownloaded(modelName);
  }

  /// Kicks off CoreML startup and waits up to COREML_READY_BUDGET_MS for it.
  /// Returns whether it became ready; provisioning continues either way.
  async _awaitCoremlReady(modelName) {
    this.provisionCoreml(modelName);
    const inFlight = this._coremlProvisioning;
    if (!inFlight) return this.coremlServer.ready;

    let timer;
    const budget = new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), COREML_READY_BUDGET_MS);
    });

    try {
      await Promise.race([inFlight, budget]);
    } finally {
      clearTimeout(timer);
    }
    return this.coremlServer.ready;
  }

  /// Starts the CoreML backend in the background (downloading its weights on
  /// first run) without blocking the caller. Idempotent — repeated calls while
  /// a provision is in flight are no-ops.
  provisionCoreml(modelName = "parakeet-tdt-0.6b-v3") {
    if (this._coremlProvisioning || this.coremlServer.ready) return;
    if (!this.coremlServer.isAvailable()) return;

    this._coremlProvisioning = this.coremlServer
      .start(modelName)
      .then(() => {
        debugLogger.info("CoreML backend provisioned and ready for subsequent dictations");
      })
      .catch((error) => {
        debugLogger.warn("CoreML background provisioning failed (staying on sherpa-onnx)", {
          error: error.message,
        });
      })
      .finally(() => {
        this._coremlProvisioning = null;
      });
  }

  /// The CoreML backend fetches its own weights from HuggingFace on first
  /// start, so a missing model directory is not a blocking error there the
  /// way it is for the sherpa-onnx path.
  canTranscribe(modelName) {
    if (this.isCoreml()) return this.coremlServer.isAvailable();
    return this.isModelDownloaded(modelName);
  }

  async _ensureWav(audioBuffer) {
    const isWav = isWavFormat(audioBuffer);
    if (isWav) return { wavBuffer: audioBuffer, filesToCleanup: [] };

    const ffmpegPath = getFFmpegPath();
    if (!ffmpegPath) {
      throw new Error(
        "FFmpeg not found - required for audio conversion. Please ensure FFmpeg is installed."
      );
    }

    const tempDir = getSafeTempDir();
    const timestamp = Date.now();
    const tempInputPath = path.join(tempDir, `parakeet-input-${timestamp}.webm`);
    const tempWavPath = path.join(tempDir, `parakeet-${timestamp}.wav`);

    fs.writeFileSync(tempInputPath, audioBuffer);

    const inputStats = fs.statSync(tempInputPath);
    debugLogger.debug("Converting audio to WAV", { inputSize: inputStats.size });

    await convertToWav(tempInputPath, tempWavPath, { sampleRate: 16000, channels: 1 });

    const wavBuffer = fs.readFileSync(tempWavPath);
    return { wavBuffer, filesToCleanup: [tempInputPath, tempWavPath] };
  }

  /// `wordTimings` requests per-word timestamps, which only the CoreML backend
  /// provides. Such requests (call transcription) are not latency-sensitive, so
  /// they wait for CoreML instead of racing it against sherpa-onnx.
  async transcribe(audioBuffer, options = {}) {
    const { modelName = "parakeet-tdt-0.6b-v3", language = "auto", wordTimings = false } = options;

    const modelDir = path.join(this.getModelsDir(), modelName);

    // Bringing CoreML up is normally ~150-220ms, but it can occasionally cost
    // far more: the first run fetches ~470MB of weights, and macOS periodically
    // evicts the ANE bundle cache, forcing a ~14s recompile. Rather than
    // guessing which case we're in, give it a short budget and fall back to
    // sherpa-onnx for this one dictation if it doesn't come up in time.
    let coreml = this.isCoreml();
    if (coreml && !wordTimings && !this.coremlServer.ready && this._onnxCanServe(modelName)) {
      const startedInTime = await this._awaitCoremlReady(modelName);
      if (!startedInTime) {
        debugLogger.info("CoreML not ready within budget — serving via sherpa-onnx this request", {
          modelName,
          budgetMs: COREML_READY_BUDGET_MS,
        });
        coreml = false;
      }
    }

    if (!this.canTranscribe(modelName)) {
      throw new Error(`Parakeet model "${modelName}" not downloaded`);
    }

    debugLogger.debug("Parakeet transcription request", {
      engine: coreml ? ENGINE_COREML : ENGINE_ONNX,
      modelName,
      language,
      audioSize: audioBuffer?.length || 0,
      isWavFormat: isWavFormat(audioBuffer),
    });

    const { wavBuffer, filesToCleanup } = await this._ensureWav(audioBuffer);
    try {
      if (coreml) {
        if (!this.coremlServer.ready) {
          await this.coremlServer.start(modelName);
        }
      } else if (!this.wsServer.ready || this.wsServer.modelName !== modelName) {
        await this.wsServer.start(modelName, modelDir);
      }

      const samples = wavToFloat32Samples(wavBuffer);
      const durationSeconds = samples.length / BYTES_PER_SAMPLE / SAMPLE_RATE;

      const rms = computeFloat32RMS(samples);
      debugLogger.debug("Parakeet audio analysis", { durationSeconds, rms });
      if (rms < SILENCE_RMS_THRESHOLD) {
        return { text: "", elapsed: 0, language, ...(coreml && wordTimings ? { words: [] } : {}) };
      }

      // FluidAudio windows long audio internally and merges on the overlap,
      // which is strictly better than the hard 15s cuts below.
      if (coreml) {
        const result = await this.coremlServer.transcribe(samples, SAMPLE_RATE, {
          language,
          timings: wordTimings,
        });
        if (!result.text?.trim()) {
          debugLogger.warn("Parakeet (CoreML) returned empty text for non-silent audio", {
            durationSeconds,
            rms,
          });
        }
        return { ...result, language };
      }

      if (samples.length <= MAX_SEGMENT_BYTES) {
        const result = await this.wsServer.transcribe(samples, SAMPLE_RATE);
        if (!result.text?.trim()) {
          debugLogger.warn("Parakeet returned empty text for non-silent audio", {
            durationSeconds,
            rms,
            samplesBytes: samples.length,
          });
        }
        return { ...result, language };
      }

      debugLogger.debug("Parakeet segmenting long audio", {
        durationSeconds,
        segmentCount: Math.ceil(samples.length / MAX_SEGMENT_BYTES),
      });

      const texts = [];
      let totalElapsed = 0;

      for (let offset = 0; offset < samples.length; offset += MAX_SEGMENT_BYTES) {
        const end = Math.min(offset + MAX_SEGMENT_BYTES, samples.length);
        const segment = samples.subarray(offset, end);
        const result = await this.wsServer.transcribe(segment, SAMPLE_RATE);
        totalElapsed += result.elapsed || 0;
        if (result.text) {
          texts.push(result.text);
        } else {
          debugLogger.warn("Parakeet segment returned empty text", {
            segmentIndex: offset / MAX_SEGMENT_BYTES,
            segmentDuration: segment.length / BYTES_PER_SAMPLE / SAMPLE_RATE,
          });
        }
      }

      return { text: texts.join(" "), elapsed: totalElapsed, language };
    } finally {
      this._cleanupFiles(filesToCleanup);
    }
  }

  _cleanupFiles(filePaths) {
    for (const filePath of filePaths) {
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch (err) {
        debugLogger.warn("Failed to cleanup temp audio file", {
          path: filePath,
          error: err.message,
        });
      }
    }
  }

  async startServer(modelName) {
    if (this.isCoreml()) {
      try {
        await this.coremlServer.start(modelName);
        return { success: true, engine: ENGINE_COREML };
      } catch (error) {
        debugLogger.error("Failed to start parakeet CoreML server", { error: error.message });
        return { success: false, reason: error.message };
      }
    }

    if (!this.wsServer.isAvailable()) {
      return { success: false, reason: "parakeet WS server binary not found" };
    }

    const modelDir = path.join(this.getModelsDir(), modelName);
    if (!this.isModelDownloaded(modelName)) {
      return { success: false, reason: `Model "${modelName}" not downloaded` };
    }

    try {
      await this.wsServer.start(modelName, modelDir);
      return { success: true, engine: ENGINE_ONNX, port: this.wsServer.port };
    } catch (error) {
      debugLogger.error("Failed to start parakeet WS server", { error: error.message });
      return { success: false, reason: error.message };
    }
  }

  /// Stops both backends: switching engines at runtime must not leave the
  /// previous one holding its model in memory.
  async stopServer() {
    await Promise.all([this.wsServer.stop(), this.coremlServer.stop()]);
  }

  getServerStatus() {
    return { engine: this.getEngine(), ...this._active().getStatus() };
  }

  getStatus() {
    return {
      available: this.isAvailable(),
      engine: this.getEngine(),
      binaryPath: this.getBinaryPath(),
      modelsDir: this.getModelsDir(),
      coremlAvailable: this.coremlServer.isAvailable(),
    };
  }
}

module.exports = ParakeetServerManager;
