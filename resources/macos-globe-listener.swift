import Cocoa
import Foundation
import Darwin

// `--wait-release <mask>`: poll the session's modifier flags until none of the
// bits in <mask> (CGEventFlags, decimal or 0x-hex) are held, print RELEASED and
// exit. Compound push-to-talk uses this to detect key release. Reading flag
// state needs no event tap and no permission, so it also works when the
// listener itself can't run. (Replaces a python3 ctypes poller, which on a Mac
// without Command Line Tools is a shim that prompts to install them.)
let cliArgs = CommandLine.arguments
if let flagIndex = cliArgs.firstIndex(of: "--wait-release") {
    let raw = flagIndex + 1 < cliArgs.count ? cliArgs[flagIndex + 1] : ""
    let parsed = raw.lowercased().hasPrefix("0x") ? UInt64(raw.dropFirst(2), radix: 16) : UInt64(raw)
    guard let releaseMask = parsed, releaseMask != 0 else {
        FileHandle.standardError.write("--wait-release needs a non-zero modifier mask\n".data(using: .utf8)!)
        exit(2)
    }
    // Give the initial key press a moment to register, as the old poller did.
    usleep(200_000)
    while CGEventSource.flagsState(.combinedSessionState).rawValue & releaseMask != 0 {
        usleep(80_000)
    }
    FileHandle.standardOutput.write("RELEASED\n".data(using: .utf8)!)
    exit(0)
}

let mask = CGEventMask(
    (1 << CGEventType.flagsChanged.rawValue) |
    (1 << CGEventType.otherMouseDown.rawValue) |
    (1 << CGEventType.otherMouseUp.rawValue)
)
var fnIsDown = false
var eventTap: CFMachPort?
var lastModifierFlags: CGEventFlags = []

// Mouse button to suppress (-1 = none, pass all through)
var suppressMouseButton: Int64 = -1

let rightModifiers: [(Int64, CGEventFlags, String)] = [
    (61, .maskAlternate, "RightOption"),
    (54, .maskCommand, "RightCommand"),
    (62, .maskControl, "RightControl"),
    (60, .maskShift, "RightShift"),
]

let modifierMask: CGEventFlags = [.maskControl, .maskCommand, .maskAlternate, .maskShift]

let releases: [(CGEventFlags, String)] = [
    (.maskControl, "control"),
    (.maskCommand, "command"),
    (.maskAlternate, "option"),
    (.maskShift, "shift"),
]

func emit(_ message: String) {
    FileHandle.standardOutput.write((message + "\n").data(using: .utf8)!)
    fflush(stdout)
}

func eventTapCallback(proxy: CGEventTapProxy, type: CGEventType, event: CGEvent, refcon: UnsafeMutableRawPointer?) -> Unmanaged<CGEvent>? {
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        if let tap = eventTap {
            CGEvent.tapEnable(tap: tap, enable: true)
        }
        return Unmanaged.passUnretained(event)
    }

    // Handle mouse button events (buttons beyond left/right, i.e. button >= 2)
    if type == .otherMouseDown {
        let button = event.getIntegerValueField(.mouseEventButtonNumber)
        emit("MOUSE_DOWN:\(button)")
        // Suppress this event if it matches the configured button
        if button == suppressMouseButton {
            return nil
        }
        return Unmanaged.passUnretained(event)
    }
    if type == .otherMouseUp {
        let button = event.getIntegerValueField(.mouseEventButtonNumber)
        emit("MOUSE_UP:\(button)")
        if button == suppressMouseButton {
            return nil
        }
        return Unmanaged.passUnretained(event)
    }

    let flags = event.flags
    let containsFn = flags.contains(.maskSecondaryFn)

    if containsFn && !fnIsDown {
        fnIsDown = true
        emit("FN_DOWN")
    } else if !containsFn && fnIsDown {
        fnIsDown = false
        emit("FN_UP")
    }

    let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
    for (code, flag, name) in rightModifiers {
        if keyCode == code {
            emit(flags.contains(flag) ? "RIGHT_MOD_DOWN:\(name)" : "RIGHT_MOD_UP:\(name)")
            break
        }
    }

    let currentModifiers = flags.intersection(modifierMask)
    if currentModifiers != lastModifierFlags {
        let released = lastModifierFlags.subtracting(currentModifiers)
        for (flag, name) in releases {
            if released.contains(flag) {
                emit("MODIFIER_UP:\(name)")
            }
        }
        lastModifierFlags = currentModifiers
    }

    return Unmanaged.passUnretained(event)
}

// Use .defaultTap so we can suppress mouse events (return nil to consume them)
guard let createdTap = CGEvent.tapCreate(tap: .cgAnnotatedSessionEventTap,
                                         place: .tailAppendEventTap,
                                         options: .defaultTap,
                                         eventsOfInterest: mask,
                                         callback: eventTapCallback,
                                         userInfo: nil) else {
    FileHandle.standardError.write("Failed to create event tap\n".data(using: .utf8)!)
    exit(1)
}

eventTap = createdTap

let runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, createdTap, 0)
CFRunLoopAddSource(CFRunLoopGetCurrent(), runLoopSource, .commonModes)
CGEvent.tapEnable(tap: createdTap, enable: true)

// Read stdin for commands (e.g., "SUPPRESS:2" to suppress button 2)
let stdinSource = DispatchSource.makeReadSource(fileDescriptor: FileHandle.standardInput.fileDescriptor, queue: .global())
var stdinBuffer = Data()
stdinSource.setEventHandler {
    let data = FileHandle.standardInput.availableData
    if data.isEmpty { return }
    stdinBuffer.append(data)
    // Process complete lines
    while let newlineRange = stdinBuffer.range(of: Data("\n".utf8)) {
        let lineData = stdinBuffer.subdata(in: stdinBuffer.startIndex..<newlineRange.lowerBound)
        stdinBuffer.removeSubrange(stdinBuffer.startIndex...newlineRange.lowerBound)
        if let line = String(data: lineData, encoding: .utf8)?.trimmingCharacters(in: .whitespaces) {
            if line.hasPrefix("SUPPRESS:") {
                let value = line.replacingOccurrences(of: "SUPPRESS:", with: "")
                if let num = Int64(value) {
                    suppressMouseButton = num
                }
            }
        }
    }
}
stdinSource.resume()

let signalSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
signal(SIGTERM, SIG_IGN)
signalSource.setEventHandler {
    CFRunLoopStop(CFRunLoopGetCurrent())
}
signalSource.resume()

CFRunLoopRun()
