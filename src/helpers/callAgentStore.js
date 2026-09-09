const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function id(value) {
  if (typeof value !== "string" || !ID.test(value)) throw new Error("Invalid ID");
  return value;
}
function text(value, max, name) {
  if (typeof value !== "string" || Buffer.byteLength(value) > max)
    throw new Error(`Invalid ${name}`);
  return value;
}
function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function read(file) {
  if (!fs.lstatSync(file).isFile()) throw new Error("Expected a regular data file");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 8 * 1024 ** 2) throw new Error("Data file too large");
    return JSON.parse(fs.readFileSync(fd, "utf8"));
  } finally {
    fs.closeSync(fd);
  }
}
function atomic(file, value) {
  const temporary = file + "." + crypto.randomUUID() + ".tmp";
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
function buildCallEvidence(callId, call) {
  id(callId);
  if (call.id !== callId) throw new Error("Invalid call identity");
  const title = text(call.title || "", 1000, "title"),
    notes = text(call.notes || "", 1000000, "notes"),
    transcript = text(call.transcript || "", 2000000, "transcript");
  if (!Array.isArray(call.segments) || call.segments.length > 20000)
    throw new Error("Too much call evidence");
  const labels = require("../utils/meetingSpeakers.mjs").speakerLabels(call);
  const evidence = call.segments.map((segment, index) => {
    if (
      !Number.isFinite(segment.start) ||
      !Number.isFinite(segment.end) ||
      segment.start < 0 ||
      segment.end < segment.start ||
      segment.end > 43200
    )
      throw new Error("Invalid evidence timing");
    const speaker = text(labels.get(segment.speaker), 200, "speaker");
    return {
      id: `segment-${index}`,
      kind: "original-transcript",
      start: segment.start,
      end: segment.end,
      speaker,
      speakerId: text(segment.speaker || "", 200, "speaker identity"),
      text: text(segment.text, 20000, "evidence text"),
    };
  });
  const paragraphs = (value, kind) =>
    value
      .split(/\n\s*\n/)
      .filter((part) => part.trim())
      .map((part, index) => ({
        id: `${kind}-${index}`,
        kind,
        start: null,
        end: null,
        speaker: "",
        text: part,
      }));
  if (!evidence.length || call.transcriptEdited)
    evidence.push(...paragraphs(transcript, "transcript"));
  evidence.push(...paragraphs(notes, "notes"));
  const content = {
    id: callId,
    title,
    createdAt: call.createdAt,
    revision: call.revision,
    notes,
    transcript,
    transcriptEdited: !!call.transcriptEdited,
    evidence,
  };
  if (Buffer.byteLength(JSON.stringify(content)) > 4 * 1024 ** 2)
    throw new Error("Call is too large for agent access; export Markdown instead");
  const sourceVersion = digest(content);
  for (const item of evidence) item.id = `${sourceVersion.slice(0, 16)}:${item.id}`;
  return { ...content, sourceVersion };
}
class CallAgentStore {
  constructor(root, { readCall, now = Date.now }) {
    if (fs.existsSync(root) && !fs.lstatSync(root).isDirectory())
      throw new Error("Expected a regular agent directory");
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    this.root = fs.realpathSync(root);
    this.readCall = readCall;
    this.now = now;
    for (const kind of ["grants", "drafts"]) this.directory(kind);
  }
  directory(kind) {
    if (!["grants", "drafts"].includes(kind) || fs.realpathSync(this.root) !== this.root)
      throw new Error("Invalid agent directory");
    const directory = path.join(this.root, kind);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!fs.lstatSync(directory).isDirectory())
      throw new Error("Expected a regular agent directory");
    return directory;
  }
  file(kind, value) {
    return path.join(this.directory(kind), id(value) + ".json");
  }
  permission(callId) {
    const file = this.file("grants", callId);
    if (!fs.existsSync(file)) throw new Error("This call is not shared with agents");
    const grant = read(file);
    if (grant.callId !== callId) throw new Error("Invalid permission identity");
    id(grant.id);
    return grant;
  }
  grant(callId) {
    id(callId);
    const call = this.readCall(callId);
    if (call.id !== callId) throw new Error("Invalid call identity");
    const file = this.file("grants", callId);
    if (fs.existsSync(file)) return this.permission(callId);
    const grant = {
      id: crypto.randomUUID(),
      callId,
      createdAt: new Date(this.now()).toISOString(),
    };
    atomic(file, grant);
    return grant;
  }
  revoke(callId) {
    const file = this.file("grants", callId);
    if (fs.existsSync(file)) {
      this.permission(callId);
      fs.unlinkSync(file);
    }
  }
  read(callId) {
    const grant = this.permission(callId),
      call = this.readCall(callId);
    const content = buildCallEvidence(callId, call);
    // Permission is re-read immediately before returning source content.
    if (this.permission(callId).id !== grant.id) throw new Error("Call sharing permission changed");
    return { ...content, grantId: grant.id, sharedAt: grant.createdAt };
  }
  list() {
    return fs
      .readdirSync(this.directory("grants"))
      .filter((name) => name.endsWith(".json") && ID.test(name.slice(0, -5)))
      .flatMap((name) => {
        try {
          const value = this.read(name.slice(0, -5));
          return [
            {
              id: value.id,
              title: value.title,
              grantId: value.grantId,
              sourceVersion: value.sourceVersion,
              sharedAt: value.sharedAt,
            },
          ];
        } catch {
          return [];
        }
      });
  }
  submitDraft({ callId, grantId, sourceVersion, title, body, citations }) {
    const current = this.read(callId);
    if (current.grantId !== grantId)
      throw new Error("Call sharing permission changed; read the call again");
    if (current.sourceVersion !== sourceVersion)
      throw new Error("Call evidence changed; read the call again");
    text(title, 1000, "draft title");
    text(body, 200000, "draft body");
    if (
      !title.trim() ||
      !body.trim() ||
      !Array.isArray(citations) ||
      !citations.length ||
      citations.length > 100
    )
      throw new Error("Draft requires title, body and evidence citations");
    const references = [...new Set(citations)].map((reference) => {
      if (typeof reference !== "string") throw new Error("Invalid evidence reference");
      const evidence = current.evidence.find((item) => item.id === reference);
      if (!evidence) throw new Error("Unknown evidence reference");
      return {
        evidenceId: evidence.id,
        kind: evidence.kind,
        start: evidence.start,
        end: evidence.end,
        speaker: evidence.speaker,
        quote: evidence.text,
      };
    });
    const draft = {
      id: crypto.randomUUID(),
      callId,
      grantId,
      sourceVersion,
      createdAt: new Date(this.now()).toISOString(),
      title,
      body,
      citations: references,
      revision: 1,
    };
    if (Buffer.byteLength(JSON.stringify(draft)) > 512 * 1024)
      throw new Error("Draft evidence is too large; cite shorter passages");
    const check = this.read(callId);
    if (check.grantId !== grantId || check.sourceVersion !== sourceVersion)
      throw new Error("Call evidence or permission changed");
    atomic(this.file("drafts", draft.id), draft);
    return draft;
  }
  getDraft(draftId) {
    const value = read(this.file("drafts", draftId));
    if (value.id !== draftId) throw new Error("Invalid draft identity");
    return value;
  }
  listDrafts(callId, { summaries = false } = {}) {
    id(callId);
    return fs
      .readdirSync(this.directory("drafts"))
      .filter((name) => name.endsWith(".json") && ID.test(name.slice(0, -5)))
      .flatMap((name) => {
        try {
          const value = this.getDraft(name.slice(0, -5));
          return value.callId === callId
            ? [summaries ? { id: value.id, title: value.title, createdAt: value.createdAt } : value]
            : [];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  deleteCall(callId) {
    id(callId);
    const drafts = this.listDrafts(callId);
    this.revoke(callId);
    for (const draft of drafts) this.deleteDraft(draft.id);
  }
  deleteDraft(draftId) {
    this.getDraft(draftId);
    fs.unlinkSync(this.file("drafts", draftId));
  }
}
module.exports = { CallAgentStore, buildCallEvidence };
