// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "parakeet-coreml",
  platforms: [.macOS(.v14)],
  dependencies: [
    .package(url: "https://github.com/FluidInference/FluidAudio.git", from: "0.17.2")
  ],
  targets: [
    .executableTarget(
      name: "parakeet-coreml",
      dependencies: [.product(name: "FluidAudio", package: "FluidAudio")],
      path: "Sources/parakeet-coreml",
      // Top-level entry point with a serial request loop; Swift 6 strict
      // concurrency adds nothing here and rejects the global model handles.
      swiftSettings: [.swiftLanguageMode(.v5)]
    ),
    // One-shot Nemotron 3 speaker diarization for call transcripts. Shares the
    // FluidAudio checkout with the dictation helper but runs as its own process
    // so the diarization model is only resident while a call is transcribed.
    .executableTarget(
      name: "call-diarizer",
      dependencies: [.product(name: "FluidAudio", package: "FluidAudio")],
      path: "Sources/call-diarizer",
      swiftSettings: [.swiftLanguageMode(.v5)]
    ),
  ]
)
