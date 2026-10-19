import Cocoa
import Foundation

// sig_atomic_t is only assigned in the POSIX handler; no allocation or I/O there.
var cancellationRequested: sig_atomic_t = 0
func handleCancellation(_ signalNumber: Int32) { cancellationRequested = 1 }
signal(SIGTERM, handleCancellation)

// One process holds one recording's AX field identity. No field value is read.
// stdin/stdout are bounded JSON lines; transcript/clipboard contents are never logged.
func reply(_ value: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: value) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([10]))
    }
}
func attribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
    var value: AnyObject?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}
func elementAttribute(_ element: AXUIElement, _ name: String) -> AXUIElement? {
    guard let value = attribute(element, name), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}
func selection(_ element: AXUIElement) -> CFRange? {
    guard let value = attribute(element, kAXSelectedTextRangeAttribute), CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    var range = CFRange()
    guard AXValueGetValue(value as! AXValue, .cfRange, &range) else { return nil }
    return range
}
func postPaste() -> Bool {
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0x09, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: 0x09, keyDown: false) else { return false }
    down.flags = .maskCommand; up.flags = .maskCommand
    guard cancellationRequested == 0 else { return false }
    down.post(tap: .cgSessionEventTap); usleep(8000); up.post(tap: .cgSessionEventTap)
    return true
}

func snapshotClipboard(_ pasteboard: NSPasteboard, limit: Int = 32 * 1024 * 1024) -> ([NSPasteboardItem]?, String?) {
    let beforeCount = pasteboard.changeCount
    var originals = [NSPasteboardItem]()
    var total = 0
    for item in pasteboard.pasteboardItems ?? [] {
        let copy = NSPasteboardItem()
        for type in item.types {
            guard let data = item.data(forType: type) else { return (nil, "clipboard-format-unavailable") }
            do {
                total += data.count
                if total > limit { return (nil, "clipboard-too-large") }
                copy.setData(data, forType: type)
            }
        }
        if !copy.types.isEmpty { originals.append(copy) }
    }
    guard pasteboard.changeCount == beforeCount else { return (nil, "clipboard-changed") }
    return (originals, nil)
}
func restoreClipboard(_ pasteboard: NSPasteboard, originals: [NSPasteboardItem], ownCount: Int) {
    if pasteboard.changeCount == ownCount {
        pasteboard.clearContents()
        if !originals.isEmpty { pasteboard.writeObjects(originals) }
    }
}
func performPasteTransaction(_ text: String, pasteboard: NSPasteboard, verifyTarget: () -> String?, dispatchPaste: () -> Bool) -> String? {
    guard cancellationRequested == 0 else { return "target-cancelled" }
    if let reason = verifyTarget() { return reason }
    let snapshotCount = pasteboard.changeCount
    let (snapshot, snapshotError) = snapshotClipboard(pasteboard)
    guard let originals = snapshot else { return snapshotError ?? "clipboard-unavailable" }
    guard cancellationRequested == 0 else { return "target-cancelled" }
    if let reason = verifyTarget() { return reason }
    guard pasteboard.changeCount == snapshotCount else { return "clipboard-changed" }
    guard cancellationRequested == 0 else { return "target-cancelled" }
    let emptyCount = pasteboard.clearContents()
    guard pasteboard.setString(text, forType: .string) else {
        if pasteboard.changeCount == emptyCount, !originals.isEmpty { pasteboard.writeObjects(originals) }
        return "clipboard-write-failed"
    }
    let ownCount = pasteboard.changeCount
    // Check once more immediately before the keystroke. On failure restore only
    // our own clipboard write; the transcript is retained by the caller.
    let targetFailure = verifyTarget()
    let failure = cancellationRequested != 0 ? "target-cancelled" : targetFailure ?? (pasteboard.changeCount == ownCount ? nil : "clipboard-changed")
    let sent = failure == nil && dispatchPaste()
    if sent {
        // SIGTERM may interrupt usleep. A posted paste still needs its full
        // consumption interval before the owned clipboard is restored.
        let restoreAfter = Date().addingTimeInterval(0.35)
        while Date() < restoreAfter { usleep(10000) }
    }
    restoreClipboard(pasteboard, originals: originals, ownCount: ownCount)
    return failure ?? (sent ? nil : cancellationRequested != 0 ? "target-cancelled" : "paste-failed")
}


// Parent-owned editors are normal targets; only the helper itself is ineligible.
func eligibleApplication(_ pid: pid_t) -> Bool {
    return pid != ProcessInfo.processInfo.processIdentifier
}
func eligibleField(role: String?, subrole: String?, enabled: Bool?) -> Bool {
    guard let role = role else { return false }
    return [kAXTextAreaRole, kAXTextFieldRole, kAXComboBoxRole].contains(role)
        && subrole != kAXSecureTextFieldSubrole && enabled != false
}

// Isolated named pasteboard: synthetic tests never access the user's general clipboard or AX.
if CommandLine.arguments.contains("--self-test") {
    precondition(eligibleApplication(getppid()))
    precondition(!eligibleApplication(ProcessInfo.processInfo.processIdentifier))
    precondition(eligibleField(role: kAXTextAreaRole, subrole: nil, enabled: true))
    precondition(eligibleField(role: kAXTextFieldRole, subrole: nil, enabled: true))
    precondition(!eligibleField(role: kAXStaticTextRole, subrole: nil, enabled: true))
    precondition(!eligibleField(role: kAXTextFieldRole, subrole: kAXSecureTextFieldSubrole, enabled: true))
    precondition(!eligibleField(role: kAXTextAreaRole, subrole: nil, enabled: false))
    let board = NSPasteboard(name: NSPasteboard.Name("ScottySpeaks.synthetic.\(UUID().uuidString)"))
    defer { board.releaseGlobally() }
    let item = NSPasteboardItem()
    item.setString("synthetic plain", forType: .string)
    item.setData(Data("<b>synthetic</b>".utf8), forType: .html)
    item.setData(Data("{\\rtf1 synthetic}".utf8), forType: .rtf)
    item.setData(Data([0, 1, 2, 3]), forType: .png)
    item.setString("file:///synthetic.txt", forType: .fileURL)
    board.clearContents(); board.writeObjects([item])
    let (snapshot, reason) = snapshotClipboard(board)
    guard reason == nil && snapshot?.count == 1 else { reply(["ok": false, "reason": reason ?? "isolated-pasteboard-unavailable", "count": snapshot?.count ?? -1]); exit(2) }
    precondition([NSPasteboard.PasteboardType.string, .html, .rtf, .png, .fileURL].allSatisfy { snapshot![0].types.contains($0) })
    let data = snapshot![0].data(forType: .png)
    board.clearContents(); board.setString("dictation", forType: .string)
    let own = board.changeCount
    restoreClipboard(board, originals: snapshot!, ownCount: own)
    precondition(board.data(forType: .png) == data && board.string(forType: .string) == "synthetic plain")
    let (second, _) = snapshotClipboard(board)
    board.clearContents(); board.setString("dictation", forType: .string)
    let stale = board.changeCount
    board.clearContents(); board.setString("newer user copy", forType: .string)
    restoreClipboard(board, originals: second!, ownCount: stale)
    precondition(board.string(forType: .string) == "newer user copy")
    let (_, oversized) = snapshotClipboard(board, limit: 1)
    precondition(oversized == "clipboard-too-large")
    precondition(board.string(forType: .string) == "newer user copy")
    var checks = 0
    var dispatched = false
    let cancelled = performPasteTransaction("must not paste", pasteboard: board, verifyTarget: {
        checks += 1
        if checks == 3 { raise(SIGTERM) }
        return nil
    }, dispatchPaste: { dispatched = true; return true })
    precondition(cancelled == "target-cancelled" && !dispatched)
    precondition(board.string(forType: .string) == "newer user copy")
    cancellationRequested = 0
    let postedAt = Date()
    let posted = performPasteTransaction("posted synthetic", pasteboard: board,
        verifyTarget: { nil }, dispatchPaste: { raise(SIGTERM); return true })
    precondition(posted == nil && Date().timeIntervalSince(postedAt) >= 0.35)
    precondition(board.string(forType: .string) == "newer user copy")
    reply(["ok": true, "tests": 13, "scope": "isolated-synthetic-pasteboard"])
    exit(0)
}

guard AXIsProcessTrusted() else { reply(["ok": false, "reason": "accessibility-required"]); exit(2) }
guard let targetApp = NSWorkspace.shared.frontmostApplication,
      eligibleApplication(targetApp.processIdentifier) else {
    reply(["ok": false, "reason": "no-target"]); exit(1)
}
let pid = targetApp.processIdentifier
let application = AXUIElementCreateApplication(pid)
guard let field = elementAttribute(application, kAXFocusedUIElementAttribute),
      let window = elementAttribute(field, kAXWindowAttribute) ?? elementAttribute(application, kAXFocusedWindowAttribute),
      eligibleField(role: attribute(field, kAXRoleAttribute) as? String,
                    subrole: attribute(field, kAXSubroleAttribute) as? String,
                    enabled: (attribute(field, kAXEnabledAttribute) as? NSNumber)?.boolValue) else {
    reply(["ok": false, "reason": "unverifiable-field"]); exit(1)
}
guard var originalSelection = selection(field) else {
    reply(["ok": false, "reason": "unverifiable-selection"]); exit(1)
}
let deadline = Date().addingTimeInterval(6 * 3600)
reply(["ok": true, "event": "ready", "pid": pid, "appName": targetApp.localizedName ?? ""])

func verify() -> String? {
    guard cancellationRequested == 0 else { return "target-cancelled" }
    guard Date() < deadline, !targetApp.isTerminated,
          let focused = elementAttribute(application, kAXFocusedUIElementAttribute), CFEqual(focused, field),
          let focusedWindow = elementAttribute(application, kAXFocusedWindowAttribute), CFEqual(focusedWindow, window),
          eligibleField(role: attribute(field, kAXRoleAttribute) as? String,
                        subrole: attribute(field, kAXSubroleAttribute) as? String,
                        enabled: (attribute(field, kAXEnabledAttribute) as? NSNumber)?.boolValue) else { return "target-changed" }
    do {
        let before = originalSelection
        guard let now = selection(field), now.location == before.location, now.length == before.length else { return "selection-changed" }
    }
    if NSWorkspace.shared.frontmostApplication?.processIdentifier != pid {
        guard targetApp.activate(options: [.activateIgnoringOtherApps]) else { return "activation-failed" }
        for _ in 0..<25 {
            if NSWorkspace.shared.frontmostApplication?.processIdentifier == pid { break }
            usleep(10000)
        }
    }
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid,
          let focused = elementAttribute(application, kAXFocusedUIElementAttribute), CFEqual(focused, field),
          let focusedWindow = elementAttribute(application, kAXFocusedWindowAttribute), CFEqual(focusedWindow, window) else { return "target-changed" }
    do {
        let before = originalSelection
        guard let now = selection(field), now.location == before.location, now.length == before.length else { return "selection-changed" }
    }
    return nil
}

// Snapshot eager pasteboard data, including HTML/RTF/images/file URLs. Never restore
// over a newer user/app clipboard write. Oversize clipboard leaves it untouched.
func paste(_ text: String) -> String? {
    performPasteTransaction(text, pasteboard: NSPasteboard.general, verifyTarget: verify, dispatchPaste: postPaste)
}

// Explicit voice commands may inspect only the selected text, never a field value.
func selectedText() -> String? {
    guard originalSelection.length <= 200_000 else { return nil }
    return attribute(field, kAXSelectedTextAttribute) as? String
}
func replace(_ text: String, expected: String) -> String? {
    if let reason = verify() { return reason }
    let before = originalSelection
    guard before.length == 0, !expected.isEmpty, expected.utf16.count <= before.location else { return "unverifiable-replacement" }
    var replacement = CFRange(location: before.location - expected.utf16.count, length: expected.utf16.count)
    guard let value = AXValueCreate(.cfRange, &replacement),
          AXUIElementSetAttributeValue(field, kAXSelectedTextRangeAttribute as CFString, value) == .success else { return "selection-failed" }
    originalSelection = replacement
    if let reason = verify() { return reason }
    guard selectedText() == expected else {
        // Restore our range only while the same field and our range still verify.
        if verify() == nil {
            var prior = before
            if let priorValue = AXValueCreate(.cfRange, &prior) {
                _ = AXUIElementSetAttributeValue(field, kAXSelectedTextRangeAttribute as CFString, priorValue)
            }
        }
        return "text-changed"
    }
    return paste(text)
}

// Bounded chunk framing avoids readLine allocating unbounded input.
DispatchQueue.global().asyncAfter(deadline: .now() + 6 * 3600) { kill(getpid(), SIGTERM) }
var buffer = Data()
while Date() < deadline && cancellationRequested == 0 {
    let chunk = FileHandle.standardInput.availableData
    if chunk.isEmpty { break }
    for byte in chunk {
        if byte != 10 {
            buffer.append(byte)
            if buffer.count > 1_000_000 { reply(["ok": false, "reason": "request-too-large"]); exit(1) }
            continue
        }
        guard let request = (try? JSONSerialization.jsonObject(with: buffer)) as? [String: Any], let op = request["op"] as? String else {
            reply(["ok": false, "reason": "invalid-request"]); exit(1)
        }
        buffer.removeAll(keepingCapacity: true)
        if op == "cancel" { exit(0) }
        if op == "verify" {
            if let reason = verify() { reply(["ok": false, "reason": reason]) } else { reply(["ok": true]) }
        } else if op == "selection" {
            if let reason = verify() { reply(["ok": false, "reason": reason]) }
            else if originalSelection.length == 0 { reply(["ok": true, "text": NSNull()]) }
            else if let text = selectedText(), text.utf8.count <= 200_000 { reply(["ok": true, "text": text]) }
            else { reply(["ok": false, "reason": "selection-unavailable"]) }
        } else if op == "replace", let text = request["text"] as? String, !text.isEmpty, text.utf8.count <= 200_000,
                  let expected = request["expected"] as? String, expected.utf8.count <= 200_000 {
            if let reason = replace(text, expected: expected) { reply(["ok": false, "event": "transaction-complete", "reason": reason]) }
            else { reply(["ok": true, "event": "transaction-complete"]) }
            exit(0)
        } else if op == "paste", let text = request["text"] as? String, !text.isEmpty, text.utf8.count <= 200_000 {
            if let reason = paste(text) { reply(["ok": false, "event": "transaction-complete", "reason": reason]) } else { reply(["ok": true, "event": "transaction-complete"]) }
            exit(0)
        } else { reply(["ok": false, "reason": "invalid-request"]); exit(1) }
    }
}
