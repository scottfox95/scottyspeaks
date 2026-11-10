const fs = require("fs");
const path = require("path");

// Why each paste landed or didn't: app, AX role, outcome and reason. Shown in
// Settings → Developer → Diagnostics. Never stores transcript text.
const MAX_ENTRIES = 200;
const SAFE_REASON = /^[a-z-]{1,80}$/;

const clip = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");

class PasteOutcomeLog {
  constructor(file) {
    this.file = file;
    this.entries = null;
  }

  _load() {
    if (this.entries) return this.entries;
    this.entries = [];
    try {
      for (const line of fs.readFileSync(this.file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          this.entries.push(JSON.parse(line));
        } catch {}
      }
    } catch {}
    this.entries = this.entries.slice(-MAX_ENTRIES);
    return this.entries;
  }

  record(outcome = {}) {
    const entry = {
      at: new Date().toISOString(),
      source: clip(outcome.source, 40) || "dictation",
      app: clip(outcome.appName, 80),
      bundleId: clip(outcome.bundleId, 120),
      role: clip(outcome.role, 40),
      ok: outcome.success === true,
      reason:
        outcome.success === true
          ? ""
          : SAFE_REASON.test(outcome.reason || "")
            ? outcome.reason
            : "unknown",
      onClipboard: outcome.onClipboard === true,
      ms: Number.isFinite(outcome.ms) ? Math.round(outcome.ms) : null,
      chars: Number.isFinite(outcome.chars) ? outcome.chars : null,
    };
    const entries = this._load();
    entries.push(entry);
    const trimmed = entries.length > MAX_ENTRIES;
    if (trimmed) this.entries = entries.slice(-MAX_ENTRIES);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      if (trimmed)
        fs.writeFileSync(this.file, this.entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
      else fs.appendFileSync(this.file, JSON.stringify(entry) + "\n");
    } catch {}
    return entry;
  }

  list(limit = 50) {
    return this._load().slice(-limit).reverse();
  }
}

module.exports = { PasteOutcomeLog };
