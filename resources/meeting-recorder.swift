// Audio-only ScreenCaptureKit bridge. stdout is a line-delimited JSON protocol.
import Foundation
import ScreenCaptureKit
import AVFoundation
import CoreMedia

func emit(_ event: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: event), let line = String(data: data, encoding: .utf8) {
        print(line); fflush(stdout)
    }
}

@available(macOS 15.0, *)
final class AudioTrack {
    let outputFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false)!
    var file: AVAudioFile?
    var converter: AVAudioConverter?
    var inputFormat: AVAudioFormat?
    var written: Int64 = 0
    // Half-second loudness windows let the app detect when a call has gone quiet.
    var levelSum: Double = 0
    var levelFrames = 0
    let url: URL
    let source: String
    init(url: URL, source: String = "audio") { self.url = url; self.source = source }
    func meter(_ buffer: AVAudioPCMBuffer) {
        guard let samples = buffer.floatChannelData?[0] else { return }
        let base = written - Int64(buffer.frameLength)
        for index in 0..<Int(buffer.frameLength) {
            let value = Double(samples[index])
            levelSum += value * value; levelFrames += 1
            if levelFrames == 8000 {
                let db = 10 * log10(levelSum / 8000 + 1e-12)
                emit(["event": "level", "source": source, "t": Double(base + Int64(index) + 1) / 16000, "db": (db * 10).rounded() / 10])
                levelSum = 0; levelFrames = 0
            }
        }
    }
    func append(_ sample: CMSampleBuffer, origin: Double) throws {
        guard let description = sample.formatDescription, let format = AVAudioFormat(cmAudioFormatDescription: description) as AVAudioFormat? else { return }
        let frames = CMSampleBufferGetNumSamples(sample)
        guard frames > 0, let pcm = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)) else { return }
        pcm.frameLength = AVAudioFrameCount(frames)
        let status = CMSampleBufferCopyPCMDataIntoAudioBufferList(sample, at: 0, frameCount: Int32(frames), into: pcm.mutableAudioBufferList)
        guard status == noErr else { throw NSError(domain: "AudioCopy", code: Int(status)) }
        if inputFormat != format { converter = AVAudioConverter(from: format, to: outputFormat); inputFormat = format }
        guard let converter else { throw NSError(domain: "AudioConverter", code: 1) }
        let capacity = AVAudioFrameCount(ceil(Double(frames) * 16000 / format.sampleRate)) + 64
        guard let output = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else { return }
        var supplied = false
        var conversionError: NSError?
        let result = converter.convert(to: output, error: &conversionError) { _, inputStatus in
            if supplied { inputStatus.pointee = .noDataNow; return nil }
            supplied = true; inputStatus.pointee = .haveData; return pcm
        }
        if result == .error { throw conversionError ?? NSError(domain: "AudioConverter", code: 2) }
        if file == nil { file = try AVAudioFile(forWriting: url, settings: outputFormat.settings) }
        // Both tracks share the same host-clock origin, including initial silence.
        let seconds = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sample)) - origin
        if seconds.isFinite && seconds >= 0 && seconds < 6 * 3600 {
            let target = Int64(seconds * 16000)
            let gap = target - written
            // Ignore tiny timestamp jitter; fill actual source interruptions.
            if gap > 3200 || written == 0 {
                var remaining = max(0, gap)
                let silence = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: 16000)!
                while remaining > 0 {
                    silence.frameLength = AVAudioFrameCount(min(remaining, 16000))
                    memset(silence.floatChannelData![0], 0, Int(silence.frameLength) * MemoryLayout<Float>.size)
                    try file?.write(from: silence); written += Int64(silence.frameLength); remaining -= Int64(silence.frameLength)
                }
            }
        }
        if output.frameLength > 0 { try file?.write(from: output); written += Int64(output.frameLength); meter(output) }
    }
    func close() { file = nil }
}

@available(macOS 15.0, *)
final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    // Track writes are confined to queue; the stop gate is protected across Tasks.
    let stopLock = NSLock()
    let queue = DispatchQueue(label: "ScottySpeaks.meeting.audio")
    let microphone: AudioTrack
    let system: AudioTrack
    var stream: SCStream?
    var origin: Double = 0
    var stopping = false
    var failed = false
    init(directory: String) {
        microphone = AudioTrack(url: URL(fileURLWithPath: directory).appendingPathComponent("microphone.caf"), source: "microphone")
        system = AudioTrack(url: URL(fileURLWithPath: directory).appendingPathComponent("system.caf"), source: "system")
    }
    func start() async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        guard let display = content.displays.first else { throw NSError(domain: "NoDisplay", code: 1) }
        let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
        let config = SCStreamConfiguration()
        config.width = 2; config.height = 2; config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        config.capturesAudio = true; config.excludesCurrentProcessAudio = true
        config.sampleRate = 16000; config.channelCount = 1; config.captureMicrophone = true
        config.showsCursor = false
        let capture = SCStream(filter: filter, configuration: config, delegate: self)
        try capture.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
        try capture.addStreamOutput(self, type: .microphone, sampleHandlerQueue: queue)
        stream = capture
        origin = CMTimeGetSeconds(CMClockGetTime(CMClockGetHostTimeClock()))
        try await capture.startCapture()
        emit(["event": "started"])
    }
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard !failed, CMSampleBufferDataIsReady(sampleBuffer) else { return }
        do {
            if type == .audio { try system.append(sampleBuffer, origin: origin) }
            else if type == .microphone { try microphone.append(sampleBuffer, origin: origin) }
        } catch {
            failed = true; emit(["event": "error", "message": "Could not save call audio: \(error.localizedDescription)"])
            Task { await stop() }
        }
    }
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        emit(["event": "error", "message": error.localizedDescription]); Task { await stop() }
    }
    func stop() async {
        guard stopLock.withLock({ if stopping { return false }; stopping = true; return true }) else { return }
        try? await stream?.stopCapture()
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            queue.async { self.microphone.close(); self.system.close(); continuation.resume() }
        }
        emit(["event": "stopped", "duration": max(0, CMTimeGetSeconds(CMClockGetTime(CMClockGetHostTimeClock())) - origin)])
        exit(failed ? 1 : 0)
    }
}

// Deterministic audio-conversion check: no microphone or system capture.
if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--self-test" {
    if #available(macOS 15.0, *) {
        let destination = URL(fileURLWithPath: CommandLine.arguments[2])
        let track = AudioTrack(url: destination)
        let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48000, channels: 2, interleaved: false)!
        var description: CMAudioFormatDescription?
        CMAudioFormatDescriptionCreate(allocator: kCFAllocatorDefault, asbd: format.streamDescription, layoutSize: 0, layout: nil, magicCookieSize: 0, magicCookie: nil, extensions: nil, formatDescriptionOut: &description)
        for index in 0..<50 {
            let pcm = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 960)!
            pcm.frameLength = 960
            for channel in 0..<2 { for frame in 0..<960 { pcm.floatChannelData![channel][frame] = Float(sin(Double(index * 960 + frame) * 2 * Double.pi * 440 / 48000) * 0.2) } }
            var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: 48000), presentationTimeStamp: CMTime(value: Int64(48000 + index * 960), timescale: 48000), decodeTimeStamp: .invalid)
            var sample: CMSampleBuffer?
            CMSampleBufferCreate(allocator: kCFAllocatorDefault, dataBuffer: nil, dataReady: false, makeDataReadyCallback: nil, refcon: nil, formatDescription: description, sampleCount: 960, sampleTimingEntryCount: 1, sampleTimingArray: &timing, sampleSizeEntryCount: 0, sampleSizeArray: nil, sampleBufferOut: &sample)
            guard let sample else { exit(2) }
            CMSampleBufferSetDataBufferFromAudioBufferList(sample, blockBufferAllocator: kCFAllocatorDefault, blockBufferMemoryAllocator: kCFAllocatorDefault, flags: 0, bufferList: pcm.audioBufferList)
            try track.append(sample, origin: 0)
        }
        track.close()
        emit(["event": "self-test", "frames": track.written]); exit(0)
    }
    exit(1)
}

if CommandLine.arguments.contains("--check") {
    if #available(macOS 15.0, *) { emit(["available": true]); exit(0) }
    emit(["available": false]); exit(1)
}
guard CommandLine.arguments.count == 2 else { emit(["event": "error", "message": "Expected a capture directory"]); exit(1) }
if #available(macOS 15.0, *) {
    let recorder = Recorder(directory: CommandLine.arguments[1])
    signal(SIGTERM, SIG_IGN); signal(SIGINT, SIG_IGN)
    let term = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    let interrupt = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
    term.setEventHandler { Task { await recorder.stop() } }; term.resume()
    interrupt.setEventHandler { Task { await recorder.stop() } }; interrupt.resume()
    DispatchQueue.global().async { while let line = readLine() { if line == "stop" { Task { await recorder.stop() }; return } }; Task { await recorder.stop() } }
    Task { do { try await recorder.start() } catch { emit(["event": "error", "message": error.localizedDescription]); exit(1) } }
    dispatchMain()
} else { emit(["event": "error", "message": "Call recording requires macOS 15 or later"]); exit(1) }
