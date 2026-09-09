const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { CaptureStore } = require("./captureStore");
const { confinedFile } = require("./audioEvidence");
const { inferenceScheduler } = require("./inferenceScheduler");
const { prepareChunks, transcribeChunk, wavInfo, audioDuration } = require("./meetingTranscriber");

function registerCaptureHandlers({
  app,
  ipcMain,
  windowManager,
  audioEvidence,
  whisperManager,
  parakeetManager,
  readCloudKey = () => "",
}) {
  const store = new CaptureStore(path.join(app.getPath("userData"), "dictation-captures"));
  store.prune();
  // A stopped app may leave an interrupted operation, but its evidence remains inspectable.
  for (const item of store.list())
    if (item.status === "processing")
      store.complete(item.id, { error: "Recording processing was interrupted" });
  const owners = new Map();
  const jobs = new Map();
  store.onAudioRemoved = (id) => jobs.get(id)?.abort();
  const watchedSenders = new WeakSet();
  const methods = {
    create: ({ audio, ...options }, event) => {
      if (!(audio instanceof ArrayBuffer) && !ArrayBuffer.isView(audio))
        throw new Error("Invalid capture audio");
      const bytes = audio.byteLength;
      if (bytes > 64 * 1024 ** 2) throw new Error("Capture audio is too large");
      const value = store.create({
        ...options,
        audio: Buffer.from(audio.buffer || audio, audio.byteOffset || 0, bytes),
      });
      owners.set(value.id, event.sender.id);
      if (!watchedSenders.has(event.sender)) {
        watchedSenders.add(event.sender);
        event.sender.once("destroyed", () => {
          for (const [id, owner] of owners)
            if (owner === event.sender.id) {
              try {
                store.complete(id, { error: "Recording window closed" });
              } catch {}
              owners.delete(id);
            }
        });
      }
      return value;
    },
    complete: ({ id, ...result }, event) => {
      if (owners.get(id) !== event.sender.id)
        throw new Error("Capture belongs to another operation");
      const value = store.complete(id, result);
      owners.delete(id);
      return value;
    },
    delete: ({ id }) => {
      jobs.get(id)?.abort();
      store.delete(id);
      owners.delete(id);
      return null;
    },
    list: () => {
      store.prune();
      return store.list();
    },
    get: ({ id }) => {
      store.prune();
      return store.get(id);
    },
    forHistory: ({ historyId }) => {
      store.prune();
      return store.forHistory(historyId);
    },
    getConfig: () => ({ retentionDays: store.retentionDays }),
    setConfig: ({ retentionDays }) => store.setRetentionDays(retentionDays),
    playback: async ({ id }) => {
      store.prune();
      const value = store.get(id);
      store.audioPath(id);
      const file = await audioEvidence.prepare(store.directory(id), [
        { file: value.audioFile, offset: 0 },
      ]);
      // Resolve again on every byte request so retention/deletion invalidates old URLs.
      try {
        store.prune();
        store.audioPath(id);
      } catch (error) {
        try {
          fs.unlinkSync(file);
        } catch {}
        throw error;
      }
      const url = audioEvidence.issue(() => {
        store.audioPath(id);
        return confinedFile(store.directory(id), path.basename(file));
      });
      return { url, durationSeconds: value.durationSeconds };
    },
    releasePlayback: ({ url }) => {
      audioEvidence.revoke(url);
      return null;
    },
    retry: async ({ id, provider, model, language, allowCloud = false }) => {
      if (!["whisper", "parakeet", "openrouter"].includes(provider))
        throw new Error("Invalid transcription provider");
      if (typeof model !== "string" || model.length > 200 || !model.trim())
        throw new Error("Invalid transcription model");
      if (language != null && (typeof language !== "string" || !/^[a-zA-Z-]{2,20}$/.test(language)))
        throw new Error("Invalid language");
      if (provider === "openrouter" && (!allowCloud || model !== "microsoft/mai-transcribe-2"))
        throw new Error("Cloud retry requires explicit consent and the MAI model");
      if (jobs.size) throw new Error("A transcription preview is already running");
      store.prune();
      const source = store.audioPath(id);
      const apiKey = provider === "openrouter" ? readCloudKey() : "";
      if (provider === "openrouter" && !apiKey)
        throw new Error("Add an OpenRouter API key in Call notes settings");
      const controller = new AbortController();
      controller.stage = "preparing";
      jobs.set(id, controller);
      const work = path.join(store.directory(id), `retry-${crypto.randomUUID()}`);
      try {
        const chunks = await prepareChunks([{ path: source, source: "audio" }], work, {
          cloud: provider === "openrouter",
        });
        let text = "";
        for (const chunk of chunks) {
          controller.signal.throwIfAborted();
          const audio = fs.readFileSync(chunk.path);
          const duration =
            chunk.format === "mp3" ? await audioDuration(chunk.path) : wavInfo(audio).duration;
          controller.stage = "transcribing";
          const result = await transcribeChunk({
            provider: provider === "openrouter" ? "openrouter" : "local",
            audio,
            apiKey,
            duration,
            audioFormat: chunk.format,
            signal: controller.signal,
            localTranscribe: (buffer) => {
              controller.stage = "queued";
              return inferenceScheduler.run(() => {
                controller.stage = "transcribing";
                return provider === "whisper"
                  ? whisperManager.transcribeLocalWhisper(buffer, { model, language })
                  : parakeetManager.transcribeLocalParakeet(buffer, { model, language });
              }, { priority: "background", signal: controller.signal });
            },
          });
          text += `${text ? "\n" : ""}${result.text}`;
        }
        controller.signal.throwIfAborted();
        return store.addAttempt(id, {
          settings: { provider, model, language },
          rawText: text,
          finalText: text,
        });
      } finally {
        jobs.delete(id);
        fs.rmSync(work, { recursive: true, force: true });
      }
    },
    retryStatus: ({ id }) => { store.get(id); return { stage: jobs.get(id)?.stage || "idle" }; },
    cancelRetry: ({ id }) => {
      jobs.get(id)?.abort();
      return null;
    },
    acceptAttempt: ({ id, attemptId }) => store.acceptAttempt(id, attemptId),
    saveFixture: ({ id, correctedText }) => store.saveFixture(id, correctedText),
    listFixtures: () => store.listFixtures(),
    deleteFixture: ({ id }) => {
      store.deleteFixture(id);
      return null;
    },
  };
  for (const [name, method] of Object.entries(methods))
    ipcMain.handle(`captures:${name}`, async (event, args) => {
      try {
        const control = windowManager.controlPanelWindow?.webContents;
        const overlay = windowManager.mainWindow?.webContents;
        if (event.sender !== control && event.sender !== overlay)
          throw new Error("Untrusted capture sender");
        if (event.senderFrame && event.senderFrame !== event.sender.mainFrame)
          throw new Error("Untrusted capture frame");
        if (!["create", "complete"].includes(name) && event.sender !== control)
          throw new Error("Capture inspection requires the control panel");
        return { success: true, data: await method(args || {}, event) };
      } catch (error) {
        return { success: false, error: String(error.message || error).slice(0, 700) };
      }
    });
  const timer = setInterval(() => {
    try {
      store.prune();
    } catch {}
  }, 3600000);
  timer.unref?.();
  app.on("before-quit", () => {
    clearInterval(timer);
    for (const job of jobs.values()) job.abort();
  });
  return { store, methods };
}
module.exports = { registerCaptureHandlers };
