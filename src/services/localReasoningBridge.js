const modelManager = require("../helpers/modelManagerBridge").default;
const debugLogger = require("../helpers/debugLogger");

class LocalReasoningService {
  constructor() {
    this.isProcessing = false;
  }

  async isAvailable() {
    try {
      await modelManager.ensureLlamaCpp();
      const models = await modelManager.getAllModels();
      return models.some((model) => model.isDownloaded);
    } catch {
      return false;
    }
  }

  async processText(text, modelId, config = {}) {
    // Serialize requests instead of throwing "already processing" — rapid
    // back-to-back dictations queue up and each gets its result.
    const run = () => this._processTextNow(text, modelId, config);
    this._queue = (this._queue || Promise.resolve()).then(run, run);
    return this._queue;
  }

  async _processTextNow(text, modelId, config = {}) {
    debugLogger.logReasoning("LOCAL_BRIDGE_START", {
      modelId,
      textLength: text.length,
      hasConfig: Object.keys(config).length > 0,
    });

    this.isProcessing = true;
    const startTime = Date.now();

    try {
      // Qwen3's hybrid models reason before answering, which costs 15-20s per
      // dictation and often eats the whole token budget. "/no_think" is
      // Qwen3's documented switch to disable it. (The 2507 "Instruct" builds
      // are non-thinking already and must NOT get this.)
      const isHybridThinkingModel =
        /^qwen3-/i.test(modelId || "") && !/instruct-2507/i.test(modelId || "");
      let systemPrompt = config.systemPrompt || "";
      if (isHybridThinkingModel && systemPrompt && !systemPrompt.includes("/no_think")) {
        systemPrompt += "\n\n/no_think";
      }

      const inferenceConfig = {
        maxTokens: config.maxTokens || this.calculateMaxTokens(text.length),
        temperature: config.temperature || 0.7,
        topK: config.topK || 40,
        topP: config.topP || 0.9,
        repeatPenalty: config.repeatPenalty || 1.1,
        contextSize: config.contextSize || 4096,
        threads: config.threads || 4,
        systemPrompt,
      };

      debugLogger.logReasoning("LOCAL_BRIDGE_INFERENCE", {
        modelId,
        config: inferenceConfig,
      });

      const result = await modelManager.runInference(modelId, text, inferenceConfig);
      const cleanResult = result
        .replace(/<think>[\s\S]*?<\/think>/g, "")
        .replace(/<think>[\s\S]*$/, "")
        .trim();

      // Hybrid Qwen3 models can spend the whole token budget "thinking",
      // leaving nothing after the <think> block is stripped. Silently
      // returning empty made dictation paste unformatted with no explanation.
      if (!cleanResult && result.includes("<think>")) {
        throw new Error(
          `${modelId} is a thinking model and used its whole budget reasoning. ` +
            `Switch to Qwen3 4B Instruct 2507 in Settings > AI for dictation.`
        );
      }

      const processingTime = Date.now() - startTime;

      debugLogger.logReasoning("LOCAL_BRIDGE_SUCCESS", {
        modelId,
        processingTimeMs: processingTime,
        resultLength: cleanResult.length,
        resultPreview: cleanResult.substring(0, 100) + (cleanResult.length > 100 ? "..." : ""),
      });

      return cleanResult;
    } catch (error) {
      const processingTime = Date.now() - startTime;

      debugLogger.logReasoning("LOCAL_BRIDGE_ERROR", {
        modelId,
        processingTimeMs: processingTime,
        error: error.message,
        stack: error.stack,
      });

      throw error;
    } finally {
      this.isProcessing = false;
    }
  }

  calculateMaxTokens(textLength, minTokens = 512, maxTokens = 2048, multiplier = 2) {
    return Math.max(minTokens, Math.min(textLength * multiplier, maxTokens));
  }
}

module.exports = {
  default: new LocalReasoningService(),
};
