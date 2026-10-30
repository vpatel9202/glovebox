// A small native app the benchmark drives. Every submit, click, or answer is
// appended as a JSON line to the --out file, which is what tasks verify.
//
// Modes: form (accessible controls), canvas (pixels only, one accessibility
// node), table (200 rows), remote (a pixels-only "remote desktop" with late
// repaints and a tooltip panel), signup (a delayed check and an alert sheet).
//
// Usage: open "Bench Fixture.app" --args --mode <mode> --out /path/to/file.jsonl [--target ID]
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
let target = argument("--target") ?? saved["target"] ?? ""

func after(_ seconds: Double, _ body: @escaping () -> Void) {
    DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: body)
}

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


// 200 rows of item, region, and quantity. The expected answer (total quantity
// for West) is recorded at launch; the data is random per launch.
final class TableController: NSObject, NSTableViewDataSource {
    let window: NSWindow
    let table = NSTableView()
    let answer = NSTextField()
    var rows: [(item: String, region: String, qty: Int)] = []

    override init() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 520, height: 460), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        super.init()
        window.title = "Bench Table"
        let regions = ["North", "South", "East", "West"]
        for i in 1...200 { rows.append((String(format: "Item %03d", i), regions.randomElement()!, Int.random(in: 1...99))) }
        record(["expected": String(rows.filter { $0.region == "West" }.reduce(0) { $0 + $1.qty })])
        for (id, title) in [("item", "Item"), ("region", "Region"), ("qty", "Qty")] {
            let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier(id))
            column.title = title
            column.width = 140
            table.addTableColumn(column)
        }
        table.dataSource = self
        let scroll = NSScrollView()
        scroll.documentView = table
        scroll.hasVerticalScroller = true
        scroll.heightAnchor.constraint(equalToConstant: 330).isActive = true
        scroll.widthAnchor.constraint(equalToConstant: 470).isActive = true
        answer.placeholderString = "Answer"
        answer.widthAnchor.constraint(equalToConstant: 160).isActive = true
        let submit = NSButton(title: "Submit", target: self, action: #selector(submitAnswer))
        let bottom = NSStackView(views: [NSTextField(labelWithString: "Answer"), answer, submit])
        let stack = NSStackView(views: [scroll, bottom])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.edgeInsets = NSEdgeInsets(top: 16, left: 20, bottom: 16, right: 20)
        window.contentView = stack
    }

    func numberOfRows(in tableView: NSTableView) -> Int { rows.count }

    func tableView(_ tableView: NSTableView, objectValueFor column: NSTableColumn?, row: Int) -> Any? {
        switch column?.identifier.rawValue {
        case "item": return rows[row].item
        case "region": return rows[row].region
        default: return String(rows[row].qty)
        }
    }

    @objc func submitAnswer() {
        record(["answer": answer.stringValue])
    }
}

// A "remote desktop": one accessibility node, small text, a table wider than
// the window (scroll right or press the Right arrow), a record that loads two
// seconds after Open, and an untitled tooltip panel that takes key focus the
// way remote clients' tooltips do.
final class RemoteView: NSView {
    struct Row { let id: String; let name: String; let status: String }
    var rows: [Row] = []
    var offset: CGFloat = 0
    var detail: Row?
    var loaded = false
    var confirmed = false
    var tooltip: NSPanel?
    let contentWidth: CGFloat = 1320
    let rowHeight: CGFloat = 26
    let top: CGFloat = 40

    override init(frame: NSRect) {
        super.init(frame: frame)
        let names = ["Avery", "Blake", "Casey", "Drew", "Emery", "Finley", "Harper", "Jordan", "Kendall", "Logan", "Morgan", "Quinn"]
        let statuses = ["Active", "Pending", "Review", "Closed"]
        let place = Int.random(in: 2..<12)
        for i in 0..<12 {
            let id = i == place && !target.isEmpty ? target : String(Int.random(in: 10_000_000...99_999_999))
            rows.append(Row(id: id, name: names[i], status: statuses.randomElement()!))
        }
        // For the dry run's scripted solve, which has no way to read pixels.
        record(["rows": rows.map(\.id)])
    }

    required init?(coder: NSCoder) { fatalError() }

    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }
    // Remote clients act on the first click even while their window isn't key.
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func isAccessibilityElement() -> Bool { true }
    override func accessibilityRole() -> NSAccessibility.Role? { .image }
    override func accessibilityLabel() -> String? { "Remote session" }
    override func accessibilityChildren() -> [Any]? { [] }

    func openRect(_ row: Int) -> NSRect {
        NSRect(x: 1220 - offset, y: top + CGFloat(row + 1) * rowHeight + 3, width: 70, height: rowHeight - 6)
    }

    var confirmRect: NSRect { NSRect(x: 20, y: bounds.height - 56, width: 100, height: 30) }

    override func draw(_ dirtyRect: NSRect) {
        NSColor(calibratedWhite: 0.93, alpha: 1).setFill()
        bounds.fill()
        let small: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 11), .foregroundColor: NSColor.black]
        let bold: [NSAttributedString.Key: Any] = [.font: NSFont.boldSystemFont(ofSize: 11), .foregroundColor: NSColor.black]
        ("Records — scroll right for actions" as NSString).draw(at: NSPoint(x: 20, y: 12), withAttributes: bold)
        let columns: [(String, CGFloat)] = [("ID", 20), ("Name", 140), ("Status", 300), ("Notes", 460), ("Owner", 800), ("Action", 1220)]
        for (title, x) in columns { (title as NSString).draw(at: NSPoint(x: x - offset, y: top + 6), withAttributes: bold) }
        for (i, row) in rows.enumerated() {
            let y = top + CGFloat(i + 1) * rowHeight
            NSColor(calibratedWhite: i % 2 == 0 ? 1 : 0.96, alpha: 1).setFill()
            NSRect(x: 0, y: y, width: bounds.width, height: rowHeight).fill()
            for (text, x) in [(row.id, 20), (row.name, 140), (row.status, 300), ("Follow up next week", 460), ("Team \(i % 3 + 1)", 800)] as [(String, CGFloat)] {
                (text as NSString).draw(at: NSPoint(x: x - offset, y: y + 7), withAttributes: small)
            }
            let open = openRect(i)
            NSColor.systemBlue.setFill()
            NSBezierPath(roundedRect: open, xRadius: 4, yRadius: 4).fill()
            ("Open" as NSString).draw(at: NSPoint(x: open.minX + 20, y: open.minY + 3), withAttributes: [.font: NSFont.systemFont(ofSize: 11), .foregroundColor: NSColor.white])
        }
        if let row = detail {
            let text = !loaded ? "Loading record…" : confirmed ? "Record \(row.id) confirmed" : "Record \(row.id) — \(row.name), \(row.status)"
            (text as NSString).draw(at: NSPoint(x: 20, y: bounds.height - 84), withAttributes: bold)
            if loaded && !confirmed {
                NSColor.systemGreen.setFill()
                NSBezierPath(roundedRect: confirmRect, xRadius: 5, yRadius: 5).fill()
                ("Confirm" as NSString).draw(at: NSPoint(x: confirmRect.minX + 26, y: confirmRect.minY + 8), withAttributes: [.font: NSFont.boldSystemFont(ofSize: 12), .foregroundColor: NSColor.white])
            }
        }
    }

    func scrollBy(_ dx: CGFloat) {
        offset = min(max(0, offset + dx), max(0, contentWidth - bounds.width))
        needsDisplay = true
    }

    override func scrollWheel(with event: NSEvent) {
        var dx = event.scrollingDeltaX
        if dx == 0 && event.modifierFlags.contains(.shift) { dx = event.scrollingDeltaY }
        scrollBy(-(event.hasPreciseScrollingDeltas ? dx : dx * 12))
    }

    override func keyDown(with event: NSEvent) {
        switch event.keyCode {
        case 124: scrollBy(240)
        case 123: scrollBy(-240)
        default: super.keyDown(with: event)
        }
    }

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        if let row = detail, loaded, !confirmed, confirmRect.contains(point) {
            record(["confirmed": row.id])
            confirmed = true
            needsDisplay = true
            return
        }
        guard let i = rows.indices.first(where: { openRect($0).contains(point) }) else { return }
        let row = rows[i]
        record(["opened": row.id])
        detail = row
        loaded = false
        confirmed = false
        needsDisplay = true
        showTooltip(near: event.locationInWindow)
        after(2) { [weak self] in
            guard let self, self.detail?.id == row.id else { return }
            self.loaded = true
            self.needsDisplay = true
        }
    }

    func showTooltip(near point: NSPoint) {
        tooltip?.close()
        guard let window = window else { return }
        let screenPoint = window.convertPoint(toScreen: point)
        let panel = KeyPanel(contentRect: NSRect(x: screenPoint.x + 12, y: screenPoint.y - 40, width: 220, height: 28), styleMask: [.borderless], backing: .buffered, defer: false)
        let label = NSTextField(labelWithString: "Opening record…")
        label.frame = NSRect(x: 8, y: 6, width: 200, height: 16)
        panel.contentView?.addSubview(label)
        panel.backgroundColor = NSColor(calibratedRed: 1, green: 1, blue: 0.85, alpha: 1)
        window.addChildWindow(panel, ordered: .above)
        panel.makeKey()
        tooltip = panel
        after(4) { [weak self, weak panel] in
            panel?.close()
            self?.window?.makeKey()
        }
    }
}

final class KeyPanel: NSPanel {
    override var canBecomeKey: Bool { true }
}

// A sign-up form whose username check answers after two seconds. A taken
// username opens an alert sheet with a random suggestion, recorded so the
// task can require it.
final class SignupController: NSObject {
    let window: NSWindow
    let username = NSTextField()
    let email = NSTextField()
    let create = NSButton(title: "Create account", target: nil, action: nil)
    let status = NSTextField(labelWithString: "")

    override init() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 420, height: 220), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        super.init()
        window.title = "Bench Signup"
        username.placeholderString = "Username"
        email.placeholderString = "name@example.com"
        for field in [username, email] { field.widthAnchor.constraint(equalToConstant: 260).isActive = true }
        create.target = self
        create.action = #selector(createAccount)
        func row(_ label: String, _ control: NSView) -> NSView {
            let text = NSTextField(labelWithString: label)
            text.alignment = .right
            text.widthAnchor.constraint(equalToConstant: 90).isActive = true
            return NSStackView(views: [text, control])
        }
        let grid = NSStackView(views: [row("Username", username), row("Email", email), row("", create), status])
        grid.orientation = .vertical
        grid.alignment = .leading
        grid.spacing = 12
        grid.edgeInsets = NSEdgeInsets(top: 20, left: 20, bottom: 20, right: 20)
        window.contentView = grid
    }

    @objc func createAccount() {
        let name = username.stringValue.trimmingCharacters(in: .whitespaces)
        let mail = email.stringValue.trimmingCharacters(in: .whitespaces)
        guard mail.contains("@"), mail.contains(".") else {
            status.stringValue = "Enter a valid email address."
            return
        }
        status.stringValue = "Checking username…"
        create.isEnabled = false
        after(2) { [self] in
            create.isEnabled = true
            if name.lowercased() == "ada" {
                let suggestion = "ada_\(Int.random(in: 10...99))"
                record(["suggested": suggestion])
                status.stringValue = ""
                let alert = NSAlert()
                alert.messageText = "The username “\(name)” is taken."
                alert.informativeText = "Suggested username: \(suggestion)"
                alert.addButton(withTitle: "OK")
                alert.beginSheetModal(for: window)
            } else {
                record(["created": ["username": name, "email": mail]])
                status.stringValue = "Account created for \(name)."
            }
        }
    }
}

final class Delegate: NSObject, NSApplicationDelegate {
    var form: FormController?
    var table: TableController?
    var signup: SignupController?
    var canvasWindow: NSWindow?

    func show(_ window: NSWindow) {
        window.center()
        window.makeKeyAndOrderFront(nil)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        if mode == "canvas" {
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 376, height: 400), styleMask: [.titled, .closable], backing: .buffered, defer: false)
            window.title = "Bench Canvas"
            window.contentView = CanvasView()
            show(window)
            canvasWindow = window
        } else if mode == "remote" {
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 720, height: 480), styleMask: [.titled, .closable], backing: .buffered, defer: false)
            window.title = "Bench Remote"
            let view = RemoteView(frame: NSRect(x: 0, y: 0, width: 720, height: 480))
            window.contentView = view
            show(window)
            window.makeFirstResponder(view)
            canvasWindow = window
        } else if mode == "table" {
            table = TableController()
            show(table!.window)
        } else if mode == "signup" {
            signup = SignupController()
            show(signup!.window)
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
