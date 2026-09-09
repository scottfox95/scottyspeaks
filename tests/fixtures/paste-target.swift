import AppKit

// Disposable manual acceptance fixture. It never reads user files or the clipboard.
final class FixtureDelegate: NSObject, NSApplicationDelegate {
    var windows: [NSWindow] = []
    func applicationDidFinishLaunching(_ notification: Notification) {
        makeWindow(second: false)
        NSApp.activate(ignoringOtherApps: true)
    }
    @objc func anotherWindow() { makeWindow(second: true) }
    func makeWindow(second: Bool) {
        let window = NSWindow(contentRect: NSRect(x: 180, y: 180, width: 620, height: 480),
                              styleMask: [.titled, .closable, .resizable, .miniaturizable],
                              backing: .buffered, defer: false)
        window.title = second ? "SS2 Paste Fixture — Second Window" : "SS2 Paste Fixture"
        window.isReleasedWhenClosed = false
        let content = NSStackView()
        content.orientation = .vertical
        content.alignment = .leading
        content.spacing = 12
        content.edgeInsets = NSEdgeInsets(top: 20, left: 20, bottom: 20, right: 20)
        window.contentView = content
        let title = NSTextField(labelWithString: "Synthetic SS2 paste verification — no user documents")
        content.addArrangedSubview(title)
        var first: NSTextView?
        for index in 1...2 {
            content.addArrangedSubview(NSTextField(labelWithString: "Field \(index)"))
            let scroll = NSScrollView()
            scroll.hasVerticalScroller = true
            scroll.borderType = .bezelBorder
            let field = NSTextView(frame: NSRect(x: 0, y: 0, width: 560, height: 100))
            field.isRichText = false
            field.font = NSFont.monospacedSystemFont(ofSize: 16, weight: .regular)
            field.string = "Synthetic field \(index). "
            field.setAccessibilityIdentifier("synthetic-field-\(index)")
            field.setAccessibilityLabel("Synthetic field \(index)")
            field.minSize = NSSize(width: 0, height: 100)
            field.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
            field.isVerticallyResizable = true
            field.autoresizingMask = [.width]
            field.textContainer?.widthTracksTextView = true
            scroll.documentView = field
            content.addArrangedSubview(scroll)
            scroll.widthAnchor.constraint(equalTo: content.widthAnchor, constant: -40).isActive = true
            scroll.heightAnchor.constraint(equalToConstant: 110).isActive = true
            if first == nil { first = field }
        }
        let button = NSButton(title: "Open another window", target: self, action: #selector(anotherWindow))
        content.addArrangedSubview(button)
        windows.append(window)
        window.makeKeyAndOrderFront(nil)
        if let first = first {
            window.makeFirstResponder(first)
            first.setSelectedRange(NSRange(location: (first.string as NSString).length, length: 0))
        }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
let app = NSApplication.shared
let delegate = FixtureDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
