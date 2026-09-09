const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { speakerLabels } = require("../utils/meetingSpeakers.mjs");
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
function atomicJson(file, value) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600, flag: "wx" });
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}
function timestamp(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60]
    .map((v) => String(v).padStart(2, "0"))
    .join(":");
}
function parseTranscript(content) {
  const text = content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const segments = [];
  const time = (s) =>
    s
      .replace(",", ".")
      .split(":")
      .reduce((a, v) => a * 60 + Number(v), 0);
  const pattern =
    /((?:\d{2}:)?\d{2}:\d{2}[.,]\d{3})\s+-->\s+((?:\d{2}:)?\d{2}:\d{2}[.,]\d{3})[^\n]*\n([\s\S]*?)(?=\n\s*\n|$)/g;
  for (const match of text.matchAll(pattern)) {
    let body = match[3].trim();
    const voice = body.match(/^<v\s+([^>]+)>/);
    const named = body.match(/^([^:\n]{1,60}):\s+/);
    const speaker = voice?.[1] || named?.[1] || "";
    body = body.replace(/^<v\s+[^>]+>/, "").replace(/<[^>]*>/g, "");
    if (named && !voice) body = body.slice(named[0].length);
    segments.push({ start: time(match[1]), end: time(match[2]), text: body.trim(), speaker });
  }
  return {
    text: segments.length
      ? segments.map((s) => `${s.speaker ? s.speaker + ": " : ""}${s.text}`).join("\n")
      : text.trim(),
    segments,
  };
}
function renderMarkdown(meeting) {
  const title = meeting.title.replace(/[\r\n]/g, " ").trim() || "Untitled call";
  const segments = meeting.segments || [];
  const labels = speakerLabels(meeting);
  const transcript = meeting.transcriptEdited
    ? meeting.transcript
    : segments.length
      ? segments
          .map((s) => `**[${timestamp(s.start)}] ${labels.get(s.speaker)}:** ${s.text}`)
          .join("\n\n")
      : meeting.transcript;
  return `---\nmeeting_id: ${meeting.id}\ndate: ${JSON.stringify(meeting.createdAt)}\nprovider: ${JSON.stringify(meeting.provider || "import")}\n---\n\n# ${title}\n\n## Notes\n\n${meeting.notes || ""}\n\n## Transcript\n\n${transcript || ""}\n`;
}
class MeetingStore {
  constructor(root) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    if (!fs.lstatSync(root).isDirectory()) throw new Error("Invalid call directory");
    this.root = fs.realpathSync(root);
    root = this.root;
    this.indexPath = path.join(root, "index.json");
    this.index = fs.existsSync(this.indexPath)
      ? JSON.parse(fs.readFileSync(this.indexPath, "utf8"))
      : {
          folders: [],
          config: { provider: "local", localEngine: "nvidia", localModel: "parakeet-tdt-0.6b-v3" },
          ids: [],
        };
    // A native child cannot be resumed after its owning app exited.
    for (const id of this.index.ids) {
      try {
        const item = this.get(id);
        const recovery = {};
        if (["recording", "transcribing", "queued"].includes(item.status))
          recovery.status = "interrupted";
        if (
          item.transcriptionCache?.split &&
          Object.keys(item.transcriptionCache.split).length > 0 &&
          !item.needsTranscription
        )
          recovery.needsTranscription = true;
        if (Object.keys(recovery).length) this.update(id, recovery);
      } catch {
        /* Keep other recoverable drafts accessible. */
      }
    }
  }
  directory(id) {
    if (typeof id !== "string" || !ID.test(id)) throw new Error("Invalid meeting ID");
    return path.join(this.root, id);
  }
  get(id) {
    const directory = this.directory(id);
    if (!this.index.ids.includes(id)) throw new Error("Call no longer exists");
    if (
      !fs.lstatSync(this.root).isDirectory() ||
      fs.realpathSync(this.root) !== this.root ||
      !fs.lstatSync(directory).isDirectory() ||
      fs.realpathSync(directory) !== directory
    )
      throw new Error("Invalid call directory");
    const file = path.join(directory, "session.json");
    if (!fs.lstatSync(file).isFile()) throw new Error("Invalid call file");
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const item = JSON.parse(fs.readFileSync(fd, "utf8"));
      if (item.id !== id) throw new Error("Invalid call identity");
      return item;
    } finally {
      fs.closeSync(fd);
    }
  }
  list() {
    return this.index.ids
      .flatMap((id) => {
        try {
          const {
            id: meetingId,
            title,
            createdAt,
            updatedAt,
            status,
            revision,
            exportPath,
            provider,
          } = this.get(id);
          return [
            { id: meetingId, title, createdAt, updatedAt, status, revision, exportPath, provider },
          ];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  persistIndex() {
    atomicJson(this.indexPath, this.index);
  }
  create() {
    const id = crypto.randomUUID(),
      now = new Date().toISOString();
    const item = {
      id,
      title: "",
      notes: "",
      transcript: "",
      transcriptEdited: false,
      segments: [],
      speakers: {},
      createdAt: now,
      updatedAt: now,
      status: "draft",
      revision: 1,
      provider: this.index.config.provider,
      audio: [],
    };
    fs.mkdirSync(this.directory(id), { mode: 0o700 });
    atomicJson(path.join(this.directory(id), "session.json"), item);
    this.index.ids.unshift(id);
    this.persistIndex();
    return item;
  }
  save(id, patch, revision) {
    const item = this.get(id);
    if (revision !== item.revision)
      throw new Error("Save conflict: this call changed. Reload before saving.");
    const next = {};
    for (const key of ["title", "notes", "transcript"])
      if (Object.hasOwn(patch, key)) {
        if (typeof patch[key] !== "string") throw new Error("Invalid note text");
        if (patch[key].length > (key === "title" ? 200 : 2_000_000))
          throw new Error("Note is too large");
        next[key] = patch[key];
        if (key === "transcript" && patch[key] !== item.transcript) next.transcriptEdited = true;
      }
    if (Object.hasOwn(patch, "speakers")) {
      if (
        !patch.speakers ||
        typeof patch.speakers !== "object" ||
        Array.isArray(patch.speakers) ||
        Object.keys(patch.speakers).length > 300
      )
        throw new Error("Invalid speaker labels");
      next.speakers = Object.fromEntries(
        Object.entries(patch.speakers).map(([key, value]) => {
          if (typeof value !== "string" || value.length > 100 || key.length > 100)
            throw new Error("Invalid speaker label");
          return [key, value];
        })
      );
    }
    return this.update(id, next);
  }
  update(id, patch) {
    const item = this.get(id);
    const next = {
      ...item,
      ...patch,
      id,
      revision: item.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    atomicJson(path.join(this.directory(id), "session.json"), next);
    return next;
  }
  delete(id) {
    const item = this.get(id);
    if (["recording", "queued", "transcribing"].includes(item.status))
      throw new Error("Stop recording and wait for transcription before deleting this call");
    // Synchronous validation, revocation and removal cannot interleave with IPC saves.
    // rm removes symlinks inside this directory, never their external targets.
    this.beforeDelete?.(id);
    fs.rmSync(this.directory(id), { recursive: true });
    this.index.ids = this.index.ids.filter((value) => value !== id);
    this.persistIndex();
    return null;
  }
  folders() {
    return this.index.folders;
  }
  pinFolder(directory) {
    const real = fs.realpathSync(directory);
    if (!fs.statSync(real).isDirectory()) throw new Error("Choose a folder");
    const existing = this.index.folders.find((f) => f.path === real);
    if (existing) return existing;
    const pin = { id: crypto.randomUUID(), name: path.basename(real), path: real };
    this.index.folders.push(pin);
    this.persistIndex();
    return pin;
  }
  unpinFolder(id) {
    this.index.folders = this.index.folders.filter((f) => f.id !== id);
    this.persistIndex();
  }
  file(id, folderId, { asCopy = false } = {}) {
    const item = this.get(id);
    const folder = this.index.folders.find((f) => f.id === folderId);
    if (!folder) throw new Error("Select a pinned folder");
    if (fs.realpathSync(folder.path) !== folder.path)
      throw new Error("The destination folder moved");
    const content = renderMarkdown(item);
    let destination;
    if (!asCopy && item.exportFolderId === folderId && item.exportPath) {
      destination = item.exportPath;
      if (path.dirname(destination) !== folder.path) throw new Error("Invalid destination");
      if (
        !fs.existsSync(destination) ||
        fs.lstatSync(destination).isSymbolicLink() ||
        hash(fs.readFileSync(destination)) !== item.exportHash
      )
        throw new Error(
          "This file changed outside ScottySpeaks. Use Save a copy to keep both versions."
        );
      const temp = path.join(folder.path, `.${crypto.randomUUID()}.tmp`);
      try {
        fs.writeFileSync(temp, content, { mode: 0o600, flag: "wx" });
        if (hash(fs.readFileSync(destination)) !== item.exportHash)
          throw new Error("This file changed outside ScottySpeaks.");
        fs.renameSync(temp, destination);
      } finally {
        if (fs.existsSync(temp)) fs.unlinkSync(temp);
      }
    } else {
      const name =
        (item.title.trim() || "Call")
          .replace(/[<>:"/\\|?*\x00-\x1f]/g, "-")
          .replace(/[. ]+$/g, "")
          .slice(0, 100) || "Call";
      const base = `${item.createdAt.slice(0, 10)} ${name}`;
      for (let i = 0; i < 1000; i++) {
        destination = path.join(folder.path, `${base}${i ? ` (${i + 1})` : ""}.md`);
        try {
          fs.writeFileSync(destination, content, { mode: 0o600, flag: "wx" });
          break;
        } catch (e) {
          if (e.code !== "EEXIST" || i === 999) throw e;
        }
      }
    }
    const meeting = this.update(id, {
      exportPath: destination,
      exportHash: hash(content),
      exportFolderId: folderId,
    });
    return { path: destination, meeting };
  }
}
module.exports = { MeetingStore, parseTranscript, renderMarkdown, timestamp };
