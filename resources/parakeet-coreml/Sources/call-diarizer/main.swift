import CoreML
import Darwin
import Foundation
import FluidAudio

// call-diarizer — one-shot NVIDIA Nemotron 3 speaker diarization (CoreML).
//
// Usage:
//   call-diarizer --models-dir <dir> --input <audio> --output <probabilities.f32>
//
// Runs the offline profile (30.4s chunks) over the whole recording so speaker
// numbers stay consistent for the entire call. Writes per-10ms-frame speaker
// activity probabilities as little-endian float32, frame-major [frames * 8],
// and prints one JSON line on stdout:
//   {"type":"result","frames":N,"speakers":8,"frameSeconds":0.01,"ms":123,"loadMs":456}
//   {"type":"error","message":"..."}
// Callers attribute transcript words by averaging these probabilities over each
// word's span, which measured fewer turn-onset errors than thresholded segments.
// Human-readable logs go to stderr so they never corrupt the result line.

func logLine(_ message: String) {
  if let data = "[call-diarizer] \(message)\n".data(using: .utf8) {
    FileHandle.standardError.write(data)
  }
}

func emit(_ object: [String: Any]) {
  guard var data = try? JSONSerialization.data(withJSONObject: object, options: []) else { return }
  data.append(0x0A)
  FileHandle.standardOutput.write(data)
}

func fail(_ message: String) -> Never {
  logLine(message)
  emit(["type": "error", "message": message])
  exit(1)
}

func argValue(_ name: String) -> String? {
  let args = CommandLine.arguments
  guard let index = args.firstIndex(of: name), index + 1 < args.count else { return nil }
  return args[index + 1]
}

guard let modelsDir = argValue("--models-dir"), let input = argValue("--input"),
  let output = argValue("--output")
else {
  fail("usage: call-diarizer --models-dir <dir> --input <audio> --output <file>")
}

let loadStart = Date()
let config = Nemotron3Config.offline
let diarizer: Nemotron3Diarizer
do {
  // First run downloads ~190MB into modelsDir/nemotron-3-diarization.
  let models = try await Nemotron3Models.loadFromHuggingFace(
    config: config,
    cacheDirectory: URL(fileURLWithPath: modelsDir)
  )
  diarizer = Nemotron3Diarizer(config: config, models: models)
} catch {
  fail("model load failed: \(error)")
}
let loadMs = Int(Date().timeIntervalSince(loadStart) * 1000)
logLine("model ready in \(loadMs)ms")

let start = Date()
do {
  let audio = try AudioConverter().resampleAudioFile(path: input)
  let (probabilities, frames) = try diarizer.processComplete(audio)
  let data = probabilities.withUnsafeBufferPointer { Data(buffer: $0) }
  try data.write(to: URL(fileURLWithPath: output), options: .atomic)
  let ms = Int(Date().timeIntervalSince(start) * 1000)
  logLine("diarized \(String(format: "%.1f", Double(audio.count) / 16000))s in \(ms)ms")
  emit([
    "type": "result",
    "frames": frames,
    "speakers": config.numSpeakers,
    "frameSeconds": Double(config.outputFrameSeconds),
    "ms": ms,
    "loadMs": loadMs,
  ])
} catch {
  fail("diarization failed: \(error)")
}
