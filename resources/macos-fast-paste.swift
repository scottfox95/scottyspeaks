import Cocoa

// Fast synthetic keystrokes via CGEvent.
//
//   (no args)              Cmd+V  — paste
//   --select-back <N>      Shift+Left ×N — select the previous N characters
//   --collapse             Right arrow — collapse a selection to its end
//
// AppleScript's System Events costs ~9ms per keystroke, which makes
// character-wise selection unusable for anything but very short text
// (a 500-char paragraph would take ~5 seconds). CGEvent posts in
// microseconds, so the same selection lands in well under 100ms.

let LEFT_ARROW: CGKeyCode = 0x7B
let RIGHT_ARROW: CGKeyCode = 0x7C
let V_KEY: CGKeyCode = 0x09

if !AXIsProcessTrusted() {
    exit(2)
}

func post(_ key: CGKeyCode, flags: CGEventFlags, downDelay: UInt32 = 0, upDelay: UInt32 = 0) -> Bool {
    guard let keyDown = CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: true),
          let keyUp = CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: false) else {
        return false
    }
    keyDown.flags = flags
    keyUp.flags = flags
    keyDown.post(tap: .cgSessionEventTap)
    if downDelay > 0 { usleep(downDelay) }
    keyUp.post(tap: .cgSessionEventTap)
    if upDelay > 0 { usleep(upDelay) }
    return true
}

let args = CommandLine.arguments

if args.count >= 2 && args[1] == "--select-back" {
    guard args.count >= 3, let count = Int(args[2]), count > 0, count <= 20000 else {
        FileHandle.standardError.write("usage: --select-back <1..20000>\n".data(using: .utf8)!)
        exit(64)
    }
    for _ in 0..<count {
        if !post(LEFT_ARROW, flags: .maskShift, upDelay: 250) {
            exit(1)
        }
    }
    // Let the target app finish processing the selection before we return
    usleep(30000)
    exit(0)
}

if args.count >= 2 && args[1] == "--collapse" {
    if !post(RIGHT_ARROW, flags: [], upDelay: 5000) {
        exit(1)
    }
    exit(0)
}

// Default: Cmd+V
if !post(V_KEY, flags: .maskCommand, downDelay: 8000, upDelay: 20000) {
    exit(1)
}
