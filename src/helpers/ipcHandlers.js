const { trustedTargetSender } = require("./recordingTargetHandlers");
const { ipcMain, app, shell, BrowserWindow } = require("electron");
const path = require("path");
const { inferenceScheduler } = require("./inferenceScheduler");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const AppUtils = require("../utils");
const debugLogger = require("./debugLogger");
const { i18nMain, changeLanguage } = require("./i18nMain");
const {
  applyDictionaryCorrections,
  applyDictionaryAliases,
  extractAliasCorrections,
  extractCorrections,
  mergeDictionaryCorrections,
  undoDictionaryCorrections,
} = require("../utils/correctionLearner");
const { normalizeSpokenForm } = require("../utils/spokenFormatting");
const { fixQuestionPunctuation } = require("../utils/questionPunctuation");

const CLOUD_REASONING_PROVIDERS = ["openai", "anthropic", "gemini", "groq", "custom"];
const isCloudReasoningProvider = (provider) => CLOUD_REASONING_PROVIDERS.includes(provider);

const MISTRAL_TRANSCRIPTION_URL = "https://api.mistral.ai/v1/audio/transcriptions";

// Debounce delay: wait for user to stop typing before processing corrections
const AUTO_LEARN_DEBOUNCE_MS = 1500;

const AUDIO_MIME_TYPES = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  webm: "audio/webm",
  ogg: "audio/ogg",
  flac: "audio/flac",
  aac: "audio/aac",
};

function buildMultipartBody(fileBuffer, fileName, contentType, fields = {}) {
  const boundary = `----OpenWhispr${Date.now()}`;
  const parts = [];

  parts.push(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`
  );
  parts.push(fileBuffer);
  parts.push("\r\n");

  for (const [name, value] of Object.entries(fields)) {
    if (value != null) {
      parts.push(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
          `${value}\r\n`
      );
    }
  }

  parts.push(`--${boundary}--\r\n`);

  const bodyParts = parts.map((p) => (typeof p === "string" ? Buffer.from(p) : p));
  return { body: Buffer.concat(bodyParts), boundary };
}

function postMultipart(url, body, boundary, headers = {}) {
  const httpModule = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = httpModule.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": body.length,
          ...headers,
        },
      },
      (res) => {
        let responseData = "";
        res.on("data", (chunk) => (responseData += chunk));
        res.on("end", () => {
          try {
            resolve({ statusCode: res.statusCode, data: JSON.parse(responseData) });
          } catch (e) {
            reject(new Error(`Invalid JSON response: ${responseData.slice(0, 200)}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

class IPCHandlers {
  constructor(managers) {
    this.environmentManager = managers.environmentManager;
    this.databaseManager = managers.databaseManager;
    this.clipboardManager = managers.clipboardManager;
    this.whisperManager = managers.whisperManager;
    this.parakeetManager = managers.parakeetManager;
    this.windowManager = managers.windowManager;
    this.updateManager = managers.updateManager;
    this.textEditMonitor = managers.textEditMonitor;
    this.getTrayManager = managers.getTrayManager;
    this.getPedalManager = managers.getPedalManager;
    this.sessionId = crypto.randomUUID();
    this._autoLearnEnabled = true; // Default on, synced from renderer
    this._autoLearnDebounceTimer = null;
    this._autoLearnStartTimer = null;
    this._autoLearnLatestData = null;
    this._autoLearnUndoEntries = new Map();
    this._textEditHandler = null;
    this._setupTextEditMonitor();
    this.setupHandlers();
  }

  _getDictionarySafe() {
    try {
      return this.databaseManager.getDictionary();
    } catch {
      return [];
    }
  }

  _getAliasesSafe() {
    try {
      return this.databaseManager.getDictionaryAliases();
    } catch {
      return [];
    }
  }

  /** Rewrites known mishearings ("a rather" → Aravo) in recognizer output. */
  _applyAliases(text) {
    if (typeof text !== "string" || !text) return text;
    try {
      return applyDictionaryAliases(text, this._getAliasesSafe());
    } catch {
      return text;
    }
  }

  /** Spoken numbers and symbols → digits and "/" ("six oh six" → 606). Never blocks a paste. */
  _normalizeSpokenForm(text) {
    try {
      // Questions the recognizer ended with "." get their "?" back here, after
      // polish, so every engine and the short no-polish path are covered.
      return fixQuestionPunctuation(normalizeSpokenForm(text));
    } catch (error) {
      debugLogger.debug("[SpokenForm] Normalization failed", { error: error.message });
      return text;
    }
  }

  /**
   * Learns "sounds like" aliases from an edit: spans the user replaced with a
   * dictionary word become substitutions for future dictations.
   */
  _learnAliases(originalText, editedText, source, dictionary = this._getDictionarySafe()) {
    try {
      const found = extractAliasCorrections(originalText, editedText, dictionary, this._getAliasesSafe());
      if (found.length === 0) return [];
      let aliases = null;
      for (const { word, alias } of found)
        aliases = this.databaseManager.addDictionaryAliases(word, [alias], source);
      if (aliases) this.broadcastToWindows("dictionary-aliases-updated", aliases);
      debugLogger.debug("[AutoLearn] Learned sounds-like aliases", { source, found });
      return found;
    } catch (error) {
      debugLogger.debug("[AutoLearn] Alias learning failed", { error: error.message });
      return [];
    }
  }

  _cleanupTextEditMonitor() {
    if (this._autoLearnStartTimer) clearTimeout(this._autoLearnStartTimer);
    this._autoLearnStartTimer = null;
    if (this._autoLearnDebounceTimer) {
      clearTimeout(this._autoLearnDebounceTimer);
      this._autoLearnDebounceTimer = null;
    }
    this._autoLearnLatestData = null;
    if (this.textEditMonitor && this._textEditHandler) {
      this.textEditMonitor.removeListener("text-edited", this._textEditHandler);
      this._textEditHandler = null;
    }
  }

  _setupTextEditMonitor() {
    if (!this.textEditMonitor) return;

    this._textEditHandler = (data) => {
      if (!this._autoLearnEnabled) return;
      if (
        !data ||
        typeof data.originalText !== "string" ||
        typeof data.newFieldValue !== "string"
      ) {
        debugLogger.debug("[AutoLearn] Invalid event payload, skipping");
        return;
      }

      const { originalText, newFieldValue } = data;

      debugLogger.debug("[AutoLearn] text-edited event", {
        originalLength: originalText.length,
        newValueLength: newFieldValue.length,
      });

      this._autoLearnLatestData = { originalText, newFieldValue };

      if (this._autoLearnDebounceTimer) {
        clearTimeout(this._autoLearnDebounceTimer);
      }

      this._autoLearnDebounceTimer = setTimeout(() => {
        this._processCorrections();
      }, AUTO_LEARN_DEBOUNCE_MS);
    };

    this.textEditMonitor.on("text-edited", this._textEditHandler);
  }

  _processCorrections() {
    this._autoLearnDebounceTimer = null;
    if (!this._autoLearnLatestData) return;
    if (!this._autoLearnEnabled) {
      debugLogger.debug("[AutoLearn] Disabled, skipping correction processing");
      this._autoLearnLatestData = null;
      return;
    }

    const { originalText, newFieldValue } = this._autoLearnLatestData;
    this._autoLearnLatestData = null;

    try {
      const currentDict = this._getDictionarySafe();
      const corrections = extractCorrections(originalText, newFieldValue, currentDict);
      debugLogger.debug("[AutoLearn] Corrections result", {
        corrections,
        dictSize: currentDict.length,
      });

      let dictionaryForAliases = currentDict;
      if (corrections.length > 0) {
        const merged = mergeDictionaryCorrections(currentDict, corrections);
        if (merged.learned.length === 0) return;
        const updatedDict = merged.dictionary;
        const saveResult = this.databaseManager.setDictionary(updatedDict);

        if (saveResult?.success === false) {
          debugLogger.debug("[AutoLearn] Failed to save dictionary", { error: saveResult.error });
          return;
        }
        dictionaryForAliases = updatedDict;

        this.broadcastToWindows("dictionary-updated", updatedDict);
        for (const entry of merged.undoEntries) {
          this._autoLearnUndoEntries.set(entry.word, entry);
        }

        // Show the overlay so the toast is visible (it may have been hidden after dictation)
        this.windowManager.showDictationPanel();
        this.broadcastToWindows("corrections-learned", merged.learned);
        debugLogger.debug("[AutoLearn] Saved corrections", { corrections: merged.learned });
      }
      // Multi-word mishearings ("a rather" → Aravo) are not single-word
      // corrections; learn them as sounds-like aliases of dictionary words.
      this._learnAliases(originalText, newFieldValue, "auto-learn", dictionaryForAliases);
    } catch (error) {
      debugLogger.debug("[AutoLearn] Error processing corrections", { error: error.message });
    }
  }

  _syncStartupEnv(setVars, clearVars = []) {
    let changed = false;
    for (const [key, value] of Object.entries(setVars)) {
      if (process.env[key] !== value) {
        process.env[key] = value;
        changed = true;
      }
    }
    for (const key of clearVars) {
      if (process.env[key]) {
        delete process.env[key];
        changed = true;
      }
    }
    if (changed) {
      debugLogger.debug("Synced startup env vars", {
        set: Object.keys(setVars),
        cleared: clearVars.filter((k) => !process.env[k]),
      });
      this.environmentManager.saveAllKeysToEnvFile().catch(() => {});
    }
  }

  setupHandlers() {
    ipcMain.handle("window-minimize", () => {
      if (this.windowManager.controlPanelWindow) {
        this.windowManager.controlPanelWindow.minimize();
      }
    });

    ipcMain.handle("window-maximize", () => {
      if (this.windowManager.controlPanelWindow) {
        if (this.windowManager.controlPanelWindow.isMaximized()) {
          this.windowManager.controlPanelWindow.unmaximize();
        } else {
          this.windowManager.controlPanelWindow.maximize();
        }
      }
    });

    ipcMain.handle("window-close", () => {
      if (this.windowManager.controlPanelWindow) {
        this.windowManager.controlPanelWindow.close();
      }
    });

    ipcMain.handle("window-is-maximized", () => {
      if (this.windowManager.controlPanelWindow) {
        return this.windowManager.controlPanelWindow.isMaximized();
      }
      return false;
    });

    ipcMain.handle("app-quit", () => {
      app.quit();
    });

    ipcMain.handle("hide-window", () => {
      if (process.platform === "darwin") {
        this.windowManager.hideDictationPanel();
        if (app.dock) app.dock.show();
      } else {
        this.windowManager.hideDictationPanel();
      }
    });

    // Reservations are renderer-owned, token-scoped and released on navigation/crash.
    const reservations = new Map();
    const assertInferenceSender = (event) => {
      if (
        ![
          this.windowManager?.mainWindow?.webContents,
          this.windowManager?.controlPanelWindow?.webContents,
        ].includes(event.sender) ||
        !event.sender
      ) {
        throw new Error("Invalid local inference sender");
      }
    };
    ipcMain.handle("local-inference-reserve", (event) => {
      assertInferenceSender(event);
      let owned = reservations.get(event.sender);
      if (!owned) {
        owned = { tokens: new Map() };
        const cleanup = () => {
          for (const release of owned.tokens.values()) release();
          owned.tokens.clear();
          reservations.delete(event.sender);
          event.sender.removeListener("destroyed", cleanup);
          event.sender.removeListener("render-process-gone", cleanup);
          event.sender.removeListener("did-start-navigation", navigate);
        };
        const navigate = (_event, _url, _inPlace, isMainFrame) => {
          if (isMainFrame) cleanup();
        };
        owned.cleanup = cleanup;
        reservations.set(event.sender, owned);
        event.sender.once("destroyed", cleanup);
        event.sender.once("render-process-gone", cleanup);
        event.sender.on("did-start-navigation", navigate);
      }
      const token = crypto.randomUUID();
      owned.tokens.set(token, inferenceScheduler.reserveForeground());
      return token;
    });
    ipcMain.handle("local-inference-release", (event, token) => {
      assertInferenceSender(event);
      const owned = reservations.get(event.sender);
      const release = owned?.tokens.get(token);
      if (release) {
        release();
        owned.tokens.delete(token);
        if (!owned.tokens.size) owned.cleanup();
      }
    });

    ipcMain.handle("show-dictation-panel", () => {
      this.windowManager.showDictationPanel();
    });

    ipcMain.handle("force-stop-dictation", () => {
      if (this.windowManager?.forceStopMacCompoundPush) {
        this.windowManager.forceStopMacCompoundPush("manual");
      }
      return { success: true };
    });

    ipcMain.handle("set-main-window-interactivity", (event, shouldCapture) => {
      this.windowManager.setMainWindowInteractivity(Boolean(shouldCapture));
      return { success: true };
    });

    ipcMain.handle("resize-main-window", (event, sizeKey) => {
      return this.windowManager.resizeMainWindow(sizeKey);
    });

    ipcMain.handle("get-openai-key", async (event) => {
      return this.environmentManager.getOpenAIKey();
    });

    ipcMain.handle("save-openai-key", async (event, key) => {
      return this.environmentManager.saveOpenAIKey(key);
    });

    ipcMain.handle("db-save-transcription", async (event, text, rawText) => {
      const result = this.databaseManager.saveTranscription(text, rawText);
      if (result?.success && result?.transcription) {
        setImmediate(() => {
          this.broadcastToWindows("transcription-added", result.transcription);
        });
      }
      return result;
    });

    ipcMain.handle("db-update-transcription", async (event, id, text) => {
      let previous = null;
      try {
        previous = this.databaseManager.getTranscription(id);
      } catch {}
      const result = this.databaseManager.updateTranscription(id, text);
      if (result?.success && result?.transcription) {
        // A History edit that swaps a mishearing for a dictionary word teaches
        // the substitution for every future dictation.
        if (previous && typeof text === "string")
          this._learnAliases(previous.raw_text || previous.text, text, "history-edit");
        setImmediate(() => {
          this.broadcastToWindows("transcription-updated", result.transcription);
        });
      }
      return result;
    });

    ipcMain.handle("db-get-transcriptions", async (event, limit = 50) => {
      return this.databaseManager.getTranscriptions(limit);
    });

    ipcMain.handle("db-query-transcriptions", async (event, options) => {
      return this.databaseManager.queryTranscriptions(options);
    });

    ipcMain.handle("db-clear-transcriptions", async (event) => {
      const result = this.databaseManager.clearTranscriptions();
      if (result?.success) {
        this.databaseManager.captureStore?.clearHistoryCaptures();
        setImmediate(() => {
          this.broadcastToWindows("transcriptions-cleared", {
            cleared: result.cleared,
          });
        });
      }
      return result;
    });

    ipcMain.handle("db-delete-transcription", async (event, id) => {
      const result = this.databaseManager.deleteTranscription(id);
      if (result?.success) {
        this.databaseManager.captureStore?.deleteForHistory(id);
        setImmediate(() => {
          this.broadcastToWindows("transcription-deleted", { id });
        });
      }
      return result;
    });

    // Dictionary handlers
    ipcMain.on("auto-learn-changed", (_event, enabled) => {
      this._autoLearnEnabled = !!enabled;
      if (!this._autoLearnEnabled) {
        if (this._autoLearnStartTimer) clearTimeout(this._autoLearnStartTimer);
        this._autoLearnStartTimer = null;
        this.textEditMonitor?.stopMonitoring?.();
        if (this._autoLearnDebounceTimer) {
          clearTimeout(this._autoLearnDebounceTimer);
          this._autoLearnDebounceTimer = null;
        }
        this._autoLearnLatestData = null;
      }
      debugLogger.debug("[AutoLearn] Setting changed", { enabled: this._autoLearnEnabled });
    });

    ipcMain.handle("db-get-dictionary", async () => {
      return this.databaseManager.getDictionary();
    });

    ipcMain.handle("db-set-dictionary", async (event, words) => {
      if (!Array.isArray(words)) {
        throw new Error("words must be an array");
      }
      const result = this.databaseManager.setDictionary(words);
      // Removing a word drops its aliases; let open views refresh.
      this.broadcastToWindows("dictionary-aliases-updated", this._getAliasesSafe());
      return result;
    });

    ipcMain.handle("db-get-dictionary-aliases", async () => {
      return this.databaseManager.getDictionaryAliases();
    });

    ipcMain.handle("db-set-word-aliases", async (event, word, aliases) => {
      if (typeof word !== "string" || !Array.isArray(aliases) || aliases.length > 50) {
        throw new Error("Invalid alias update");
      }
      const list = this.databaseManager.setWordAliases(word, aliases, "manual");
      this.broadcastToWindows("dictionary-aliases-updated", list);
      return list;
    });

    ipcMain.handle("db-remove-dictionary-alias", async (event, alias) => {
      if (typeof alias !== "string") throw new Error("Invalid alias");
      const list = this.databaseManager.removeDictionaryAlias(alias);
      this.broadcastToWindows("dictionary-aliases-updated", list);
      return list;
    });

    ipcMain.handle("undo-learned-corrections", async (_event, words) => {
      try {
        if (!Array.isArray(words) || words.length === 0) {
          return { success: false };
        }
        const validWords = words.filter((w) => typeof w === "string" && w.trim().length > 0);
        if (validWords.length === 0) {
          return { success: false };
        }
        const currentDict = this._getDictionarySafe();
        const undoEntries = validWords.map(
          (word) =>
            this._autoLearnUndoEntries.get(word) || {
              word,
              previous: [],
              index: currentDict.length,
            }
        );
        const updatedDict = undoDictionaryCorrections(currentDict, undoEntries);
        const saveResult = this.databaseManager.setDictionary(updatedDict);
        if (saveResult?.success === false) {
          debugLogger.debug("[AutoLearn] Undo failed to save dictionary", {
            error: saveResult.error,
          });
          return { success: false };
        }
        for (const word of validWords) this._autoLearnUndoEntries.delete(word);
        this.broadcastToWindows("dictionary-updated", updatedDict);
        debugLogger.debug("[AutoLearn] Undo: removed words", { words: validWords });
        return { success: true };
      } catch (err) {
        debugLogger.debug("[AutoLearn] Undo failed", { error: err.message });
        return { success: false };
      }
    });

    ipcMain.handle(
      "db-save-note",
      async (event, title, content, noteType, sourceFile, audioDuration, folderId) => {
        const result = this.databaseManager.saveNote(
          title,
          content,
          noteType,
          sourceFile,
          audioDuration,
          folderId
        );
        if (result?.success && result?.note) {
          setImmediate(() => {
            this.broadcastToWindows("note-added", result.note);
          });
        }
        return result;
      }
    );

    ipcMain.handle("db-get-notes", async (event, noteType, limit, folderId) => {
      return this.databaseManager.getNotes(noteType, limit, folderId);
    });

    ipcMain.handle("db-update-note", async (event, id, updates) => {
      const result = this.databaseManager.updateNote(id, updates);
      if (result?.success && result?.note) {
        setImmediate(() => {
          this.broadcastToWindows("note-updated", result.note);
        });
      }
      return result;
    });

    ipcMain.handle("db-delete-note", async (event, id) => {
      const result = this.databaseManager.deleteNote(id);
      if (result?.success) {
        setImmediate(() => {
          this.broadcastToWindows("note-deleted", { id });
        });
      }
      return result;
    });

    ipcMain.handle("db-get-folders", async () => {
      return this.databaseManager.getFolders();
    });

    ipcMain.handle("db-create-folder", async (event, name) => {
      const result = this.databaseManager.createFolder(name);
      if (result?.success && result?.folder) {
        setImmediate(() => {
          this.broadcastToWindows("folder-created", result.folder);
        });
      }
      return result;
    });

    ipcMain.handle("db-delete-folder", async (event, id) => {
      const result = this.databaseManager.deleteFolder(id);
      if (result?.success) {
        setImmediate(() => {
          this.broadcastToWindows("folder-deleted", { id });
        });
      }
      return result;
    });

    ipcMain.handle("db-rename-folder", async (event, id, name) => {
      const result = this.databaseManager.renameFolder(id, name);
      if (result?.success && result?.folder) {
        setImmediate(() => {
          this.broadcastToWindows("folder-renamed", result.folder);
        });
      }
      return result;
    });

    ipcMain.handle("db-get-folder-note-counts", async () => {
      return this.databaseManager.getFolderNoteCounts();
    });

    ipcMain.handle("db-get-actions", async () => {
      return this.databaseManager.getActions();
    });

    ipcMain.handle("db-create-action", async (event, name, description, prompt, icon) => {
      const result = this.databaseManager.createAction(name, description, prompt, icon);
      if (result?.success && result?.action) {
        setImmediate(() => {
          this.broadcastToWindows("action-created", result.action);
        });
      }
      return result;
    });

    ipcMain.handle("db-update-action", async (event, id, updates) => {
      const result = this.databaseManager.updateAction(id, updates);
      if (result?.success && result?.action) {
        setImmediate(() => {
          this.broadcastToWindows("action-updated", result.action);
        });
      }
      return result;
    });

    ipcMain.handle("db-delete-action", async (event, id) => {
      const result = this.databaseManager.deleteAction(id);
      if (result?.success) {
        setImmediate(() => {
          this.broadcastToWindows("action-deleted", { id });
        });
      }
      return result;
    });

    // === Usage Stats ===
    ipcMain.handle("db-record-usage", async (event, wordCount, durationSeconds) => {
      return this.databaseManager.recordUsage(wordCount, durationSeconds);
    });

    ipcMain.handle("db-get-usage-stats", async () => {
      return this.databaseManager.getUsageStats();
    });

    // === Snippets ===
    ipcMain.handle("db-get-snippets", async () => {
      return this.databaseManager.getSnippets();
    });

    ipcMain.handle("db-create-snippet", async (event, keyword, expansion) => {
      return this.databaseManager.createSnippet(keyword, expansion);
    });

    ipcMain.handle("db-update-snippet", async (event, id, updates) => {
      return this.databaseManager.updateSnippet(id, updates);
    });

    ipcMain.handle("db-delete-snippet", async (event, id) => {
      return this.databaseManager.deleteSnippet(id);
    });

    ipcMain.handle("db-find-snippet", async (event, text) => {
      return this.databaseManager.findSnippet(text);
    });

    // Style profile handlers
    // --- Stream Deck Pedal ---
    ipcMain.handle("pedal-get-status", async () => {
      const pedal = this.getPedalManager?.();
      return pedal ? pedal.getStatus() : { supported: false, connected: false };
    });

    ipcMain.handle("pedal-set-config", async (event, partial) => {
      const pedal = this.getPedalManager?.();
      return pedal ? pedal.setConfig(partial) : { supported: false, connected: false };
    });

    ipcMain.handle("pedal-quit-blocking-app", async () => {
      const pedal = this.getPedalManager?.();
      return pedal ? pedal.quitBlockingApp() : { success: false, error: "no-pedal-manager" };
    });

    // Copies the current selection in the frontmost app (for voice commands)
    ipcMain.handle("capture-selected-text", async (event, token) => {
      if (!trustedTargetSender(event, this.windowManager)) return { text: null, error: "untrusted-sender" };
      try {
        return await this.clipboardManager.captureSelection(token, event.sender.id);
      } catch (error) {
        return { text: null, error: error.message };
      }
    });

    // Self-diagnostics: everything needed to explain "why is it slow / why
    // isn't it formatting" without shipping a script to the machine.
    ipcMain.handle("run-diagnostics", async () => {
      const { spawnSync } = require("child_process");
      const fsx = require("fs");
      const osx = require("os");
      const pathx = require("path");
      const out = { generatedAt: new Date().toISOString() };

      const sh = (cmd, args) => {
        try {
          return spawnSync(cmd, args, { encoding: "utf8", timeout: 4000 }).stdout?.trim() || "";
        } catch {
          return "";
        }
      };

      // Hardware + power (throttling is the usual cause of "slow on a better Mac")
      out.chip = sh("sysctl", ["-n", "machdep.cpu.brand_string"]);
      out.memoryGB = Math.round(Number(sh("sysctl", ["-n", "hw.memsize"]) || 0) / 1073741824);
      const pm = sh("pmset", ["-g"]);
      out.lowPowerMode = /lowpowermode\s+1/i.test(pm);
      out.onBattery = !/AC Power/.test(sh("pmset", ["-g", "ps"]));
      const thermal = sh("pmset", ["-g", "therm"]);
      out.cpuSpeedLimit = Number((thermal.match(/CPU_Speed_Limit\s+=\s+(\d+)/) || [])[1] || 100);

      // Which engine processes are alive
      const ps = sh("ps", ["ax", "-o", "command"]);
      out.llamaRunning = ps.includes("llama-server");
      out.parakeetRunning = ps.includes("sherpa-onnx");

      // Models actually on disk
      const cacheDir = pathx.join(osx.homedir(), ".cache", "scottyspeaks");
      const sizeOf = (dir) => {
        let total = 0;
        const walk = (d) => {
          let entries = [];
          try {
            entries = fsx.readdirSync(d, { withFileTypes: true });
          } catch {
            return;
          }
          for (const e of entries) {
            const p = pathx.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else {
              try {
                total += fsx.statSync(p).size;
              } catch {}
            }
          }
        };
        walk(dir);
        return total;
      };
      out.models = {};
      for (const sub of ["models", "parakeet-models", "whisper-models"]) {
        const p = pathx.join(cacheDir, sub);
        out.models[sub] = fsx.existsSync(p)
          ? { files: fsx.readdirSync(p), bytes: sizeOf(p) }
          : null;
      }

      // Did polish actually run recently? The decisive signal.
      try {
        const rows = this.databaseManager.db
          .prepare("SELECT raw_text FROM transcriptions ORDER BY id DESC LIMIT 20")
          .all();
        out.recentCount = rows.length;
        out.recentPolished = rows.filter((r) => r.raw_text).length;
      } catch (e) {
        out.recentCount = null;
        out.recentPolished = null;
      }

      // Time a real inference against the local model server
      try {
        const modelManager = require("./modelManagerBridge").default;
        const port = modelManager.serverManager?.port;
        out.llamaPort = port || null;
        if (port) {
          const started = Date.now();
          const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              messages: [
                { role: "system", content: "Rewrite as clean text. Output only the text." },
                {
                  role: "user",
                  content: "so um i think we should ship it today and follow up tomorrow",
                },
              ],
              max_tokens: 128,
              temperature: 0.2,
              stream: false,
            }),
          });
          const json = await res.json();
          out.polishMs = Date.now() - started;
          out.polishSample = json?.choices?.[0]?.message?.content?.trim()?.slice(0, 120) || null;
        }
      } catch (e) {
        out.polishError = e.message;
      }

      return out;
    });

    // Frontmost app name — gives the polish pass app-aware tone context
    ipcMain.handle("get-frontmost-app", async () => {
      if (process.platform !== "darwin") return { name: null };
      return new Promise((resolve) => {
        const { spawn } = require("child_process");
        const proc = spawn("osascript", [
          "-e",
          'tell application "System Events" to get name of first application process whose frontmost is true',
        ]);
        let out = "";
        const timeoutId = setTimeout(() => {
          proc.kill("SIGKILL");
          resolve({ name: null });
        }, 1500);
        proc.stdout.on("data", (d) => (out += d.toString()));
        proc.on("close", () => {
          clearTimeout(timeoutId);
          const name = out.trim();
          // Our own overlay may be frontmost at record start; that's useless context
          resolve({ name: name && name !== "ScottySpeaks" && name !== "Electron" ? name : null });
        });
        proc.on("error", () => {
          clearTimeout(timeoutId);
          resolve({ name: null });
        });
      });
    });

    ipcMain.handle("db-get-style-profiles", async () => {
      return this.databaseManager.getStyleProfiles();
    });

    ipcMain.handle("db-get-style-examples", async (event, limit) => {
      return this.databaseManager.getStyleExamples(limit);
    });

    ipcMain.handle("db-add-style-example", async (event, beforeText, afterText, source) => {
      return this.databaseManager.addStyleExample(beforeText, afterText, source);
    });

    ipcMain.handle("db-get-active-style-profile", async () => {
      return this.databaseManager.getActiveStyleProfile();
    });

    ipcMain.handle("db-set-active-style-profile", async (event, id) => {
      return this.databaseManager.setActiveStyleProfile(id);
    });

    ipcMain.handle("db-create-style-profile", async (event, name, rules) => {
      return this.databaseManager.createStyleProfile(name, rules);
    });

    ipcMain.handle("db-update-style-profile", async (event, id, updates) => {
      return this.databaseManager.updateStyleProfile(id, updates);
    });

    ipcMain.handle("db-delete-style-profile", async (event, id) => {
      return this.databaseManager.deleteStyleProfile(id);
    });

    ipcMain.handle("export-note", async (event, noteId, format) => {
      try {
        const note = this.databaseManager.getNote(noteId);
        if (!note) return { success: false, error: "Note not found" };

        const { dialog } = require("electron");
        const fs = require("fs");
        const ext = format === "txt" ? "txt" : "md";
        const safeName = (note.title || "Untitled").replace(/[/\\?%*:|"<>]/g, "-");

        const result = await dialog.showSaveDialog({
          defaultPath: `${safeName}.${ext}`,
          filters: [
            { name: "Markdown", extensions: ["md"] },
            { name: "Text", extensions: ["txt"] },
          ],
        });

        if (result.canceled || !result.filePath) return { success: false };

        let exportContent;
        if (format === "txt") {
          exportContent = (note.content || "")
            .replace(/#{1,6}\s+/g, "")
            .replace(/[*_~`]+/g, "")
            .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
            .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
            .replace(/^>\s+/gm, "")
            .trim();
        } else {
          exportContent = note.enhanced_content || note.content;
        }

        fs.writeFileSync(result.filePath, exportContent, "utf-8");
        return { success: true };
      } catch (error) {
        debugLogger.error("Error exporting note", { error: error.message }, "notes");
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("paste-text", async (event, text, options = {}) => {
      if (!trustedTargetSender(event, this.windowManager) || typeof text !== "string" || Buffer.byteLength(text) > 200000)
        return { success: false, manualCopy: true, reason: "invalid-request" };
      // If the floating dictation panel currently has focus, dismiss it so the
      // paste keystroke lands in the user's target app instead of the overlay.
      // macOS pastes into the recorded target through the AX helper instead.
      const mainWindow = this.windowManager?.mainWindow;
      if (process.platform !== "darwin" && mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()) {
        mainWindow.blur();
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      const canonicalText = options?.exact
        ? text
        : this._normalizeSpokenForm(applyDictionaryCorrections(this._applyAliases(text), this._getDictionarySafe()));
      const result = await this.clipboardManager.pasteText(canonicalText, {
        ...options,
        webContents: event.sender,
      });
      const targetPid = result?.pid || this.textEditMonitor?.lastTargetPid || null;
      debugLogger.debug("[AutoLearn] Paste completed", {
        autoLearnEnabled: this._autoLearnEnabled,
        hasMonitor: !!this.textEditMonitor,
        targetPid,
      });
      if (result?.success !== false && this.textEditMonitor && this._autoLearnEnabled) {
        if (this._autoLearnStartTimer) clearTimeout(this._autoLearnStartTimer);
        this._autoLearnStartTimer = setTimeout(() => {
          this._autoLearnStartTimer = null;
          if (!this._autoLearnEnabled) return;
          try {
            debugLogger.debug("[AutoLearn] Starting monitoring", {
              textLength: canonicalText.length,
            });
            this.textEditMonitor.startMonitoring(canonicalText, 30000, { targetPid });
          } catch (err) {
            debugLogger.debug("[AutoLearn] Failed to start monitoring", { error: err.message });
          }
        }, 500);
      }
      return { ...(result || {}), text: canonicalText };
    });

    // Voice command with nothing selected: replace our own previous paste
    // when it's verifiably still there, otherwise append.
    ipcMain.handle("replace-last-paste", async (event, newText, expectedText, options = {}) => {
      if (!trustedTargetSender(event, this.windowManager) || typeof newText !== "string" || typeof expectedText !== "string" || Buffer.byteLength(newText) > 200000 || Buffer.byteLength(expectedText) > 200000)
        return { success: false, replaced: false, manualCopy: true, reason: "invalid-request" };
      const mainWindow = this.windowManager?.mainWindow;
      if (process.platform !== "darwin" && mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()) {
        mainWindow.blur();
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      return this.clipboardManager.replaceLastPaste(newText, expectedText, {
        ...options,
        webContents: event.sender,
      });
    });

    ipcMain.handle("check-accessibility-permission", async () => {
      return this.clipboardManager.checkAccessibilityPermissions();
    });

    ipcMain.handle("read-clipboard", async (event) => {
      return this.clipboardManager.readClipboard();
    });

    ipcMain.handle("write-clipboard", async (event, text) => {
      return this.clipboardManager.writeClipboard(text, event.sender);
    });

    ipcMain.handle("check-paste-tools", async () => {
      return this.clipboardManager.checkPasteTools();
    });

    ipcMain.handle("transcribe-local-whisper", async (event, audioBlob, options = {}) => {
      debugLogger.log("transcribe-local-whisper called", {
        audioBlobType: typeof audioBlob,
        audioBlobSize: audioBlob?.byteLength || audioBlob?.length || 0,
        options,
      });

      try {
        const result = await inferenceScheduler.run(
          () => {
            if (typeof options.requestId === "string" && options.requestId.length < 100 && !event.sender.isDestroyed?.())
              event.sender.send("local-transcription-started", { requestId: options.requestId });
            return this.whisperManager.transcribeLocalWhisper(audioBlob, options);
          },
          { priority: "foreground" }
        );

        debugLogger.log("Whisper result", {
          success: result.success,
          hasText: !!result.text,
          message: result.message,
          error: result.error,
        });
        if (result?.success && result.text && !options.skipAliases)
          result.text = this._applyAliases(result.text);

        // Check if no audio was detected and send appropriate event
        if (!result.success && result.message === "No audio detected") {
          debugLogger.log("Sending no-audio-detected event to renderer");
          event.sender.send("no-audio-detected");
        }

        return result;
      } catch (error) {
        debugLogger.error("Local Whisper transcription error", error);
        const errorMessage = error.message || "Unknown error";

        // Return specific error types for better user feedback
        if (errorMessage.includes("FFmpeg not found")) {
          return {
            success: false,
            error: "ffmpeg_not_found",
            message: "FFmpeg is missing. Please reinstall the app or install FFmpeg manually.",
          };
        }
        if (
          errorMessage.includes("FFmpeg conversion failed") ||
          errorMessage.includes("FFmpeg process error")
        ) {
          return {
            success: false,
            error: "ffmpeg_error",
            message: "Audio conversion failed. The recording may be corrupted.",
          };
        }
        if (
          errorMessage.includes("whisper.cpp not found") ||
          errorMessage.includes("whisper-cpp")
        ) {
          return {
            success: false,
            error: "whisper_not_found",
            message: "Whisper binary is missing. Please reinstall the app.",
          };
        }
        if (
          errorMessage.includes("Audio buffer is empty") ||
          errorMessage.includes("Audio data too small")
        ) {
          return {
            success: false,
            error: "no_audio_data",
            message: "No audio detected",
          };
        }
        if (errorMessage.includes("model") && errorMessage.includes("not downloaded")) {
          return {
            success: false,
            error: "model_not_found",
            message: errorMessage,
          };
        }

        throw error;
      }
    });

    ipcMain.handle("check-whisper-installation", async (event) => {
      return this.whisperManager.checkWhisperInstallation();
    });

    ipcMain.handle("download-whisper-model", async (event, modelName) => {
      try {
        const result = await this.whisperManager.downloadWhisperModel(modelName, (progressData) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send("whisper-download-progress", progressData);
          }
        });
        return result;
      } catch (error) {
        if (!event.sender.isDestroyed()) {
          event.sender.send("whisper-download-progress", {
            type: "error",
            model: modelName,
            error: error.message,
            code: error.code || "DOWNLOAD_FAILED",
          });
        }
        return {
          success: false,
          error: error.message,
          code: error.code || "DOWNLOAD_FAILED",
        };
      }
    });

    ipcMain.handle("check-model-status", async (event, modelName) => {
      return this.whisperManager.checkModelStatus(modelName);
    });

    ipcMain.handle("list-whisper-models", async (event) => {
      return this.whisperManager.listWhisperModels();
    });

    ipcMain.handle("delete-whisper-model", async (event, modelName) => {
      return this.whisperManager.deleteWhisperModel(modelName);
    });

    ipcMain.handle("delete-all-whisper-models", async () => {
      return this.whisperManager.deleteAllWhisperModels();
    });

    ipcMain.handle("cancel-whisper-download", async (event) => {
      return this.whisperManager.cancelDownload();
    });

    ipcMain.handle("transcribe-local-parakeet", async (event, audioBlob, options = {}) => {
      debugLogger.log("transcribe-local-parakeet called", {
        audioBlobType: typeof audioBlob,
        audioBlobSize: audioBlob?.byteLength || audioBlob?.length || 0,
        options,
      });

      try {
        const result = await inferenceScheduler.run(
          () => {
            if (typeof options.requestId === "string" && options.requestId.length < 100 && !event.sender.isDestroyed?.())
              event.sender.send("local-transcription-started", { requestId: options.requestId });
            return this.parakeetManager.transcribeLocalParakeet(audioBlob, options);
          },
          { priority: "foreground" }
        );

        debugLogger.log("Parakeet result", {
          success: result.success,
          hasText: !!result.text,
          message: result.message,
          error: result.error,
        });
        if (result?.success && result.text && !options.skipAliases)
          result.text = this._applyAliases(result.text);

        if (!result.success && result.message === "No audio detected") {
          debugLogger.log("Sending no-audio-detected event to renderer");
          event.sender.send("no-audio-detected");
        }

        return result;
      } catch (error) {
        debugLogger.error("Local Parakeet transcription error", error);
        const errorMessage = error.message || "Unknown error";

        if (error.code === "PARAKEET_WARMING_UP") {
          return {
            success: false,
            error: "model_warming_up",
            message: error.startupError
              ? i18nMain.t("hooks.audioRecording.speechModelFailed", { error: error.startupError })
              : i18nMain.t("hooks.audioRecording.speechModelPreparing"),
          };
        }
        if (error.code === "PARAKEET_ENGINE_STOPPED") {
          return {
            success: false,
            error: "engine_stopped",
            message: i18nMain.t("hooks.audioRecording.speechEngineStopped"),
          };
        }

        if (errorMessage.includes("sherpa-onnx") && errorMessage.includes("not found")) {
          return {
            success: false,
            error: "parakeet_not_found",
            message: "Parakeet binary is missing. Please reinstall the app.",
          };
        }
        if (errorMessage.includes("model") && errorMessage.includes("not downloaded")) {
          return {
            success: false,
            error: "model_not_found",
            message: errorMessage,
          };
        }

        throw error;
      }
    });

    ipcMain.handle("download-parakeet-model", async (event, modelName) => {
      try {
        const result = await this.parakeetManager.downloadParakeetModel(
          modelName,
          (progressData) => {
            if (!event.sender.isDestroyed()) {
              event.sender.send("parakeet-download-progress", progressData);
            }
          }
        );
        return result;
      } catch (error) {
        if (!event.sender.isDestroyed()) {
          event.sender.send("parakeet-download-progress", {
            type: "error",
            model: modelName,
            error: error.message,
            code: error.code || "DOWNLOAD_FAILED",
          });
        }
        return {
          success: false,
          error: error.message,
          code: error.code || "DOWNLOAD_FAILED",
        };
      }
    });

    ipcMain.handle("check-parakeet-model-status", async (_event, modelName) => {
      return this.parakeetManager.checkModelStatus(modelName);
    });

    ipcMain.handle("list-parakeet-models", async () => {
      return this.parakeetManager.listParakeetModels();
    });

    ipcMain.handle("delete-parakeet-model", async (_event, modelName) => {
      return this.parakeetManager.deleteParakeetModel(modelName);
    });

    ipcMain.handle("delete-all-parakeet-models", async () => {
      return this.parakeetManager.deleteAllParakeetModels();
    });

    ipcMain.handle("cancel-parakeet-download", async () => {
      return this.parakeetManager.cancelDownload();
    });

    ipcMain.handle("get-parakeet-engine-info", async () => {
      const manager = this.parakeetManager.serverManager;
      return {
        engine: manager.getEngine(),
        coremlAvailable: manager.coremlServer.isAvailable(),
        coremlModelDownloaded: manager.coremlServer.isModelDownloaded(),
      };
    });

    ipcMain.handle("set-parakeet-engine", async (event, engine) => {
      const manager = this.parakeetManager.serverManager;
      try {
        manager.setEngine(engine || null);
      } catch (error) {
        return { success: false, error: error.message };
      }

      // Drop both backends so the next dictation starts on the chosen one
      // rather than continuing to use whichever is still resident.
      await this.parakeetManager.stopServer();

      if (engine) {
        process.env.PARAKEET_ENGINE = engine;
      } else {
        delete process.env.PARAKEET_ENGINE;
      }
      await this.environmentManager.saveAllKeysToEnvFile();

      return { success: true, engine: manager.getEngine() };
    });

    ipcMain.handle("cleanup-app", async (event) => {
      AppUtils.cleanup(this.windowManager.mainWindow);
      return { success: true, message: "Cleanup completed successfully" };
    });

    ipcMain.handle("update-hotkey", async (event, hotkey) => {
      return await this.windowManager.updateHotkey(hotkey);
    });

    ipcMain.handle("set-hotkey-listening-mode", async (event, enabled, newHotkey = null) => {
      this.windowManager.setHotkeyListeningMode(enabled);
      const hotkeyManager = this.windowManager.hotkeyManager;

      // When exiting capture mode with a new hotkey, use that to avoid reading stale state
      const effectiveHotkey = !enabled && newHotkey ? newHotkey : hotkeyManager.getCurrentHotkey();

      const {
        isGlobeLikeHotkey,
        isModifierOnlyHotkey,
        isRightSideModifier,
      } = require("./hotkeyManager");
      const usesNativeListener = (hotkey) =>
        !hotkey ||
        isGlobeLikeHotkey(hotkey) ||
        isModifierOnlyHotkey(hotkey) ||
        isRightSideModifier(hotkey);

      if (enabled) {
        // Entering capture mode - unregister globalShortcut so it doesn't consume key events
        const currentHotkey = hotkeyManager.getCurrentHotkey();
        if (currentHotkey && !usesNativeListener(currentHotkey)) {
          debugLogger.log(
            `[IPC] Unregistering globalShortcut "${currentHotkey}" for hotkey capture mode`
          );
          const { globalShortcut } = require("electron");
          globalShortcut.unregister(currentHotkey);
        }
      } else {
        // Exiting capture mode - re-register globalShortcut if not already registered
        if (effectiveHotkey && !usesNativeListener(effectiveHotkey)) {
          const { globalShortcut } = require("electron");
          const accelerator = effectiveHotkey.startsWith("Fn+")
            ? effectiveHotkey.slice(3)
            : effectiveHotkey;
          if (!globalShortcut.isRegistered(accelerator)) {
            debugLogger.log(
              `[IPC] Re-registering globalShortcut "${accelerator}" after capture mode`
            );
            const callback = this.windowManager.createHotkeyCallback();
            const registered = globalShortcut.register(accelerator, callback);
            if (!registered) {
              debugLogger.warn(
                `[IPC] Failed to re-register globalShortcut "${accelerator}" after capture mode`
              );
            }
          }
        }
      }

      return { success: true };
    });

    ipcMain.handle("start-window-drag", async (event) => {
      return await this.windowManager.startWindowDrag();
    });

    ipcMain.handle("stop-window-drag", async (event) => {
      return await this.windowManager.stopWindowDrag();
    });

    ipcMain.handle("open-external", async (event, url) => {
      try {
        await shell.openExternal(url);
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("get-auto-start-enabled", async () => {
      try {
        const loginSettings = app.getLoginItemSettings();
        return loginSettings.openAtLogin;
      } catch (error) {
        debugLogger.error("Error getting auto-start status:", error);
        return false;
      }
    });

    ipcMain.handle("set-auto-start-enabled", async (event, enabled) => {
      try {
        app.setLoginItemSettings({
          openAtLogin: enabled,
          openAsHidden: true, // Start minimized to tray
        });
        debugLogger.debug("Auto-start setting updated", { enabled });
        return { success: true };
      } catch (error) {
        debugLogger.error("Error setting auto-start:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("model-get-all", async () => {
      try {
        debugLogger.debug("model-get-all called", undefined, "ipc");
        const modelManager = require("./modelManagerBridge").default;
        const models = await modelManager.getModelsWithStatus();
        debugLogger.debug("Returning models", { count: models.length }, "ipc");
        return models;
      } catch (error) {
        debugLogger.error("Error in model-get-all:", error);
        throw error;
      }
    });

    ipcMain.handle("model-check", async (_, modelId) => {
      const modelManager = require("./modelManagerBridge").default;
      return modelManager.isModelDownloaded(modelId);
    });

    ipcMain.handle("model-download", async (event, modelId) => {
      try {
        const modelManager = require("./modelManagerBridge").default;
        const result = await modelManager.downloadModel(
          modelId,
          (progress, downloadedSize, totalSize) => {
            if (!event.sender.isDestroyed()) {
              event.sender.send("model-download-progress", {
                modelId,
                progress,
                downloadedSize,
                totalSize,
              });
            }
          }
        );
        return { success: true, path: result };
      } catch (error) {
        return {
          success: false,
          error: error.message,
          code: error.code,
          details: error.details,
        };
      }
    });

    ipcMain.handle("model-delete", async (event, modelId) => {
      try {
        const modelManager = require("./modelManagerBridge").default;
        await modelManager.deleteModel(modelId);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error.message,
          code: error.code,
          details: error.details,
        };
      }
    });

    ipcMain.handle("model-delete-all", async () => {
      try {
        const modelManager = require("./modelManagerBridge").default;
        await modelManager.deleteAllModels();
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error.message,
          code: error.code,
          details: error.details,
        };
      }
    });

    ipcMain.handle("model-cancel-download", async (event, modelId) => {
      try {
        const modelManager = require("./modelManagerBridge").default;
        const cancelled = modelManager.cancelDownload(modelId);
        return { success: cancelled };
      } catch (error) {
        return {
          success: false,
          error: error.message,
        };
      }
    });

    ipcMain.handle("get-anthropic-key", async (event) => {
      return this.environmentManager.getAnthropicKey();
    });

    ipcMain.handle("get-gemini-key", async (event) => {
      return this.environmentManager.getGeminiKey();
    });

    ipcMain.handle("save-gemini-key", async (event, key) => {
      return this.environmentManager.saveGeminiKey(key);
    });

    ipcMain.handle("get-groq-key", async (event) => {
      return this.environmentManager.getGroqKey();
    });

    ipcMain.handle("save-groq-key", async (event, key) => {
      return this.environmentManager.saveGroqKey(key);
    });

    ipcMain.handle("get-mistral-key", async () => {
      return this.environmentManager.getMistralKey();
    });

    ipcMain.handle("save-mistral-key", async (event, key) => {
      return this.environmentManager.saveMistralKey(key);
    });

    ipcMain.handle(
      "proxy-mistral-transcription",
      async (event, { audioBuffer, model, language, contextBias }) => {
        const apiKey = this.environmentManager.getMistralKey();
        if (!apiKey) {
          throw new Error("Mistral API key not configured");
        }

        const formData = new FormData();
        const audioBlob = new Blob([Buffer.from(audioBuffer)], { type: "audio/webm" });
        formData.append("file", audioBlob, "audio.webm");
        formData.append("model", model || "voxtral-mini-latest");
        if (language && language !== "auto") {
          formData.append("language", language);
        }
        if (contextBias && contextBias.length > 0) {
          for (const token of contextBias) {
            formData.append("context_bias", token);
          }
        }

        const response = await fetch(MISTRAL_TRANSCRIPTION_URL, {
          method: "POST",
          headers: {
            "x-api-key": apiKey,
          },
          body: formData,
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Mistral API Error: ${response.status} ${errorText}`);
        }

        return await response.json();
      }
    );

    ipcMain.handle("get-custom-transcription-key", async () => {
      return this.environmentManager.getCustomTranscriptionKey();
    });

    ipcMain.handle("save-custom-transcription-key", async (event, key) => {
      return this.environmentManager.saveCustomTranscriptionKey(key);
    });

    ipcMain.handle("get-custom-reasoning-key", async () => {
      return this.environmentManager.getCustomReasoningKey();
    });

    ipcMain.handle("save-custom-reasoning-key", async (event, key) => {
      return this.environmentManager.saveCustomReasoningKey(key);
    });

    ipcMain.handle("get-dictation-key", async () => {
      return this.environmentManager.getDictationKey();
    });

    ipcMain.handle("save-dictation-key", async (event, key) => {
      return this.environmentManager.saveDictationKey(key);
    });

    ipcMain.handle("get-activation-mode", async () => {
      return this.environmentManager.getActivationMode();
    });

    ipcMain.handle("save-anthropic-key", async (event, key) => {
      return this.environmentManager.saveAnthropicKey(key);
    });

    ipcMain.handle("get-ui-language", async () => {
      return this.environmentManager.getUiLanguage();
    });

    ipcMain.handle("set-ui-language", async (event, language) => {
      const result = this.environmentManager.saveUiLanguage(language);
      process.env.UI_LANGUAGE = result.language;
      changeLanguage(result.language);
      this.windowManager?.refreshLocalizedUi?.();
      this.getTrayManager?.()?.updateTrayMenu?.();
      return { success: true, language: result.language };
    });

    ipcMain.handle("save-all-keys-to-env", async () => {
      return this.environmentManager.saveAllKeysToEnvFile();
    });

    ipcMain.handle("sync-startup-preferences", async (event, prefs) => {
      const setVars = {};
      const clearVars = [];

      if (prefs.useLocalWhisper && prefs.model) {
        // Local mode with model selected - set provider and model for pre-warming
        setVars.LOCAL_TRANSCRIPTION_PROVIDER = prefs.localTranscriptionProvider;
        if (prefs.localTranscriptionProvider === "nvidia") {
          setVars.PARAKEET_MODEL = prefs.model;
          clearVars.push("LOCAL_WHISPER_MODEL");
          this.whisperManager.stopServer().catch((err) => {
            debugLogger.error("Failed to stop whisper-server on provider switch", {
              error: err.message,
            });
          });
        } else {
          setVars.LOCAL_WHISPER_MODEL = prefs.model;
          clearVars.push("PARAKEET_MODEL");
          this.parakeetManager.stopServer().catch((err) => {
            debugLogger.error("Failed to stop parakeet-server on provider switch", {
              error: err.message,
            });
          });
        }
      } else if (prefs.useLocalWhisper) {
        // Local mode enabled but no model selected - clear pre-warming vars
        clearVars.push("LOCAL_TRANSCRIPTION_PROVIDER", "PARAKEET_MODEL", "LOCAL_WHISPER_MODEL");
      } else {
        // Cloud mode - stop local servers to free RAM
        clearVars.push("LOCAL_TRANSCRIPTION_PROVIDER", "PARAKEET_MODEL", "LOCAL_WHISPER_MODEL");
        this.whisperManager.stopServer().catch((err) => {
          debugLogger.error("Failed to stop whisper-server on cloud switch", {
            error: err.message,
          });
        });
        this.parakeetManager.stopServer().catch((err) => {
          debugLogger.error("Failed to stop parakeet-server on cloud switch", {
            error: err.message,
          });
        });
      }

      // The renderer's provider is a model *family* id for local models
      // ("qwen", "granite"), not "local". Only a real cloud provider may clear
      // the polish model and stop llama-server; anything else is local, and
      // its model is persisted so launch prewarms the one actually selected.
      if (!isCloudReasoningProvider(prefs.reasoningProvider) && prefs.reasoningModel) {
        const changedModel = process.env.LOCAL_REASONING_MODEL !== prefs.reasoningModel;
        setVars.REASONING_PROVIDER = "local";
        setVars.LOCAL_REASONING_MODEL = prefs.reasoningModel;
        if (changedModel) {
          const modelManager = require("./modelManagerBridge").default;
          modelManager.prewarmServer?.(prefs.reasoningModel).catch((err) => {
            debugLogger.debug("llama-server prewarm after model change failed", {
              error: err.message,
            });
          });
        }
      } else if (isCloudReasoningProvider(prefs.reasoningProvider)) {
        clearVars.push("REASONING_PROVIDER", "LOCAL_REASONING_MODEL");
        const modelManager = require("./modelManagerBridge").default;
        modelManager.stopServer().catch((err) => {
          debugLogger.error("Failed to stop llama-server on provider switch", {
            error: err.message,
          });
        });
      }

      this._syncStartupEnv(setVars, clearVars);
    });

    ipcMain.handle("process-local-reasoning", async (event, text, modelId, _agentName, config) => {
      try {
        const LocalReasoningService = require("../services/localReasoningBridge").default;
        const result = await LocalReasoningService.processText(text, modelId, config);
        return { success: true, text: result };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    // The renderer gave up on a polish pass (timeout, or the person chose the
    // raw text). Drop the HTTP request so llama-server stops generating
    // instead of holding its slot for the next dictation.
    ipcMain.handle("cancel-local-reasoning", () => {
      try {
        const modelManager = require("./modelManagerBridge").default;
        const aborted = modelManager.serverManager?.abortInflight?.("Polish cancelled") || 0;
        return { success: true, aborted };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle(
      "process-anthropic-reasoning",
      async (event, text, modelId, _agentName, config) => {
        try {
          const apiKey = this.environmentManager.getAnthropicKey();

          if (!apiKey) {
            throw new Error("Anthropic API key not configured");
          }

          const systemPrompt = config?.systemPrompt || "";
          const userPrompt = text;

          if (!modelId) {
            throw new Error("No model specified for Anthropic API call");
          }

          const requestBody = {
            model: modelId,
            messages: [{ role: "user", content: userPrompt }],
            system: systemPrompt,
            max_tokens: config?.maxTokens || Math.max(100, Math.min(text.length * 2, 4096)),
            temperature: config?.temperature || 0.3,
          };

          const response = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-API-Key": apiKey,
              "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify(requestBody),
          });

          if (!response.ok) {
            const errorText = await response.text();
            let errorData = { error: response.statusText };
            try {
              errorData = JSON.parse(errorText);
            } catch {
              errorData = { error: errorText || response.statusText };
            }
            throw new Error(
              errorData.error?.message ||
                errorData.error ||
                `Anthropic API error: ${response.status}`
            );
          }

          const data = await response.json();
          return { success: true, text: data.content[0].text.trim() };
        } catch (error) {
          debugLogger.error("Anthropic reasoning error:", error);
          return { success: false, error: error.message };
        }
      }
    );

    ipcMain.handle("check-local-reasoning-available", async () => {
      try {
        const LocalReasoningService = require("../services/localReasoningBridge").default;
        return await LocalReasoningService.isAvailable();
      } catch (error) {
        return false;
      }
    });

    ipcMain.handle("llama-server-stop", async () => {
      try {
        const modelManager = require("./modelManagerBridge").default;
        await modelManager.stopServer();
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("llama-server-status", async () => {
      try {
        const modelManager = require("./modelManagerBridge").default;
        return modelManager.getServerStatus();
      } catch (error) {
        return { available: false, running: false, error: error.message };
      }
    });

    ipcMain.handle("get-log-level", async () => {
      return debugLogger.getLevel();
    });

    ipcMain.handle("app-log", async (event, entry) => {
      debugLogger.logEntry(entry);
      return { success: true };
    });

    const SYSTEM_SETTINGS_URLS = {
      darwin: {
        microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
        sound: "x-apple.systempreferences:com.apple.preference.sound?input",
        accessibility:
          "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
      },
      win32: {
        microphone: "ms-settings:privacy-microphone",
        sound: "ms-settings:sound",
      },
    };

    const openSystemSettings = async (settingType) => {
      const platform = process.platform;
      const urls = SYSTEM_SETTINGS_URLS[platform];
      const url = urls?.[settingType];

      if (!url) {
        // Platform doesn't support this settings URL
        const messages = {
          microphone: i18nMain.t("systemSettings.microphone"),
          sound: i18nMain.t("systemSettings.sound"),
          accessibility: i18nMain.t("systemSettings.accessibility"),
        };
        return {
          success: false,
          error:
            messages[settingType] || `${settingType} settings are not available on this platform.`,
        };
      }

      try {
        await shell.openExternal(url);
        return { success: true };
      } catch (error) {
        debugLogger.error(`Failed to open ${settingType} settings:`, error);
        return { success: false, error: error.message };
      }
    };

    ipcMain.handle("open-microphone-settings", () => openSystemSettings("microphone"));
    ipcMain.handle("open-sound-input-settings", () => openSystemSettings("sound"));
    ipcMain.handle("open-accessibility-settings", () => openSystemSettings("accessibility"));

    ipcMain.handle("request-microphone-access", async () => {
      if (process.platform !== "darwin") {
        return { granted: true };
      }
      const { systemPreferences } = require("electron");
      const granted = await systemPreferences.askForMediaAccess("microphone");
      return { granted };
    });

    ipcMain.handle("open-whisper-models-folder", async () => {
      try {
        const modelsDir = this.whisperManager.getModelsDir();
        await shell.openPath(modelsDir);
        return { success: true };
      } catch (error) {
        debugLogger.error("Failed to open whisper models folder:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("get-debug-state", async () => {
      try {
        return {
          enabled: debugLogger.isEnabled(),
          logPath: debugLogger.getLogPath(),
          logLevel: debugLogger.getLevel(),
        };
      } catch (error) {
        debugLogger.error("Failed to get debug state:", error);
        return { enabled: false, logPath: null, logLevel: "info" };
      }
    });

    ipcMain.handle("set-debug-logging", async (event, enabled) => {
      try {
        const path = require("path");
        const fs = require("fs");
        const envPath = path.join(app.getPath("userData"), ".env");

        // Read current .env content
        let envContent = "";
        if (fs.existsSync(envPath)) {
          envContent = fs.readFileSync(envPath, "utf8");
        }

        // Parse lines
        const lines = envContent.split("\n");
        const logLevelIndex = lines.findIndex((line) =>
          line.trim().startsWith("OPENWHISPR_LOG_LEVEL=")
        );

        if (enabled) {
          // Set to debug
          if (logLevelIndex !== -1) {
            lines[logLevelIndex] = "OPENWHISPR_LOG_LEVEL=debug";
          } else {
            // Add new line
            if (lines.length > 0 && lines[lines.length - 1] !== "") {
              lines.push("");
            }
            lines.push("# Debug logging setting");
            lines.push("OPENWHISPR_LOG_LEVEL=debug");
          }
        } else {
          // Remove or set to info
          if (logLevelIndex !== -1) {
            lines[logLevelIndex] = "OPENWHISPR_LOG_LEVEL=info";
          }
        }

        // Write back
        fs.writeFileSync(envPath, lines.join("\n"), "utf8");

        // Update environment variable
        process.env.OPENWHISPR_LOG_LEVEL = enabled ? "debug" : "info";

        // Refresh logger state
        debugLogger.refreshLogLevel();

        return {
          success: true,
          enabled: debugLogger.isEnabled(),
          logPath: debugLogger.getLogPath(),
        };
      } catch (error) {
        debugLogger.error("Failed to set debug logging:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("open-logs-folder", async () => {
      try {
        const logsDir = path.join(app.getPath("userData"), "logs");
        await shell.openPath(logsDir);
        return { success: true };
      } catch (error) {
        debugLogger.error("Failed to open logs folder:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("check-for-updates", async () => {
      return this.updateManager.checkForUpdates();
    });

    ipcMain.handle("download-update", async () => {
      return this.updateManager.downloadUpdate();
    });

    ipcMain.handle("install-update", async () => {
      return this.updateManager.installUpdate();
    });

    ipcMain.handle("get-app-version", async () => {
      return this.updateManager.getAppVersion();
    });

    ipcMain.handle("get-update-status", async () => {
      return this.updateManager.getUpdateStatus();
    });

    ipcMain.handle("get-update-info", async () => {
      return this.updateManager.getUpdateInfo();
    });

  }

  broadcastToWindows(channel, payload) {
    const windows = BrowserWindow.getAllWindows();
    windows.forEach((win) => {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, payload);
      }
    });
  }
}

module.exports = IPCHandlers;
