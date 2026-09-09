const fs = require("fs");
const { playbackInputs, confinedFile } = require("./audioEvidence");
const { inferenceScheduler } = require("./inferenceScheduler");
const path = require("path");
const crypto = require("crypto");
const { MeetingStore, parseTranscript } = require("./meetingStore");
const { MeetingRecorder } = require("./meetingRecorder");
const { prepareChunks, transcribeChunk, wavInfo, audioDuration } = require("./meetingTranscriber");
const TRANSCRIPTION_CACHE_VERSION = 2;
function isTransientCloudError(error) {
  const status = Number(error?.status);
  return (
    error?.name === "TimeoutError" ||
    /timeout|timed out/i.test(String(error?.message || "")) ||
    status === 408 ||
    status === 429 ||
    (status >= 500 && status <= 599)
  );
}
function registerMeetingHandlers({
  app,
  ipcMain,
  dialog,
  shell,
  safeStorage,
  systemPreferences,
  whisperManager,
  parakeetManager,
  databaseManager,
  windowManager,
  audioEvidence,
  localSpeech,
}) {
  const root = path.join(app.getPath("userData"), "call-notes");
  const store = new MeetingStore(root);
  const binary = app.isPackaged
    ? path.join(process.resourcesPath, "bin", `meeting-recorder-${process.arch}`)
    : path.join(__dirname, "../../resources/bin", `meeting-recorder-${process.arch}`);
  const recorder = new MeetingRecorder(store, { binary, localSpeech });
  const keyPath = path.join(root, "openrouter-key.enc");
  const jobs = new Map();
  const starting = new Set();
  const reading = new Set();
  const readKey = () =>
    fs.existsSync(keyPath) ? safeStorage.decryptString(fs.readFileSync(keyPath)) : "";
  const config = () => ({
    ...store.index.config,
    hasKey: fs.existsSync(keyPath),
    captureAvailable:
      process.platform === "darwin" &&
      Number(require("os").release().split(".")[0]) >= 24 &&
      fs.existsSync(binary),
  });
  const localTranscribe = (audio, settings) =>
    settings.localEngine === "whisper"
      ? whisperManager.transcribeLocalWhisper(audio, { model: settings.localModel || "base" })
      : parakeetManager.transcribeLocalParakeet(audio, {
          model: settings.localModel || "parakeet-tdt-0.6b-v3",
        });
  async function transcribe(id) {
    if (jobs.size) throw new Error("A call is already being transcribed");
    const original = store.get(id);
    if (recorder.status().id === id) throw new Error("Stop recording before transcription");
    const settings = { ...store.index.config };
    const apiKey = settings.provider === "openrouter" ? readKey() : "";
    if (settings.provider === "openrouter" && !apiKey)
      throw new Error("Add your OpenRouter API key first");
    const audio = (original.audio || []).filter((a) =>
      fs.existsSync(path.join(store.directory(id), a.file))
    );
    if (!audio.length) throw new Error("No saved audio is available for this call");
    const controller = new AbortController();
    jobs.set(id, controller);
    store.update(id, {
      status: "transcribing",
      lastError: null,
      progress: { completed: 0, total: 0 },
    });
    // Background job keeps capture/navigation responsive; each completed request is checkpointed.
    (async () => {
      const work = path.join(store.directory(id), `work-${crypto.randomUUID()}`);
      try {
        const keywords = databaseManager.getDictionary().filter((v) => typeof v === "string");
        const signature = crypto
          .createHash("sha256")
          .update(JSON.stringify({ settings, audio, keywords }))
          .digest("hex");
        const old = original.transcriptionCache;
        const cache =
          old?.version === TRANSCRIPTION_CACHE_VERSION && old.signature === signature
            ? old
            : { version: TRANSCRIPTION_CACHE_VERSION, signature, results: {} };
        let chunks = [];
        if (settings.provider === "openrouter") {
          const groups = new Map();
          for (const entry of audio) {
            const key = path.dirname(entry.file);
            const group = groups.get(key) || [];
            group.push(entry);
            groups.set(key, group);
          }
          let index = 0;
          for (const group of groups.values()) {
            const prepared = await prepareChunks(
              group.map((a) => ({
                path: path.join(store.directory(id), a.file),
                source: a.source,
              })),
              path.join(work, String(index)),
              { mix: true, cloud: true }
            );
            chunks.push(
              ...prepared.map((c) => ({
                ...c,
                offset: c.offset + (group[0].offset || 0),
                key: `${index}:${c.offset}`,
              }))
            );
            index++;
          }
        } else {
          let index = 0;
          for (const entry of audio) {
            const prepared = await prepareChunks(
              [{ path: path.join(store.directory(id), entry.file), source: entry.source }],
              path.join(work, String(index))
            );
            chunks.push(
              ...prepared.map((c) => ({
                ...c,
                offset: c.offset + (entry.offset || 0),
                key: `${index}:${c.offset}`,
              }))
            );
            index++;
          }
        }
        if (!chunks.length) throw new Error("No audio could be prepared");
        let completed = 0;
        for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
          const chunk = chunks[chunkIndex];
          if (controller.signal.aborted)
            throw new Error("Transcription cancelled; audio and completed chunks are saved");
          if (!cache.results[chunk.key]) {
            const buffer = fs.readFileSync(chunk.path);
            const info =
              chunk.format === "mp3"
                ? { duration: await audioDuration(chunk.path), silent: false }
                : wavInfo(buffer);
            let attempt = 0;
            while (!cache.results[chunk.key]) {
              try {
                cache.results[chunk.key] = info.silent
                  ? { text: "", segments: [], words: [] }
                  : await transcribeChunk({
                      provider: settings.provider,
                      audioFormat: chunk.format || "wav",
                      audio: buffer,
                      apiKey,
                      offset: chunk.offset,
                      chunkId: `part-${chunk.key.replace(/[^a-zA-Z0-9-]/g, "-")}`,
                      source: chunk.source,
                      duration: info.duration,
                      keywords,
                      signal: controller.signal,
                      localTranscribe: (audio) => {
                        store.update(id, { status: "queued" });
                        return inferenceScheduler.run(
                          () => {
                            store.update(id, { status: "transcribing" });
                            return localTranscribe(audio, settings);
                          },
                          { priority: "background", signal: controller.signal }
                        );
                      },
                    });
              } catch (error) {
                if (
                  !controller.signal.aborted &&
                  settings.provider === "openrouter" &&
                  !attempt &&
                  isTransientCloudError(error)
                ) {
                  attempt++;
                  continue;
                }
                throw error;
              }
            }
          }
          completed++;
          store.update(id, {
            transcriptionCache: cache,
            progress: { completed, total: chunks.length },
          });
        }
        if (controller.signal.aborted)
          throw new Error("Transcription cancelled; saved audio is retained");
        const results = chunks.map((c) => cache.results[c.key]);
        const segments = results.flatMap((r) => r.segments).sort((a, b) => a.start - b.start);
        const words = results.flatMap((r) => r.words).sort((a, b) => a.start - b.start);
        const current = store.get(id);
        const speakers = {};
        for (const segment of segments)
          if (segment.speaker && !Object.hasOwn(speakers, segment.speaker))
            speakers[segment.speaker] = current.speakers[segment.speaker] || "";
        store.update(id, {
          status: "ready",
          provider: settings.provider,
          localEngine: settings.localEngine,
          segments,
          words,
          speakers,
          transcript: current.transcriptEdited
            ? current.transcript
            : segments.map((s) => s.text).join("\n\n"),
          transcriptEdited: !!current.transcriptEdited,
          needsTranscription: false,
          lastError: null,
          progress: null,
        });
      } catch (error) {
        store.update(id, {
          status: "interrupted",
          lastError: String(error.message || error).slice(0, 600),
          progress: null,
        });
      } finally {
        jobs.delete(id);
        fs.rmSync(work, { recursive: true, force: true });
      }
    })();
    return store.get(id);
  }
  const methods = {
    list: () => store.list(),
    create: () => store.create(),
    get: ({ id }) => store.get(id),
    save: ({ id, patch, revision }) => store.save(id, patch, revision),
    delete: ({ id }) => {
      if (starting.has(id) || reading.has(id) || jobs.has(id) || recorder.status().id === id)
        throw new Error("Wait for active call work to finish before deleting this call");
      const result = store.delete(id);
      // UI read-aloud speech belongs to the trusted control-panel renderer.
      void localSpeech?.stopOwner(windowManager.controlPanelWindow.webContents.id).catch(() => {});
      return result;
    },
    folders: () => store.folders(),
    pinFolder: async () => {
      const result = await dialog.showOpenDialog(windowManager.controlPanelWindow, {
        properties: ["openDirectory", "createDirectory"],
      });
      return result.canceled ? null : store.pinFolder(result.filePaths[0]);
    },
    unpinFolder: ({ id }) => store.unpinFolder(id),
    file: ({ id, folderId, asCopy }) => store.file(id, folderId, { asCopy: asCopy === true }),
    reveal: ({ id }) => {
      const meeting = store.get(id);
      if (meeting.exportPath) shell.showItemInFolder(meeting.exportPath);
    },
    getConfig: config,
    setConfig: ({ provider, localEngine, localModel, apiKey }) => {
      if (provider && !["local", "openrouter"].includes(provider))
        throw new Error("Invalid provider");
      if (localEngine && !["whisper", "nvidia"].includes(localEngine))
        throw new Error("Invalid local engine");
      if (
        localModel != null &&
        (typeof localModel !== "string" || localModel.length > 150 || !/^[-\w.]+$/.test(localModel))
      )
        throw new Error("Invalid local model");
      if (apiKey != null) {
        if (typeof apiKey !== "string" || apiKey.length > 500) throw new Error("Invalid API key");
        if (apiKey.trim()) {
          if (!safeStorage.isEncryptionAvailable())
            throw new Error("macOS key encryption is unavailable");
          fs.writeFileSync(keyPath, safeStorage.encryptString(apiKey.trim()), { mode: 0o600 });
        } else if (fs.existsSync(keyPath)) fs.unlinkSync(keyPath);
      }
      store.index.config = {
        ...store.index.config,
        ...(provider ? { provider } : {}),
        ...(localEngine ? { localEngine } : {}),
        ...(localModel ? { localModel } : {}),
      };
      store.persistIndex();
      return config();
    },
    importTranscript: async () => {
      const result = await dialog.showOpenDialog({
        properties: ["openFile"],
        filters: [{ name: "Transcripts", extensions: ["txt", "md", "vtt", "srt"] }],
      });
      if (result.canceled) return null;
      const file = result.filePaths[0];
      if (fs.statSync(file).size > 2_000_000)
        throw new Error("Transcript file is too large (2 MB maximum)");
      const parsed = parseTranscript(fs.readFileSync(file, "utf8"));
      const item = store.create();
      return store.update(item.id, {
        title: path.basename(file, path.extname(file)),
        transcript: parsed.text,
        segments: parsed.segments,
        speakers: Object.fromEntries(
          parsed.segments.filter((s) => s.speaker).map((s) => [s.speaker, s.speaker])
        ),
        provider: "import",
        status: "ready",
      });
    },
    importAudio: async () => {
      const result = await dialog.showOpenDialog({
        properties: ["openFile"],
        filters: [
          { name: "Audio", extensions: ["wav", "mp3", "m4a", "mp4", "webm", "ogg", "flac", "caf"] },
        ],
      });
      if (result.canceled) return null;
      const file = result.filePaths[0];
      if (fs.statSync(file).size > 2 * 1024 ** 3)
        throw new Error("Audio file is too large (2 GB maximum)");
      const item = store.create();
      const filename = `import${path.extname(file).toLowerCase()}`;
      await fs.promises.copyFile(file, path.join(store.directory(item.id), filename));
      return store.update(item.id, {
        title: path.basename(file, path.extname(file)),
        audio: [{ file: filename, source: "audio", offset: 0 }],
        status: "recorded",
        needsTranscription: true,
      });
    },
    startCapture: async ({ id }) => {
      if (jobs.has(id) || ["queued", "transcribing"].includes(store.get(id).status))
        throw new Error("Wait for transcription to finish");
      if (!config().captureAvailable)
        throw new Error("Call recording requires macOS 15 or later and the native recorder");
      if (starting.has(id)) throw new Error("Call recording is already starting");
      starting.add(id);
      try {
        if (!(await systemPreferences.askForMediaAccess("microphone")))
          throw new Error("Microphone permission is required");
        return await recorder.start(id);
      } finally {
        starting.delete(id);
      }
    },
    stopCapture: ({ id }) => recorder.stop(id),
    captureStatus: () => recorder.status(),
    playback: async ({ id, source = "all" }) => {
      if (recorder.status().id === id) throw new Error("Stop recording before playback");
      const original = store.get(id);
      const inputs = playbackInputs(original, source);
      if (reading.has(id)) throw new Error("Playback is already being prepared");
      reading.add(id);
      try {
        const file = await audioEvidence.prepare(store.directory(id), inputs);
        const url = audioEvidence.issue(() => {
          const current = playbackInputs(store.get(id), source);
          if (JSON.stringify(current) !== JSON.stringify(inputs))
            throw new Error("Recording changed");
          for (const input of current) confinedFile(store.directory(id), input.file);
          return confinedFile(store.directory(id), path.basename(file));
        });
        return { url, durationSeconds: original.recordedDuration || 0 };
      } finally {
        reading.delete(id);
      }
    },
    releasePlayback: ({ url }) => {
      audioEvidence.revoke(url);
      return null;
    },
    transcribe: ({ id }) => transcribe(id),
    cancelTranscription: ({ id }) => {
      jobs.get(id)?.abort();
    },
  };
  for (const [name, method] of Object.entries(methods))
    ipcMain.handle(`meetings:${name}`, async (event, args) => {
      try {
        if (
          windowManager?.controlPanelWindow?.webContents !== event.sender ||
          !event.senderFrame ||
          event.senderFrame !== event.sender.mainFrame
        )
          throw new Error("Call notes are available only in the control panel");
        if (
          name === "delete" &&
          (!args ||
            typeof args !== "object" ||
            Array.isArray(args) ||
            Object.keys(args).length !== 1 ||
            typeof args.id !== "string")
        )
          throw new Error("Invalid delete action");
        return { success: true, data: await method(args || {}) };
      } catch (error) {
        return { success: false, error: String(error.message || error).slice(0, 700) };
      }
    });
  let quitting = false;
  app.on("before-quit", (event) => {
    for (const job of jobs.values()) job.abort();
    const active = recorder.status();
    if (active.id && !quitting) {
      event.preventDefault();
      quitting = true;
      recorder.stop(active.id).finally(() => app.quit());
    }
  });
  return { store, recorder, inferenceScheduler, readCloudKey: readKey };
}
module.exports = { registerMeetingHandlers };
