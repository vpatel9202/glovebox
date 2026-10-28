// A small native app the benchmark drives: a form (accessible controls) and a
// canvas (pixels only, one accessibility node). Every submit or tile click is
// appended as a JSON line to the --out file, which is what tasks verify.
//
// Usage: open "Bench Fixture.app" --args --mode form|canvas --out /path/to/file.jsonl
//
// Without arguments (a tool relaunching the app by bundle id, say) it reads
// the same settings from ~/glovebox-bench/fixture.json, so a relaunch shows
// the window the task expects.
import AppKit

let arguments = CommandLine.arguments
func argument(_ name: String) -> String? {
    guard let i = arguments.firstIndex(of: name), i + 1 < arguments.count else { return nil }
    return arguments[i + 1]
}
let saved: [String: String] = {
    let file = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("glovebox-bench/fixture.json")
    guard let data = try? Data(contentsOf: file) else { return [:] }
    return (try? JSONSerialization.jsonObject(with: data)) as? [String: String] ?? [:]
}()
let mode = argument("--mode") ?? saved["mode"] ?? "form"
let outPath = argument("--out") ?? saved["out"] ?? NSTemporaryDirectory() + "bench-fixture.jsonl"

func record(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { return }
    var line = data
    line.append(0x0A)
    if let handle = FileHandle(forWritingAtPath: outPath) {
        handle.seekToEndOfFile()
        handle.write(line)
        handle.closeFile()
    } else {
        FileManager.default.createFile(atPath: outPath, contents: line)
    }
}

final class FormController: NSObject {
    let window: NSWindow
    let name = NSTextField()
    let email = NSTextField()
    let department = NSPopUpButton()
    let newsletter = NSButton(checkboxWithTitle: "Subscribe to newsletter", target: nil, action: nil)
    let status = NSTextField(labelWithString: "No records yet")
    var saved = 0

    override init() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 420, height: 260), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        super.init()
        window.title = "Bench Form"
        department.addItems(withTitles: ["Choose…", "Engineering", "Sales", "Support"])
        name.placeholderString = "Full name"
        email.placeholderString = "name@example.com"
        let submit = NSButton(title: "Submit", target: self, action: #selector(submitForm))
        submit.keyEquivalent = "\r"

        func row(_ label: String, _ control: NSView) -> NSView {
            let text = NSTextField(labelWithString: label)
            text.alignment = .right
            text.widthAnchor.constraint(equalToConstant: 90).isActive = true
            let stack = NSStackView(views: [text, control])
            stack.spacing = 10
            return stack
        }
        for field in [name, email] { field.widthAnchor.constraint(equalToConstant: 260).isActive = true }
        let grid = NSStackView(views: [
            row("Full name", name),
            row("Email", email),
            row("Department", department),
            row("", newsletter),
            row("", submit),
            status,
        ])
        grid.orientation = .vertical
        grid.alignment = .leading
        grid.spacing = 12
        grid.edgeInsets = NSEdgeInsets(top: 20, left: 20, bottom: 20, right: 20)
        window.contentView = grid
    }

    @objc func submitForm() {
        record([
            "name": name.stringValue,
            "email": email.stringValue,
            "department": department.indexOfSelectedItem > 0 ? department.titleOfSelectedItem ?? "" : "",
            "newsletter": newsletter.state == .on,
        ])
        saved += 1
        status.stringValue = "Saved \(saved) record\(saved == 1 ? "" : "s")"
        name.stringValue = ""
        email.stringValue = ""
        department.selectItem(at: 0)
        newsletter.state = .off
        window.makeFirstResponder(name)
    }
}

// Draws a 3x3 grid of numbered tiles. Like a remote desktop viewer or a game,
// the view is one accessibility element with no children: the numbers exist
// only as pixels.
final class CanvasView: NSView {
    static let order = [4, 9, 2, 3, 5, 7, 8, 1, 6]
    var last = "Click a tile"

    override var isFlipped: Bool { true }

    override func isAccessibilityElement() -> Bool { true }
    override func accessibilityRole() -> NSAccessibility.Role? { .image }
    override func accessibilityLabel() -> String? { "Canvas" }
    override func accessibilityChildren() -> [Any]? { [] }

    func tileRect(_ i: Int) -> NSRect {
        let size: CGFloat = 100, gap: CGFloat = 12, top: CGFloat = 50
        return NSRect(x: 20 + CGFloat(i % 3) * (size + gap), y: top + CGFloat(i / 3) * (size + gap), width: size, height: size)
    }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.windowBackgroundColor.setFill()
        bounds.fill()
        let caption: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 15), .foregroundColor: NSColor.labelColor]
        (last as NSString).draw(at: NSPoint(x: 20, y: 16), withAttributes: caption)
        let digits: [NSAttributedString.Key: Any] = [.font: NSFont.boldSystemFont(ofSize: 40), .foregroundColor: NSColor.white]
        for (i, number) in Self.order.enumerated() {
            let rect = tileRect(i)
            NSColor(calibratedHue: CGFloat(number) / 10, saturation: 0.55, brightness: 0.7, alpha: 1).setFill()
            NSBezierPath(roundedRect: rect, xRadius: 10, yRadius: 10).fill()
            let text = "\(number)" as NSString
            let size = text.size(withAttributes: digits)
            text.draw(at: NSPoint(x: rect.midX - size.width / 2, y: rect.midY - size.height / 2), withAttributes: digits)
        }
    }

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        guard let i = (0..<9).first(where: { tileRect($0).contains(point) }) else { return }
        let number = Self.order[i]
        record(["tile": number])
        last = "Last clicked: \(number)"
        needsDisplay = true
    }
}

final class Delegate: NSObject, NSApplicationDelegate {
    var form: FormController?
    var canvasWindow: NSWindow?

    func applicationDidFinishLaunching(_ notification: Notification) {
        if mode == "canvas" {
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 376, height: 400), styleMask: [.titled, .closable], backing: .buffered, defer: false)
            window.title = "Bench Canvas"
            window.contentView = CanvasView()
            window.center()
            window.makeKeyAndOrderFront(nil)
            canvasWindow = window
        } else {
            let controller = FormController()
            controller.window.center()
            controller.window.makeKeyAndOrderFront(nil)
            form = controller
        }
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = Delegate()
app.delegate = delegate
app.run()
