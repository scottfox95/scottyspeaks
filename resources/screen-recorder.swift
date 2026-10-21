// ScreenCaptureKit screen recorder. stdout is a line-delimited JSON protocol.
//   --check                 {"available": bool}
//   --list                  {"displays": [...], "windows": [...]}
//   <file.mov> [--display <id> | --window <id>] [--system-audio] [--microphone]
//   --self-test <file.mov> <seconds> [--crash]   synthetic screen + audio, no capture
// While recording, "stop" on stdin (or SIGTERM/SIGINT, or stdin closing) finalizes the file.
//
// Built for multi-hour sessions: frames stream straight into a fragmented
// QuickTime movie (a fragment every few seconds), so memory stays flat and a
// crash or power loss leaves a playable file up to the last fragment. Video is
// HEVC at a capped bitrate and frame rate; system audio and microphone are
// separate AAC tracks that the app mixes down when the recording ends.
import Foundation
import ScreenCaptureKit
import AVFoundation
import CoreMedia
import CoreText
import VideoToolbox

let FRAME_RATE: Int32 = 15
let MAX_LONG_SIDE: CGFloat = 1920
let VIDEO_BITRATE = 1_200_000
let FRAGMENT_SECONDS: Int64 = 5

func emit(_ event: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: event), let line = String(data: data, encoding: .utf8) {
        print(line); fflush(stdout)
    }
}

// TCC refusals surface as SCStreamError.userDeclined; the app shows settings guidance for these.
func describe(_ error: Error) -> [String: Any] {
    let ns = error as NSError
    let declined = ns.domain == SCStreamErrorDomain && ns.code == SCStreamError.Code.userDeclined.rawValue
    return ["event": "error", "code": declined ? "permission" : "capture", "message": error.localizedDescription]
}

@available(macOS 15.0, *)
func listSources() async throws {
    let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
    let displays = content.displays.enumerated().map { index, display in
        ["id": Int(display.displayID), "index": index + 1, "width": display.width, "height": display.height] as [String: Any]
    }
    let own = ProcessInfo.processInfo.processIdentifier
    let windows = content.windows.compactMap { window -> [String: Any]? in
        // Normal app windows only: menu bar, dock and overlays sit above layer 0.
        guard window.windowLayer == 0, window.frame.width >= 80, window.frame.height >= 60,
              let app = window.owningApplication, app.processID != own else { return nil }
        return ["id": Int(window.windowID), "title": window.title ?? "", "app": app.applicationName]
    }
    emit(["displays": displays, "windows": windows])
}

// Compressed, fragmented movie output. Not thread-safe: callers serialize access.
final class MovieWriter {
    let writer: AVAssetWriter
    let video: AVAssetWriterInput
    var system: AVAssetWriterInput?
    var mic: AVAssetWriterInput?
    var sessionStart: CMTime?
    var lastVideo: CMTime = .zero
    var frames = 0
    var dropped = 0
    init(url: URL, width: Int, height: Int, systemAudio: Bool, microphone: Bool) throws {
        writer = try AVAssetWriter(outputURL: url, fileType: .mov)
        writer.movieFragmentInterval = CMTime(value: FRAGMENT_SECONDS, timescale: 1)
        video = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.hevc,
            AVVideoWidthKey: width, AVVideoHeightKey: height,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: VIDEO_BITRATE,
                AVVideoExpectedSourceFrameRateKey: FRAME_RATE,
                AVVideoMaxKeyFrameIntervalDurationKey: 10,
                AVVideoAllowFrameReorderingKey: false,
            ],
        ])
        video.expectsMediaDataInRealTime = true
        writer.add(video)
        if systemAudio { system = MovieWriter.audioInput(channels: 2, bitrate: 96_000); writer.add(system!) }
        if microphone { mic = MovieWriter.audioInput(channels: 1, bitrate: 64_000); writer.add(mic!) }
        guard writer.startWriting() else { throw writer.error ?? NSError(domain: "ScreenRecorder", code: 3) }
    }
    static func audioInput(channels: Int, bitrate: Int) -> AVAssetWriterInput {
        let input = AVAssetWriterInput(mediaType: .audio, outputSettings: [
            AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48000,
            AVNumberOfChannelsKey: channels, AVEncoderBitRateKey: bitrate,
        ])
        input.expectsMediaDataInRealTime = true
        return input
    }
    var writing: Bool { writer.status == .writing }
    // Returns false only on a writer failure; a busy encoder drops the frame instead.
    func appendVideo(_ sample: CMSampleBuffer) -> Bool {
        let time = CMSampleBufferGetPresentationTimeStamp(sample)
        if sessionStart == nil { writer.startSession(atSourceTime: time); sessionStart = time }
        guard video.isReadyForMoreMediaData else { dropped += 1; return true }
        guard video.append(sample) else { return false }
        frames += 1; lastVideo = time
        return true
    }
    func appendAudio(_ sample: CMSampleBuffer, microphone: Bool) -> Bool {
        // Audio before the first frame would precede the session; drop it.
        guard let start = sessionStart, CMTimeCompare(CMSampleBufferGetPresentationTimeStamp(sample), start) >= 0,
              let input = microphone ? mic : system, input.isReadyForMoreMediaData else { return true }
        return input.append(sample)
    }
    func finish(_ done: @escaping (Double) -> Void) {
        guard writing, let start = sessionStart else { writer.cancelWriting(); done(0); return }
        video.markAsFinished(); system?.markAsFinished(); mic?.markAsFinished()
        let seconds = CMTimeGetSeconds(CMTimeSubtract(lastVideo, start))
        writer.finishWriting { done(max(0, seconds)) }
    }
}

@available(macOS 15.0, *)
final class Recorder: NSObject, SCStreamDelegate, SCStreamOutput, @unchecked Sendable {
    // All writer access is confined to queue; the stop gate is protected across Tasks.
    let stopLock = NSLock()
    let queue = DispatchQueue(label: "ScottySpeaks.screen.writer")
    let output: URL
    let displayID: CGDirectDisplayID?
    let windowID: CGWindowID?
    let systemAudio: Bool
    let microphone: Bool
    var stream: SCStream?
    var movie: MovieWriter?
    var stopping = false
    var failed = false
    init(output: URL, displayID: CGDirectDisplayID?, windowID: CGWindowID?, systemAudio: Bool, microphone: Bool) {
        self.output = output; self.displayID = displayID; self.windowID = windowID
        self.systemAudio = systemAudio; self.microphone = microphone
    }
    func start() async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        let filter: SCContentFilter
        if let windowID {
            guard let window = content.windows.first(where: { $0.windowID == windowID }) else {
                throw NSError(domain: "ScreenRecorder", code: 1, userInfo: [NSLocalizedDescriptionKey: "That window is no longer available"])
            }
            filter = SCContentFilter(desktopIndependentWindow: window)
        } else {
            guard let display = content.displays.first(where: { displayID == nil || $0.displayID == displayID }) else {
                throw NSError(domain: "ScreenRecorder", code: 2, userInfo: [NSLocalizedDescriptionKey: "That display is no longer available"])
            }
            filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
        }
        // Capture at native pixels, then cap the long side: screen text stays legible at 1920.
        let scale = CGFloat(filter.pointPixelScale)
        var width = filter.contentRect.width * scale, height = filter.contentRect.height * scale
        let shrink = max(width, height) / MAX_LONG_SIDE
        if shrink > 1 { width /= shrink; height /= shrink }
        let pixelWidth = max(2, Int(width) & ~1), pixelHeight = max(2, Int(height) & ~1)

        let config = SCStreamConfiguration()
        config.width = pixelWidth; config.height = pixelHeight
        config.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        config.minimumFrameInterval = CMTime(value: 1, timescale: FRAME_RATE)
        config.queueDepth = 6
        config.showsCursor = true
        config.capturesAudio = systemAudio; config.excludesCurrentProcessAudio = true
        config.sampleRate = 48000; config.channelCount = 2
        config.captureMicrophone = microphone

        movie = try MovieWriter(url: output, width: pixelWidth, height: pixelHeight, systemAudio: systemAudio, microphone: microphone)
        let capture = SCStream(filter: filter, configuration: config, delegate: self)
        try capture.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
        if systemAudio { try capture.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue) }
        if microphone { try capture.addStreamOutput(self, type: .microphone, sampleHandlerQueue: queue) }
        stream = capture
        try await capture.startCapture()
        emit(["event": "started", "width": pixelWidth, "height": pixelHeight, "fps": Int(FRAME_RATE)])
    }
    func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
        guard !failed, !stopping, let movie, movie.writing, CMSampleBufferDataIsReady(sample) else { return }
        switch type {
        case .screen:
            // Static screens deliver idle frames with no image; skipping them keeps files small.
            guard let info = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
                  let raw = info.first?[.status] as? Int, SCFrameStatus(rawValue: raw) == .complete else { return }
            if !movie.appendVideo(sample) { fail(movie.writer.error) }
        case .audio, .microphone:
            if !movie.appendAudio(sample, microphone: type == .microphone) { fail(movie.writer.error) }
        @unknown default: return
        }
    }
    func fail(_ error: Error?) {
        guard !failed else { return }
        failed = true
        emit(["event": "error", "code": "capture", "message": "Could not save the recording: \(error?.localizedDescription ?? "writer failed")"])
        Task { await stop() }
    }
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        emit(describe(error)); Task { await stop() }
    }
    func stop() async {
        guard stopLock.withLock({ if stopping { return false }; stopping = true; return true }) else { return }
        try? await stream?.stopCapture()
        let duration: Double = await withCheckedContinuation { continuation in
            queue.async {
                guard let movie = self.movie else { continuation.resume(returning: 0); return }
                movie.finish { continuation.resume(returning: $0) }
            }
        }
        if movie?.writer.status == .failed { failed = true }
        emit([
            "event": "stopped", "duration": duration, "frames": movie?.frames ?? 0,
            "dropped": movie?.dropped ?? 0, "hasVideo": movie?.sessionStart != nil,
        ])
        exit(failed ? 1 : 0)
    }
}

// Deterministic encoder check without ScreenCaptureKit (which needs the TCC grant):
// a scrolling document, a moving window and a busy "camera tile", plus tone audio,
// written through MovieWriter at 15 fps as fast as the encoder allows.
func selfTest(path: String, seconds: Int, crash: Bool) throws -> Never {
    let width = 1920, height = 1080
    let movie = try MovieWriter(url: URL(fileURLWithPath: path), width: width, height: height, systemAudio: true, microphone: true)
    let space = CGColorSpaceCreateDeviceRGB()
    // A tall page of text rendered once; each frame shows a scrolled slice of it.
    let pageHeight = 6000
    let page = CGContext(data: nil, width: width, height: pageHeight, bitsPerComponent: 8, bytesPerRow: 0, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue)!
    page.setFillColor(CGColor(gray: 1, alpha: 1)); page.fill(CGRect(x: 0, y: 0, width: width, height: pageHeight))
    let font = CTFontCreateWithName("Helvetica" as CFString, 22, nil)
    let words = "the quarterly plan covers hiring budget roadmap customers pricing support release notes meeting follow up action items owner due date risk mitigation".split(separator: " ")
    var line = 0
    for y in stride(from: pageHeight - 40, to: 20, by: -32) {
        let text = (0..<14).map { words[($0 * 7 + line * 3) % words.count] }.joined(separator: " ")
        let attributed = CFAttributedStringCreate(nil, text as CFString, [kCTFontAttributeName: font] as CFDictionary)!
        page.textPosition = CGPoint(x: 80, y: CGFloat(y)); CTLineDraw(CTLineCreateWithAttributedString(attributed), page)
        line += 1
    }
    let pageImage = page.makeImage()!
    var formatDescription: CMVideoFormatDescription?
    var pool: CVPixelBufferPool?
    CVPixelBufferPoolCreate(nil, nil, [
        kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32BGRA, kCVPixelBufferWidthKey: width,
        kCVPixelBufferHeightKey: height, kCVPixelBufferIOSurfacePropertiesKey: [:],
    ] as CFDictionary, &pool)
    // Tone audio in 1024-frame buffers, matching ScreenCaptureKit's float32 layout.
    func audioSample(channels: Int, index: Int, frequency: Double) -> CMSampleBuffer {
        let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48000, channels: AVAudioChannelCount(channels), interleaved: false)!
        let pcm = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 1024)!
        pcm.frameLength = 1024
        for channel in 0..<channels { for frame in 0..<1024 {
            pcm.floatChannelData![channel][frame] = Float(sin(Double(index * 1024 + frame) * 2 * .pi * frequency / 48000) * 0.1)
        } }
        var description: CMAudioFormatDescription?
        CMAudioFormatDescriptionCreate(allocator: nil, asbd: format.streamDescription, layoutSize: 0, layout: nil, magicCookieSize: 0, magicCookie: nil, extensions: nil, formatDescriptionOut: &description)
        var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: 48000), presentationTimeStamp: CMTime(value: Int64(index * 1024), timescale: 48000), decodeTimeStamp: .invalid)
        var sample: CMSampleBuffer?
        CMSampleBufferCreate(allocator: nil, dataBuffer: nil, dataReady: false, makeDataReadyCallback: nil, refcon: nil, formatDescription: description, sampleCount: 1024, sampleTimingEntryCount: 1, sampleTimingArray: &timing, sampleSizeEntryCount: 0, sampleSizeArray: nil, sampleBufferOut: &sample)
        CMSampleBufferSetDataBufferFromAudioBufferList(sample!, blockBufferAllocator: nil, blockBufferMemoryAllocator: nil, flags: 0, bufferList: pcm.audioBufferList)
        return sample!
    }
    let total = seconds * Int(FRAME_RATE)
    var audioIndex = 0
    for frame in 0..<total {
        var buffer: CVPixelBuffer?
        CVPixelBufferPoolCreatePixelBuffer(nil, pool!, &buffer)
        CVPixelBufferLockBaseAddress(buffer!, [])
        let context = CGContext(data: CVPixelBufferGetBaseAddress(buffer!), width: width, height: height, bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(buffer!), space: space, bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)!
        // Scroll a few pixels per frame, pause half of every 20 seconds like someone reading.
        let scroll = (frame / Int(FRAME_RATE)) % 20 < 10 ? frame * 3 : (frame / 300) * 900
        context.draw(pageImage, in: CGRect(x: 0, y: -CGFloat(pageHeight - height - (scroll % (pageHeight - height))), width: CGFloat(width), height: CGFloat(pageHeight)))
        let t = Double(frame) / Double(FRAME_RATE)
        context.setFillColor(CGColor(red: 0.2, green: 0.4, blue: 0.8, alpha: 1))
        context.fill(CGRect(x: 200 + 300 * sin(t / 7), y: 300 + 100 * cos(t / 5), width: 500, height: 300))
        // A 480×270 "camera tile" with continuous motion, the costliest part of a call.
        for row in stride(from: 0, to: 270, by: 6) {
            let shade = 0.5 + 0.5 * sin(t * 2 + Double(row) / 20)
            context.setFillColor(CGColor(red: shade, green: 0.6 * shade, blue: 0.4, alpha: 1))
            context.fill(CGRect(x: 1400 + 6 * sin(t * 3), y: 760 + Double(row), width: 480, height: 6))
        }
        CVPixelBufferUnlockBaseAddress(buffer!, [])
        if formatDescription == nil { CMVideoFormatDescriptionCreateForImageBuffer(allocator: nil, imageBuffer: buffer!, formatDescriptionOut: &formatDescription) }
        var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: FRAME_RATE), presentationTimeStamp: CMTime(value: Int64(frame), timescale: FRAME_RATE), decodeTimeStamp: .invalid)
        var sample: CMSampleBuffer?
        CMSampleBufferCreateReadyWithImageBuffer(allocator: nil, imageBuffer: buffer!, formatDescription: formatDescription!, sampleTiming: &timing, sampleBufferOut: &sample)
        while !movie.video.isReadyForMoreMediaData { usleep(1000) }
        guard movie.appendVideo(sample!) else { throw movie.writer.error ?? NSError(domain: "ScreenRecorder", code: 4) }
        while Double(audioIndex * 1024) / 48000 < t + 1.0 / Double(FRAME_RATE) {
            for (input, channels, frequency) in [(movie.system!, 2, 440.0), (movie.mic!, 1, 660.0)] {
                while !input.isReadyForMoreMediaData { usleep(1000) }
                _ = channels == 1 ? movie.appendAudio(audioSample(channels: 1, index: audioIndex, frequency: frequency), microphone: true)
                                  : movie.appendAudio(audioSample(channels: 2, index: audioIndex, frequency: frequency), microphone: false)
            }
            audioIndex += 1
        }
    }
    // Simulates a crash: no trailer is written, so only the fragments on disk remain.
    if crash { emit(["event": "crashing", "frames": movie.frames]); kill(getpid(), SIGKILL) }
    let done = DispatchSemaphore(value: 0)
    var duration = 0.0
    movie.finish { duration = $0; done.signal() }
    done.wait()
    emit(["event": "self-test", "frames": movie.frames, "duration": duration, "status": movie.writer.status.rawValue])
    exit(movie.writer.status == .completed ? 0 : 1)
}

let args = Array(CommandLine.arguments.dropFirst())
if args.contains("--check") {
    if #available(macOS 15.0, *) { emit(["available": true]); exit(0) }
    emit(["available": false]); exit(1)
}
if args.first == "--self-test", args.count >= 3, let seconds = Int(args[2]) {
    do { try selfTest(path: args[1], seconds: seconds, crash: args.contains("--crash")) }
    catch { emit(["event": "error", "code": "capture", "message": error.localizedDescription]); exit(1) }
}
@available(macOS 15.0, *)
func run() -> Never {
    if args.first == "--list" {
        Task { do { try await listSources(); exit(0) } catch { emit(describe(error)); exit(1) } }
        dispatchMain()
    }
    func value(_ flag: String) -> UInt32? {
        guard let index = args.firstIndex(of: flag), index + 1 < args.count else { return nil }
        return UInt32(args[index + 1])
    }
    guard let path = args.first, path.hasSuffix(".mov") else {
        emit(["event": "error", "code": "capture", "message": "Expected a .mov output path"]); exit(1)
    }
    let recorder = Recorder(
        output: URL(fileURLWithPath: path),
        displayID: value("--display"),
        windowID: value("--window"),
        systemAudio: args.contains("--system-audio"),
        microphone: args.contains("--microphone")
    )
    signal(SIGTERM, SIG_IGN); signal(SIGINT, SIG_IGN)
    let term = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    let interrupt = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
    term.setEventHandler { Task { await recorder.stop() } }; term.resume()
    interrupt.setEventHandler { Task { await recorder.stop() } }; interrupt.resume()
    // stdin closing means SS2 went away; finalize rather than leave a fragment-only file.
    DispatchQueue.global().async { while let line = readLine() { if line == "stop" { Task { await recorder.stop() }; return } }; Task { await recorder.stop() } }
    Task { do { try await recorder.start() } catch { emit(describe(error)); exit(1) } }
    dispatchMain()
}
if #available(macOS 15.0, *) { run() }
emit(["event": "error", "code": "capture", "message": "Screen recording requires macOS 15 or later"]); exit(1)
