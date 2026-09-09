import CoreML
import Darwin
import Foundation
import FluidAudio

// parakeet-coreml — persistent Parakeet TDT 0.6B v3 transcription helper.
//
// Runs the same model ScottySpeaks already uses via sherpa-onnx, but through
// CoreML on the Apple Neural Engine. The ANE is a separate compute unit from
// the GPU, so transcription no longer contends with the llama.cpp polish model
// running on Metal.
//
// Wire protocol (stdin, little-endian):
//   [uint32 metaLen][uint32 audioLen][meta JSON utf8][float32 mono 16kHz audio]
// Responses (stdout, one JSON object per line):
//   {"type":"ready","loadMs":1234}
//   {"type":"result","text":"...","ms":123,"confidence":0.94,"rtf":0.04}
//   {"type":"error","message":"..."}
// Human-readable logs go to stderr so they never corrupt the protocol stream.

struct RequestMeta: Decodable {
  let language: String?
}

let stderrHandle = FileHandle.standardError

func logLine(_ message: String) {
  if let data = "[parakeet-coreml] \(message)\n".data(using: .utf8) {
    stderrHandle.write(data)
  }
}

func emit(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object, options: []) else { return }
  var line = data
  line.append(0x0A)
  line.withUnsafeBytes { raw in
    var offset = 0
    while offset < raw.count {
      let written = write(1, raw.baseAddress!.advanced(by: offset), raw.count - offset)
      if written <= 0 {
        if errno == EINTR { continue }
        return
      }
      offset += written
    }
  }
}

/// Reads exactly `count` bytes from stdin, looping over short reads.
/// Returns nil on EOF or unrecoverable error.
func readExactly(_ count: Int) -> Data? {
  if count == 0 { return Data() }
  var buffer = [UInt8](repeating: 0, count: count)
  var offset = 0
  while offset < count {
    let n: Int = buffer.withUnsafeMutableBytes { raw in
      read(0, raw.baseAddress!.advanced(by: offset), count - offset)
    }
    if n == 0 { return nil }
    if n < 0 {
      if errno == EINTR { continue }
      return nil
    }
    offset += n
  }
  return Data(buffer)
}

func readUInt32() -> UInt32? {
  guard let data = readExactly(4) else { return nil }
  return data.withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) }.littleEndian
}

/// Data may not be 4-byte aligned, so load each sample unaligned.
func float32Samples(from data: Data) -> [Float] {
  let count = data.count / MemoryLayout<Float>.size
  if count == 0 { return [] }
  return data.withUnsafeBytes { raw -> [Float] in
    var out = [Float]()
    out.reserveCapacity(count)
    for i in 0..<count {
      let bits = raw.loadUnaligned(fromByteOffset: i * 4, as: UInt32.self).littleEndian
      out.append(Float(bitPattern: bits))
    }
    return out
  }
}

func argValue(_ name: String) -> String? {
  let args = CommandLine.arguments
  guard let index = args.firstIndex(of: name), index + 1 < args.count else { return nil }
  return args[index + 1]
}

let modelsDirArg = argValue("--models-dir")
let modelsDir = modelsDirArg.map { URL(fileURLWithPath: $0) }
let defaultLanguage = argValue("--language").flatMap { $0 == "auto" ? nil : Language(rawValue: $0) }

let loadStart = Date()

let models: AsrModels
do {
  // int8 encoders must not route to the GPU — CoreML sends quantized ops to
  // MPSGraph, which fails its MLIR pass. cpuAndNeuralEngine keeps the encoder
  // on the ANE, which is the whole point of this binary.
  models = try await AsrModels.downloadAndLoad(
    to: modelsDir,
    version: .v3,
    encoderPrecision: .int8,
    encoderComputeUnits: .cpuAndNeuralEngine
  )
} catch {
  logLine("model load failed: \(error)")
  emit(["type": "error", "message": "model load failed: \(error)"])
  exit(1)
}

let manager = AsrManager(config: .default, models: models)

guard await manager.isAvailable else {
  logLine("AsrManager reported models unavailable after load")
  emit(["type": "error", "message": "AsrManager unavailable after model load"])
  exit(1)
}

// Force ANE model compilation + weight paging now rather than on the user's
// first dictation. Without this the first real request pays several seconds.
do {
  var warmState = try TdtDecoderState()
  let silence = [Float](repeating: 0, count: 16000)
  _ = try await manager.transcribe(silence, decoderState: &warmState, language: defaultLanguage)
  logLine("warm-up inference complete")
} catch {
  logLine("warm-up failed (non-fatal): \(error)")
}

let loadMs = Int(Date().timeIntervalSince(loadStart) * 1000)
logLine("ready in \(loadMs)ms")
emit(["type": "ready", "loadMs": loadMs])

while true {
  guard let metaLen = readUInt32(), let audioLen = readUInt32() else {
    logLine("stdin closed, exiting")
    break
  }

  guard let metaData = readExactly(Int(metaLen)),
    let audioData = readExactly(Int(audioLen))
  else {
    logLine("truncated frame, exiting")
    break
  }

  let meta = (try? JSONDecoder().decode(RequestMeta.self, from: metaData)) ?? RequestMeta(language: nil)
  let language = meta.language.flatMap { $0 == "auto" ? nil : Language(rawValue: $0) } ?? defaultLanguage

  let samples = float32Samples(from: audioData)
  if samples.isEmpty {
    emit(["type": "result", "text": "", "ms": 0])
    continue
  }

  let start = Date()
  do {
    var state = try TdtDecoderState()
    let result = try await manager.transcribe(samples, decoderState: &state, language: language)
    let ms = Int(Date().timeIntervalSince(start) * 1000)
    let audioSeconds = Double(samples.count) / 16000.0
    emit([
      "type": "result",
      "text": result.text,
      "ms": ms,
      "confidence": result.confidence,
      "rtf": audioSeconds > 0 ? Double(ms) / 1000.0 / audioSeconds : 0,
    ])
  } catch {
    logLine("transcription failed: \(error)")
    emit(["type": "error", "message": "\(error)"])
  }
}
