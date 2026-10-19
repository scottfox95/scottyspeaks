const fs = require("fs");
const { playbackInputs, confinedFile } = require("./audioEvidence");
const { inferenceScheduler } = require("./inferenceScheduler");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { MeetingStore, parseTranscript } = require("./meetingStore");
const { MeetingRecorder } = require("./meetingRecorder");
const {
  prepareChunks,
  prepareDiarizationAudio,
  prepareTrackPcm,
  transcribeChunk,
  wavInfo,
  audioDuration,
} = require("./meetingTranscriber");
const {
  attributeWords,
  buildSegments,
  frameLevels,
  microphoneSpeaker,
} = require("./meetingDiarization");
const debugLogger = require("./debugLogger");
const { analyzeFile, mergeSegments, trimSuggestions } = require("./speechActivity");
const AUTO_STOP_MINUTES = [0, 1, 2, 5, 10];
const DEFAULT_AUTO_STOP_MINUTES = 2;
const TRANSCRIPTION_CACHE_VERSION = 3;
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
  cloudFetch,
  callDiarizer = null,
}) {
  const root = path.join(app.getPath("userData"), "call-notes");
  const store = new MeetingStore(root);
  const binary = app.isPackaged
    ? path.join(process.resourcesPath, "bin", `meeting-recorder-${process.arch}`)
    : path.join(__dirname, "../../resources/bin", `meeting-recorder-${process.arch}`);
  const recorder = new MeetingRecorder(store, { binary, localSpeech });
  const keyPath = path.join(root, "openrouter-key.enc");
  let keyLoaded = false;
  let cachedKey = "";
  let cachedKeyError = null;
  const jobs = new Map();
  const starting = new Set();
  const reading = new Set();
  const readKey = () => {
    if (keyLoaded) {
      if (cachedKeyError) throw cachedKeyError;
      return cachedKey;
    }
    keyLoaded = true;
    try {
      cachedKey = fs.existsSync(keyPath) ? safeStorage.decryptString(fs.readFileSync(keyPath)) : "";
      return cachedKey;
    } catch (error) {
      cachedKeyError =
        error instanceof Error
          ? error
          : new Error(String(error || "Could not decrypt stored OpenRouter key"));
      throw cachedKeyError;
    }
  };
  const rememberKey = (value) => {
    cachedKey = value;
    cachedKeyError = null;
    keyLoaded = true;
  };
  const config = () => ({
    autoStopMinutes: DEFAULT_AUTO_STOP_MINUTES,
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
          wordTimings: true,
        });
  // Identifies the diarized speaker carried by the microphone track, when a
  // group holds exactly one microphone and one call-audio track.
  async function microphoneSpeakerFor(group, diarization, work) {
    const microphone = group.inputs.find((input) => input.source === "microphone");
    const system = group.inputs.find((input) => input.source === "system");
    if (group.inputs.length !== 2 || !microphone || !system) return null;
    const frameSamples = Math.round(16000 * diarization.frameSeconds);
    const levels = [];
    for (const [index, input] of [microphone, system].entries()) {
      const file = path.join(work, `levels-${group.index}-${index}.pcm`);
      await prepareTrackPcm(input.path, file);
      levels.push(frameLevels(fs.readFileSync(file), frameSamples));
      fs.rmSync(file, { force: true });
    }
    return microphoneSpeaker(diarization, levels[0], levels[1]);
  }
  // Splits each local recording group's transcript into speaker paragraphs.
  // Diarization runs once per group so speaker numbers hold for the whole
  // take. It is best-effort: when timings are missing (Whisper or the
  // sherpa-onnx engine) or the diarizer fails, the unattributed transcript is
  // kept. Cached chunk results stay raw; attribution is recomputed per job.
  async function attributeSpeakers({ groups, chunks, results, work, signal }) {
    if (!callDiarizer?.isAvailable()) return results;
    const attributed = [...results];
    for (const group of groups) {
      const members = chunks.flatMap((chunk, index) => (chunk.group === group.index ? [index] : []));
      if (!members.every((index) => results[index].timed || !results[index].text)) continue;
      const words = members.flatMap((index) => results[index].words);
      if (!words.length) continue;
      try {
        const audio = await prepareDiarizationAudio(
          group.inputs,
          path.join(work, `diarize-${group.index}.wav`)
        );
        const diarization = await inferenceScheduler.run(
          () =>
            callDiarizer.diarize(audio, path.join(work, `diarize-${group.index}.f32`), { signal }),
          { priority: "background", signal }
        );
        const labels = attributeWords(words, diarization, group.offset);
        const microphone = await microphoneSpeakerFor(group, diarization, work);
        const labelled = words.map((word, index) => ({
          ...word,
          speaker:
            labels[index] === null
              ? group.source
              : labels[index] === microphone
                ? "microphone"
                : `part-${group.index}:${labels[index]}`,
        }));
        const segments = buildSegments(labelled);
        members.forEach((index, position) => {
          attributed[index] = {
            ...results[index],
            segments: position ? [] : segments,
            words: position ? [] : labelled,
          };
        });
      } catch (error) {
        if (signal.aborted) throw error;
        debugLogger.warn("Call speaker diarization failed; keeping unattributed transcript", {
          group: group.index,
          error: error.message,
        });
      }
    }
    return attributed;
  }
  async function transcribe(id, { force = false } = {}) {
    if (jobs.size) throw new Error("A call is already being transcribed");
    const original = store.get(id);
    if (recorder.status().id === id) throw new Error("Stop recording before transcription");
    const settings = { ...store.index.config };
    const apiKey = settings.provider === "openrouter" ? readKey() : "";
    if (settings.provider === "openrouter" && !apiKey)
      throw new Error("Add your OpenRouter API key first");
    if (settings.provider === "openrouter" && typeof cloudFetch !== "function")
      throw new Error("Electron desktop network transport is unavailable");
    const audio = (original.audio || []).filter((a) =>
      fs.existsSync(path.join(store.directory(id), a.file))
    );
    if (!audio.length) throw new Error("No saved audio is available for this call");
    const controller = new AbortController();
    jobs.set(id, controller);
    store.update(id, {
      status: "transcribing",
      lastError: null,
      lastErrorCode: null,
      lastErrorStatus: null,
      lastErrorDetail: null,
      progress: { completed: 0, total: 0 },
    });
    // Background job keeps capture/navigation responsive; each completed request is checkpointed.
    (async () => {
      const work = path.join(store.directory(id), `work-${crypto.randomUUID()}`);
      try {
        const keywords = databaseManager.getDictionary().filter((v) => typeof v === "string");
        const signature = crypto
          .createHash("sha256")
          .update(
            JSON.stringify({
              settings,
              audio,
              keywords,
              // Local results now carry word timings; older local caches lack them.
              ...(settings.provider === "local" ? { wordTimings: true } : {}),
            })
          )
          .digest("hex");
        const old = original.transcriptionCache;
        const cache =
          !force && old?.version === TRANSCRIPTION_CACHE_VERSION && old.signature === signature
            ? old
            : { version: TRANSCRIPTION_CACHE_VERSION, signature, results: {} };
        let chunks = [];
        const localGroups = [];
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
          const groups = new Map();
          for (const entry of audio) {
            const key = `${path.dirname(entry.file)}:${entry.offset || 0}`;
            const group = groups.get(key) || [];
            group.push(entry);
            groups.set(key, group);
          }
          let index = 0;
          for (const group of groups.values()) {
            const source = group.length > 1 ? "combined" : group[0].source;
            const inputs = group.map((entry) => ({
              path: path.join(store.directory(id), entry.file),
              source: entry.source,
            }));
            const prepared = await prepareChunks(inputs, path.join(work, String(index)), {
              mix: group.length > 1,
              source,
            });
            localGroups.push({ index, inputs, source, offset: group[0].offset || 0 });
            chunks.push(
              ...prepared.map((c) => ({
                ...c,
                offset: c.offset + (group[0].offset || 0),
                key: `${index}:${c.offset}`,
                group: index,
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
                      fetchImpl: cloudFetch,
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
                // A quiet stretch (an hour of dead air after a call ended) comes
                // back empty. That is "no speech", not a failure, as long as some
                // other part of the call produced text; checked after the loop.
                if (error?.code === "openrouterEmpty" && chunks.length > 1) {
                  cache.results[chunk.key] = { text: "", segments: [], words: [], empty: true };
                  break;
                }
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
        const raw = chunks.map((c) => cache.results[c.key]);
        if (raw.every((r) => r.empty || !r.text?.trim()) && raw.some((r) => r.empty)) {
          for (const chunk of chunks)
            if (cache.results[chunk.key]?.empty) delete cache.results[chunk.key];
          store.update(id, { transcriptionCache: cache });
          const error = new Error("OpenRouter returned no usable transcript.");
          error.code = "openrouterEmpty";
          throw error;
        }
        const results =
          settings.provider === "local"
            ? await attributeSpeakers({
                groups: localGroups,
                chunks,
                results: raw,
                work,
                signal: controller.signal,
              })
            : raw;
        if (controller.signal.aborted)
          throw new Error("Transcription cancelled; saved audio is retained");
        const segments = results.flatMap((r) => r.segments).sort((a, b) => a.start - b.start);
        const words = results.flatMap((r) => r.words).sort((a, b) => a.start - b.start);
        const current = store.get(id);
        const speakers = {};
        for (const segment of segments)
          if (segment.speaker && !Object.hasOwn(speakers, segment.speaker))
            speakers[segment.speaker] = force ? "" : current.speakers[segment.speaker] || "";
        store.update(id, {
          status: "ready",
          provider: settings.provider,
          localEngine: settings.localEngine,
          segments,
          words,
          speakers,
          transcript:
            !force && current.transcriptEdited
              ? current.transcript
              : segments.map((s) => s.text).join("\n\n"),
          transcriptEdited: force ? false : !!current.transcriptEdited,
          needsTranscription: false,
          lastError: null,
          lastErrorCode: null,
          lastErrorStatus: null,
          lastErrorDetail: null,
          progress: null,
        });
      } catch (error) {
        store.update(id, {
          status: "interrupted",
          lastError: String(error.message || error).slice(0, 600),
          lastErrorCode: typeof error.code === "string" ? error.code : null,
          lastErrorStatus: Number.isFinite(error.status) ? error.status : null,
          lastErrorDetail:
            typeof error.providerDetail === "string" ? error.providerDetail.slice(0, 240) : null,
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
    list: (args) => store.list(args),
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
    setConfig: ({ provider, localEngine, localModel, apiKey, autoStopMinutes }) => {
      if (autoStopMinutes != null && !AUTO_STOP_MINUTES.includes(autoStopMinutes))
        throw new Error("Invalid auto-stop setting");
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
          const nextKey = apiKey.trim();
          fs.writeFileSync(keyPath, safeStorage.encryptString(nextKey), { mode: 0o600 });
          rememberKey(nextKey);
        } else {
          if (fs.existsSync(keyPath)) fs.unlinkSync(keyPath);
          rememberKey("");
        }
      }
      store.index.config = {
        ...store.index.config,
        ...(provider ? { provider } : {}),
        ...(localEngine ? { localEngine } : {}),
        ...(localModel ? { localModel } : {}),
        ...(autoStopMinutes != null ? { autoStopMinutes } : {}),
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
        return await recorder.start(id, { autoStopSeconds: config().autoStopMinutes * 60 });
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
    exportAudio: async ({ id, source = "all" }) => {
      if (recorder.status().id === id) throw new Error("Stop recording before exporting audio");
      const original = store.get(id);
      const inputs = playbackInputs(original, source);
      if (reading.has(id)) throw new Error("Audio is already being prepared");
      reading.add(id);
      try {
        const file = await audioEvidence.prepare(store.directory(id), inputs);
        const title =
          (original.title || "Call audio")
            .replace(/[<>:"/\\|?*\x00-\x1f]/g, "-")
            .replace(/[. ]+$/g, "")
            .slice(0, 100) || "Call audio";
        const result = await dialog.showSaveDialog(windowManager.controlPanelWindow, {
          defaultPath: path.join(app.getPath("downloads"), `${title}.mp3`),
          filters: [{ name: "MP3 audio", extensions: ["mp3"] }],
        });
        if (result.canceled || !result.filePath) return null;
        await fs.promises.copyFile(file, result.filePath);
        return { path: result.filePath };
      } finally {
        reading.delete(id);
      }
    },
    analyzeSpeech: async ({ id }) => {
      if (recorder.status().id === id) throw new Error("Stop recording before trimming");
      const original = store.get(id);
      const audio = (original.audio || []).filter((entry) =>
        fs.existsSync(path.join(store.directory(id), entry.file))
      );
      if (!audio.length) throw new Error("No saved audio is available for this call");
      if (reading.has(id)) throw new Error("Audio is already being prepared");
      reading.add(id);
      try {
        const results = [];
        for (const entry of audio) {
          const result = await analyzeFile(confinedFile(store.directory(id), entry.file));
          const offset = entry.offset || 0;
          results.push({
            end: offset + result.duration,
            segments: result.segments.map((s) => ({
              start: s.start + offset,
              end: s.end + offset,
            })),
          });
        }
        const duration = Math.max(...results.map((r) => r.end));
        const segments = mergeSegments(results.flatMap((r) => r.segments));
        return { duration, segments, suggestions: trimSuggestions(segments, duration) };
      } finally {
        reading.delete(id);
      }
    },
    // Destructive: rewrites the saved audio so playback, export, transcription
    // and later takes all see one consistent, shorter recording.
    trim: async ({ id, end }) => {
      if (!Number.isFinite(end) || end < 1) throw new Error("Invalid trim point");
      if (recorder.status().id === id || starting.has(id))
        throw new Error("Stop recording before trimming");
      if (jobs.has(id) || ["queued", "transcribing", "recording"].includes(store.get(id).status))
        throw new Error("Wait for transcription to finish before trimming");
      if (reading.has(id)) throw new Error("Audio is already being prepared");
      reading.add(id);
      try {
        const original = store.get(id);
        const directory = store.directory(id);
        const ffmpeg = require("ffmpeg-static").replace("app.asar/", "app.asar.unpacked/");
        const keep = [];
        const remove = [];
        for (const entry of original.audio || []) {
          const file = confinedFile(directory, entry.file);
          const length = end - (entry.offset || 0);
          if (length <= 0) {
            remove.push(file);
            continue;
          }
          keep.push(entry);
          if ((await audioDuration(file)) <= length + 0.05) continue;
          const extension = path.extname(file);
          const temporary = path.join(
            path.dirname(file),
            `trim-${crypto.randomUUID()}${extension}`
          );
          try {
            await promisify(execFile)(
              ffmpeg,
              ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", file].concat([
                "-t",
                length.toFixed(3),
                "-map",
                "0:a",
                "-c",
                "copy",
                temporary,
              ]),
              { timeout: 300000, maxBuffer: 512 * 1024 }
            );
            fs.renameSync(temporary, file);
          } finally {
            fs.rmSync(temporary, { force: true });
          }
        }
        if (!keep.length) throw new Error("The trim point is before any saved audio");
        for (const file of remove) fs.rmSync(file, { force: true });
        for (const name of fs.readdirSync(directory)) {
          const full = path.join(directory, name);
          if (/^playback-[a-f0-9]{64}\.mp3$/.test(name)) fs.rmSync(full, { force: true });
          else if (
            /^take-/.test(name) &&
            fs.statSync(full).isDirectory() &&
            !fs.readdirSync(full).length
          )
            fs.rmdirSync(full);
        }
        return store.update(id, {
          audio: keep,
          ...(Number.isFinite(original.recordedDuration)
            ? { recordedDuration: Math.min(original.recordedDuration, end) }
            : {}),
          // The audio list is unchanged for a same-file trim, so cached chunk
          // results would otherwise be reused against different audio.
          transcriptionCache: null,
          needsTranscription: true,
          autoStopped: false,
          lastError: null,
          lastErrorCode: null,
          lastErrorStatus: null,
          lastErrorDetail: null,
          trimmedAt: new Date().toISOString(),
        });
      } finally {
        reading.delete(id);
      }
    },
    transcribe: ({ id, force = false }) => {
      if (typeof force !== "boolean") throw new Error("Invalid transcription request");
      return transcribe(id, { force });
    },
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
