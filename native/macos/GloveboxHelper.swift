// glovebox-helper: the macOS backend for glovebox.
//
// A small JSON-lines RPC server on a Unix socket (~/.glovebox/helper.sock),
// packaged as its own app so macOS grants Accessibility and Screen Recording
// to "Glovebox Helper" once, whichever agent or terminal starts it. Each request is
// {"id": n, "method": "...", "params": {...}} and each reply is
// {"id": n, "result": ...} or {"id": n, "error": {"message": "..."}}.
// Unsolicited events are {"event": "..."}.
//
// Coordinates on this side are always global screen points, top-left origin
// (the same space AX and CGEvent use). The Node side owns the mapping between
// those points and the image pixels a model sees.
//
// Build: glovebox setup (see src/macos-helper.mjs).

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ScreenCaptureKit
import UniformTypeIdentifiers

let helperVersion = "0.4.0"
// Marks events we synthesize so the Escape watcher ignores them.
let syntheticMarker: Int64 = 0x676C_6F76

// MARK: - Output

// Sends an unsolicited event to every connected client.
func emit(_ object: [String: Any]) {
    for connection in Connection.all() { connection.send(object) }
}

struct HelperError: Error {
    let message: String
    let code: String
    init(_ message: String, code: String = "failed") {
        self.message = message
        self.code = code
    }
}

// MARK: - Param helpers

extension Dictionary where Key == String, Value == Any {
    func int(_ key: String) -> Int? {
        if let v = self[key] as? Int { return v }
        if let v = self[key] as? Double { return Int(v) }
        if let v = self[key] as? NSNumber { return v.intValue }
        return nil
    }
    func double(_ key: String) -> Double? {
        if let v = self[key] as? Double { return v }
        if let v = self[key] as? Int { return Double(v) }
        if let v = self[key] as? NSNumber { return v.doubleValue }
        return nil
    }
    func string(_ key: String) -> String? { self[key] as? String }
    func bool(_ key: String) -> Bool? { self[key] as? Bool }
    func requireInt(_ key: String) throws -> Int {
        guard let v = int(key) else { throw HelperError("missing integer param \(key)", code: "bad_request") }
        return v
    }
    func requireDouble(_ key: String) throws -> Double {
        guard let v = double(key) else { throw HelperError("missing number param \(key)", code: "bad_request") }
        return v
    }
}

// MARK: - Apps

func appInfo(_ app: NSRunningApplication) -> [String: Any] {
    var info: [String: Any] = [
        "name": app.localizedName ?? "",
        "pid": Int(app.processIdentifier),
        "running": true,
        "active": app.isActive,
        "hidden": app.isHidden,
    ]
    if let id = app.bundleIdentifier { info["bundleId"] = id }
    if let url = app.bundleURL { info["path"] = url.path }
    return info
}

func installedApps() -> [[String: Any]] {
    var roots = ["/Applications", "/Applications/Utilities", "/System/Applications", "/System/Applications/Utilities"]
    roots.append(NSHomeDirectory() + "/Applications")
    var seen = Set<String>()
    var out: [[String: Any]] = []
    let fm = FileManager.default
    for root in roots {
        guard let items = try? fm.contentsOfDirectory(atPath: root) else { continue }
        for item in items where item.hasSuffix(".app") {
            let path = root + "/" + item
            guard let bundle = Bundle(path: path), let id = bundle.bundleIdentifier, !seen.contains(id) else { continue }
            seen.insert(id)
            let name = (bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String)
                ?? (bundle.object(forInfoDictionaryKey: "CFBundleName") as? String)
                ?? String(item.dropLast(4))
            out.append(["name": name, "bundleId": id, "path": path, "running": false])
        }
    }
    return out
}

func listApps() -> [[String: Any]] {
    var out: [[String: Any]] = []
    var seen = Set<String>()
    for app in NSWorkspace.shared.runningApplications where app.activationPolicy == .regular {
        out.append(appInfo(app))
        if let id = app.bundleIdentifier { seen.insert(id) }
    }
    for app in installedApps() where !seen.contains(app["bundleId"] as? String ?? "") {
        out.append(app)
    }
    return out
}

func resolveApp(_ query: String) throws -> [String: Any] {
    let q = query.lowercased()
    let running = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy != .prohibited }
    if q.hasPrefix("pid:"), let pid = Int32(q.dropFirst(4)),
       let app = NSRunningApplication(processIdentifier: pid) {
        return appInfo(app)
    }
    for app in running {
        if app.bundleIdentifier?.lowercased() == q || app.localizedName?.lowercased() == q {
            return appInfo(app)
        }
    }
    let installed = installedApps()
    for app in installed {
        if (app["bundleId"] as? String)?.lowercased() == q || (app["name"] as? String)?.lowercased() == q {
            return app
        }
    }
    if query.hasSuffix(".app") || query.hasPrefix("/"), let bundle = Bundle(path: query), let id = bundle.bundleIdentifier {
        return ["name": bundle.bundleURL.deletingPathExtension().lastPathComponent, "bundleId": id, "path": query, "running": false]
    }
    let near = (running.compactMap { $0.localizedName } + installed.compactMap { $0["name"] as? String })
        .filter { $0.lowercased().contains(q) }
    let hint = near.isEmpty ? "" : " Did you mean: \(Array(Set(near)).sorted().prefix(5).joined(separator: ", "))?"
    throw HelperError("No app named \"\(query)\".\(hint)", code: "not_found")
}

// NSRunningApplication(processIdentifier:) can come back nil for a live app
// when called off the main thread, so a miss is checked against the process
// table and the workspace list before calling the app gone.
func runningApp(_ pid: Int) throws -> NSRunningApplication {
    if let app = NSRunningApplication(processIdentifier: pid_t(pid)), !app.isTerminated { return app }
    if kill(pid_t(pid), 0) == 0 {
        var found: NSRunningApplication?
        let look = {
            found = NSRunningApplication(processIdentifier: pid_t(pid))
                ?? NSWorkspace.shared.runningApplications.first { $0.processIdentifier == pid_t(pid) }
        }
        if Thread.isMainThread { look() } else { DispatchQueue.main.sync(execute: look) }
        if let app = found { return app }
    }
    throw HelperError("App with pid \(pid) is not running", code: "not_running")
}

func launch(_ params: [String: Any]) throws -> [String: Any] {
    if let bundleId = params.string("bundleId"),
       let app = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == bundleId }) {
        return appInfo(app)
    }
    var url: URL?
    if let path = params.string("path") { url = URL(fileURLWithPath: path) }
    if url == nil, let bundleId = params.string("bundleId") {
        url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId)
    }
    guard let appURL = url else { throw HelperError("Cannot locate app to launch", code: "not_found") }
    let config = NSWorkspace.OpenConfiguration()
    config.activates = params.bool("activate") ?? true
    let done = DispatchSemaphore(value: 0)
    var launched: NSRunningApplication?
    var failure: Error?
    NSWorkspace.shared.openApplication(at: appURL, configuration: config) { app, error in
        launched = app
        failure = error
        done.signal()
    }
    if done.wait(timeout: .now() + 20) == .timedOut { throw HelperError("Timed out launching \(appURL.lastPathComponent)") }
    if let error = failure { throw HelperError("Launch failed: \(error.localizedDescription)") }
    guard let app = launched else { throw HelperError("Launch returned no app") }
    // Give the app a moment to put up a window.
    let element = AXUIElementCreateApplication(app.processIdentifier)
    for _ in 0..<50 {
        if let windows: [AXUIElement] = axAttr(element, kAXWindowsAttribute), !windows.isEmpty { break }
        Thread.sleep(forTimeInterval: 0.1)
    }
    return appInfo(app)
}

func activate(_ pid: Int) throws {
    let app = try runningApp(pid)
    if app.isActive { return }
    if app.isHidden { app.unhide() }
    let element = AXUIElementCreateApplication(pid_t(pid))
    AXUIElementSetAttributeValue(element, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
    for _ in 0..<20 {
        if app.isActive { return }
        Thread.sleep(forTimeInterval: 0.05)
    }
    if let url = app.bundleURL {
        let config = NSWorkspace.OpenConfiguration()
        config.activates = true
        NSWorkspace.shared.openApplication(at: url, configuration: config, completionHandler: nil)
    } else {
        app.activate(options: [.activateAllWindows])
    }
    for _ in 0..<40 {
        if app.isActive { return }
        Thread.sleep(forTimeInterval: 0.05)
    }
    throw HelperError("Could not bring \(app.localizedName ?? "app") to the front", code: "activate_failed")
}

// MARK: - AX basics

func axAttr<T>(_ element: AXUIElement, _ name: String) -> T? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success, let v = value else { return nil }
    return v as? T
}

func axPoint(_ value: CFTypeRef?) -> CGPoint? {
    guard let v = value, CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero
    return AXValueGetValue(v as! AXValue, .cgPoint, &point) ? point : nil
}

func axSize(_ value: CFTypeRef?) -> CGSize? {
    guard let v = value, CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
    var size = CGSize.zero
    return AXValueGetValue(v as! AXValue, .cgSize, &size) ? size : nil
}

func axFrame(_ element: AXUIElement) -> CGRect? {
    var pos: CFTypeRef?
    var size: CFTypeRef?
    AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &pos)
    AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &size)
    guard let p = axPoint(pos), let s = axSize(size) else { return nil }
    return CGRect(origin: p, size: s)
}

func rectJSON(_ r: CGRect) -> [Double] {
    [Double(r.origin.x), Double(r.origin.y), Double(r.size.width), Double(r.size.height)]
}

func stringify(_ value: Any?, limit: Int) -> String? {
    guard let value = value else { return nil }
    var text: String?
    switch value {
    case let s as String: text = s
    case let n as NSNumber: text = n.stringValue
    case let a as NSAttributedString: text = a.string
    case let url as URL: text = url.absoluteString
    default:
        let cf = value as CFTypeRef
        if CFGetTypeID(cf) == AXValueGetTypeID() { return nil }
        if CFGetTypeID(cf) == AXUIElementGetTypeID() { return nil }
        text = nil
    }
    guard var t = text, !t.isEmpty else { return nil }
    if t.count > limit { t = String(t.prefix(limit)) + "…" }
    return t
}

// MARK: - Element tables (stable indices per app)

final class ElementTable {
    var elements: [AXUIElement] = []
    var buckets: [CFHashCode: [Int]] = [:]

    func index(of element: AXUIElement) -> Int {
        let hash = CFHash(element)
        if let candidates = buckets[hash] {
            for i in candidates where CFEqual(elements[i], element) { return i }
        }
        elements.append(element)
        let i = elements.count - 1
        buckets[hash, default: []].append(i)
        return i
    }

    func element(_ index: Int) throws -> AXUIElement {
        guard index >= 0 && index < elements.count else {
            throw HelperError("No element \(index). Read the accessibility tree again.", code: "stale_index")
        }
        return elements[index]
    }
}

var tables: [Int: ElementTable] = [:]

func table(_ pid: Int) -> ElementTable {
    if let t = tables[pid] { return t }
    let t = ElementTable()
    tables[pid] = t
    return t
}

// MARK: - Windows

func cgWindows(pid: Int) -> [[String: Any]] {
    guard let info = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return [] }
    return info.filter { ($0[kCGWindowOwnerPID as String] as? Int) == pid && ($0[kCGWindowLayer as String] as? Int) == 0 }
}

func cgWindowID(pid: Int, frame: CGRect) -> Int? {
    var best: (Int, CGFloat)?
    for w in cgWindows(pid: pid) {
        guard let id = w[kCGWindowNumber as String] as? Int,
              let b = w[kCGWindowBounds as String] as? [String: Any],
              let rect = CGRect(dictionaryRepresentation: b as CFDictionary) else { continue }
        let d = abs(rect.minX - frame.minX) + abs(rect.minY - frame.minY) + abs(rect.width - frame.width) + abs(rect.height - frame.height)
        if best == nil || d < best!.1 { best = (id, d) }
    }
    if let b = best, b.1 < 8 { return b.0 }
    return nil
}

func backingScale(for frame: CGRect) -> Double {
    // NSScreen frames are bottom-left origin; convert the window's center.
    guard let primary = NSScreen.screens.first else { return 2 }
    let center = CGPoint(x: frame.midX, y: primary.frame.height - frame.midY)
    for screen in NSScreen.screens where screen.frame.contains(center) {
        return Double(screen.backingScaleFactor)
    }
    return Double(primary.backingScaleFactor)
}

func axWindows(_ pid: Int) -> [AXUIElement] {
    let app = AXUIElementCreateApplication(pid_t(pid))
    return axAttr(app, kAXWindowsAttribute) ?? []
}

func windowsInfo(_ pid: Int) -> [[String: Any]] {
    let app = AXUIElementCreateApplication(pid_t(pid))
    let focused: AXUIElement? = axAttr(app, kAXFocusedWindowAttribute)
    let main: AXUIElement? = axAttr(app, kAXMainWindowAttribute)
    var out: [[String: Any]] = []
    for (i, w) in axWindows(pid).enumerated() {
        guard let frame = axFrame(w) else { continue }
        var info: [String: Any] = [
            "index": i,
            "title": (axAttr(w, kAXTitleAttribute) as String?) ?? "",
            "frame": rectJSON(frame),
            "scale": backingScale(for: frame),
            "minimized": (axAttr(w, kAXMinimizedAttribute) as Bool?) ?? false,
            "focused": focused.map { CFEqual($0, w) } ?? false,
            "main": main.map { CFEqual($0, w) } ?? false,
        ]
        if let role: String = axAttr(w, kAXSubroleAttribute) { info["subrole"] = role }
        if let id = cgWindowID(pid: pid, frame: frame) { info["windowId"] = id }
        out.append(info)
    }
    return out
}

// Normal windows of the app that are not on screen and that Accessibility
// does not list: on another Space, such as a full-screen window whose Space
// is not showing.
func otherSpaceWindows(_ pid: Int) -> [[String: Any]] {
    let listed = Set(axWindows(pid).compactMap { w in axFrame(w).flatMap { cgWindowID(pid: pid, frame: $0) } })
    return cgWindows(pid: pid).compactMap { w in
        guard let id = w[kCGWindowNumber as String] as? Int, !listed.contains(id),
              (w[kCGWindowIsOnscreen as String] as? Bool) != true,
              let b = w[kCGWindowBounds as String] as? [String: Any],
              let rect = CGRect(dictionaryRepresentation: b as CFDictionary), rect.width >= 160, rect.height >= 100 else { return nil }
        var out: [String: Any] = ["windowId": id, "frame": rectJSON(rect)]
        if let t = w[kCGWindowName as String] as? String, !t.isEmpty { out["title"] = t }
        return out
    }
}

// Picks the window an action should target: an explicit index, else focused, main, first.
func targetWindow(_ pid: Int, _ params: [String: Any]) throws -> (AXUIElement, Int) {
    let windows = axWindows(pid)
    if windows.isEmpty { throw HelperError("The app has no open windows", code: "no_window") }
    if let i = params.int("window") {
        guard i >= 0 && i < windows.count else { throw HelperError("No window \(i); the app has \(windows.count)", code: "no_window") }
        return (windows[i], i)
    }
    let app = AXUIElementCreateApplication(pid_t(pid))
    for attr in [kAXFocusedWindowAttribute, kAXMainWindowAttribute] {
        if let w: AXUIElement = axAttr(app, attr), let i = windows.firstIndex(where: { CFEqual($0, w) }) {
            return (w, i)
        }
    }
    return (windows[0], 0)
}

// MARK: - Accessibility tree

let treeAttributes: [String] = [
    kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXValueAttribute, kAXDescriptionAttribute,
    kAXHelpAttribute, kAXPlaceholderValueAttribute, kAXPositionAttribute, kAXSizeAttribute, kAXChildrenAttribute,
    kAXEnabledAttribute, kAXFocusedAttribute, kAXSelectedAttribute, kAXIdentifierAttribute,
    kAXRoleDescriptionAttribute,
]

func axTree(_ params: [String: Any]) throws -> [String: Any] {
    let pid = try params.requireInt("pid")
    _ = try runningApp(pid)
    let maxNodes = params.int("maxNodes") ?? 800
    let maxDepth = params.int("maxDepth") ?? 40
    let maxText = params.int("maxText") ?? 160
    let includeMenus = params.bool("menus") ?? false
    enableWebAccessibility(pid)
    let windowless = axWindows(pid).isEmpty
    let (window, windowIndex): (AXUIElement, Int) = windowless ? (AXUIElementCreateApplication(pid_t(pid)), -1) : try targetWindow(pid, params)
    let t = table(pid)
    var nodes: [[String: Any]] = []
    var truncated = false

    let appElement = AXUIElementCreateApplication(pid_t(pid))
    let focusedElement: AXUIElement? = axAttr(appElement, kAXFocusedUIElementAttribute)

    func visit(_ element: AXUIElement, _ depth: Int) {
        if nodes.count >= maxNodes { truncated = true; return }
        var raw: CFArray?
        let err = AXUIElementCopyMultipleAttributeValues(element, treeAttributes as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &raw)
        guard err == .success, let values = raw as? [Any] else { return }
        func v(_ i: Int) -> Any? {
            let value = values[i]
            if CFGetTypeID(value as CFTypeRef) == AXValueGetTypeID() {
                // Errors come back as AXValue of type kAXValueAXErrorType.
                if AXValueGetType(value as! AXValue) == .axError { return nil }
            }
            return value is NSNull ? nil : value
        }
        var node: [String: Any] = ["i": t.index(of: element), "d": depth]
        node["role"] = (v(0) as? String) ?? "AXUnknown"
        if let s = v(1) as? String { node["subrole"] = s }
        if let s = stringify(v(2), limit: maxText) { node["title"] = s }
        if let s = stringify(v(3), limit: maxText) { node["value"] = s }
        if let s = stringify(v(4), limit: maxText) { node["desc"] = s }
        if let s = stringify(v(5), limit: maxText) { node["help"] = s }
        if let s = stringify(v(6), limit: maxText) { node["placeholder"] = s }
        if let p = axPoint(v(7) as CFTypeRef?), let s = axSize(v(8) as CFTypeRef?) {
            node["frame"] = rectJSON(CGRect(origin: p, size: s))
        }
        if let enabled = v(10) as? Bool, !enabled { node["disabled"] = true }
        if let focused = v(11) as? Bool, focused { node["focused"] = true }
        else if let f = focusedElement, CFEqual(f, element) { node["focused"] = true }
        if let selected = v(12) as? Bool, selected { node["selected"] = true }
        if let s = v(13) as? String, !s.isEmpty { node["id"] = s }
        // A field labeled by a separate text element (AppKit forms) takes its label.
        if node["title"] == nil && node["desc"] == nil, let labelElement: AXUIElement = axAttr(element, kAXTitleUIElementAttribute) {
            let text = (axAttr(labelElement, kAXValueAttribute) as String?) ?? (axAttr(labelElement, kAXTitleAttribute) as String?)
            if let t = stringify(text?.trimmingCharacters(in: CharacterSet(charactersIn: ": ")), limit: maxText) { node["desc"] = t }
        }
        var names: CFArray?
        if AXUIElementCopyActionNames(element, &names) == .success, let actions = names as? [String] {
            let useful = actions.filter { $0 != "AXScrollToVisible" && $0 != "AXShowDefaultUI" && $0 != "AXShowAlternateUI" }
            if !useful.isEmpty { node["actions"] = useful }
        }
        var settable: DarwinBoolean = false
        if AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable) == .success, settable.boolValue {
            node["settable"] = true
        }
        nodes.append(node)
        if depth >= maxDepth { return }
        if let children = v(9) as? [AXUIElement] {
            for child in children {
                if nodes.count >= maxNodes { truncated = true; return }
                visit(child, depth + 1)
            }
        }
    }

    AXUIElementSetMessagingTimeout(appElement, 2.0)
    if windowless {
        // An app with no windows (the Dock, a menu bar app): read what it has.
        for child in axChildren(appElement) where axRole(child) != kAXMenuBarRole { visit(child, 0) }
        if let extras: AXUIElement = axAttr(appElement, kAXExtrasMenuBarAttribute) { visit(extras, 0) }
    } else {
        visit(window, 0)
        // Open pop-up and context menus are the app's own children, outside the window.
        for child in axChildren(appElement) where axRole(child) == kAXMenuRole { visit(child, 0) }
    }
    if includeMenus, let bar: AXUIElement = axAttr(appElement, kAXMenuBarAttribute) {
        visit(bar, 0)
    }
    if windowless {
        let screen = displaysInfo().first?["frame"] ?? [0, 0, 0, 0]
        return ["window": ["index": -1, "title": "(no window)", "frame": screen, "scale": Double(NSScreen.screens.first?.backingScaleFactor ?? 2)], "nodes": nodes, "truncated": truncated]
    }
    guard let frame = axFrame(window) else { throw HelperError("Window has no frame", code: "no_window") }
    var windowInfo: [String: Any] = [
        "index": windowIndex,
        "title": (axAttr(window, kAXTitleAttribute) as String?) ?? "",
        "frame": rectJSON(frame),
        "scale": backingScale(for: frame),
    ]
    if let id = cgWindowID(pid: pid, frame: frame) { windowInfo["windowId"] = id }
    return ["window": windowInfo, "nodes": nodes, "truncated": truncated]
}

// MARK: - Element actions

func elementFrame(_ params: [String: Any]) throws -> [String: Any] {
    let pid = try params.requireInt("pid")
    let element = try table(pid).element(try params.requireInt("index"))
    guard let frame = axFrame(element) else { throw HelperError("Element has no on-screen frame", code: "no_frame") }
    return ["frame": rectJSON(frame)]
}

func performAction(_ params: [String: Any]) throws -> [String: Any] {
    let pid = try params.requireInt("pid")
    let element = try table(pid).element(try params.requireInt("index"))
    let action = params.string("action") ?? kAXPressAction
    let err = AXUIElementPerformAction(element, action as CFString)
    if err != .success {
        throw HelperError("\(action) failed (AXError \(err.rawValue))", code: "action_failed")
    }
    return [:]
}

func actionNames(_ params: [String: Any]) throws -> [String: Any] {
    let pid = try params.requireInt("pid")
    let element = try table(pid).element(try params.requireInt("index"))
    var names: CFArray?
    AXUIElementCopyActionNames(element, &names)
    return ["actions": (names as? [String]) ?? []]
}

func setValue(_ params: [String: Any]) throws -> [String: Any] {
    let pid = try params.requireInt("pid")
    let element = try table(pid).element(try params.requireInt("index"))
    let attribute = params.string("attribute") ?? kAXValueAttribute
    // Finder takes a new value on a file-name field but only relabels the row:
    // the file keeps its old name. Only the rename editor (focused) commits.
    if attribute == kAXValueAttribute, NSRunningApplication(processIdentifier: pid_t(pid))?.bundleIdentifier == "com.apple.finder",
       (axAttr(element, kAXRoleAttribute) as String?) == kAXTextFieldRole, (axAttr(element, kAXFocusedAttribute) as Bool?) != true {
        throw HelperError("Finder would show the new name without renaming the file. Rename instead: click the item, pressKey(\"Return\"), typeText(newName), pressKey(\"Return\").", code: "label_only")
    }
    var value: CFTypeRef
    if let s = params["value"] as? String { value = s as CFString }
    else if let b = params["value"] as? Bool { value = (b ? kCFBooleanTrue : kCFBooleanFalse)! }
    else if let n = params["value"] as? NSNumber { value = n }
    else { throw HelperError("setValue needs a string, number, or boolean", code: "bad_request") }
    let err = AXUIElementSetAttributeValue(element, attribute as CFString, value)
    if err != .success { throw HelperError("Setting \(attribute) failed (AXError \(err.rawValue))", code: "action_failed") }
    return [:]
}

func selectText(_ params: [String: Any]) throws -> [String: Any] {
    let pid = try params.requireInt("pid")
    let element = try table(pid).element(try params.requireInt("index"))
    AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    var range = CFRange(location: params.int("start") ?? 0, length: params.int("length") ?? 0)
    if params.int("length") == nil, let value: String = axAttr(element, kAXValueAttribute) {
        range.length = (value as NSString).length - range.location
    }
    guard let axRange = AXValueCreate(.cfRange, &range) else { throw HelperError("Bad range") }
    let err = AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, axRange)
    if err != .success { throw HelperError("Selecting text failed (AXError \(err.rawValue))", code: "action_failed") }
    return [:]
}

// MARK: - Input

let eventSource: CGEventSource? = {
    let source = CGEventSource(stateID: .hidSystemState)
    source?.userData = syntheticMarker
    return source
}()

// Mouse events. On the background route they go to the target process,
// stamped with its window; otherwise to the system at the screen point.
func post(_ event: CGEvent?) {
    guard let e = event else { return }
    e.setIntegerValueField(.eventSourceUserData, value: syntheticMarker)
    if let route = backgroundRoute {
        route.postMouse(e)
    } else {
        e.post(tap: .cghidEventTap)
    }
}

// Keyboard events go to the target app's process when it is in the
// background, so typing does not depend on (or steal) the user's focus.
var keyTargetPid: pid_t?

func postKey(_ event: CGEvent?) {
    guard let e = event else { return }
    e.setIntegerValueField(.eventSourceUserData, value: syntheticMarker)
    if let route = backgroundRoute {
        route.postKey(e)
    } else if let pid = keyTargetPid, let app = NSRunningApplication(processIdentifier: pid), !app.isActive {
        e.postToPid(pid)
    } else {
        e.post(tap: .cghidEventTap)
    }
}

let modifierKeyCodes: [String: CGKeyCode] = ["ctrl": 59, "shift": 56, "alt": 58, "super": 55, "fn": 63]

// Whether postKey sends to the system (the foreground route) rather than to a process.
func postsToHID() -> Bool {
    if backgroundRoute != nil { return false }
    if let pid = keyTargetPid, let app = NSRunningApplication(processIdentifier: pid), !app.isActive { return false }
    return true
}

func withKeyTarget<T>(_ params: [String: Any], _ body: () throws -> T) rethrows -> T {
    keyTargetPid = params.int("pid").map { pid_t($0) }
    defer { keyTargetPid = nil }
    return try body()
}

// The element under a screen point, registered in the app's element table.
func hitTest(_ params: [String: Any]) throws -> [String: Any] {
    let pid = try params.requireInt("pid")
    let app = AXUIElementCreateApplication(pid_t(pid))
    var hit: AXUIElement?
    let err = AXUIElementCopyElementAtPosition(app, Float(try params.requireDouble("x")), Float(try params.requireDouble("y")), &hit)
    guard err == .success, let element = hit else { return [:] }
    var elementPid: pid_t = 0
    AXUIElementGetPid(element, &elementPid)
    if Int(elementPid) != pid {
        // Something of another app is on top there (a menu bar extra, an
        // overlay). Say whose, with its index in that app's table.
        // Only whose it is: its content belongs to an app this session may
        // not be approved for (elementAtPoint, under macos:screen, says more).
        var out: [String: Any] = ["foreign": true, "pid": Int(elementPid), "role": axRole(element)]
        if let app = NSRunningApplication(processIdentifier: elementPid) { out["app"] = app.localizedName ?? ""; out["bundleId"] = app.bundleIdentifier ?? "" }
        return out
    }
    var out: [String: Any] = ["index": table(pid).index(of: element), "role": (axAttr(element, kAXRoleAttribute) as String?) ?? "AXUnknown"]
    var names: CFArray?
    if AXUIElementCopyActionNames(element, &names) == .success, let actions = names as? [String] { out["actions"] = actions }
    if let frame = axFrame(element) { out["frame"] = rectJSON(frame) }
    return out
}

let keyCodes: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12,
    "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23,
    "=": 24, "equal": 24, "9": 25, "7": 26, "-": 27, "minus": 27, "8": 28, "0": 29, "]": 30, "bracketright": 30,
    "o": 31, "u": 32, "[": 33, "bracketleft": 33, "i": 34, "p": 35, "Return": 36, "l": 37, "j": 38,
    "'": 39, "apostrophe": 39, "k": 40, ";": 41, "semicolon": 41, "\\": 42, "backslash": 42, ",": 43, "comma": 43,
    "/": 44, "slash": 44, "n": 45, "m": 46, ".": 47, "period": 47, "Tab": 48, "space": 49, " ": 49,
    "`": 50, "grave": 50, "BackSpace": 51, "Escape": 53, "Caps_Lock": 57, "KP_Enter": 76,
    "F1": 122, "F2": 120, "F3": 99, "F4": 118, "F5": 96, "F6": 97, "F7": 98, "F8": 100, "F9": 101,
    "F10": 109, "F11": 103, "F12": 111, "F13": 105, "F14": 107, "F15": 113, "F16": 106, "F17": 64,
    "F18": 79, "F19": 80, "F20": 90, "Help": 114, "Insert": 114, "Home": 115, "Page_Up": 116, "Delete": 117,
    "End": 119, "Page_Down": 121, "Left": 123, "Right": 124, "Down": 125, "Up": 126,
    "ctrl": 59, "shift": 56, "alt": 58, "super": 55, "fn": 63,
]

// Shifted characters on a US layout, so "ctrl+shift+?" and "?" both work.
let shifted: [String: String] = [
    "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
    "_": "-", "+": "=", "plus": "=", "{": "[", "}": "]", "|": "\\", ":": ";", "\"": "'", "<": ",", ">": ".",
    "?": "/", "~": "`",
]

func flags(_ mods: [String]) -> CGEventFlags {
    var f: CGEventFlags = []
    for m in mods {
        switch m {
        case "ctrl": f.insert(.maskControl)
        case "shift": f.insert(.maskShift)
        case "alt": f.insert(.maskAlternate)
        case "super": f.insert(.maskCommand)
        case "fn": f.insert(.maskSecondaryFn)
        default: break
        }
    }
    return f
}

func pressKeys(_ params: [String: Any]) throws -> [String: Any] {
    guard let chords = params["chords"] as? [[String: Any]] else { throw HelperError("missing chords", code: "bad_request") }
    for chord in chords {
        guard var key = chord["key"] as? String else { continue }
        var mods = (chord["mods"] as? [String]) ?? []
        if let base = shifted[key] {
            key = base
            if !mods.contains("shift") { mods.append("shift") }
        }
        let lower = key.count == 1 ? key.lowercased() : key
        if key.count == 1 && key != lower && !mods.contains("shift") { mods.append("shift") }
        if let code = keyCodes[lower] {
            var f = flags(mods)
            // Real arrow and navigation keys carry these; Mission Control's
            // Ctrl+arrow shortcuts look for them.
            if [123, 124, 125, 126].contains(code) { f.insert([.maskNumericPad, .maskSecondaryFn]) }
            if [115, 116, 117, 119, 121, 114].contains(code) { f.insert(.maskSecondaryFn) }
            // At the system level the modifiers go down and come back up as
            // their own events; flags on the key alone leave them stuck down.
            let hid = postsToHID()
            let modCodes = mods.compactMap { modifierKeyCodes[$0] }
            if hid {
                var held: CGEventFlags = []
                for (m, c) in zip(mods, modCodes) {
                    held.insert(flags([m]))
                    let e = CGEvent(keyboardEventSource: eventSource, virtualKey: c, keyDown: true)
                    e?.flags = held
                    postKey(e)
                    usleep(6000)
                }
            }
            let down = CGEvent(keyboardEventSource: eventSource, virtualKey: code, keyDown: true)
            let up = CGEvent(keyboardEventSource: eventSource, virtualKey: code, keyDown: false)
            down?.flags = f
            up?.flags = f
            postKey(down)
            usleep(8000)
            postKey(up)
            if hid {
                var held = flags(mods)
                for (m, c) in zip(mods, modCodes).reversed() {
                    held.remove(flags([m]))
                    let e = CGEvent(keyboardEventSource: eventSource, virtualKey: c, keyDown: false)
                    e?.flags = held
                    postKey(e)
                    usleep(6000)
                }
            }
        } else if mods.isEmpty {
            try typeText(["text": key])
        } else {
            throw HelperError("No key code for \"\(key)\" with modifiers", code: "bad_key")
        }
        usleep(25000)
    }
    return [:]
}

@discardableResult
func typeText(_ params: [String: Any]) throws -> [String: Any] {
    guard let text = params.string("text") else { throw HelperError("missing text", code: "bad_request") }
    var chunk: [UniChar] = []
    func flush() {
        guard !chunk.isEmpty else { return }
        let down = CGEvent(keyboardEventSource: eventSource, virtualKey: 0, keyDown: true)
        let up = CGEvent(keyboardEventSource: eventSource, virtualKey: 0, keyDown: false)
        down?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
        up?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
        // Never inherit modifiers that happen to be down: typed text is plain.
        down?.flags = []
        up?.flags = []
        postKey(down)
        usleep(4000)
        postKey(up)
        usleep(12000)
        chunk.removeAll()
    }
    for scalar in text.unicodeScalars {
        if scalar == "\n" || scalar == "\r" || scalar == "\t" {
            flush()
            let code: CGKeyCode = scalar == "\t" ? 48 : 36
            let d = CGEvent(keyboardEventSource: eventSource, virtualKey: code, keyDown: true)
            let u = CGEvent(keyboardEventSource: eventSource, virtualKey: code, keyDown: false)
            d?.flags = []
            u?.flags = []
            postKey(d)
            usleep(8000)
            postKey(u)
            usleep(20000)
            continue
        }
        // One character per event: some apps drop the tail of multi-character events.
        chunk.append(contentsOf: Array(String(scalar).utf16))
        flush()
    }
    flush()
    return [:]
}

func mouseButton(_ name: String?) -> (CGMouseButton, CGEventType, CGEventType, CGEventType) {
    switch name {
    case "right": return (.right, .rightMouseDown, .rightMouseUp, .rightMouseDragged)
    case "middle": return (.center, .otherMouseDown, .otherMouseUp, .otherMouseDragged)
    default: return (.left, .leftMouseDown, .leftMouseUp, .leftMouseDragged)
    }
}

func click(_ params: [String: Any]) throws -> [String: Any] {
    let point = CGPoint(x: try params.requireDouble("x"), y: try params.requireDouble("y"))
    let count = max(1, params.int("count") ?? 1)
    let (button, downType, upType, _) = mouseButton(params.string("button"))
    let f = flags((params["mods"] as? [String]) ?? [])
    post(CGEvent(mouseEventSource: eventSource, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left))
    usleep(30000)
    backgroundRoute?.primeChromiumClick()
    for n in 1...count {
        let down = CGEvent(mouseEventSource: eventSource, mouseType: downType, mouseCursorPosition: point, mouseButton: button)
        let up = CGEvent(mouseEventSource: eventSource, mouseType: upType, mouseCursorPosition: point, mouseButton: button)
        down?.setIntegerValueField(.mouseEventClickState, value: Int64(n))
        up?.setIntegerValueField(.mouseEventClickState, value: Int64(n))
        down?.flags = f
        up?.flags = f
        post(down)
        // An NSButton's mouseDown polls for the matching up; too tight a gap races it.
        // holdMs keeps the button down (press and hold).
        usleep(useconds_t(max(28, params.int("holdMs") ?? 28)) * 1000)
        post(up)
        usleep(count > 1 ? 80000 : 30000)
    }
    return [:]
}

func moveMouse(_ params: [String: Any]) throws -> [String: Any] {
    let point = CGPoint(x: try params.requireDouble("x"), y: try params.requireDouble("y"))
    post(CGEvent(mouseEventSource: eventSource, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left))
    return [:]
}

func scroll(_ params: [String: Any]) throws -> [String: Any] {
    let point = CGPoint(x: try params.requireDouble("x"), y: try params.requireDouble("y"))
    post(CGEvent(mouseEventSource: eventSource, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left))
    usleep(30000)
    // Positive dy scrolls content down (toward the end), like a trackpad swipe up.
    let dy = Int32(-(params.int("dy") ?? 0))
    let dx = Int32(-(params.int("dx") ?? 0))
    let steps = max(abs(dy), abs(dx), 1)
    for i in 0..<steps {
        let sy: Int32 = i < abs(dy) ? (dy > 0 ? 1 : -1) : 0
        let sx: Int32 = i < abs(dx) ? (dx > 0 ? 1 : -1) : 0
        let e = CGEvent(scrollWheelEvent2Source: eventSource, units: .line, wheelCount: 2, wheel1: sy, wheel2: sx, wheel3: 0)
        e?.location = point
        // Some clients (Citrix Viewer) read only the point and fixed-point
        // deltas, which the line-based constructor leaves at 0 for axis 2.
        if sx != 0 {
            e?.setIntegerValueField(.scrollWheelEventPointDeltaAxis2, value: Int64(sx) * 10)
            e?.setDoubleValueField(.scrollWheelEventFixedPtDeltaAxis2, value: Double(sx))
        }
        if let route = backgroundRoute, let event = e {
            event.setIntegerValueField(.eventSourceUserData, value: syntheticMarker)
            route.postScroll(event)
        } else {
            post(e)
        }
        usleep(15000)
    }
    return [:]
}

func drag(_ params: [String: Any]) throws -> [String: Any] {
    guard let raw = params["path"] as? [[Double]], raw.count >= 2 else { throw HelperError("drag needs at least two points", code: "bad_request") }
    let points = raw.map { CGPoint(x: $0[0], y: $0[1]) }
    let (button, downType, upType, dragType) = mouseButton(params.string("button"))
    post(CGEvent(mouseEventSource: eventSource, mouseType: .mouseMoved, mouseCursorPosition: points[0], mouseButton: button))
    usleep(40000)
    // Background delivery carries no click count unless we set one, and AppKit
    // ignores a mouseDown without it.
    func withClickState(_ e: CGEvent?) -> CGEvent? {
        e?.setIntegerValueField(.mouseEventClickState, value: 1)
        return e
    }
    post(withClickState(CGEvent(mouseEventSource: eventSource, mouseType: downType, mouseCursorPosition: points[0], mouseButton: button)))
    usleep(60000)
    for i in 1..<points.count {
        let a = points[i - 1], b = points[i]
        let steps = max(4, Int(hypot(b.x - a.x, b.y - a.y) / 12))
        for s in 1...steps {
            let t = CGFloat(s) / CGFloat(steps)
            let p = CGPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t)
            post(withClickState(CGEvent(mouseEventSource: eventSource, mouseType: dragType, mouseCursorPosition: p, mouseButton: button)))
            usleep(8000)
        }
    }
    usleep(40000)
    post(withClickState(CGEvent(mouseEventSource: eventSource, mouseType: upType, mouseCursorPosition: points.last!, mouseButton: button)))
    return [:]
}

// MARK: - Background input
//
// Delivers input to an app that stays in the background: its window is made
// key inside the app without activating it, and events are posted to the
// process with the window stamped on them. The real cursor never moves and the
// user's frontmost app keeps focus. This uses private SkyLight functions that
// Codex, Claude desktop, cua-driver, Peekaboo, and yabai also rely on; each is
// looked up at runtime, and when one is missing the caller falls back to the
// foreground route.

enum SkyLight {
    typealias PostRecord = @convention(c) (UnsafeRawPointer, UnsafeRawPointer) -> Int32
    typealias PostToPid = @convention(c) (pid_t, CGEvent) -> Void
    typealias SetWindowLocation = @convention(c) (CGEvent, CGPoint) -> Void
    typealias SetIntegerField = @convention(c) (CGEvent, UInt32, Int64) -> Void
    typealias MainConnection = @convention(c) () -> UInt32
    typealias WindowOwner = @convention(c) (UInt32, UInt32, UnsafeMutablePointer<UInt32>) -> Int32
    typealias ConnectionPSN = @convention(c) (UInt32, UnsafeMutableRawPointer) -> Int32
    typealias ProcessForPID = @convention(c) (pid_t, UnsafeMutableRawPointer) -> Int32

    static let handle = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY)

    static func symbol<T>(_ name: String, _: T.Type) -> T? {
        _ = handle
        // RTLD_DEFAULT is ((void *)-2) and is not imported into Swift.
        guard let pointer = dlsym(UnsafeMutableRawPointer(bitPattern: -2), name) else { return nil }
        return unsafeBitCast(pointer, to: T.self)
    }

    static let postRecord = symbol("SLPSPostEventRecordTo", PostRecord.self)
    static let postToPid = symbol("SLEventPostToPid", PostToPid.self)
    static let setWindowLocation = symbol("CGEventSetWindowLocation", SetWindowLocation.self)
    static let setIntegerField = symbol("CGEventSetIntegerValueField", SetIntegerField.self)
    static let mainConnection = symbol("SLSMainConnectionID", MainConnection.self) ?? symbol("CGSMainConnectionID", MainConnection.self)
    static let windowOwner = symbol("SLSGetWindowOwner", WindowOwner.self)
    static let connectionPSN = symbol("SLSGetConnectionPSN", ConnectionPSN.self)
    static let processForPID = symbol("GetProcessForPID", ProcessForPID.self)

    // What the background route needs: records to make a window key, and a
    // way to stamp window fields. Posting falls back to CGEventPostToPid.
    static var available: Bool { postRecord != nil && setIntegerField != nil && (windowOwner != nil || processForPID != nil) }

    static var capabilities: [String: Bool] {
        [
            "postEventRecord": postRecord != nil,
            "postToPid": postToPid != nil,
            "setWindowLocation": setWindowLocation != nil,
            "setIntegerField": setIntegerField != nil,
            "processSerialNumber": windowOwner != nil || processForPID != nil,
        ]
    }

    // The 8-byte ProcessSerialNumber of the process that owns `windowId`.
    static func psn(pid: pid_t, windowId: UInt32) -> [UInt8]? {
        var psn = [UInt8](repeating: 0, count: 8)
        if let owner = windowOwner, let toPSN = connectionPSN, let main = mainConnection {
            var cid: UInt32 = 0
            if owner(main(), windowId, &cid) == 0, cid != 0,
               psn.withUnsafeMutableBytes({ toPSN(cid, $0.baseAddress!) }) == 0 {
                return psn
            }
        }
        if let forPid = processForPID, psn.withUnsafeMutableBytes({ forPid(pid, $0.baseAddress!) }) == 0 {
            return psn
        }
        return nil
    }

    // 248-byte event records. Layout from yabai and cua-driver (MIT).
    static func focusRecord(_ windowId: UInt32, focus: Bool) -> [UInt8] {
        var record = [UInt8](repeating: 0, count: 0xF8)
        record[0x04] = 0xF8
        record[0x08] = 0x0D
        withUnsafeBytes(of: windowId.littleEndian) { record.replaceSubrange(0x3C..<0x40, with: $0) }
        record[0x8A] = focus ? 0x01 : 0x02
        return record
    }

    static func makeKeyRecord(_ windowId: UInt32, kind: UInt8) -> [UInt8] {
        var record = [UInt8](repeating: 0, count: 0xF8)
        record[0x04] = 0xF8
        record[0x08] = kind
        record[0x3A] = 0x10
        for i in 0x20..<0x30 { record[i] = 0xFF }
        withUnsafeBytes(of: windowId.littleEndian) { record.replaceSubrange(0x3C..<0x40, with: $0) }
        return record
    }

    @discardableResult
    static func send(_ record: [UInt8], to psn: [UInt8]) -> Bool {
        guard let post = postRecord else { return false }
        return psn.withUnsafeBytes { p in record.withUnsafeBytes { r in post(p.baseAddress!, r.baseAddress!) } } == 0
    }
}

func bundleUsesChromium(_ pid: pid_t) -> Bool {
    guard let url = NSRunningApplication(processIdentifier: pid)?.bundleURL else { return false }
    let frameworks = url.appendingPathComponent("Contents/Frameworks")
    let names = (try? FileManager.default.contentsOfDirectory(atPath: frameworks.path)) ?? []
    if names.contains(where: { $0.hasPrefix("Electron Framework") || $0.hasPrefix("Chromium Embedded Framework") || $0.contains("Chromium Framework") }) {
        return true
    }
    let chromiumBrowsers: Set<String> = ["com.google.Chrome", "com.microsoft.edgemac", "com.brave.Browser", "company.thebrowser.Browser", "com.vivaldi.Vivaldi", "com.operasoftware.Opera"]
    return chromiumBrowsers.contains(NSRunningApplication(processIdentifier: pid)?.bundleIdentifier ?? "")
}

// The CGWindowID of the app's key window as Accessibility reports it.
func keyWindowId(_ pid: pid_t) -> UInt32? {
    let app = AXUIElementCreateApplication(pid)
    guard let window: AXUIElement = axAttr(app, kAXFocusedWindowAttribute), let frame = axFrame(window),
          let id = cgWindowID(pid: Int(pid), frame: frame) else { return nil }
    return UInt32(id)
}

func cgWindowBounds(_ windowId: UInt32) -> CGRect? {
    guard let info = CGWindowListCopyWindowInfo([.optionIncludingWindow], CGWindowID(windowId)) as? [[String: Any]],
          let bounds = info.first?[kCGWindowBounds as String] as? [String: Any] else { return nil }
    return CGRect(dictionaryRepresentation: bounds as CFDictionary)
}

final class BackgroundRoute {
    let pid: pid_t
    let windowId: UInt32
    let origin: CGPoint
    let chromium: Bool
    let localLocation: Bool
    let gesture = Int64.random(in: 1...Int64(Int32.max))

    init(pid: pid_t, windowId: UInt32, origin: CGPoint, localLocation: Bool) {
        self.pid = pid
        self.windowId = windowId
        self.origin = origin
        self.chromium = bundleUsesChromium(pid)
        self.localLocation = localLocation
    }

    private func stamp(_ e: CGEvent) {
        guard let set = SkyLight.setIntegerField else { return }
        set(e, 40, Int64(pid))       // kCGEventTargetUnixProcessID
        set(e, 51, Int64(windowId))  // window number
        set(e, 91, Int64(windowId))  // kCGMouseEventWindowUnderMousePointer
        set(e, 92, Int64(windowId))  // ...ThatCanHandleThisEvent
        set(e, 58, gesture)          // groups one gesture's events
        if let setLocation = SkyLight.setWindowLocation {
            let p = e.location
            setLocation(e, localLocation ? CGPoint(x: p.x - origin.x, y: p.y - origin.y) : p)
        }
    }

    // Chromium and Electron want the SkyLight route; AppKit takes the public
    // one. Never both: AppKit controls would see each click twice.
    func postMouse(_ e: CGEvent) {
        stamp(e)
        if chromium, let post = SkyLight.postToPid { post(pid, e) } else { e.postToPid(pid) }
    }

    func postKey(_ e: CGEvent) {
        if let post = SkyLight.postToPid { post(pid, e) } else { e.postToPid(pid) }
    }

    // Scroll wheel events reach background AppKit views only through both
    // routes (cua-driver does the same); a doubled scroll tick is harmless.
    func postScroll(_ e: CGEvent) {
        stamp(e)
        e.postToPid(pid)
        if let post = SkyLight.postToPid { post(pid, e) }
    }

    // Chromium ignores a background click until it has seen user activation;
    // an off-screen click satisfies that without touching anything.
    func primeChromiumClick() {
        guard chromium else { return }
        let off = CGPoint(x: -1, y: -1)
        postMouse(CGEvent(mouseEventSource: eventSource, mouseType: .leftMouseDown, mouseCursorPosition: off, mouseButton: .left)!)
        usleep(10000)
        postMouse(CGEvent(mouseEventSource: eventSource, mouseType: .leftMouseUp, mouseCursorPosition: off, mouseButton: .left)!)
        usleep(100000)
    }
}

var backgroundRoute: BackgroundRoute?

// Makes `windowId` the key window inside its app without activating the app.
// Sends nothing to any other process. Returns whether AX confirms it.
func makeWindowKey(pid: pid_t, windowId: UInt32, settle: UInt32 = 120_000) -> Bool {
    guard let psn = SkyLight.psn(pid: pid, windowId: windowId) else { return false }
    if let current = keyWindowId(pid), current != windowId {
        SkyLight.send(SkyLight.focusRecord(current, focus: false), to: psn)
        usleep(settle)
    }
    SkyLight.send(SkyLight.focusRecord(windowId, focus: true), to: psn)
    usleep(settle)
    SkyLight.send(SkyLight.makeKeyRecord(windowId, kind: 0x01), to: psn)
    SkyLight.send(SkyLight.makeKeyRecord(windowId, kind: 0x02), to: psn)
    for _ in 0..<10 {
        if keyWindowId(pid) == windowId { return true }
        usleep(40000)
    }
    return false
}

enum InputKind { case keys, mouse }

// True when keyboard focus is in a small uncapturable window inside
// `windowId`, such as Finder's rename field editor. Keys already go there, and
// making the parent key again would end the edit. A background app reports no
// focused window, so look for a focused child instead.
func focusIsInside(pid: pid_t, windowId: UInt32) -> Bool {
    guard let bounds = cgWindowBounds(windowId)?.insetBy(dx: -2, dy: -2) else { return false }
    for w in axWindows(Int(pid)) {
        guard let frame = axFrame(w), frame.height < 120, bounds.contains(frame),
              cgWindowID(pid: Int(pid), frame: frame) == nil else { continue }
        // Finder's editor "window" is the focused text field itself.
        let children: [AXUIElement] = axAttr(w, kAXChildrenAttribute) ?? []
        if ([w] + children).contains(where: { (axAttr($0, kAXFocusedAttribute) as Bool?) == true }) { return true }
    }
    return false
}

// The window id of a sheet attached to window `parent`, if one is open.
func sheetWindowId(pid: pid_t, parent: UInt32) -> UInt32? {
    for w in axWindows(Int(pid)) {
        guard let frame = axFrame(w), cgWindowID(pid: Int(pid), frame: frame) == Int(parent) else { continue }
        for child in axChildren(w) where axRole(child) == "AXSheet" {
            if let f = axFrame(child), let id = cgWindowID(pid: Int(pid), frame: f) { return UInt32(id) }
        }
    }
    return nil
}

// Runs `body` with input routed to the background app named in params, and
// restores the user's frontmost app if the target took focus anyway.
func withInputRoute(_ params: [String: Any], _ kind: InputKind, _ body: () throws -> [String: Any]) throws -> [String: Any] {
    guard params.string("mode") == "background" else { return try body() }
    guard SkyLight.available else {
        throw HelperError("Background input is unavailable on this macOS (private SkyLight functions missing).", code: "background_unavailable")
    }
    let pid = pid_t(try params.requireInt("pid"))
    var windowId = UInt32(try params.requireInt("windowId"))
    // An open sheet (save and open panels, dialogs) is its own window and
    // takes the keys while it is up.
    if kind == .keys, let sheet = sheetWindowId(pid: pid, parent: windowId) { windowId = sheet }
    guard let bounds = cgWindowBounds(windowId) else { throw HelperError("Window \(windowId) is gone", code: "no_window") }
    let front = NSWorkspace.shared.frontmostApplication
    var keyed = true
    if kind == .keys {
        keyed = focusIsInside(pid: pid, windowId: windowId) || makeWindowKey(pid: pid, windowId: windowId)
        if !keyed {
            throw HelperError("Could not make the window key in the background; use foreground mode for this app.", code: "background_unconfirmed")
        }
    } else if let psn = SkyLight.psn(pid: pid, windowId: windowId) {
        // A window that is not key inside its app takes the first click as
        // "focus this window" and drops it, so make it key first (unless an
        // edit field inside it already has focus, which that would end).
        if keyWindowId(pid) != windowId && !focusIsInside(pid: pid, windowId: windowId) && params.bool("keyFirst") != false {
            _ = makeWindowKey(pid: pid, windowId: windowId, settle: 60_000)
        } else {
            // Target-only focus record so AppKit routes the click to this window.
            SkyLight.send(SkyLight.focusRecord(windowId, focus: true), to: psn)
            usleep(50000)
        }
    }
    let route = BackgroundRoute(pid: pid, windowId: windowId, origin: bounds.origin, localLocation: params.string("windowLocation") != "screen")
    backgroundRoute = route
    defer { backgroundRoute = nil }
    var result = try body()
    usleep(60000)
    var restored = false
    if let front = front, front.processIdentifier != pid,
       NSWorkspace.shared.frontmostApplication?.processIdentifier == pid {
        // The target took focus anyway: give it back to the user's app.
        AXUIElementSetAttributeValue(AXUIElementCreateApplication(front.processIdentifier), kAXFrontmostAttribute as CFString, kCFBooleanTrue)
        restored = true
    }
    result["route"] = route.chromium ? "background-skylight" : "background"
    result["focusRestored"] = restored
    return result
}

// MARK: - Chromium and Electron accessibility
//
// Chromium builds its web accessibility tree only for assistive technology.
// Electron listens for AXManualAccessibility, Chrome for
// AXEnhancedUserInterface. Set once per process, then wait for the tree.

var webAXEnabled = Set<Int>()

func countNodes(_ root: AXUIElement, limit: Int = 400) -> Int {
    var count = 0
    var stack = [root]
    while let e = stack.popLast(), count < limit {
        count += 1
        if let kids: [AXUIElement] = axAttr(e, kAXChildrenAttribute) { stack.append(contentsOf: kids) }
    }
    return count
}

func enableWebAccessibility(_ pid: Int) {
    if webAXEnabled.contains(pid) { return }
    webAXEnabled.insert(pid)
    guard bundleUsesChromium(pid_t(pid)) else { return }
    let app = AXUIElementCreateApplication(pid_t(pid))
    AXUIElementSetMessagingTimeout(app, 2.0)
    let window: AXUIElement? = axAttr(app, kAXFocusedWindowAttribute) ?? axWindows(pid).first
    let before = window.map { countNodes($0) } ?? 0
    AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    func grew() -> Bool {
        guard let w = window else { return true }
        return countNodes(w) > before + 10
    }
    for _ in 0..<15 { if grew() { return }; usleep(100_000) }
    // Chrome itself (not Electron) answers the older attribute.
    AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
    for _ in 0..<20 { if grew() { return }; usleep(100_000) }
}

// MARK: - Menus

func normalizeTitle(_ s: String) -> String {
    var t = s.trimmingCharacters(in: .whitespaces).lowercased()
    while t.hasSuffix("…") || t.hasSuffix(".") { t.removeLast() }
    return t.trimmingCharacters(in: .whitespaces)
}

func axChildren(_ e: AXUIElement) -> [AXUIElement] { axAttr(e, kAXChildrenAttribute) ?? [] }

func axRole(_ e: AXUIElement) -> String { (axAttr(e, kAXRoleAttribute) as String?) ?? "" }

func axTitle(_ e: AXUIElement) -> String {
    (axAttr(e, kAXTitleAttribute) as String?).flatMap { $0.isEmpty ? nil : $0 }
        ?? (axAttr(e, kAXDescriptionAttribute) as String?) ?? ""
}

// The items of a menu bar item or menu item: the children of its AXMenu child.
// Electron builds a menu's items on first access, so an existing but empty
// menu is read again after a moment.
func menuItems(of e: AXUIElement) -> [AXUIElement] {
    var menu: AXUIElement?
    if axRole(e) == kAXMenuRole { menu = e }
    else { menu = axChildren(e).first { axRole($0) == kAXMenuRole } }
    guard let m = menu else { return [] }
    var items = axChildren(m)
    var tries = 0
    while items.isEmpty && tries < 4 {
        usleep(60_000)
        items = axChildren(m)
        tries += 1
    }
    return items
}

let modifierNames: [(Int, String)] = [(4, "ctrl"), (2, "alt"), (1, "shift")]

func shortcutText(_ e: AXUIElement) -> String? {
    let char: String? = axAttr(e, kAXMenuItemCmdCharAttribute)
    let virtual: Int? = axAttr(e, kAXMenuItemCmdVirtualKeyAttribute)
    let glyph: Int? = axAttr(e, kAXMenuItemCmdGlyphAttribute)
    guard (char != nil && !(char!.isEmpty)) || virtual != nil || glyph != nil else { return nil }
    let mods: Int = axAttr(e, kAXMenuItemCmdModifiersAttribute) ?? 0
    var parts = modifierNames.filter { mods & $0.0 != 0 }.map { $0.1 }
    if mods & 8 == 0 { parts.append("super") }
    var key = char ?? ""
    if key.isEmpty, let v = virtual, let name = keyCodes.first(where: { Int($0.value) == v && $0.key.count > 1 })?.key { key = name }
    if key.isEmpty { return nil }
    if key.count == 1 { key = key.lowercased() }
    return (parts + [key]).joined(separator: "+")
}

func menuItemInfo(_ e: AXUIElement, table t: ElementTable, depth: Int) -> [String: Any] {
    var info: [String: Any] = ["index": t.index(of: e), "title": axTitle(e), "role": axRole(e)]
    if let enabled: Bool = axAttr(e, kAXEnabledAttribute), !enabled { info["disabled"] = true }
    if let mark: String = axAttr(e, kAXMenuItemMarkCharAttribute), !mark.isEmpty { info["checked"] = true }
    if let s = shortcutText(e) { info["shortcut"] = s }
    let items = menuItems(of: e)
    if !items.isEmpty {
        info["submenu"] = depth > 0 ? items.map { menuItemInfo($0, table: t, depth: depth - 1) } : items.count
    }
    return info
}

func menuBar(_ pid: Int) throws -> AXUIElement {
    let app = AXUIElementCreateApplication(pid_t(pid))
    AXUIElementSetMessagingTimeout(app, 3.0)
    guard let bar: AXUIElement = axAttr(app, kAXMenuBarAttribute) else {
        throw HelperError("The app has no menu bar", code: "not_found")
    }
    return bar
}

func findMenuPath(_ pid: Int, _ path: [String]) throws -> AXUIElement {
    var current = try menuBar(pid)
    var level = axChildren(current)
    for (depth, want) in path.enumerated() {
        let w = normalizeTitle(want)
        guard let next = level.first(where: { normalizeTitle(axTitle($0)) == w })
                ?? level.first(where: { normalizeTitle(axTitle($0)).hasPrefix(w) }) else {
            let names = level.map { axTitle($0) }.filter { !$0.isEmpty }
            let where_ = depth == 0 ? "the menu bar" : "\"\(path[depth - 1])\""
            throw HelperError("No menu item \"\(want)\" in \(where_). It has: \(names.joined(separator: ", "))", code: "not_found")
        }
        current = next
        level = menuItems(of: next)
    }
    return current
}

func menuList(_ params: [String: Any]) throws -> [String: Any] {
    let pid = try params.requireInt("pid")
    let t = table(pid)
    let path = (params["path"] as? [String]) ?? []
    let depth = params.int("depth") ?? (path.isEmpty ? 1 : 2)
    if path.isEmpty {
        let bar = try menuBar(pid)
        return ["items": axChildren(bar).map { menuItemInfo($0, table: t, depth: depth) }]
    }
    let item = try findMenuPath(pid, path)
    return ["items": menuItems(of: item).map { menuItemInfo($0, table: t, depth: depth - 1) }, "title": axTitle(item)]
}

func menuPress(_ params: [String: Any]) throws -> [String: Any] {
    let pid = try params.requireInt("pid")
    guard let path = params["path"] as? [String], !path.isEmpty else { throw HelperError("menu needs a path such as [\"File\", \"Save\"]", code: "bad_request") }
    let item = try findMenuPath(pid, path)
    if let enabled: Bool = axAttr(item, kAXEnabledAttribute), !enabled {
        throw HelperError("\"\(path.joined(separator: " > "))\" is disabled right now.", code: "action_failed")
    }
    if !menuItems(of: item).isEmpty { throw HelperError("\"\(path.last!)\" is a submenu; name one of its items.", code: "bad_request") }
    let err = AXUIElementPerformAction(item, kAXPressAction as CFString)
    if err != .success && err != .cannotComplete { throw HelperError("Pressing the menu item failed (AXError \(err.rawValue))", code: "action_failed") }
    return ["title": axTitle(item), "route": "menu"]
}

// Finds the menu item whose shortcut is the chord and presses it. Menu
// shortcuts sent as keys to a background app never reach its menus.
func menuShortcut(_ params: [String: Any]) throws -> [String: Any] {
    let pid = try params.requireInt("pid")
    guard var key = params.string("key") else { throw HelperError("missing key", code: "bad_request") }
    var mods = Set((params["mods"] as? [String]) ?? [])
    if let base = shifted[key] { key = base; mods.insert("shift") }
    if key.count == 1, key != key.lowercased() { mods.insert("shift") }
    let wantKey = key.count == 1 ? key.lowercased() : key
    let bar = try menuBar(pid)
    // Electron fills in its menus' shortcuts only after something reads the
    // menus, so a miss on the first pass gets a second one.
    var seen = 0
    for pass in 0..<2 {
        if pass == 1 {
            // Read each menu the way menus() does; that makes Electron fill them in.
            let t = table(pid)
            for top in axChildren(bar) { _ = menuItemInfo(top, table: t, depth: 1) }
            usleep(150_000)
        }
        var stack = axChildren(bar).filter { normalizeTitle(axTitle($0)) != "apple" }
        while let e = stack.popLast(), seen < 6000 {
            seen += 1
            let items = menuItems(of: e)
            if !items.isEmpty { stack.append(contentsOf: items); continue }
            guard let s = shortcutText(e) else { continue }
            var parts = s.split(separator: "+").map(String.init)
            var k = parts.removeLast()
            var have = Set(parts)
            if let base = shifted[k] { k = base; have.insert("shift") }
            if k.count == 1, k != k.lowercased() { have.insert("shift"); k = k.lowercased() }
            // A menu's "A" with Shift prints as uppercase; letters compare case-free.
            guard k.lowercased() == wantKey.lowercased(), have == mods else { continue }
            if let enabled: Bool = axAttr(e, kAXEnabledAttribute), !enabled { return ["found": true, "pressed": false, "title": axTitle(e), "disabled": true] }
            // dryRun: say which item the chord would press, and press nothing.
            if params.bool("dryRun") == true { return ["found": true, "pressed": false, "title": axTitle(e), "visited": seen, "pass": pass] }
            let err = AXUIElementPerformAction(e, kAXPressAction as CFString)
            return ["found": true, "pressed": err == .success || err == .cannotComplete, "title": axTitle(e)]
        }
    }
    return ["found": false, "visited": seen]
}

// Opens an element's menu (a pop-up button, menu button, or any element with
// a context menu) and picks an item, in one call: the menu is open only for
// the moment between the two, so the user's typing never lands in it.
func selectMenuItem(_ params: [String: Any]) throws -> [String: Any] {
    let pid = try params.requireInt("pid")
    let t = table(pid)
    let element = try t.element(try params.requireInt("index"))
    guard let path = params["path"] as? [String], !path.isEmpty else { throw HelperError("select needs an item title", code: "bad_request") }
    let role = axRole(element)
    let app = AXUIElementCreateApplication(pid_t(pid))
    func openMenus() -> [AXUIElement] {
        (axChildren(element) + axChildren(app)).filter { axRole($0) == kAXMenuRole }
    }
    var actions: CFArray?
    AXUIElementCopyActionNames(element, &actions)
    let names = (actions as? [String]) ?? []
    let useShowMenu = params.bool("context") == true || !(role == kAXPopUpButtonRole || role == kAXMenuButtonRole) || !names.contains(kAXPressAction)
    let open = useShowMenu ? kAXShowMenuAction : kAXPressAction
    if !names.contains(open) { throw HelperError("Element \(params.int("index")!) has no menu (\(role) has: \(names.joined(separator: ", ")))", code: "action_failed") }
    AXUIElementPerformAction(element, open as CFString)
    var menu: AXUIElement?
    for _ in 0..<40 {
        if let m = openMenus().first { menu = m; break }
        usleep(25_000)
    }
    guard var level = menu.map({ axChildren($0) }) else { throw HelperError("The menu did not open", code: "action_failed") }
    var target: AXUIElement?
    for (depth, want) in path.enumerated() {
        let w = normalizeTitle(want)
        guard let item = level.first(where: { normalizeTitle(axTitle($0)) == w }) ?? level.first(where: { normalizeTitle(axTitle($0)).hasPrefix(w) }) else {
            let titles = level.map { axTitle($0) }.filter { !$0.isEmpty }
            if let m = menu { AXUIElementPerformAction(m, kAXCancelAction as CFString) }
            throw HelperError("No item \"\(want)\"\(depth > 0 ? " in \"\(path[depth - 1])\"" : ""). The menu has: \(titles.joined(separator: ", "))", code: "not_found")
        }
        target = item
        level = menuItems(of: item)
    }
    let err = AXUIElementPerformAction(target!, kAXPressAction as CFString)
    // Wait for the menu to close, so the next action does not hit it.
    for _ in 0..<40 {
        if openMenus().isEmpty { break }
        usleep(25_000)
    }
    if err != .success && err != .cannotComplete { throw HelperError("Picking the item failed (AXError \(err.rawValue))", code: "action_failed") }
    return ["title": axTitle(target!), "route": "accessibility"]
}

// MARK: - Windows and apps

func windowAction(_ params: [String: Any]) throws -> [String: Any] {
    let pid = try params.requireInt("pid")
    let (window, index) = try targetWindow(pid, params)
    let op = params.string("op") ?? ""
    func set(_ attr: String, _ value: CFTypeRef) throws {
        let err = AXUIElementSetAttributeValue(window, attr as CFString, value)
        if err != .success { throw HelperError("Setting \(attr) failed (AXError \(err.rawValue)); the window may not allow it.", code: "action_failed") }
    }
    func press(_ attr: String) throws {
        guard let button: AXUIElement = axAttr(window, attr) else { throw HelperError("The window has no \(attr.replacingOccurrences(of: "AX", with: "").lowercased())", code: "action_failed") }
        AXUIElementPerformAction(button, kAXPressAction as CFString)
    }
    switch op {
    case "move":
        var p = CGPoint(x: try params.requireDouble("x"), y: try params.requireDouble("y"))
        try set(kAXPositionAttribute, AXValueCreate(.cgPoint, &p)!)
    case "resize":
        var s = CGSize(width: try params.requireDouble("width"), height: try params.requireDouble("height"))
        try set(kAXSizeAttribute, AXValueCreate(.cgSize, &s)!)
    case "minimize": try set(kAXMinimizedAttribute, kCFBooleanTrue)
    case "restore":
        if (axAttr(window, kAXMinimizedAttribute) as Bool?) == true { try set(kAXMinimizedAttribute, kCFBooleanFalse) }
        if (axAttr(window, "AXFullScreen") as Bool?) == true { try set("AXFullScreen", kCFBooleanFalse) }
        AXUIElementPerformAction(window, kAXRaiseAction as CFString)
    case "raise": AXUIElementPerformAction(window, kAXRaiseAction as CFString)
    case "close": try press(kAXCloseButtonAttribute)
    case "zoom": try press(kAXZoomButtonAttribute)
    case "fullScreen": try set("AXFullScreen", (params.bool("on") ?? true) ? kCFBooleanTrue : kCFBooleanFalse)
    default: throw HelperError("Unknown window operation \(op)", code: "bad_request")
    }
    usleep(250_000)
    return ["index": index]
}

func appAction(_ params: [String: Any]) throws -> [String: Any] {
    let pid = try params.requireInt("pid")
    let app = try runningApp(pid)
    switch params.string("op") ?? "" {
    case "hide": DispatchQueue.main.sync { _ = app.hide() }
    case "unhide": DispatchQueue.main.sync { _ = app.unhide() }
    case "quit", "forceQuit":
        let force = params.string("op") == "forceQuit"
        DispatchQueue.main.sync { _ = force ? app.forceTerminate() : app.terminate() }
        for _ in 0..<50 {
            if app.isTerminated { tables[pid] = nil; return ["terminated": true] }
            usleep(100_000)
        }
        // A "save changes?" sheet, for one, keeps the app open.
        return ["terminated": false]
    default: throw HelperError("Unknown app operation", code: "bad_request")
    }
    return [:]
}

// MARK: - Pointer extras

func hover(_ params: [String: Any]) throws -> [String: Any] {
    let point = CGPoint(x: try params.requireDouble("x"), y: try params.requireDouble("y"))
    // A few moves, so tracking areas see the pointer enter and then rest.
    for dx in [-6.0, -3.0, 0.0] {
        let e = CGEvent(mouseEventSource: eventSource, mouseType: .mouseMoved, mouseCursorPosition: CGPoint(x: point.x + dx, y: point.y), mouseButton: .left)
        if let route = backgroundRoute, let event = e {
            // Tracking areas in a background AppKit window see moves only on
            // the SkyLight route; post both, as scrolls do.
            event.setIntegerValueField(.eventSourceUserData, value: syntheticMarker)
            route.postScroll(event)
        } else {
            post(e)
        }
        usleep(40_000)
    }
    return [:]
}

// Trackpad gestures as gesture events (type 29), the form AppKit turns into
// magnify and rotate events. Field numbers are CoreGraphics' private ones,
// as used by MiddleClick, Swish and other trackpad tools.
func gesture(_ params: [String: Any]) throws -> [String: Any] {
    let point = CGPoint(x: try params.requireDouble("x"), y: try params.requireDouble("y"))
    let kind = params.string("kind") ?? "magnify"
    let amount = params.double("amount") ?? 1
    let steps = max(2, params.int("steps") ?? 10)
    let ms = params.int("ms") ?? 400
    let hidType: Int64
    switch kind {
    case "magnify": hidType = 8   // kIOHIDEventTypeZoom
    case "rotate": hidType = 5    // kIOHIDEventTypeRotation
    case "smartMagnify": hidType = 22
    default: throw HelperError("Unknown gesture \(kind)", code: "bad_request")
    }
    post(CGEvent(mouseEventSource: eventSource, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left))
    usleep(30_000)
    func event(phase: Int64, value: Double) -> CGEvent? {
        guard let e = CGEvent(source: eventSource) else { return nil }
        e.location = point
        e.setIntegerValueField(CGEventField(rawValue: 55)!, value: 29)   // event type: gesture
        e.setIntegerValueField(CGEventField(rawValue: 110)!, value: hidType)
        if kind == "magnify" { e.setDoubleValueField(CGEventField(rawValue: 113)!, value: value) }
        if kind == "rotate" { e.setDoubleValueField(CGEventField(rawValue: 114)!, value: value) }
        e.setIntegerValueField(CGEventField(rawValue: 132)!, value: phase)
        return e
    }
    if kind == "smartMagnify" {
        post(event(phase: 0, value: 0))
        return [:]
    }
    // Magnify: amount is the total scale change (1 doubles: 0.1 per step of 10).
    // Rotate: amount is degrees.
    let per = amount / Double(steps)
    post(event(phase: 1, value: 0))
    usleep(useconds_t(ms * 1000 / steps))
    for _ in 0..<steps {
        post(event(phase: 2, value: per))
        usleep(useconds_t(ms * 1000 / steps))
    }
    post(event(phase: 4, value: 0))
    return [:]
}

// MARK: - Whole screen

func displaysInfo() -> [[String: Any]] {
    guard let primary = NSScreen.screens.first else { return [] }
    return NSScreen.screens.enumerated().map { i, s in
        let f = s.frame
        // Top-left origin, like every other frame here.
        let top = CGRect(x: f.minX, y: primary.frame.height - f.maxY, width: f.width, height: f.height)
        let id = (s.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.intValue ?? 0
        return ["index": i, "displayId": id, "frame": rectJSON(top), "scale": Double(s.backingScaleFactor), "main": s == NSScreen.main, "name": s.localizedName]
    }
}

func allWindows(_ params: [String: Any]) -> [[String: Any]] {
    let onScreen = params.bool("all") != true
    let options: CGWindowListOption = onScreen ? [.optionOnScreenOnly, .excludeDesktopElements] : [.optionAll, .excludeDesktopElements]
    guard let info = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else { return [] }
    var out: [[String: Any]] = []
    for w in info {
        guard let id = w[kCGWindowNumber as String] as? Int, let pid = w[kCGWindowOwnerPID as String] as? Int,
              let b = w[kCGWindowBounds as String] as? [String: Any], let rect = CGRect(dictionaryRepresentation: b as CFDictionary),
              rect.width >= 2, rect.height >= 2 else { continue }
        let alpha = (w[kCGWindowAlpha as String] as? Double) ?? 1
        if alpha == 0 { continue }
        var entry: [String: Any] = [
            "windowId": id, "pid": pid, "app": (w[kCGWindowOwnerName as String] as? String) ?? "",
            "frame": rectJSON(rect), "layer": (w[kCGWindowLayer as String] as? Int) ?? 0,
            "onScreen": (w[kCGWindowIsOnscreen as String] as? Bool) ?? false,
        ]
        if let title = w[kCGWindowName as String] as? String, !title.isEmpty { entry["title"] = title }
        if let id = NSRunningApplication(processIdentifier: pid_t(pid))?.bundleIdentifier { entry["bundleId"] = id }
        out.append(entry)
    }
    return out
}

func screenCapture(_ params: [String: Any]) throws -> [String: Any] {
    let displayIndex = params.int("display") ?? 0
    let screens = NSScreen.screens
    guard displayIndex >= 0 && displayIndex < screens.count else { throw HelperError("No display \(displayIndex)", code: "bad_request") }
    let displayId = (screens[displayIndex].deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value ?? CGMainDisplayID()
    let width = try params.requireInt("width"), height = try params.requireInt("height")
    let format = params.string("format") ?? "png"
    let quality = params.double("quality") ?? 0.8
    let done = DispatchSemaphore(value: 0)
    var captured: CGImage?
    var failure: Error?
    Task {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            guard let display = content.displays.first(where: { $0.displayID == displayId }) else { throw HelperError("Display not capturable", code: "no_window") }
            // Leave out the helper's own windows (the agent cursor).
            let own = content.windows.filter { $0.owningApplication?.processID == getpid() }
            let filter = SCContentFilter(display: display, excludingWindows: own)
            let config = SCStreamConfiguration()
            config.width = width
            config.height = height
            config.showsCursor = params.bool("cursor") ?? false
            if let r = params["region"] as? [Double], r.count == 4 { config.sourceRect = CGRect(x: r[0], y: r[1], width: r[2], height: r[3]) }
            captured = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        } catch { failure = error }
        done.signal()
    }
    if done.wait(timeout: .now() + 15) == .timedOut { throw HelperError("Screen capture timed out") }
    if let error = failure as? HelperError { throw error }
    if let error = failure { throw HelperError("Screen capture failed: \(error.localizedDescription)") }
    guard let image = captured else { throw HelperError("Screen capture returned nothing") }
    let data = try encode(image, format: format, quality: quality)
    return ["data": data.base64EncodedString(), "width": image.width, "height": image.height, "mimeType": format == "jpeg" ? "image/jpeg" : "image/png"]
}

// The element at a global screen point, whichever app owns it.
func elementAtPoint(_ params: [String: Any]) throws -> [String: Any] {
    let system = AXUIElementCreateSystemWide()
    var hit: AXUIElement?
    let err = AXUIElementCopyElementAtPosition(system, Float(try params.requireDouble("x")), Float(try params.requireDouble("y")), &hit)
    guard err == .success, let element = hit else { return [:] }
    var pid: pid_t = 0
    AXUIElementGetPid(element, &pid)
    var out: [String: Any] = ["pid": Int(pid), "role": axRole(element), "title": axTitle(element), "index": table(Int(pid)).index(of: element)]
    if let app = NSRunningApplication(processIdentifier: pid) { out["app"] = app.localizedName ?? ""; out["bundleId"] = app.bundleIdentifier ?? "" }
    if let frame = axFrame(element) { out["frame"] = rectJSON(frame) }
    if let v: String = axAttr(element, kAXValueAttribute) { out["value"] = String(v.prefix(160)) }
    return out
}

// Menu bar extras (status items) of every running app, with Control Center's
// and the clock among them. Indices are in the owning app's element table.
func menuExtras(_ params: [String: Any]) -> [[String: Any]] {
    var out: [[String: Any]] = []
    for app in NSWorkspace.shared.runningApplications where !app.isTerminated {
        let pid = Int(app.processIdentifier)
        if pid == Int(getpid()) { continue }
        let element = AXUIElementCreateApplication(app.processIdentifier)
        AXUIElementSetMessagingTimeout(element, 0.25)
        guard let bar: AXUIElement = axAttr(element, kAXExtrasMenuBarAttribute) else { continue }
        // Some extras bars (MenuBarAgent on macOS 26+) group their items.
        var items: [AXUIElement] = []
        var queue = axChildren(bar)
        while !queue.isEmpty {
            let e = queue.removeFirst()
            let kids = axChildren(e)
            if axRole(e) != kAXMenuBarItemRole && axTitle(e).isEmpty && !kids.isEmpty && items.count < 200 { queue.append(contentsOf: kids) } else { items.append(e) }
        }
        for item in items {
            var entry: [String: Any] = ["pid": pid, "app": app.localizedName ?? "", "index": table(pid).index(of: item)]
            if let id = app.bundleIdentifier { entry["bundleId"] = id }
            let title = axTitle(item)
            if !title.isEmpty { entry["title"] = title }
            if let help: String = axAttr(item, kAXHelpAttribute), !help.isEmpty { entry["help"] = help }
            if let ident: String = axAttr(item, kAXIdentifierAttribute), !ident.isEmpty { entry["id"] = ident }
            if let frame = axFrame(item) { entry["frame"] = rectJSON(frame) }
            out.append(entry)
        }
    }
    return out.sorted { (($0["frame"] as? [Double])?.first ?? 0) < (($1["frame"] as? [Double])?.first ?? 0) }
}

// Keys to whatever is frontmost (Spotlight, Mission Control, screenshots):
// the system-wide route, posted at the HID level.
func systemKeys(_ params: [String: Any]) throws -> [String: Any] {
    keyTargetPid = nil
    backgroundRoute = nil
    if params["chords"] != nil { return try pressKeys(params) }
    // System UI (Spotlight) drops Unicode-only key events; send real key
    // codes when every character has one.
    let text = params.string("text") ?? ""
    let typable = text.allSatisfy { c in
        let k = String(c)
        return keyCodes[k.lowercased()] != nil || shifted[k] != nil
    }
    if typable && !text.isEmpty {
        return try pressKeys(["chords": text.map { ["key": String($0) == " " ? "space" : String($0), "mods": [String]()] }])
    }
    return try typeText(params)
}

// MARK: - Clipboard

func pasteboardSnapshot() -> [[NSPasteboard.PasteboardType: Data]] {
    (NSPasteboard.general.pasteboardItems ?? []).map { item in
        var d: [NSPasteboard.PasteboardType: Data] = [:]
        for type in item.types { if let data = item.data(forType: type) { d[type] = data } }
        return d
    }
}

func pasteboardRestore(_ snapshot: [[NSPasteboard.PasteboardType: Data]]) {
    let pb = NSPasteboard.general
    pb.clearContents()
    let items = snapshot.map { entry -> NSPasteboardItem in
        let item = NSPasteboardItem()
        for (type, data) in entry { item.setData(data, forType: type) }
        return item
    }
    if !items.isEmpty { pb.writeObjects(items) }
}

var stashedPasteboard: [[NSPasteboard.PasteboardType: Data]]?

func clipboard(_ params: [String: Any]) throws -> [String: Any] {
    let pb = NSPasteboard.general
    switch params.string("op") ?? "read" {
    case "read":
        var out: [String: Any] = ["types": (pb.types ?? []).map { $0.rawValue }, "changeCount": pb.changeCount]
        if let s = pb.string(forType: .string) { out["text"] = s }
        if let urls = pb.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL], !urls.isEmpty {
            out["files"] = urls.map { $0.path }
        }
        if pb.data(forType: .png) != nil || pb.data(forType: .tiff) != nil { out["image"] = true }
        return out
    case "write":
        pb.clearContents()
        if let files = params["files"] as? [String] {
            pb.writeObjects(files.map { URL(fileURLWithPath: $0) as NSURL })
        } else {
            pb.setString(params.string("text") ?? "", forType: .string)
        }
        return ["changeCount": pb.changeCount]
    default: throw HelperError("Unknown clipboard operation", code: "bad_request")
    }
}

// For app.paste: put text on the clipboard, keeping the user's contents to
// put back afterwards. The user's clipboard never leaves the helper.
func pasteStash(_ params: [String: Any]) throws -> [String: Any] {
    let pb = NSPasteboard.general
    switch params.string("op") ?? "stash" {
    case "stash":
        if stashedPasteboard == nil { stashedPasteboard = pasteboardSnapshot() }
        pb.clearContents()
        pb.setString(params.string("text") ?? "", forType: .string)
    case "restore":
        if let s = stashedPasteboard { pasteboardRestore(s) }
        stashedPasteboard = nil
    default: throw HelperError("Unknown paste operation", code: "bad_request")
    }
    return [:]
}

// MARK: - Opening files and links

func openTarget(_ connection: Connection, _ params: [String: Any]) throws -> [String: Any] {
    guard let target = params.string("target"), !target.isEmpty else { throw HelperError("open needs a path or URL", code: "bad_request") }
    let url: URL
    if target.hasPrefix("/") || target.hasPrefix("~") {
        url = URL(fileURLWithPath: (target as NSString).expandingTildeInPath)
        guard FileManager.default.fileExists(atPath: url.path) else { throw HelperError("No file at \(url.path)", code: "not_found") }
    } else if let u = URL(string: target), u.scheme != nil {
        url = u
    } else {
        throw HelperError("\(target) is neither an absolute path nor a URL with a scheme", code: "bad_request")
    }
    var appURL: URL?
    if let id = params.string("bundleId") {
        appURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: id)
        if appURL == nil { throw HelperError("No app with bundle id \(id)", code: "not_found") }
    } else {
        appURL = NSWorkspace.shared.urlForApplication(toOpen: url)
    }
    guard let handler = appURL, let bundle = Bundle(url: handler), let handlerId = bundle.bundleIdentifier else {
        throw HelperError("No app opens \(target)", code: "not_found")
    }
    let name = (bundle.object(forInfoDictionaryKey: "CFBundleName") as? String) ?? handler.deletingPathExtension().lastPathComponent
    if url.isFileURL { try authorize(connection, bundleId: "macos:files", name: "files on this Mac", reason: "It wants to open \(url.path) in \(name).") }
    try authorize(connection, bundleId: handlerId, name: name)
    let config = NSWorkspace.OpenConfiguration()
    config.activates = params.bool("activate") ?? false
    let done = DispatchSemaphore(value: 0)
    var opened: NSRunningApplication?
    var failure: Error?
    NSWorkspace.shared.open([url], withApplicationAt: handler, configuration: config) { app, error in
        opened = app; failure = error; done.signal()
    }
    if done.wait(timeout: .now() + 20) == .timedOut { throw HelperError("Timed out opening \(target)") }
    if let error = failure { throw HelperError("Opening failed: \(error.localizedDescription)") }
    guard let app = opened else { throw HelperError("Opening returned no app") }
    return appInfo(app)
}

// MARK: - Dropping files
//
// A file drag needs a drag source in some process. The helper shows a small
// window holding the files, presses on it, drags to the target and lets go.
// This uses the real pointer (foreground route) and puts it back afterwards.

final class DragSourceView: NSView, NSDraggingSource {
    var files: [URL] = []
    var finished = DispatchSemaphore(value: 0)
    func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation { .copy }
    func draggingSession(_ session: NSDraggingSession, endedAt screenPoint: NSPoint, operation: NSDragOperation) { finished.signal() }
    override func draw(_ dirtyRect: NSRect) {
        NSColor.systemPurple.withAlphaComponent(0.6).setFill()
        bounds.fill()
    }
    override func mouseDown(with event: NSEvent) {
        let items = files.map { url -> NSDraggingItem in
            let item = NSDraggingItem(pasteboardWriter: url as NSURL)
            item.setDraggingFrame(NSRect(x: 0, y: 0, width: 32, height: 32), contents: NSWorkspace.shared.icon(forFile: url.path))
            return item
        }
        beginDraggingSession(with: items, event: event, source: self)
    }
}

func dropFiles(_ params: [String: Any]) throws -> [String: Any] {
    guard let paths = params["paths"] as? [String], !paths.isEmpty else { throw HelperError("dropFiles needs paths", code: "bad_request") }
    let urls = paths.map { URL(fileURLWithPath: ($0 as NSString).expandingTildeInPath) }
    for u in urls where !FileManager.default.fileExists(atPath: u.path) { throw HelperError("No file at \(u.path)", code: "not_found") }
    let to = CGPoint(x: try params.requireDouble("x"), y: try params.requireDouble("y"))
    let saved = CGEvent(source: nil)?.location ?? to
    var window: NSWindow?
    var view: DragSourceView?
    var start = CGPoint.zero
    DispatchQueue.main.sync {
        guard let primary = NSScreen.screens.first else { return }
        // Near the target but not on it, so the drag has somewhere to travel.
        let size: CGFloat = 40
        let sx = max(primary.frame.minX + 4, to.x - 160), sy = max(30, to.y - 120)
        start = CGPoint(x: sx + size / 2, y: sy + size / 2)
        let w = NSWindow(contentRect: NSRect(x: sx, y: primary.frame.height - sy - size, width: size, height: size), styleMask: .borderless, backing: .buffered, defer: false)
        w.level = .floating
        w.isOpaque = false
        w.title = "glovebox drag source"
        let v = DragSourceView(frame: NSRect(x: 0, y: 0, width: size, height: size))
        v.files = urls
        w.contentView = v
        w.orderFrontRegardless()
        window = w
        view = v
    }
    defer {
        DispatchQueue.main.sync { window?.orderOut(nil) }
        CGWarpMouseCursorPosition(saved)
    }
    guard let source = view else { throw HelperError("Could not create the drag source") }
    usleep(150_000)
    func mouse(_ type: CGEventType, _ p: CGPoint) {
        let e = CGEvent(mouseEventSource: eventSource, mouseType: type, mouseCursorPosition: p, mouseButton: .left)
        e?.setIntegerValueField(.mouseEventClickState, value: 1)
        e?.setIntegerValueField(.eventSourceUserData, value: syntheticMarker)
        e?.post(tap: .cghidEventTap)
    }
    mouse(.mouseMoved, start)
    usleep(80_000)
    mouse(.leftMouseDown, start)
    usleep(120_000)
    let steps = 30
    for s in 1...steps {
        let t = CGFloat(s) / CGFloat(steps)
        mouse(.leftMouseDragged, CGPoint(x: start.x + (to.x - start.x) * t, y: start.y + (to.y - start.y) * t))
        usleep(16_000)
    }
    usleep(250_000)
    mouse(.leftMouseUp, to)
    let ended = source.finished.wait(timeout: .now() + 3) == .success
    return ["route": "foreground", "ended": ended]
}

// MARK: - Agent cursor
//
// A drawn pointer that shows where the agent acts. It sits just above the
// target window (not above everything), ignores the mouse, and never moves
// the real cursor.

final class AgentCursor {
    static let shared = AgentCursor()
    var enabled = true
    private var window: NSWindow?
    private var hideTimer: Timer?
    private let size = CGSize(width: 36, height: 36)

    private func makeWindow() -> NSWindow {
        let w = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: .borderless, backing: .buffered, defer: false)
        w.isOpaque = false
        w.backgroundColor = .clear
        w.hasShadow = false
        w.ignoresMouseEvents = true
        w.level = .normal
        w.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        w.sharingType = .readOnly
        w.title = "glovebox cursor"
        let view = NSImageView(frame: NSRect(origin: .zero, size: size))
        let config = NSImage.SymbolConfiguration(pointSize: 22, weight: .regular).applying(.init(paletteColors: [.white, .systemPurple]))
        view.image = NSImage(systemSymbolName: "cursorarrow", accessibilityDescription: "agent cursor")?.withSymbolConfiguration(config)
        view.imageAlignment = .alignTopLeft
        w.contentView = view
        return w
    }

    // Moves the cursor to a screen point (top-left origin) above `windowId`.
    // Blocks until the move animation finishes so the action lines up with it.
    func move(to point: CGPoint, above windowId: Int?) {
        guard enabled else { return }
        var from = NSPoint.zero
        var target = NSPoint.zero
        var duration: TimeInterval = 0
        DispatchQueue.main.sync {
            let w = self.window ?? self.makeWindow()
            self.window = w
            guard let primary = NSScreen.screens.first else { return }
            // AppKit frames are bottom-left origin; the arrow tip is the frame's top-left.
            target = NSPoint(x: point.x - 4, y: primary.frame.height - point.y - self.size.height + 3)
            from = w.isVisible ? w.frame.origin : target
            let distance = hypot(target.x - from.x, target.y - from.y)
            duration = w.isVisible ? min(0.45, 0.12 + Double(distance) / 2400) : 0
            if let id = windowId { w.order(.above, relativeTo: id) } else { w.orderFrontRegardless() }
            if duration == 0 { w.setFrameOrigin(target) }
            self.hideTimer?.invalidate()
            self.hideTimer = Timer.scheduledTimer(withTimeInterval: 4, repeats: false) { _ in self.hide() }
        }
        guard duration > 0 else { return }
        // Stepped by hand: an animator() frame move left the window where it was.
        let steps = max(1, Int(duration * 60))
        for step in 1...steps {
            let t = Double(step) / Double(steps)
            let eased = t * t * (3 - 2 * t)
            let next = NSPoint(x: from.x + (target.x - from.x) * eased, y: from.y + (target.y - from.y) * eased)
            DispatchQueue.main.sync { self.window?.setFrameOrigin(next) }
            usleep(useconds_t(duration / Double(steps) * 1_000_000))
        }
    }

    func hide() {
        let work: () -> Void = { self.window?.orderOut(nil) }
        if Thread.isMainThread { work() } else { DispatchQueue.main.async(execute: work) }
    }
}

func cursorCommand(_ params: [String: Any]) throws -> [String: Any] {
    if let enabled = params.bool("enabled") {
        AgentCursor.shared.enabled = enabled
        if !enabled { AgentCursor.shared.hide() }
    }
    if params.bool("hide") == true { AgentCursor.shared.hide() }
    if let x = params.double("x"), let y = params.double("y") {
        AgentCursor.shared.move(to: CGPoint(x: x, y: y), above: params.int("windowId"))
    }
    return ["enabled": AgentCursor.shared.enabled]
}

// MARK: - Screenshots

func encode(_ image: CGImage, format: String, quality: Double) throws -> Data {
    let data = NSMutableData()
    let type = format == "jpeg" ? UTType.jpeg.identifier : UTType.png.identifier
    guard let dest = CGImageDestinationCreateWithData(data, type as CFString, 1, nil) else { throw HelperError("Cannot encode image") }
    let options: [CFString: Any] = format == "jpeg" ? [kCGImageDestinationLossyCompressionQuality: quality] : [:]
    CGImageDestinationAddImage(dest, image, options as CFDictionary)
    guard CGImageDestinationFinalize(dest) else { throw HelperError("Cannot encode image") }
    return data as Data
}

func screenshot(_ params: [String: Any]) throws -> [String: Any] {
    let windowId = try params.requireInt("windowId")
    let width = try params.requireInt("width")
    let height = try params.requireInt("height")
    let format = params.string("format") ?? "png"
    let quality = params.double("quality") ?? 0.8

    // CGPreflightScreenCaptureAccess can report false for a granted ad-hoc
    // signed app, so ScreenCaptureKit itself is the source of truth.
    let done = DispatchSemaphore(value: 0)
    var captured: CGImage?
    var failure: Error?
    Task {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            guard let window = content.windows.first(where: { Int($0.windowID) == windowId }) else {
                throw HelperError("Window \(windowId) is not capturable (closed, or on another Space?)", code: "no_window")
            }
            let filter = SCContentFilter(desktopIndependentWindow: window)
            let config = SCStreamConfiguration()
            config.width = width
            config.height = height
            config.showsCursor = false
            config.scalesToFit = true
            if #available(macOS 14.0, *) { config.ignoreShadowsSingleWindow = true }
            captured = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        } catch {
            failure = error
        }
        done.signal()
    }
    if done.wait(timeout: .now() + 15) == .timedOut { throw HelperError("Screenshot timed out") }
    if let error = failure as? HelperError { throw error }
    if let error = failure {
        if !screenCaptureAllowed() {
            throw HelperError("Screen Recording permission is missing for Glovebox Helper. Run `glovebox doctor`.", code: "permission")
        }
        throw HelperError("Screenshot failed: \(error.localizedDescription)")
    }
    guard let image = captured else { throw HelperError("Screenshot returned nothing") }
    let data = try encode(image, format: format, quality: quality)
    return ["data": data.base64EncodedString(), "width": image.width, "height": image.height, "mimeType": format == "jpeg" ? "image/jpeg" : "image/png"]
}

// True when ScreenCaptureKit will hand us window content.
func screenCaptureAllowed() -> Bool {
    if CGPreflightScreenCaptureAccess() { return true }
    let done = DispatchSemaphore(value: 0)
    var ok = false
    Task {
        ok = (try? await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)) != nil
        done.signal()
    }
    return done.wait(timeout: .now() + 5) == .success && ok
}

// MARK: - Stopping scripts
//
// Two ways for the user to stop a running script, both broadcast as an
// "escape" event that clients turn into an abort:
//  - a physical Escape press (synthetic events we post carry syntheticMarker
//    and are ignored);
//  - "Stop Running Scripts" in the menu-bar item shown while agents are connected.

var watchTap: CFMachPort?
var keyMonitor: Any?
var lastEscape = Date.distantPast

func userPressedEscape() {
    // The tap and the monitor can both see one press.
    if Date().timeIntervalSince(lastEscape) < 0.2 { return }
    lastEscape = Date()
    emit(["event": "escape"])
}

// A global key monitor. macOS delivers key events to it only with Input
// Monitoring granted; Accessibility alone installs it but it stays silent.
func startEscapeMonitor() {
    guard keyMonitor == nil, AXIsProcessTrusted() else { return }
    let install = {
        keyMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { event in
            guard event.keyCode == 53 else { return }
            if let cg = event.cgEvent, cg.getIntegerValueField(.eventSourceUserData) == syntheticMarker { return }
            userPressedEscape()
        }
    }
    if Thread.isMainThread { install() } else { DispatchQueue.main.sync(execute: install) }
}

// An event tap also sees keys sent to apps that bypass the monitor, but
// macOS only feeds it with Input Monitoring; without it the tap is silent.
func startEscapeTap() {
    guard watchTap == nil, CGPreflightListenEventAccess() else { return }
    let mask = CGEventMask(1 << CGEventType.keyDown.rawValue)
    let callback: CGEventTapCallBack = { _, type, event, _ in
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let tap = watchTap { CGEvent.tapEnable(tap: tap, enable: true) }
            return Unmanaged.passUnretained(event)
        }
        if type == .keyDown,
           event.getIntegerValueField(.keyboardEventKeycode) == 53,
           event.getIntegerValueField(.eventSourceUserData) != syntheticMarker {
            userPressedEscape()
        }
        return Unmanaged.passUnretained(event)
    }
    guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly,
                                      eventsOfInterest: mask, callback: callback, userInfo: nil) else { return }
    watchTap = tap
    let source = CFMachPortCreateRunLoopSource(nil, tap, 0)
    CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
    CGEvent.tapEnable(tap: tap, enable: true)
}

@discardableResult
func startEscapeWatcher() -> Bool {
    startEscapeMonitor()
    startEscapeTap()
    return keyMonitor != nil || watchTap != nil
}

func escapeWatcherActive() -> Bool {
    startEscapeWatcher()
}

// MARK: - Menu-bar item

final class StatusMenu: NSObject, NSMenuDelegate {
    var item: NSStatusItem?

    // Called on the main thread whenever clients connect or disconnect.
    func refresh() {
        let connections = Connection.all()
        if connections.isEmpty {
            if let item = item { NSStatusBar.system.removeStatusItem(item) }
            item = nil
            return
        }
        if item == nil {
            let created = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
            if let image = NSImage(systemSymbolName: "hand.raised.fill", accessibilityDescription: "glovebox") {
                image.isTemplate = true
                created.button?.image = image
            } else {
                created.button?.title = "glovebox"
            }
            let menu = NSMenu()
            menu.delegate = self
            created.menu = menu
            item = created
        }
        item?.button?.toolTip = "glovebox: \(connections.count) agent session(s) connected"
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let connections = Connection.all()
        menu.addItem(withTitle: "glovebox — \(connections.count) connected", action: nil, keyEquivalent: "")
        for c in connections {
            let apps = c.approved.sorted().joined(separator: ", ")
            menu.addItem(withTitle: "  \(c.client)\(apps.isEmpty ? "" : ": \(apps)")", action: nil, keyEquivalent: "")
        }
        menu.addItem(.separator())
        let stop = NSMenuItem(title: "Stop Running Scripts", action: #selector(stopScripts), keyEquivalent: "")
        stop.target = self
        menu.addItem(stop)
        let revoke = NSMenuItem(title: "Revoke Session Approvals", action: #selector(revokeApprovals), keyEquivalent: "")
        revoke.target = self
        menu.addItem(revoke)
        let cursor = NSMenuItem(title: "Hide Agent Cursor", action: #selector(toggleCursor), keyEquivalent: "")
        cursor.target = self
        cursor.state = AgentCursor.shared.enabled ? .off : .on
        menu.addItem(cursor)
        let quit = NSMenuItem(title: "Quit Glovebox Helper", action: #selector(quitHelper), keyEquivalent: "")
        quit.target = self
        menu.addItem(quit)
    }

    @objc func stopScripts() { emit(["event": "escape"]) }

    @objc func toggleCursor() {
        AgentCursor.shared.enabled.toggle()
        if !AgentCursor.shared.enabled { AgentCursor.shared.hide() }
    }

    @objc func revokeApprovals() {
        work.async { for c in Connection.all() { c.approved.removeAll() } }
    }

    @objc func quitHelper() {
        unlink(socketPath)
        exit(0)
    }
}

let statusMenu = StatusMenu()

func refreshStatusMenu() {
    DispatchQueue.main.async { statusMenu.refresh() }
}

// MARK: - Approval policy
//
// The approval gate lives here, at the process that holds the Accessibility
// grant, so a client cannot skip it by talking to the socket directly.

let gloveboxHome: String = ProcessInfo.processInfo.environment["GLOVEBOX_HOME"] ?? (NSHomeDirectory() + "/.glovebox")
let configPath = gloveboxHome + "/config.json"

// Apps that can run arbitrary commands, hold secrets, send messages, or change
// system settings. Nothing is blocked: these ask first, even under allow-all,
// and an explicit `allow` entry skips the dialog. `askFirst` in config.json
// adds more. Entries ending in ":" or "." match by prefix.
let askFirstByDefault: [String] = [
    // Terminals and scripting
    "com.apple.terminal", "com.googlecode.iterm2", "com.mitchellh.ghostty", "dev.warp.warp-stable",
    "com.github.wez.wezterm", "org.alacritty", "net.kovidgoyal.kitty", "org.tabby", "co.zeit.hyper",
    "com.apple.scripteditor2", "com.apple.automator", "com.apple.shortcuts", "com.cmuxterm.app", "com.termius.mac",
    // System control, installs and security prompts
    "com.apple.systempreferences", "com.apple.installer", "com.apple.securityagent",
    "com.apple.coreservices.uiagent", "com.apple.usernotificationcenter", "com.apple.appstore",
    // Secrets
    "com.apple.keychainaccess", "com.apple.passwords",
    "com.1password.1password", "com.agilebits.onepassword7", "com.bitwarden.desktop", "com.lastpass.lastpassmacdesktop",
    // Messages and calls
    "com.apple.mobilesms", "com.apple.facetime", "com.apple.mail",
    // Surfaces that are not one app: macos:screen, macos:clipboard, macos:notifications,
    // macos:system (Dock, menu bar, Spotlight, global keys), macos:files
    "macos:",
]

// The helper's own windows are the approval dialogs. Driving them would let an
// agent approve itself, so this is the one target glovebox refuses.
let helperBundleId = "io.github.vpatel9202.glovebox.helper"

func isAskFirst(_ bundleId: String, _ config: [String: Any]) -> Bool {
    let id = bundleId.lowercased()
    let extra = ((config["askFirst"] as? [String]) ?? []).map { $0.lowercased() }
    return (askFirstByDefault + extra).contains { e in
        (e.hasSuffix(":") || e.hasSuffix(".")) ? id.hasPrefix(e) : id == e
    }
}

func readConfig() -> [String: Any] {
    guard let data = FileManager.default.contents(atPath: configPath),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
    return obj
}

func matches(_ list: [String], _ bundleId: String, _ name: String) -> Bool {
    let id = bundleId.lowercased(), n = name.lowercased()
    return list.contains { let e = $0.lowercased(); return e == id || e == n }
}

func persistAllow(_ bundleId: String) {
    var config = readConfig()
    var allow = (config["allow"] as? [String]) ?? []
    if !allow.contains(where: { $0.lowercased() == bundleId.lowercased() }) { allow.append(bundleId) }
    config["allow"] = allow
    try? FileManager.default.createDirectory(atPath: gloveboxHome, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    if let data = try? JSONSerialization.data(withJSONObject: config, options: [.prettyPrinted, .sortedKeys]) {
        FileManager.default.createFile(atPath: configPath, contents: data, attributes: [.posixPermissions: 0o600])
    }
}

enum Choice { case session, always, deny }

func askUser(client: String, app: String, bundleId: String, reason: String? = nil) -> Choice {
    var choice = Choice.deny
    DispatchQueue.main.sync {
        let alert = NSAlert()
        alert.messageText = "Allow \(client) to control \(app)?"
        let what = bundleId.hasPrefix("macos:") ? app : "\(app) (\(bundleId))"
        alert.informativeText = "An agent using glovebox wants to click, type, and read the screen in \(what).\(reason.map { " \($0)" } ?? "") Every action is logged in \(gloveboxHome)/actions.log. Press Escape any time to stop a running script. This dialog denies on its own after 2 minutes."
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Allow for This Session")
        alert.addButton(withTitle: "Always Allow")
        alert.addButton(withTitle: "Deny")
        NSApp.activate(ignoringOtherApps: true)
        alert.window.level = .floating
        // Nobody may be at the Mac: give up (Deny) after two minutes.
        let timer = Timer(timeInterval: 120, repeats: false) { _ in NSApp.abortModal() }
        RunLoop.main.add(timer, forMode: .modalPanel)
        let response = alert.runModal()
        timer.invalidate()
        switch response {
        case .alertFirstButtonReturn: choice = .session
        case .alertSecondButtonReturn: choice = .always
        default: choice = .deny
        }
    }
    return choice
}

func authorize(_ connection: Connection, bundleId: String, name: String, reason: String? = nil) throws {
    if connection.approved.contains(bundleId) { return }
    if bundleId.lowercased() == helperBundleId {
        throw HelperError("Glovebox Helper's own windows are its approval dialogs; an agent cannot drive them.", code: "denied")
    }
    let config = readConfig()
    let allow = (config["allow"] as? [String]) ?? []
    let deny = (config["deny"] as? [String]) ?? []
    let mode = (ProcessInfo.processInfo.environment["GLOVEBOX_APPROVAL"] ?? config["approval"] as? String) ?? "ask"
    if matches(deny, bundleId, name) {
        throw HelperError("\(name) is on the deny list in \(configPath).", code: "denied")
    }
    if matches(allow, bundleId, name) {
        connection.approved.insert(bundleId)
        return
    }
    let askFirst = isAskFirst(bundleId, config)
    if !askFirst && mode == "allow-all" {
        connection.approved.insert(bundleId)
        return
    }
    if mode == "allowlist" {
        throw HelperError("\(name) is not in the allowlist. Run: glovebox allow \"\(bundleId)\"", code: "not_allowed")
    }
    let why = reason ?? (askFirst ? "\(name) can run commands, hold secrets, send messages, or change system settings, so glovebox always asks first." : nil)
    switch askUser(client: connection.client, app: name, bundleId: bundleId, reason: why) {
    case .session: connection.approved.insert(bundleId)
    case .always: connection.approved.insert(bundleId); persistAllow(bundleId)
    case .deny: throw HelperError("The user denied access to \(name) (or nobody answered within 2 minutes). Ask the user; `glovebox allow \(bundleId)` skips the dialog.", code: "denied")
    }
}

// Methods that only read the app list or the helper's own state.
let ungatedMethods: Set<String> = ["hello", "ping", "permissions", "listApps", "resolveApp", "forget", "cursor", "displays"]
// Spotlight is a panel that takes the keys without becoming the front app.
func spotlightOpen() -> Bool {
    allWindows([:]).contains { w in
        let id = ((w["bundleId"] as? String) ?? "").lowercased()
        let frame = (w["frame"] as? [Double]) ?? []
        return (id == "com.apple.siri" || id == "com.apple.spotlight" || id == "com.apple.campo") && frame.count == 4 && frame[3] > 100
    }
}

// Chords macOS handles itself before any app sees them.
func isSystemHotkey(_ chord: [String: Any]) -> Bool {
    let key = (chord["key"] as? String) ?? ""
    let mods = Set((chord["mods"] as? [String]) ?? [])
    switch key {
    case "space": return mods == ["super"] || mods == ["super", "alt"]                    // Spotlight, Finder search
    case "Up", "Down", "Left", "Right": return mods == ["ctrl"]                          // Mission Control, Spaces
    case "3", "4", "5": return mods == ["super", "shift"]                                // screenshots
    case "Tab": return mods == ["super"] || mods == ["super", "shift"]                   // app switcher
    case "q": return mods == ["super", "ctrl"]                                           // lock screen
    default: return false
    }
}

let systemUIBundles: Set<String> = [
    "com.apple.siri", "com.apple.spotlight", "com.apple.campo", "com.apple.dock", "com.apple.systemuiserver",
    "com.apple.controlcenter", "com.apple.notificationcenterui", "com.apple.menubaragent", "com.apple.windowmanager",
]

// Methods with no app of their own: each asks under a macos: key.
let systemMethods: [String: (String, String)] = [
    "screenCapture": ("macos:screen", "the whole screen"),
    "allWindows": ("macos:screen", "the list of every window on screen"),
    "menuExtras": ("macos:system", "the menu bar and Control Center"),
    "systemKeys": ("macos:system", "system-wide keys (Spotlight, Mission Control, shortcuts)"),
    "clipboard": ("macos:clipboard", "the clipboard"),
    "elementAtPoint": ("macos:screen", "what is on screen at a point"),
]

func gate(_ connection: Connection, _ method: String, _ params: [String: Any]) throws {
    if ungatedMethods.contains(method) { return }
    if let (key, name) = systemMethods[method] {
        try authorize(connection, bundleId: key, name: name)
        return
    }
    // Authorizes the app that handles the file or link itself.
    if method == "open" { return }
    // A surface the scripting layer assembles from apps (notifications):
    // asks under its macos: key.
    if method == "approveSurface" {
        guard let key = params.string("key"), key.hasPrefix("macos:") else { throw HelperError("approveSurface needs a macos: key", code: "bad_request") }
        try authorize(connection, bundleId: key, name: params.string("name") ?? key, reason: params.string("reason"))
        return
    }
    if method == "dropFiles" {
        try authorize(connection, bundleId: "macos:files", name: "files on this Mac", reason: "It wants to drag files into an app.")
    }
    if method == "launch" {
        let bundleId = params.string("bundleId") ?? params.string("path").flatMap { Bundle(path: $0)?.bundleIdentifier } ?? ""
        let name = params.string("name") ?? bundleId
        if bundleId.isEmpty { throw HelperError("launch needs a bundleId", code: "bad_request") }
        try authorize(connection, bundleId: bundleId, name: name)
        return
    }
    guard let pid = params.int("pid") else { throw HelperError("\(method) needs a pid", code: "bad_request") }
    let app = try runningApp(pid)
    guard let bundleId = app.bundleIdentifier else { throw HelperError("App has no bundle identifier", code: "denied") }
    try authorize(connection, bundleId: bundleId, name: app.localizedName ?? bundleId)
}

// MARK: - Dispatch

func permissions(_ params: [String: Any]) -> [String: Any] {
    let prompt = params.bool("prompt") ?? false
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: prompt] as CFDictionary
    let ax = AXIsProcessTrustedWithOptions(options)
    var input = CGPreflightListenEventAccess()
    if prompt && params.bool("inputMonitoring") == true && !input { input = CGRequestListenEventAccess() }
    var screen = screenCaptureAllowed()
    if prompt && !screen { screen = CGRequestScreenCaptureAccess() }
    return ["accessibility": ax, "screenRecording": screen, "escapeWatcher": escapeWatcherActive(), "inputMonitoring": input]
}

func handle(_ connection: Connection, _ method: String, _ params: [String: Any]) throws -> Any {
    try gate(connection, method, params)
    switch method {
    case "hello":
        connection.client = params.string("client") ?? connection.client
        return ["version": helperVersion, "platform": "macos", "pid": Int(getpid())]
    case "ping": return ["version": helperVersion, "platform": "macos", "pid": Int(getpid()), "background": SkyLight.capabilities]
    case "permissions": return permissions(params)
    case "listApps": return listApps()
    case "resolveApp": return try resolveApp(params.string("query") ?? "")
    case "launch": return try launch(params)
    case "activate": try activate(try params.requireInt("pid")); return [:]
    case "isActive": return ["active": try runningApp(try params.requireInt("pid")).isActive]
    case "windows": return windowsInfo(try params.requireInt("pid"))
    case "otherSpaceWindows": return otherSpaceWindows(try params.requireInt("pid"))
    case "axTree": return try axTree(params)
    case "menus": return try menuList(params)
    case "menuPress": return try menuPress(params)
    case "menuShortcut": return try menuShortcut(params)
    case "selectMenuItem": return try selectMenuItem(params)
    case "windowAction": return try windowAction(params)
    case "appAction": return try appAction(params)
    case "hover": return try withInputRoute(params, .mouse) { try hover(params) }
    case "gesture": return try withInputRoute(params, .mouse) { try gesture(params) }
    case "displays": return displaysInfo()
    case "approveSurface": return [:]
    case "elementAtPoint": return try elementAtPoint(params)
    case "allWindows": return allWindows(params)
    case "screenCapture": return try screenCapture(params)
    case "menuExtras": return menuExtras(params)
    case "systemKeys":
        // System-wide keys land in whatever is in front, so that app must be
        // approved too (a terminal in front asks first).
        // System UI in front (Spotlight, the Dock, Control Center) is what
        // macos:system already covers, and system hotkeys (Spotlight,
        // Mission Control, screenshots) never reach the app.
        let hotkey = params["chords"] != nil && ((params["chords"] as? [[String: Any]]) ?? []).allSatisfy { isSystemHotkey($0) }
        if !hotkey, !spotlightOpen(), let front = NSWorkspace.shared.frontmostApplication, let id = front.bundleIdentifier, front.processIdentifier != getpid(),
           !systemUIBundles.contains(id.lowercased()) {
            try authorize(connection, bundleId: id, name: front.localizedName ?? id, reason: "System-wide keys go to the app in front.")
        }
        return try systemKeys(params)
    case "clipboard": return try clipboard(params)
    case "pasteStash": return try pasteStash(params)
    case "open": return try openTarget(connection, params)
    case "dropFiles": return try dropFiles(params)
    case "hitTest": return try hitTest(params)
    case "elementFrame": return try elementFrame(params)
    case "performAction": return try performAction(params)
    case "actionNames": return try actionNames(params)
    case "setValue": return try setValue(params)
    case "selectText": return try selectText(params)
    case "focusElement":
        var p = params
        p["attribute"] = kAXFocusedAttribute
        p["value"] = true
        return try setValue(p)
    case "keys": return try withInputRoute(params, .keys) { try withKeyTarget(params) { try pressKeys(params) } }
    case "type": return try withInputRoute(params, .keys) { try withKeyTarget(params) { try typeText(params) } }
    case "click": return try withInputRoute(params, .mouse) { try click(params) }
    case "cursor": return try cursorCommand(params)
    case "makeKey":
        let ok = makeWindowKey(pid: pid_t(try params.requireInt("pid")), windowId: UInt32(try params.requireInt("windowId")))
        return ["keyed": ok]
    case "move": return try moveMouse(params)
    case "scroll": return try withInputRoute(params, .mouse) { try scroll(params) }
    case "drag": return try withInputRoute(params, .mouse) { try drag(params) }
    case "screenshot": return try screenshot(params)
    case "forget": tables[try params.requireInt("pid")] = nil; return [:]
    default: throw HelperError("Unknown method \(method)", code: "bad_request")
    }
}

// MARK: - Socket server

// All GUI work runs on one queue so actions from different clients never interleave.
let work = DispatchQueue(label: "glovebox.work")

final class Connection {
    static var lock = NSLock()
    static var open: [ObjectIdentifier: Connection] = [:]
    static var lastClosed = Date()

    static func all() -> [Connection] {
        lock.lock(); defer { lock.unlock() }
        return Array(open.values)
    }

    let fd: Int32
    let writeLock = NSLock()
    var client = "An agent"
    private let approvedLock = NSLock()
    private var approvedApps = Set<String>()
    // Read from the menu on the main thread and written on the work queue.
    var approved: Set<String> {
        get { approvedLock.lock(); defer { approvedLock.unlock() }; return approvedApps }
        set { approvedLock.lock(); approvedApps = newValue; approvedLock.unlock() }
    }

    init(fd: Int32) { self.fd = fd }

    func send(_ object: [String: Any]) {
        guard var data = try? JSONSerialization.data(withJSONObject: object, options: []) else { return }
        data.append(0x0A)
        writeLock.lock(); defer { writeLock.unlock() }
        data.withUnsafeBytes { raw in
            var offset = 0
            while offset < raw.count {
                let n = Darwin.write(fd, raw.baseAddress! + offset, raw.count - offset)
                if n <= 0 { return }
                offset += n
            }
        }
    }

    func run() {
        Connection.lock.lock(); Connection.open[ObjectIdentifier(self)] = self; Connection.lock.unlock()
        refreshStatusMenu()
        var buffer = Data()
        var chunk = [UInt8](repeating: 0, count: 65536)
        while true {
            let n = read(fd, &chunk, chunk.count)
            if n <= 0 { break }
            buffer.append(chunk, count: n)
            while let newline = buffer.firstIndex(of: 0x0A) {
                let line = buffer.subdata(in: buffer.startIndex..<newline)
                buffer.removeSubrange(buffer.startIndex...newline)
                guard !line.isEmpty,
                      let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
                      let method = obj["method"] as? String else { continue }
                let id = obj["id"] ?? NSNull()
                let params = (obj["params"] as? [String: Any]) ?? [:]
                work.async {
                    do {
                        let result = try handle(self, method, params)
                        self.send(["id": id, "result": result])
                    } catch let error as HelperError {
                        self.send(["id": id, "error": ["message": error.message, "code": error.code]])
                    } catch {
                        self.send(["id": id, "error": ["message": "\(error)", "code": "failed"]])
                    }
                }
            }
        }
        close(fd)
        Connection.lock.lock()
        Connection.open[ObjectIdentifier(self)] = nil
        Connection.lastClosed = Date()
        Connection.lock.unlock()
        refreshStatusMenu()
    }
}

func socketAddress(_ path: String) -> sockaddr_un {
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8)
    withUnsafeMutableBytes(of: &addr.sun_path) { raw in
        for (i, b) in bytes.prefix(raw.count - 1).enumerated() { raw[i] = b }
    }
    return addr
}

func listen(at path: String) -> Int32 {
    // A live helper already owns the socket: let it keep serving.
    let probe = socket(AF_UNIX, SOCK_STREAM, 0)
    var addr = socketAddress(path)
    let alive = withUnsafePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(probe, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
    } == 0
    close(probe)
    if alive {
        FileHandle.standardError.write("glovebox-helper: already running\n".data(using: .utf8)!)
        exit(0)
    }
    unlink(path)
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    let bound = withUnsafePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
    }
    if bound != 0 || Darwin.listen(fd, 16) != 0 {
        FileHandle.standardError.write("glovebox-helper: cannot listen on \(path)\n".data(using: .utf8)!)
        exit(1)
    }
    chmod(path, 0o600)
    return fd
}

func acceptLoop(_ server: Int32) {
    while true {
        let fd = accept(server, nil, nil)
        if fd < 0 { continue }
        // Only the user who owns this helper may drive it.
        var uid: uid_t = 0
        var gid: gid_t = 0
        if getpeereid(fd, &uid, &gid) != 0 || uid != getuid() {
            close(fd)
            continue
        }
        var on: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
        let connection = Connection(fd: fd)
        Thread.detachNewThread { connection.run() }
    }
}

let socketPath = ProcessInfo.processInfo.environment["GLOVEBOX_SOCKET"] ?? (gloveboxHome + "/helper.sock")
let idleQuitSeconds: TimeInterval = 30 * 60

try? FileManager.default.createDirectory(atPath: gloveboxHome, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
_ = NSApplication.shared
NSApp.setActivationPolicy(.accessory)
signal(SIGPIPE, SIG_IGN)
if CommandLine.arguments.contains("--request-permissions") {
    _ = permissions(["prompt": true])
}
_ = startEscapeWatcher()
let server = listen(at: socketPath)
Thread.detachNewThread { acceptLoop(server) }
// Quit after a long stretch with no clients; the next client relaunches us.
Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { _ in
    Connection.lock.lock()
    let idle = Connection.open.isEmpty && Date().timeIntervalSince(Connection.lastClosed) > idleQuitSeconds
    Connection.lock.unlock()
    if idle { unlink(socketPath); exit(0) }
}
NSApp.run()
