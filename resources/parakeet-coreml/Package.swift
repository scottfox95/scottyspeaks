// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "parakeet-coreml",
  platforms: [.macOS(.v14)],
  dependencies: [
    .package(url: "https://github.com/FluidInference/FluidAudio.git", from: "0.15.5")
  ],
  targets: [
    .executableTarget(
      name: "parakeet-coreml",
      dependencies: [.product(name: "FluidAudio", package: "FluidAudio")],
      path: "Sources/parakeet-coreml",
      // Top-level entry point with a serial request loop; Swift 6 strict
      // concurrency adds nothing here and rejects the global model handles.
      swiftSettings: [.swiftLanguageMode(.v5)]
    )
  ]
)
