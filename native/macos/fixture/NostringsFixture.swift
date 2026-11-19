// Nostrings Fixture: a test app for the macOS backend. Every control reports
// what reached it, in a label (id "lastEvent") the checks read through the
// accessibility tree, and as JSON lines in $NOSTRINGS_HOME/fixture.log, so a
// check needs no model and no screenshot. Built by `nostrings smoke --macos`
// (src/macos-fixture.mjs); not shipped to users.

import AppKit
import SwiftUI
import WebKit

let home = ProcessInfo.processInfo.environment["NOSTRINGS_HOME"] ?? (NSHomeDirectory() + "/.nostrings")
let logPath = home + "/fixture.log"
var lastEventField: NSTextField!

func report(_ event: String, _ fields: [String: Any] = [:]) {
    var obj = fields
    obj["event"] = event
    obj["ts"] = Date().timeIntervalSince1970
    if let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]),
       var line = String(data: data, encoding: .utf8) {
        line += "\n"
        if let handle = FileHandle(forWritingAtPath: logPath) {
            handle.seekToEndOfFile()
            handle.write(line.data(using: .utf8)!)
            handle.closeFile()
        } else {
            FileManager.default.createFile(atPath: logPath, contents: line.data(using: .utf8))
        }
    }
    let summary = ([event] + fields.keys.sorted().map { "\($0)=\(fields[$0]!)" }).joined(separator: " ")
    DispatchQueue.main.async { lastEventField?.stringValue = summary }
}

func label(_ text: String) -> NSTextField {
    let field = NSTextField(labelWithString: text)
    return field
}

// MARK: - Pointer canvas

final class Canvas: NSView {
    var downAt: Date?
    var hoverReported = false
    override var acceptsFirstResponder: Bool { true }
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        for area in trackingAreas { removeTrackingArea(area) }
        addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseMoved, .mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self))
    }
    override func draw(_ dirtyRect: NSRect) {
        NSColor.systemTeal.withAlphaComponent(0.25).setFill()
        bounds.fill()
        ("Pointer canvas" as NSString).draw(at: NSPoint(x: 8, y: 8), withAttributes: [.font: NSFont.systemFont(ofSize: 13)])
    }
    func local(_ event: NSEvent) -> [String: Any] {
        let p = convert(event.locationInWindow, from: nil)
        return ["x": Int(p.x), "y": Int(bounds.height - p.y)]
    }
    override func mouseEntered(with event: NSEvent) { report("canvas.enter", local(event)) }
    override func mouseExited(with event: NSEvent) { report("canvas.exit", local(event)) }
    override func mouseMoved(with event: NSEvent) {
        if !hoverReported { hoverReported = true; report("canvas.hover", local(event)) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.hoverReported = false }
    }
    override func mouseDown(with event: NSEvent) {
        downAt = Date()
        var f = local(event); f["clicks"] = event.clickCount
        report("canvas.down", f)
    }
    override func mouseUp(with event: NSEvent) {
        var f = local(event)
        f["heldMs"] = Int((Date().timeIntervalSince(downAt ?? Date())) * 1000)
        f["clicks"] = event.clickCount
        report("canvas.up", f)
    }
    override func mouseDragged(with event: NSEvent) {}
    override func rightMouseDown(with event: NSEvent) { report("canvas.right", local(event)) }
    override func otherMouseDown(with event: NSEvent) {
        var f = local(event); f["button"] = event.buttonNumber
        report("canvas.other", f)
    }
    override func scrollWheel(with event: NSEvent) {
        report("canvas.scroll", ["dx": Int(event.scrollingDeltaX.rounded()), "dy": Int(event.scrollingDeltaY.rounded())])
    }
    override func magnify(with event: NSEvent) {
        if event.phase == .ended || event.phase == [] { report("canvas.magnify", ["m": Double(round(event.magnification * 1000) / 1000)]) }
        else { totalMagnify += event.magnification }
        if event.phase == .ended { report("canvas.pinch", ["total": Double(round(totalMagnify * 100) / 100)]); totalMagnify = 0 }
    }
    var totalMagnify: CGFloat = 0
    var totalRotation: Float = 0
    override func rotate(with event: NSEvent) {
        totalRotation += event.rotation
        if event.phase == .ended || event.phase == [] { report("canvas.rotate", ["total": Int(totalRotation)]); totalRotation = 0 }
    }
    override func swipe(with event: NSEvent) { report("canvas.swipe", ["dx": Int(event.deltaX), "dy": Int(event.deltaY)]) }
    override func smartMagnify(with event: NSEvent) { report("canvas.smartMagnify") }
    override func keyDown(with event: NSEvent) { report("canvas.key", ["chars": event.characters ?? "", "code": Int(event.keyCode)]) }
}

// MARK: - Drop target

final class DropTarget: NSView {
    override init(frame: NSRect) {
        super.init(frame: frame)
        registerForDraggedTypes([.fileURL, .string])
    }
    required init?(coder: NSCoder) { fatalError() }
    override func draw(_ dirtyRect: NSRect) {
        NSColor.systemOrange.withAlphaComponent(0.25).setFill()
        bounds.fill()
        ("Drop files here" as NSString).draw(at: NSPoint(x: 8, y: 8), withAttributes: [.font: NSFont.systemFont(ofSize: 13)])
    }
    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation { .copy }
    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let urls = (sender.draggingPasteboard.readObjects(forClasses: [NSURL.self]) as? [URL]) ?? []
        let text = sender.draggingPasteboard.string(forType: .string)
        report("drop", ["files": urls.map { $0.lastPathComponent }.joined(separator: ","), "text": text ?? ""])
        return true
    }
}

// MARK: - Hover label

final class HoverLabel: NSTextField {
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        for area in trackingAreas { removeTrackingArea(area) }
        addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self))
    }
    override func mouseEntered(with event: NSEvent) { stringValue = "Hovered"; report("hover.enter") }
    override func mouseExited(with event: NSEvent) { stringValue = "Hover me"; report("hover.exit") }
}

// MARK: - Controller

final class Controller: NSObject, NSApplicationDelegate, NSTextFieldDelegate, NSTextViewDelegate, WKScriptMessageHandler, NSWindowDelegate {
    var window: NSWindow!
    var extraWindows: [NSWindow] = []
    var checkItem: NSMenuItem!
    let colorPopup = NSPopUpButton(frame: .zero, pullsDown: false)

    func applicationDidFinishLaunching(_ notification: Notification) {
        try? FileManager.default.createDirectory(atPath: home, withIntermediateDirectories: true)
        buildMenus()
        buildWindow()
        if ProcessInfo.processInfo.arguments.contains("--swiftui") || ProcessInfo.processInfo.environment["NOSTRINGS_FIXTURE_SWIFTUI"] != nil { openSwiftUIWindow() }
        report("launched", ["pid": Int(getpid())])
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        report("quit")
        return .terminateNow
    }

    func applicationDidHide(_ notification: Notification) { report("app.hidden") }
    func applicationDidUnhide(_ notification: Notification) { report("app.unhidden") }

    // MARK: Menus

    func item(_ title: String, _ action: Selector?, _ key: String = "", _ mods: NSEvent.ModifierFlags = [.command]) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.keyEquivalentModifierMask = mods
        item.target = self
        return item
    }

    func buildMenus() {
        let main = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Hide Nostrings Fixture", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Quit Nostrings Fixture", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        let fileItem = NSMenuItem()
        let file = NSMenu(title: "File")
        file.addItem(item("New Window", #selector(newWindow), "n"))
        file.addItem(item("SwiftUI Window", #selector(showSwiftUI)))
        file.addItem(item("Open…", #selector(openPanel), "o"))
        file.addItem(item("Save…", #selector(savePanel), "s"))
        file.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        fileItem.submenu = file
        main.addItem(fileItem)

        let editItem = NSMenuItem()
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        main.addItem(editItem)

        let fxItem = NSMenuItem()
        let fx = NSMenu(title: "Fixture")
        fx.addItem(item("Alpha", #selector(menuPicked(_:)), "a", [.command, .shift]))
        fx.addItem(item("Beta", #selector(menuPicked(_:))))
        let more = NSMenuItem(title: "More", action: nil, keyEquivalent: "")
        let moreMenu = NSMenu(title: "More")
        moreMenu.addItem(item("Gamma", #selector(menuPicked(_:)), "g", [.command, .option]))
        more.submenu = moreMenu
        fx.addItem(more)
        let delta = NSMenuItem(title: "Delta", action: nil, keyEquivalent: "")
        delta.isEnabled = false
        fx.autoenablesItems = false
        fx.addItem(delta)
        checkItem = item("Check Me", #selector(toggleCheck))
        fx.addItem(checkItem)
        fxItem.submenu = fx
        main.addItem(fxItem)

        let windowItem = NSMenuItem()
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        windowItem.submenu = windowMenu
        main.addItem(windowItem)
        NSApp.windowsMenu = windowMenu
        NSApp.mainMenu = main
    }

    @objc func showSwiftUI() { openSwiftUIWindow(); report("window.new", ["title": "SwiftUI Fixture"]) }

    @objc func menuPicked(_ sender: NSMenuItem) { report("menu", ["item": sender.title]) }
    @objc func toggleCheck() {
        checkItem.state = checkItem.state == .on ? .off : .on
        report("menu", ["item": "Check Me", "state": checkItem.state == .on ? "on" : "off"])
    }

    @objc func newWindow() {
        let w = NSWindow(contentRect: NSRect(x: 200, y: 200, width: 360, height: 200), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        w.title = "Fixture Window \(extraWindows.count + 2)"
        w.isReleasedWhenClosed = false
        w.delegate = self
        let text = label("Second window")
        text.frame = NSRect(x: 20, y: 120, width: 300, height: 24)
        w.contentView?.addSubview(text)
        extraWindows.append(w)
        w.orderFront(nil)
        report("window.new", ["title": w.title])
    }

    @objc func openPanel() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = true
        panel.beginSheetModal(for: window) { response in
            report("open", ["ok": response == .OK, "path": panel.url?.path ?? ""])
        }
    }

    @objc func savePanel() {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = "fixture.txt"
        panel.beginSheetModal(for: window) { response in
            // Only reports the choice: a test app must never write files.
            report("save", ["ok": response == .OK, "path": panel.url?.path ?? ""])
        }
    }

    // MARK: Window

    func buildWindow() {
        window = NSWindow(contentRect: NSRect(x: 120, y: 120, width: 760, height: 760), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Nostrings Fixture"
        window.isReleasedWhenClosed = false
        window.delegate = self
        let content = NSView(frame: window.contentRect(forFrameRect: window.frame))
        window.contentView = content

        func row(_ views: [NSView]) -> NSStackView {
            let s = NSStackView(views: views)
            s.orientation = .horizontal
            s.spacing = 8
            s.alignment = .centerY
            return s
        }
        func field(_ title: String, id: String, secure: Bool = false) -> NSStackView {
            let l = label("\(title):")
            let f: NSTextField = secure ? NSSecureTextField() : NSTextField()
            f.placeholderString = secure ? "" : "Type \(title.lowercased())"
            f.setAccessibilityIdentifier(id)
            f.delegate = self
            f.widthAnchor.constraint(equalToConstant: 220).isActive = true
            f.setAccessibilityTitleUIElement(l)
            return row([l, f])
        }

        lastEventField = label("ready")
        lastEventField.setAccessibilityIdentifier("lastEvent")
        lastEventField.lineBreakMode = .byTruncatingTail
        lastEventField.widthAnchor.constraint(equalToConstant: 700).isActive = true

        let subscribe = NSButton(checkboxWithTitle: "Subscribe", target: self, action: #selector(checkbox(_:)))
        colorPopup.addItems(withTitles: ["Red", "Green", "Blue", "Purple"])
        colorPopup.target = self
        colorPopup.action = #selector(popupPicked(_:))
        colorPopup.setAccessibilityIdentifier("color")
        let colorLabel = label("Color:")
        colorPopup.setAccessibilityTitleUIElement(colorLabel)
        let slider = NSSlider(value: 50, minValue: 0, maxValue: 100, target: self, action: #selector(sliderMoved(_:)))
        slider.setAccessibilityIdentifier("volume")
        slider.widthAnchor.constraint(equalToConstant: 160).isActive = true
        let stepper = NSStepper()
        stepper.minValue = 0; stepper.maxValue = 10; stepper.integerValue = 5
        stepper.target = self; stepper.action = #selector(stepped(_:))
        stepper.setAccessibilityIdentifier("count")

        let sheetButton = NSButton(title: "Show Sheet", target: self, action: #selector(showSheet))
        let alertButton = NSButton(title: "Show Alert", target: self, action: #selector(showAlert))
        let tipButton = NSButton(title: "Tooltip", target: self, action: #selector(plainButton(_:)))
        tipButton.toolTip = "Fixture tooltip text"
        let hover = HoverLabel(labelWithString: "Hover me")
        hover.setAccessibilityIdentifier("hoverLabel")
        let context = NSTextField(labelWithString: "Right-click here")
        context.setAccessibilityIdentifier("contextTarget")
        let contextMenu = NSMenu()
        contextMenu.addItem(item("Copy Item", #selector(menuPicked(_:))))
        contextMenu.addItem(item("Rename Item", #selector(menuPicked(_:))))
        context.menu = contextMenu

        let canvas = Canvas(frame: NSRect(x: 0, y: 0, width: 340, height: 180))
        canvas.setAccessibilityElement(true)
        canvas.setAccessibilityRole(.group)
        canvas.setAccessibilityLabel("Pointer canvas")
        canvas.setAccessibilityIdentifier("canvas")
        canvas.widthAnchor.constraint(equalToConstant: 340).isActive = true
        canvas.heightAnchor.constraint(equalToConstant: 180).isActive = true
        let drop = DropTarget(frame: NSRect(x: 0, y: 0, width: 200, height: 180))
        drop.setAccessibilityElement(true)
        drop.setAccessibilityRole(.group)
        drop.setAccessibilityLabel("Drop target")
        drop.setAccessibilityIdentifier("dropTarget")
        drop.widthAnchor.constraint(equalToConstant: 200).isActive = true
        drop.heightAnchor.constraint(equalToConstant: 180).isActive = true

        let scroll = NSTextView.scrollableTextView()
        let textView = scroll.documentView as! NSTextView
        textView.setAccessibilityIdentifier("notes")
        textView.delegate = self
        textView.isRichText = false
        scroll.widthAnchor.constraint(equalToConstant: 340).isActive = true
        scroll.heightAnchor.constraint(equalToConstant: 90).isActive = true

        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "fixture")
        let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 340, height: 140), configuration: config)
        web.widthAnchor.constraint(equalToConstant: 340).isActive = true
        web.heightAnchor.constraint(equalToConstant: 140).isActive = true
        web.loadHTMLString("""
        <html><body style="font: 13px -apple-system">
        <h1 style="font-size:16px">Web Fixture</h1>
        <a href="#" onclick="webkit.messageHandlers.fixture.postMessage('link');return false">Web link</a>
        <input id="q" placeholder="Web field" oninput="webkit.messageHandlers.fixture.postMessage('input:'+this.value)">
        <button onclick="webkit.messageHandlers.fixture.postMessage('button')">Web button</button>
        </body></html>
        """, baseURL: nil)

        let stack = NSStackView(views: [
            lastEventField,
            field("Name", id: "name"),
            field("Email", id: "email"),
            field("Password", id: "password", secure: true),
            row([subscribe, colorLabel, colorPopup, label("Volume:"), slider, stepper]),
            row([sheetButton, alertButton, tipButton, hover, context]),
            row([canvas, drop]),
            row([scroll, web]),
        ])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 12
        stack.edgeInsets = NSEdgeInsets(top: 16, left: 16, bottom: 16, right: 16)
        stack.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: content.topAnchor),
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor),
        ])
        window.orderFront(nil)
    }

    @objc func checkbox(_ sender: NSButton) { report("checkbox", ["on": sender.state == .on]) }
    @objc func popupPicked(_ sender: NSPopUpButton) { report("popup", ["item": sender.titleOfSelectedItem ?? ""]) }
    @objc func sliderMoved(_ sender: NSSlider) { report("slider", ["value": sender.integerValue]) }
    @objc func stepped(_ sender: NSStepper) { report("stepper", ["value": sender.integerValue]) }
    @objc func plainButton(_ sender: NSButton) { report("button", ["title": sender.title]) }

    @objc func showSheet() {
        let sheet = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 320, height: 120), styleMask: [.titled], backing: .buffered, defer: false)
        let text = NSTextField(frame: NSRect(x: 20, y: 70, width: 280, height: 24))
        text.placeholderString = "Sheet field"
        text.setAccessibilityIdentifier("sheetField")
        let ok = NSButton(title: "OK", target: nil, action: nil)
        ok.frame = NSRect(x: 220, y: 20, width: 80, height: 30)
        ok.keyEquivalent = "\r"
        let cancel = NSButton(title: "Cancel", target: nil, action: nil)
        cancel.frame = NSRect(x: 130, y: 20, width: 80, height: 30)
        sheet.contentView?.addSubview(text)
        sheet.contentView?.addSubview(ok)
        sheet.contentView?.addSubview(cancel)
        final class Closer: NSObject {
            let sheet: NSWindow, parent: NSWindow, field: NSTextField
            init(_ s: NSWindow, _ p: NSWindow, _ f: NSTextField) { sheet = s; parent = p; field = f }
            @objc func ok() { report("sheet", ["result": "OK", "text": field.stringValue]); parent.endSheet(sheet) }
            @objc func cancel() { report("sheet", ["result": "Cancel"]); parent.endSheet(sheet) }
        }
        let closer = Closer(sheet, window, text)
        ok.target = closer; ok.action = #selector(Closer.ok)
        cancel.target = closer; cancel.action = #selector(Closer.cancel)
        objc_setAssociatedObject(sheet, "closer", closer, .OBJC_ASSOCIATION_RETAIN)
        window.beginSheet(sheet)
        report("sheet.open")
    }

    @objc func showAlert() {
        let alert = NSAlert()
        alert.messageText = "Fixture alert"
        alert.informativeText = "Keep or discard the changes?"
        alert.addButton(withTitle: "Keep")
        alert.addButton(withTitle: "Discard")
        report("alert.open")
        alert.beginSheetModal(for: window) { response in
            report("alert", ["result": response == .alertFirstButtonReturn ? "Keep" : "Discard"])
        }
    }

    // MARK: Delegates

    func controlTextDidChange(_ obj: Notification) {
        guard let f = obj.object as? NSTextField else { return }
        let id = f.accessibilityIdentifier()
        report("text", ["field": id, "value": id == "password" ? "(\(f.stringValue.count) chars)" : f.stringValue])
    }

    func textDidChange(_ notification: Notification) {
        guard let t = notification.object as? NSTextView else { return }
        report("notes", ["value": t.string])
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        report("web", ["what": "\(message.body)"])
    }

    func windowDidMiniaturize(_ notification: Notification) { report("window.minimized", ["title": (notification.object as? NSWindow)?.title ?? ""]) }
    func windowDidDeminiaturize(_ notification: Notification) { report("window.restored", ["title": (notification.object as? NSWindow)?.title ?? ""]) }
    func windowDidResize(_ notification: Notification) {
        guard let w = notification.object as? NSWindow else { return }
        report("window.resized", ["w": Int(w.frame.width), "h": Int(w.frame.height)])
    }
    func windowDidMove(_ notification: Notification) {
        guard let w = notification.object as? NSWindow else { return }
        report("window.moved", ["x": Int(w.frame.minX), "y": Int(w.frame.minY)])
    }
    func windowDidEnterFullScreen(_ notification: Notification) { report("window.fullscreen", ["on": true]) }
    func windowDidExitFullScreen(_ notification: Notification) { report("window.fullscreen", ["on": false]) }
    func windowWillClose(_ notification: Notification) { report("window.closed", ["title": (notification.object as? NSWindow)?.title ?? ""]) }
    func windowDidBecomeKey(_ notification: Notification) { report("window.key", ["title": (notification.object as? NSWindow)?.title ?? ""]) }
}

// MARK: - SwiftUI window
//
// SwiftUI controls expose accessibility differently from AppKit ones, so the
// same kinds of control are here again, built in SwiftUI.

// No @State: the command line tools ship without SwiftUI's macro plugin.
final class PanelModel: ObservableObject {
    @Published var on = false { didSet { report("swiftui.toggle", ["on": on]) } }
    @Published var flavor = "Vanilla" { didSet { report("swiftui.picker", ["item": flavor]) } }
    @Published var name = "" { didSet { report("swiftui.text", ["value": name]) } }
    @Published var level = 3.0 { didSet { report("swiftui.slider", ["value": Int(level)]) } }
    @Published var count = 1 { didSet { report("swiftui.stepper", ["value": count]) } }
    @Published var picked: String? = nil { didSet { report("swiftui.list", ["item": picked ?? ""]) } }
}

struct SwiftUIPanel: View {
    @ObservedObject var model: PanelModel
    let rows = ["Apple", "Banana", "Cherry"]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("SwiftUI Fixture").font(.headline)
            Toggle("Dark Roast", isOn: $model.on)
            Picker("Flavor", selection: $model.flavor) {
                ForEach(["Vanilla", "Mocha", "Caramel"], id: \.self) { Text($0) }
            }
            TextField("Order name", text: $model.name)
            Slider(value: $model.level, in: 0...10)
            Stepper("Shots: \(model.count)", value: $model.count, in: 0...5)
            Button("Place Order") { report("swiftui.button", ["name": model.name, "flavor": model.flavor]) }
            Menu("More Actions") {
                Button("Duplicate") { report("swiftui.menu", ["item": "Duplicate"]) }
                Button("Archive") { report("swiftui.menu", ["item": "Archive"]) }
            }
            List(rows, id: \.self, selection: $model.picked) { Text($0) }
                .frame(height: 90)
        }
        .padding(16)
        .frame(width: 320)
    }
}

func openSwiftUIWindow() {
    let w = NSWindow(contentRect: NSRect(x: 920, y: 200, width: 340, height: 420), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    w.title = "SwiftUI Fixture"
    w.isReleasedWhenClosed = false
    w.contentView = NSHostingView(rootView: SwiftUIPanel(model: panelModel))
    w.orderFront(nil)
    swiftUIWindow = w
}
var swiftUIWindow: NSWindow?
let panelModel = PanelModel()

let app = NSApplication.shared
let controller = Controller()
app.delegate = controller
app.setActivationPolicy(.regular)
app.run()
