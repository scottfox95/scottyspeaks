const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const RETENTION = [0, 1, 7, 30];
const TYPES = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
};
function text(value, name, limit = 2_000_000) {
  if (typeof value !== "string" || value.length > limit) throw new Error(`Invalid ${name}`);
  return value;
}
function regular(file) {
  if (!fs.lstatSync(file).isFile()) throw new Error("Evidence must be a regular file");
  return file;
}
function json(file) {
  return JSON.parse(fs.readFileSync(regular(file), "utf8"));
}
function atomic(file, value) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), { flag: "wx", mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}
function snapshot(settings = {}) {
  const result = {};
  for (const key of ["provider", "model", "language", "styleId", "styleName", "polishModel", "polishProvider"])
    if (settings[key] != null) result[key] = text(settings[key], key, 200);
  if (Array.isArray(settings.dictionary)) result.dictionary = settings.dictionary.slice(0, 500).map(v => text(v, "dictionary word", 200));
  if (settings.styleRules && typeof settings.styleRules === "object") {
    result.styleRules = {};
    for (const key of ["removeFillers", "autoPunctuation", "aiPolish"])
      if (typeof settings.styleRules[key] === "boolean") result.styleRules[key] = settings.styleRules[key];
    for (const key of ["capitalization", "formality", "greeting", "signoff", "instructions"])
      if (settings.styleRules[key] != null) result.styleRules[key] = text(settings.styleRules[key], key, 8000);
  }
  result.cleanup = {};
  for (const key of ["exact", "removeFillers", "resolveCorrections", "preserveTechnical"])
    if (typeof settings.cleanup?.[key] === "boolean") result.cleanup[key] = settings.cleanup[key];
  return result;
}
class CaptureStore {
  constructor(root, { now = Date.now } = {}) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    this.root = fs.realpathSync(root);
    this.now = now;
    this.configPath = path.join(this.root, "settings.json");
    this.retentionDays = fs.existsSync(this.configPath) ? json(this.configPath).retentionDays : 7;
    if (!RETENTION.includes(this.retentionDays))
      throw new Error("Invalid capture retention policy");
    if (!fs.existsSync(this.configPath))
      atomic(this.configPath, { retentionDays: this.retentionDays });
    // No conversion jobs survive process restart. Remove only recognized work names,
    // including those belonging to captures whose original audio already expired.
    for (const id of fs.readdirSync(this.root).filter((name) => ID.test(name))) {
      try {
        this.cleanupWork(id);
      } catch {}
    }
  }
  directory(id) {
    if (typeof id !== "string" || !ID.test(id)) throw new Error("Invalid capture ID");
    const directory = path.join(this.root, id);
    if (fs.existsSync(directory) && !fs.lstatSync(directory).isDirectory())
      throw new Error("Evidence directory must be a regular directory");
    return directory;
  }
  get(id) {
    const value = json(path.join(this.directory(id), "capture.json"));
    if (value.id !== id) throw new Error("Capture identity mismatch");
    return value;
  }
  persist(value) {
    atomic(path.join(this.directory(value.id), "capture.json"), value);
    return value;
  }
  list() {
    return fs
      .readdirSync(this.root)
      .filter((id) => ID.test(id))
      .flatMap((id) => {
        try {
          return [this.get(id)];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  forHistory(historyId) {
    if (!Number.isSafeInteger(historyId) || historyId < 1) throw new Error("Invalid history ID");
    return this.list().find((capture) => capture.historyId === historyId) || null;
  }
  create({ audio, mimeType, durationSeconds, settings }) {
    const extension = TYPES[String(mimeType).split(";")[0].trim().toLowerCase()];
    if (!extension) throw new Error("Unsupported capture audio format");
    if (!Buffer.isBuffer(audio) || !audio.length || audio.length > 64 * 1024 ** 2)
      throw new Error("Capture audio must be between 1 byte and 64 MB");
    if (!Number.isFinite(durationSeconds) || durationSeconds < 0 || durationSeconds > 6 * 3600)
      throw new Error("Invalid audio duration");
    const capturedSettings = snapshot(settings);
    const id = crypto.randomUUID();
    fs.mkdirSync(this.directory(id), { mode: 0o700 });
    const value = {
      id,
      createdAt: new Date(this.now()).toISOString(),
      durationSeconds,
      mimeType: String(mimeType).split(";")[0],
      settings: capturedSettings,
      status: "processing",
      rawText: "",
      finalText: "",
      attempts: [],
      audioFile: `audio.${extension}`,
      audioAvailable: this.retentionDays > 0,
      audioUnavailableReason: this.retentionDays ? null : "disabled",
    };
    try {
      if (value.audioAvailable)
        fs.writeFileSync(path.join(this.directory(id), value.audioFile), audio, {
          flag: "wx",
          mode: 0o600,
        });
      return this.persist(value);
    } catch (error) {
      fs.rmSync(this.directory(id), { recursive: true, force: true });
      throw error;
    }
  }
  complete(id, { rawText = "", finalText = "", historyId, error }) {
    const value = this.get(id);
    if (value.status !== "processing") throw new Error("Capture already finalized");
    if (historyId != null && (!Number.isSafeInteger(historyId) || historyId < 1))
      throw new Error("Invalid history ID");
    return this.persist({
      ...value,
      rawText: text(rawText, "raw text"),
      finalText: text(finalText, "final text"),
      historyId: historyId ?? null,
      status: error ? "failed" : "ready",
      error: error ? text(error, "error", 1000) : null,
    });
  }
  audioPath(id) {
    const value = this.get(id);
    if (!value.audioAvailable) throw new Error("Original audio is unavailable");
    if (!/^audio\.(webm|ogg|wav|m4a|mp3)$/.test(value.audioFile))
      throw new Error("Invalid capture audio file");
    return regular(path.join(this.directory(id), value.audioFile));
  }
  addAttempt(id, attempt) {
    const value = this.get(id);
    if (value.attempts.length >= 50) throw new Error("Capture retry history is full");
    const candidate = {
      id: crypto.randomUUID(),
      createdAt: new Date(this.now()).toISOString(),
      settings: snapshot(attempt.settings || attempt),
      rawText: text(attempt.rawText, "raw text"),
      finalText: text(attempt.finalText, "final text"),
    };
    this.persist({ ...value, attempts: [...value.attempts, candidate] });
    return candidate;
  }
  acceptAttempt(id, attemptId) {
    const value = this.get(id);
    const candidate = value.attempts.find((attempt) => attempt.id === attemptId);
    if (!candidate) throw new Error("Unknown transcription attempt");
    return this.persist({
      ...value,
      acceptedAttemptId: candidate.id,
      acceptedText: candidate.finalText,
    });
  }
  saveFixture(id, expected) {
    const value = this.get(id);
    text(expected, "corrected text");
    if (!expected.trim()) throw new Error("Corrected text cannot be empty");
    const fixtureId = crypto.randomUUID();
    const fixtures = path.join(this.root, "fixtures");
    fs.mkdirSync(fixtures, { recursive: true, mode: 0o700 });
    if (!fs.lstatSync(fixtures).isDirectory()) throw new Error("Invalid fixture directory");
    const directory = path.join(fixtures, fixtureId);
    fs.mkdirSync(directory, { mode: 0o700 });
    try {
      const record = {
        version: 1,
        id: fixtureId,
        captureId: id,
        createdAt: new Date(this.now()).toISOString(),
        rawText: value.rawText,
        finalText: value.finalText,
        expected,
        settings: value.settings,
        audioFile: null,
      };
      if (value.audioAvailable) {
        fs.copyFileSync(
          this.audioPath(id),
          path.join(directory, value.audioFile),
          fs.constants.COPYFILE_EXCL
        );
        fs.chmodSync(path.join(directory, value.audioFile), 0o600);
        record.audioFile = value.audioFile;
      }
      const file = path.join(directory, "fixture.json");
      atomic(file, record);
      this.persist({
        ...value,
        correctedText: expected,
        fixtureIds: [...(value.fixtureIds || []), fixtureId],
      });
      return { id: fixtureId, path: file };
    } catch (error) {
      fs.rmSync(directory, { recursive: true, force: true });
      throw error;
    }
  }
  fixtureDirectory(id) {
    if (typeof id !== "string" || !ID.test(id)) throw new Error("Invalid fixture ID");
    const root = path.join(this.root, "fixtures");
    if (!fs.lstatSync(root).isDirectory()) throw new Error("Invalid fixture directory");
    const directory = path.join(root, id);
    if (!fs.lstatSync(directory).isDirectory()) throw new Error("Invalid fixture directory");
    const record = json(path.join(directory, "fixture.json"));
    if (record.id !== id) throw new Error("Fixture identity mismatch");
    return { directory, record };
  }
  listFixtures() {
    const root = path.join(this.root, "fixtures");
    if (!fs.existsSync(root)) return [];
    if (!fs.lstatSync(root).isDirectory()) throw new Error("Invalid fixture directory");
    return fs
      .readdirSync(root)
      .filter((id) => ID.test(id))
      .flatMap((id) => {
        try {
          const { record } = this.fixtureDirectory(id);
          return [
            {
              id,
              createdAt: record.createdAt,
              captureId: record.captureId,
              expected: record.expected,
            },
          ];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  deleteFixture(id) {
    const { directory } = this.fixtureDirectory(id);
    fs.rmSync(directory, { recursive: true, force: true });
  }
  delete(id) {
    this.get(id);
    fs.rmSync(this.directory(id), { recursive: true, force: true });
  }
  deleteForHistory(historyId) {
    for (const value of this.list()) if (value.historyId === historyId) this.delete(value.id);
  }
  clearHistoryCaptures() {
    for (const value of this.list()) if (value.historyId != null) this.delete(value.id);
  }
  setRetentionDays(days) {
    if (!RETENTION.includes(days)) throw new Error("Invalid capture retention policy");
    atomic(this.configPath, { retentionDays: days });
    this.retentionDays = days;
    this.prune();
    return { retentionDays: days };
  }
  cleanupWork(id) {
    const directory = this.directory(id);
    for (const name of fs.readdirSync(directory)) {
      if (
        !/^retry-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(name) &&
        !/^playback-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.tmp\.mp3$/.test(
          name
        )
      )
        continue;
      // rm never traverses a symbolic link; unexpected work-name links are removed.
      fs.rmSync(path.join(directory, name), { recursive: true, force: true });
    }
  }
  prune() {
    for (const value of this.list()) {
      if (
        value.audioAvailable &&
        this.retentionDays &&
        this.now() - Date.parse(value.createdAt) < this.retentionDays * 86400000
      )
        continue;
      this.onAudioRemoved?.(value.id);
      this.cleanupWork(value.id);
      // Include already unavailable captures: a previously interrupted conversion
      // must never make fresh derived audio exempt from the retention policy.
      for (const name of fs.readdirSync(this.directory(value.id))) {
        if (!/^(audio\.(webm|ogg|wav|m4a|mp3)|playback-[a-f0-9]{64}\.mp3)$/.test(name)) continue;
        const file = path.join(this.directory(value.id), name);
        fs.unlinkSync(regular(file));
      }
      if (value.audioAvailable)
        this.persist({
          ...value,
          audioAvailable: false,
          audioUnavailableReason: this.retentionDays ? "expired" : "disabled",
        });
    }
  }
}
module.exports = { CaptureStore };
