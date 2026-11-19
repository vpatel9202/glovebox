# macOS plan

A plan to take the macOS backend from "works on AppKit apps" to "an agent can
do anything on the Mac that the user could". Written 2026-11-19. Rows are
marked done only when a check has run on a real Mac.

## Goal

**Who it is for.** One user and their agent, on the user's own Mac. The agent
should be able to do anything the user could do with a keyboard, a pointer
and their eyes. The agent asks the user before sensitive steps; glovebox asks
before sensitive apps and surfaces; **glovebox itself forbids nothing**.
Decided 2026-11-19 (same model as Android, decided 2026-11-18).

**Done means:**

1. Every row in the [capability matrix](#capability-matrix) has a check that
   runs on a real Mac and passes, or names an OS limit that stops a human's
   synthetic stand-in too (see [OS limits](#os-limits)).
2. No row fails because glovebox refused. Sensitive apps ask; the user's
   answer decides.
3. The properties in [design.md](design.md) "The bar" still hold: one call per
   step, diffed text reads, background by default, image-pixel clicks.

## Audit, 2026-11-19

Run before writing this plan, on macOS 27, helper rebuilt from `android/phase-1`.

| App | Kind | Tree read | Notes |
|---|---|---|---|
| Calculator, TextEdit | AppKit | good | `smoke --full` passes: background keys, click, drag, scroll |
| Safari | WebKit | good | chrome and page content |
| Notes | AppKit | good | |
| Pages | AppKit | good (127 nodes) | |
| System Settings | SwiftUI | good (170 nodes) | read only after `glovebox allow`; blocked by default |
| Reminders | SwiftUI | thin (16 nodes) | to check with a list open |
| Terminal | AppKit | one text area | blocked by default |
| Google Chrome | Chromium | **no web content** (73 nodes, all browser chrome) | needs `AXManualAccessibility` / `AXEnhancedUserInterface` |
| VS Code Insiders | Electron | **empty** (12 nodes: window buttons only) | same |

Gaps from the audit, the roadmap and the open bugs (gb-1iz.14, gb-d1f,
gb-1iz.12), in the order they are built:

## Status, 2026-11-19

M0 through M7 are built. `glovebox smoke --macos` passes 37 of 37 checks on
the fixture app. Rows marked done below ran on this Mac. Still open: the
Dock as an app handle, Spotlight and global keys tried by hand, other displays
and Spaces (M8), and the OS limits list.

## Phases

### M0. Nothing is blocked

- `blockedByDefault` (terminals, System Settings, Keychain, password managers,
  Script Editor) becomes **ask first**: these prompt even under `allow-all`;
  `glovebox allow` skips the prompt. The error code `blocked` goes away.
- The approval dialog gives up after 120 s (Deny), as the Android prompt does,
  so an unattended run cannot hang on it.
- System surfaces that are not one app get approval keys of their own, all
  ask first: `macos:screen` (whole-screen capture), `macos:clipboard`,
  `macos:notifications`, `macos:system` (Dock, menu bar, Spotlight, Control
  Center, global keys), `macos:files` (opening or dropping files).
- Check: the fixture app, listed as ask first by a test-only config key,
  prompts under `allow-all`; Terminal reads after `allow`.

### M1. A macOS fixture app

A single-file SwiftUI + AppKit app (`native/macos/fixture`) built with
`swiftc`, like the Android fixture. One window per area: menus and popups,
sheets and alerts, open and save panels, labeled form fields, tables, a
canvas that logs pointer events (hover, press-and-hold, middle click,
gestures), a web view, drag and drop targets, notifications it posts itself.
It writes what it received to a log the checks read, so checks need no model.

Check: `glovebox smoke --macos` drives every area and prints PASS/FAIL per row.

### M2. Chromium and Electron

- On first read of a Chromium or Electron app, set `AXManualAccessibility`
  (Electron) and `AXEnhancedUserInterface` (Chromium) on the app element, then
  wait for the web tree to appear. Map web roles (heading, link, web area) as
  Safari's are.
- Check background keys and typing in Chrome and VS Code (roadmap item: key
  events may need an authentication message on macOS 15+).
- Check: Chrome reads a page's headings and links; VS Code reads its editor
  and command palette; typing reaches both in the background.

### M3. Menus and pop-ups

- `app.menu(["File", "Export…"])` presses a menu bar item through
  accessibility, in the background; `app.menus()` lists the menu bar.
- `app.pressKey("super+s")` in the background first looks for a menu item
  with that shortcut and presses it (menu shortcuts are not delivered to
  background apps as keys).
- `app.select(popup, item)` opens a pop-up button and picks an item in one
  helper call, so the user's keystrokes never reach the open menu (gb-1iz.14).
- Context menus: `rightClick` then pick, same treatment.

### M4. Windows, apps, dialogs

- `app.window(i)` gains `move`, `resize`, `minimize`, `restore`, `zoom`,
  `fullScreen`, `close`, `raise`. `app.quit()`, `app.hide()`, `app.unhide()`.
- Reads say when a window, sheet, alert or panel opened or closed since the
  last read (one notice line), and name fields by their `AXTitleUIElement`
  label.
- Open and save panels: `app.choosePath(path)` types a path into the panel
  (Cmd+Shift+G) and confirms.

### M5. Pointer and gestures

- `app.hover(target)` moves the agent's pointer (background: a mouse-moved
  event to the window) so tooltips and hover menus show.
- `app.press(target, {ms})` holds the button down (long press, force-click
  substitute); `click(..., {button: "middle"})`.
- `app.pinch` and `app.rotate`, as on Android, through trackpad gesture
  events; `app.swipe` for two-finger swipes (back and forward in browsers).

### M6. System surfaces (`gb.system`)

- `gb.screenshot({display})` and `gb.ocr()` capture a whole display;
  `gb.windows()` lists every window on screen with its owner, so an agent can
  find an unexpected dialog (permission prompts, "downloaded from the
  internet") and `getApp` its owner.
- `gb.menuExtras()` lists menu bar extras (Wi-Fi, battery, third-party icons)
  and `gb.menuExtra(name)` opens one; Control Center is reachable the same way.
- `gb.notifications()` reads Notification Center; actions on a notification go
  through its element index.
- `gb.pressKey(keys)` sends a global key (Spotlight, Mission Control,
  screenshots) on the foreground route; `gb.spotlight(query)` opens an app or
  file by name.
- The Dock is an app handle: `gb.getApp("Dock")`.

### M7. Data in and out

- `gb.clipboard.read()` and `gb.clipboard.write(text)` (ask first);
  `app.paste(text)` pastes and restores the user's clipboard, for long text and
  scripts the key map cannot type.
- `gb.open(pathOrUrl, {app, background})` opens files and links;
  `app.open(path)` opens a file in a given app.
- `app.dropFiles(target, paths)` drops files on a window (foreground route).

### M8. Spaces, displays, minimized windows

- Reads and actions on windows on another display; a minimized window or one
  on another Space is reported as such, and `restore()` brings it back.

### M9. Prove it

- `glovebox smoke --macos` covers every row of the matrix that the fixture can
  show; real apps cover the rest (Safari, Chrome, VS Code, Finder, Notes,
  System Settings read only).
- Docs: `api.md`, `SECURITY.md`, `design.md`, `testing.md`, changelog.

## Capability matrix

| # | A human can... | glovebox call | Phase |
|---|---|---|---|
| 1 | Read and act in AppKit apps | `getAXState`, `click`, `typeText` | done |
| 2 | ... in SwiftUI apps | same | partial: AppKit fixture and System Settings reads; no SwiftUI-only app driven yet |
| 3 | ... in Safari web pages | same | done |
| 4 | ... in Chrome web pages | same | done 2026-11-19 |
| 5 | ... in Electron apps | same | partial: VS Code reads in full; background shortcuts go as keys (gb-c3n.12) |
| 6 | Use any app, terminals and System Settings included | approval asks | partial: nothing is blocked; a dialog appears for an unlisted app (Chess); ask-first under allow-all not yet run |
| 7 | Use the menu bar, in the background | `app.menu` | done 2026-11-19 |
| 8 | Use menu shortcuts in the background | `pressKey("super+s")` | done 2026-11-19 |
| 9 | Pick from a pop-up without stealing keys | `app.select` | done 2026-11-19 |
| 10 | Use context menus | `rightClick` + pick | done 2026-11-19 |
| 11 | Move, resize, minimize, close, full-screen windows | `app.window(i).*` | done 2026-11-19 |
| 12 | Quit, hide apps | `app.quit`, `app.hide` | done 2026-11-19 |
| 13 | Notice sheets, alerts and new windows | read notice | done 2026-11-19 |
| 14 | Pick a file in open/save panels | `app.choosePath` | done 2026-11-19 |
| 15 | Hover for tooltips and hover menus | `app.hover` | done 2026-11-19 |
| 16 | Press and hold, middle click | `app.press`, `button: "middle"` | done 2026-11-19 |
| 17 | Pinch, rotate, swipe on a trackpad | `app.pinch`, `rotate`, `swipe` | done for pinch and rotate; two-finger swipe not built |
| 18 | See the whole screen | `gb.screenshot`, `gb.ocr`, `gb.windows` | done 2026-11-19 |
| 19 | Use menu bar extras and Control Center | `gb.menuExtras` | done 2026-11-19 |
| 20 | Read notifications | `gb.notifications` | done 2026-11-19 |
| 21 | Spotlight, Mission Control, global shortcuts | `gb.pressKey`, `gb.spotlight` | partial: Cmd+Space opens Spotlight; typing into it untested with nobody at the Mac |
| 22 | Use the Dock | `gb.getApp("Dock")` | done 2026-11-19 (read) |
| 23 | Copy and paste | `gb.clipboard`, `app.paste` | done 2026-11-19 |
| 24 | Open files and links | `gb.open`, `app.open` | done 2026-11-19 |
| 25 | Drag files into apps | `app.dropFiles` | done 2026-11-19 |
| 26 | Work on other displays and Spaces | reads and `restore` | M8 |
| 27 | Type any text (accents, emoji, CJK) | `typeText`, `paste` | done 2026-11-19 |
| 28 | Respond to system dialogs (permission prompts) | `gb.windows` + `getApp` | M6 |
| 29 | Read canvases and remote desktops | `ocr`, screenshots | done |

## OS limits

Things a human can do that synthetic input may not reach. Each is confirmed by
trying it, and documented with what was seen:

- Password and Touch ID prompts from SecurityAgent (secure input).
- The lock screen and login window.
- Fields under Secure Event Input (password fields in other apps).
- Protected content (DRM video) captures black.
