const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const run = promisify(execFile);
const CHUNK_SECONDS = 120;
function transcriptionError(message, code, status, providerDetail) {
  const error = new Error(message);
  error.code = code;
  if (Number.isFinite(status)) error.status = status;
  if (providerDetail) error.providerDetail = providerDetail;
  return error;
}
async function readProviderDetail(response, apiKey) {
  if (typeof response?.text !== "function") return "";
  let raw;
  try {
    raw = await response.text();
  } catch {
    return "";
  }
  if (typeof raw !== "string" || !raw.trim()) return "";
  let detail = raw;
  try {
    const parsed = JSON.parse(raw);
    detail =
      parsed?.error?.message ??
      parsed?.message ??
      (typeof parsed?.error === "string" ? parsed.error : "");
  } catch {}
  if (typeof detail !== "string") return "";
  if (apiKey) detail = detail.split(apiKey).join("[redacted]");
  return detail
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk-or-v1-|sk-)[A-Za-z0-9_-]{12,}\b/g, "[redacted]")
    .replace(
      /data:audio\/[a-z0-9.+-]+;base64,(?:[A-Za-z0-9+/=]{20,}[ \t\r\n]*){2,}[A-Za-z0-9+/=]{0,19}/gi,
      "[audio redacted]"
    )
    .replace(/(?:[A-Za-z0-9+/=]{20,}[ \t\r\n]+){2,}[A-Za-z0-9+/=]{20,}/g, "[redacted]")
    .replace(/[A-Za-z0-9+/=_-]{80,}/g, "[redacted]")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}
function normalizeTranscript(data, offset = 0, chunkId = "chunk", duration = CHUNK_SECONDS) {
  if (!data || typeof data.text !== "string")
    throw new Error("Provider returned an invalid transcript");
  const normalize = (entry, word = false) => {
    if (
      !entry ||
      !Number.isFinite(entry.start) ||
      !Number.isFinite(entry.end) ||
      entry.start < 0 ||
      entry.end < entry.start ||
      entry.end > duration + 2
    )
      throw new Error("Provider returned invalid timestamps");
    const text = word ? entry.word : entry.text;
    if (typeof text !== "string") throw new Error("Provider returned invalid transcript text");
    return {
      ...(word ? { word: text } : { text }),
      start: entry.start + offset,
      end: entry.end + offset,
      speaker: entry.speaker == null ? "" : `${chunkId}:${String(entry.speaker).slice(0, 60)}`,
    };
  };
  if (data.segments != null && !Array.isArray(data.segments))
    throw new Error("Provider returned invalid transcript segments");
  if (data.words != null && !Array.isArray(data.words))
    throw new Error("Provider returned invalid transcript words");
  return {
    text: data.text,
    segments: (data.segments || []).map((s) => normalize(s)),
    words: (data.words || []).map((s) => normalize(s, true)),
  };
}
async function transcribeChunk({
  provider,
  audio,
  apiKey,
  offset = 0,
  chunkId = "chunk",
  source = "audio",
  duration = CHUNK_SECONDS,
  localTranscribe,
  fetchImpl = fetch,
  signal,
  keywords = [],
  audioFormat = "wav",
}) {
  if (provider === "local") {
    const result = await localTranscribe(audio);
    if (!result?.success)
      throw new Error(result?.error || result?.message || "Local transcription failed");
    const text = result.text || "";
    // Word timings (Parakeet on CoreML) let the job attribute words to diarized
    // speakers; `timed` distinguishes "no words spoken" from "no timings".
    const timed = Array.isArray(result.words);
    return {
      text,
      segments: text ? [{ text, start: offset, end: offset + duration, speaker: source }] : [],
      words: timed
        ? result.words
            .filter(
              (w) =>
                typeof w?.word === "string" && Number.isFinite(w.start) && Number.isFinite(w.end)
            )
            .map((w) => ({
              word: w.word,
              start: offset + w.start,
              end: offset + Math.max(w.start, w.end),
              speaker: source,
            }))
        : [],
      ...(timed ? { timed: true } : {}),
    };
  }
  if (provider !== "openrouter") throw new Error("Unknown transcription provider");
  if (!apiKey) throw new Error("Add an OpenRouter API key in Call notes settings");
  // Long-form transcription commonly takes more than a minute. Allow roughly
  // one second per ten seconds of audio, bounded so cancellation stays useful.
  const timeout = AbortSignal.timeout(
    Math.min(600_000, Math.max(60_000, Math.round(duration * 100)))
  );
  const response = await fetchImpl("https://openrouter.ai/api/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    body: JSON.stringify({
      model: "microsoft/mai-transcribe-2",
      input_audio: { data: audio.toString("base64"), format: audioFormat },
      response_format: "verbose_json",
      timestamp_granularities: ["segment", "word"],
      provider: {
        options: {
          azure: {
            diarization: { enabled: true },
            ...(keywords.length ? { phraseList: { phrases: keywords.slice(0, 50) } } : {}),
          },
        },
      },
    }),
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403)
      throw transcriptionError(
        `OpenRouter rejected the API key (${response.status}).`,
        "openrouterAuth",
        response.status
      );
    if (response.status === 402)
      throw transcriptionError(
        "OpenRouter account needs credit (402).",
        "openrouterCredit",
        response.status
      );
    const providerDetail = await readProviderDetail(response, apiKey);
    throw transcriptionError(
      `OpenRouter transcription failed (${response.status}).${providerDetail ? ` ${providerDetail}` : ""}`,
      "openrouterFailed",
      response.status,
      providerDetail
    );
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw transcriptionError("OpenRouter returned no usable transcript.", "openrouterEmpty");
  }
  const segmentText = Array.isArray(data?.segments)
    ? data.segments
        .map((segment) => (typeof segment?.text === "string" ? segment.text.trim() : ""))
        .filter(Boolean)
        .join(" ")
    : "";
  const hasText = typeof data?.text === "string" && !!data.text.trim();
  if (!hasText && !segmentText)
    throw transcriptionError("OpenRouter returned no usable transcript.", "openrouterEmpty");
  if (!hasText) data = { ...data, text: segmentText };
  const result = normalizeTranscript(data, offset, chunkId, duration);
  if (result.text && !result.segments.length)
    result.segments = [{ text: result.text, start: offset, end: offset + duration, speaker: "" }];
  return result;
}
function ffmpegPath() {
  return require("ffmpeg-static").replace("app.asar/", "app.asar.unpacked/");
}
async function prepareChunks(inputs, directory, { mix = false, cloud = false, source } = {}) {
  fs.mkdirSync(directory, { recursive: true });
  // A fresh work directory is supplied for each job; partial files are never reused.
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin"];
  for (const input of inputs) args.push("-i", input.path);
  if (mix && inputs.length > 1) args.push("-filter_complex", mixFilter(inputs.length));
  args.push(
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    cloud ? "libmp3lame" : "pcm_s16le",
    ...(cloud ? ["-b:a", "32k"] : []),
    "-f",
    "segment",
    "-segment_time",
    String(cloud ? 3600 : CHUNK_SECONDS),
    "-reset_timestamps",
    "1",
    path.join(directory, cloud ? "chunk-%05d.mp3" : "chunk-%05d.wav")
  );
  await run(ffmpegPath(), args, { timeout: 300000, maxBuffer: 512 * 1024 });
  return fs
    .readdirSync(directory)
    .filter((name) => /^chunk-\d{5}\.(wav|mp3)$/.test(name))
    .sort()
    .map((name, index) => ({
      path: path.join(directory, name),
      offset: index * (cloud ? 3600 : CHUNK_SECONDS),
      format: cloud ? "mp3" : "wav",
      source: source || inputs[0].source,
    }));
}
function mixFilter(count) {
  return `amix=inputs=${count}:duration=longest:dropout_transition=0:normalize=1`;
}
/// One 16kHz mono WAV of a whole synchronized group, mixed exactly like the
/// transcription chunks, so diarization sees the same audio as the transcriber.
async function prepareDiarizationAudio(inputs, file) {
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y"];
  for (const input of inputs) args.push("-i", input.path);
  if (inputs.length > 1) args.push("-filter_complex", mixFilter(inputs.length));
  args.push("-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", file);
  await run(ffmpegPath(), args, { timeout: 300000, maxBuffer: 512 * 1024 });
  return file;
}
/// Raw 16kHz mono s16le of one track, for comparing microphone and call levels.
async function prepareTrackPcm(input, file) {
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", input];
  args.push("-vn", "-ac", "1", "-ar", "16000", "-f", "s16le", "-c:a", "pcm_s16le", file);
  await run(ffmpegPath(), args, { timeout: 300000, maxBuffer: 512 * 1024 });
  return file;
}
async function audioDuration(file) {
  let stderr = "";
  try {
    const result = await run(ffmpegPath(), ["-hide_banner", "-i", file], {
      timeout: 10000,
      maxBuffer: 128 * 1024,
    });
    stderr = result.stderr;
  } catch (error) {
    stderr = error.stderr || "";
  }
  const match = stderr.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) throw new Error("Could not read the prepared audio duration");
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}
function wavInfo(buffer) {
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE")
    throw new Error("Invalid prepared audio");
  let data = null,
    rate = 16000;
  for (let i = 12; i + 8 <= buffer.length; ) {
    const size = buffer.readUInt32LE(i + 4),
      kind = buffer.toString("ascii", i, i + 4);
    if (kind === "fmt " && size >= 16) rate = buffer.readUInt32LE(i + 12);
    if (kind === "data") {
      data = buffer.subarray(i + 8, Math.min(buffer.length, i + 8 + size));
      break;
    }
    i += 8 + size + (size % 2);
  }
  if (!data) throw new Error("Prepared audio has no samples");
  let peak = 0;
  for (let i = 0; i + 1 < data.length; i += 2) peak = Math.max(peak, Math.abs(data.readInt16LE(i)));
  return { duration: data.length / 2 / rate, silent: peak <= 3 };
}
module.exports = {
  normalizeTranscript,
  transcribeChunk,
  prepareChunks,
  prepareDiarizationAudio,
  prepareTrackPcm,
  wavInfo,
  audioDuration,
  CHUNK_SECONDS,
};
