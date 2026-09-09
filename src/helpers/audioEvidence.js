const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Readable } = require("stream");
const { execFile } = require("child_process");
const { promisify } = require("util");
const run = promisify(execFile);
const AUDIO_NAME = /^(?:[a-zA-Z0-9_-]+\/)?[a-zA-Z0-9_-]+\.(caf|wav|mp3|m4a|mp4|webm|ogg|flac)$/;
function playbackInputs(meeting, source = "all") {
  if (!["all", "microphone", "system", "audio"].includes(source))
    throw new Error("Invalid playback source");
  return (meeting.audio || [])
    .filter((entry) => source === "all" || entry.source === source)
    .map((entry) => {
      if (typeof entry.file !== "string" || !AUDIO_NAME.test(entry.file))
        throw new Error("Invalid audio file");
      const offset = entry.offset ?? 0;
      if (!Number.isFinite(offset) || offset < 0 || offset > 21600)
        throw new Error("Invalid audio offset");
      return { file: entry.file, offset };
    });
}
function confinedFile(directory, relative) {
  if (!AUDIO_NAME.test(relative)) throw new Error("Invalid audio file");
  const root = fs.realpathSync(directory);
  const file = path.join(root, relative);
  const resolved = fs.realpathSync(file);
  if (!resolved.startsWith(root + path.sep) || !fs.lstatSync(file).isFile())
    throw new Error("Invalid audio file");
  return file;
}
class AudioEvidence {
  constructor({ now = Date.now, ttl = 8 * 3600 * 1000 } = {}) {
    this.now = now;
    this.ttl = ttl;
    this.tokens = new Map();
    this.preparing = new Map();
  }
  issue(resolveFile) {
    for (const [token, value] of this.tokens)
      if (this.now() >= value.expiresAt) this.tokens.delete(token);
    if (this.tokens.size >= 128) this.tokens.delete(this.tokens.keys().next().value);
    const token = crypto.randomBytes(32).toString("hex");
    this.tokens.set(token, { resolveFile, expiresAt: this.now() + this.ttl });
    return `ss2-audio://playback/${token}`;
  }
  revoke(url) {
    try {
      this.tokens.delete(new URL(url).pathname.slice(1));
    } catch {}
  }
  async handle(request) {
    let fd;
    try {
      const url = new URL(request.url);
      if (
        url.protocol !== "ss2-audio:" ||
        url.hostname !== "playback" ||
        !/^\/[a-f0-9]{64}$/.test(url.pathname)
      )
        return new Response(null, { status: 404 });
      const entry = this.tokens.get(url.pathname.slice(1));
      if (!entry || this.now() >= entry.expiresAt) return new Response(null, { status: 404 });
      if (!["GET", "HEAD"].includes(request.method)) return new Response(null, { status: 405 });
      const file = entry.resolveFile();
      // Open before streaming and refuse symlinks; an expired/replaced source cannot
      // turn a previously issued media URL into an arbitrary filesystem read.
      fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size === 0) throw new Error("Audio unavailable");
      const size = stat.size;
      let start = 0,
        end = size - 1,
        status = 200;
      const headers = {
        "Content-Type": "audio/mpeg",
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
      };
      const range = request.headers.get("range");
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        const invalid = () =>
          new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
        if (!match || (!match[1] && !match[2])) return invalid();
        if (!match[1]) {
          const length = Number(match[2]);
          if (!Number.isSafeInteger(length) || length <= 0) return invalid();
          start = Math.max(0, size - length);
        } else {
          start = Number(match[1]);
          if (match[2]) end = Math.min(size - 1, Number(match[2]));
        }
        if (
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(end) ||
          start < 0 ||
          end < start ||
          start >= size
        )
          return invalid();
        status = 206;
        headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
      }
      headers["Content-Length"] = String(end - start + 1);
      if (request.method === "HEAD") return new Response(null, { status, headers });
      const stream = fs.createReadStream(file, { fd, autoClose: true, start, end });
      fd = undefined; // stream owns the descriptor, including cancellation cleanup
      return new Response(Readable.toWeb(stream), { status, headers });
    } catch {
      return new Response(null, { status: 404 });
    } finally {
      if (fd != null) fs.closeSync(fd);
    }
  }
  async prepare(directory, inputs) {
    directory = fs.realpathSync(directory);
    if (!inputs.length || inputs.length > 128)
      throw new Error("No playable audio or too many recording takes");
    const resolved = inputs.map((input) => {
      if (!Number.isFinite(input.offset) || input.offset < 0 || input.offset > 21600)
        throw new Error("Invalid audio offset");
      const file = confinedFile(directory, input.file);
      const stat = fs.statSync(file);
      return { ...input, path: file, size: stat.size, mtime: stat.mtimeMs };
    });
    const signature = crypto.createHash("sha256").update(JSON.stringify(resolved)).digest("hex");
    const filename = `playback-${signature}.mp3`;
    const output = path.join(directory, filename);
    if (fs.existsSync(output)) return confinedFile(directory, filename);
    if (this.preparing.has(output)) return this.preparing.get(output);
    const work = (async () => {
      const temporary = path.join(directory, `playback-${crypto.randomUUID()}.tmp.mp3`);
      try {
        const args = ["-hide_banner", "-loglevel", "error", "-nostdin"];
        for (const input of resolved) args.push("-i", input.path);
        const filters = resolved.map(
          (input, index) => `[${index}:a]adelay=${Math.round(input.offset * 1000)}:all=1[a${index}]`
        );
        filters.push(
          resolved.map((_, index) => `[a${index}]`).join("") +
            `amix=inputs=${resolved.length}:duration=longest:normalize=0[mix]`
        );
        args.push(
          "-filter_complex",
          filters.join(";"),
          "-map",
          "[mix]",
          "-vn",
          "-ac",
          "1",
          "-ar",
          "16000",
          "-c:a",
          "libmp3lame",
          "-b:a",
          "64k",
          "-t",
          "43200",
          temporary
        );
        await run(require("ffmpeg-static").replace("app.asar/", "app.asar.unpacked/"), args, {
          timeout: 300000,
          maxBuffer: 512 * 1024,
        });
        fs.chmodSync(temporary, 0o600);
        fs.renameSync(temporary, output);
        return output;
      } finally {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
      }
    })();
    this.preparing.set(output, work);
    try {
      return await work;
    } finally {
      this.preparing.delete(output);
    }
  }
}
module.exports = { AudioEvidence, playbackInputs, confinedFile };
