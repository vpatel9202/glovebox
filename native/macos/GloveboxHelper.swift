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

let helperVersion = "0.1.0"
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

func runningApp(_ pid: Int) throws -> NSRunningApplication {
    guard let app = NSRunningApplication(processIdentifier: pid_t(pid)), !app.isTerminated else {
        throw HelperError("App with pid \(pid) is not running", code: "not_running")
    }
    return app
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
    let (window, windowIndex) = try targetWindow(pid, params)
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
    visit(window, 0)
    if includeMenus, let bar: AXUIElement = axAttr(appElement, kAXMenuBarAttribute) {
        visit(bar, 0)
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

func post(_ event: CGEvent?) {
    guard let e = event else { return }
    e.setIntegerValueField(.eventSourceUserData, value: syntheticMarker)
    e.post(tap: .cghidEventTap)
}

// Keyboard events go to the target app's process when it is in the
// background, so typing does not depend on (or steal) the user's focus.
var keyTargetPid: pid_t?

func postKey(_ event: CGEvent?) {
    guard let e = event else { return }
    e.setIntegerValueField(.eventSourceUserData, value: syntheticMarker)
    if let pid = keyTargetPid, let app = NSRunningApplication(processIdentifier: pid), !app.isActive {
        e.postToPid(pid)
    } else {
        e.post(tap: .cghidEventTap)
    }
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
    if Int(elementPid) != pid { return ["foreign": true] }
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
            let f = flags(mods)
            let down = CGEvent(keyboardEventSource: eventSource, virtualKey: code, keyDown: true)
            let up = CGEvent(keyboardEventSource: eventSource, virtualKey: code, keyDown: false)
            down?.flags = f
            up?.flags = f
            postKey(down)
            usleep(8000)
            postKey(up)
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
            postKey(CGEvent(keyboardEventSource: eventSource, virtualKey: code, keyDown: true))
            usleep(8000)
            postKey(CGEvent(keyboardEventSource: eventSource, virtualKey: code, keyDown: false))
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
    for n in 1...count {
        let down = CGEvent(mouseEventSource: eventSource, mouseType: downType, mouseCursorPosition: point, mouseButton: button)
        let up = CGEvent(mouseEventSource: eventSource, mouseType: upType, mouseCursorPosition: point, mouseButton: button)
        down?.setIntegerValueField(.mouseEventClickState, value: Int64(n))
        up?.setIntegerValueField(.mouseEventClickState, value: Int64(n))
        down?.flags = f
        up?.flags = f
        post(down)
        usleep(20000)
        post(up)
        usleep(30000)
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
        post(e)
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
    post(CGEvent(mouseEventSource: eventSource, mouseType: downType, mouseCursorPosition: points[0], mouseButton: button))
    usleep(60000)
    for i in 1..<points.count {
        let a = points[i - 1], b = points[i]
        let steps = max(4, Int(hypot(b.x - a.x, b.y - a.y) / 12))
        for s in 1...steps {
            let t = CGFloat(s) / CGFloat(steps)
            let p = CGPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t)
            post(CGEvent(mouseEventSource: eventSource, mouseType: dragType, mouseCursorPosition: p, mouseButton: button))
            usleep(8000)
        }
    }
    usleep(40000)
    post(CGEvent(mouseEventSource: eventSource, mouseType: upType, mouseCursorPosition: points.last!, mouseButton: button))
    return [:]
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

// A global key monitor needs only Accessibility.
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
        let quit = NSMenuItem(title: "Quit Glovebox Helper", action: #selector(quitHelper), keyEquivalent: "")
        quit.target = self
        menu.addItem(quit)
    }

    @objc func stopScripts() { emit(["event": "escape"]) }

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

// Apps that can run arbitrary commands, hold secrets, or change system
// security. These are never offered in a dialog; only an explicit `allow`
// entry in config.json unlocks one.
let blockedByDefault: Set<String> = [
    "com.apple.terminal", "com.googlecode.iterm2", "com.mitchellh.ghostty", "dev.warp.warp-stable",
    "com.github.wez.wezterm", "org.alacritty", "net.kovidgoyal.kitty", "org.tabby", "co.zeit.hyper",
    "com.apple.systempreferences", "com.apple.keychainaccess", "com.apple.passwords",
    "com.1password.1password", "com.agilebits.onepassword7", "com.bitwarden.desktop", "com.lastpass.lastpassmacdesktop",
    "com.apple.scripteditor2", "com.apple.automator", "io.github.vpatel9202.glovebox.helper",
]

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

func askUser(client: String, app: String, bundleId: String) -> Choice {
    var choice = Choice.deny
    DispatchQueue.main.sync {
        let alert = NSAlert()
        alert.messageText = "Allow \(client) to control \(app)?"
        alert.informativeText = "An agent using glovebox wants to click, type, and read the screen in \(app) (\(bundleId)). Every action is logged in \(gloveboxHome)/actions.log. Press Escape any time to stop a running script."
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Allow for This Session")
        alert.addButton(withTitle: "Always Allow")
        alert.addButton(withTitle: "Deny")
        NSApp.activate(ignoringOtherApps: true)
        alert.window.level = .floating
        switch alert.runModal() {
        case .alertFirstButtonReturn: choice = .session
        case .alertSecondButtonReturn: choice = .always
        default: choice = .deny
        }
    }
    return choice
}

func authorize(_ connection: Connection, bundleId: String, name: String) throws {
    if connection.approved.contains(bundleId) { return }
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
    if blockedByDefault.contains(bundleId.lowercased()) {
        throw HelperError("\(name) is blocked by default because it can run commands or holds secrets. To allow it anyway, run: glovebox allow \(bundleId)", code: "blocked")
    }
    switch mode {
    case "allow-all":
        connection.approved.insert(bundleId)
    case "allowlist":
        throw HelperError("\(name) is not in the allowlist. Run: glovebox allow \"\(name)\"", code: "not_allowed")
    default:
        switch askUser(client: connection.client, app: name, bundleId: bundleId) {
        case .session: connection.approved.insert(bundleId)
        case .always: connection.approved.insert(bundleId); persistAllow(bundleId)
        case .deny: throw HelperError("The user denied access to \(name).", code: "denied")
        }
    }
}

// Methods that only read the app list or the helper's own state.
let ungatedMethods: Set<String> = ["hello", "ping", "permissions", "listApps", "resolveApp", "forget"]

func gate(_ connection: Connection, _ method: String, _ params: [String: Any]) throws {
    if ungatedMethods.contains(method) { return }
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
    case "ping": return ["version": helperVersion, "platform": "macos", "pid": Int(getpid())]
    case "permissions": return permissions(params)
    case "listApps": return listApps()
    case "resolveApp": return try resolveApp(params.string("query") ?? "")
    case "launch": return try launch(params)
    case "activate": try activate(try params.requireInt("pid")); return [:]
    case "isActive": return ["active": try runningApp(try params.requireInt("pid")).isActive]
    case "windows": return windowsInfo(try params.requireInt("pid"))
    case "axTree": return try axTree(params)
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
    case "keys": return try withKeyTarget(params) { try pressKeys(params) }
    case "type": return try withKeyTarget(params) { try typeText(params) }
    case "click": return try click(params)
    case "move": return try moveMouse(params)
    case "scroll": return try scroll(params)
    case "drag": return try drag(params)
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
