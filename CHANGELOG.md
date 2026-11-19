# Changelog

## Unreleased

- macOS: nothing is blocked any more. Terminals, System Settings, password
  managers, messaging and scripting apps are ask first: they always show the
  dialog, even under `allow-all`, and `glovebox allow` skips it. An
  unanswered dialog denies after two minutes. `askFirst` in the config adds
  apps. The one refused target is the helper's own dialogs.
- macOS: menus (`app.menus`, `app.menu`), menu shortcuts that work on a
  background app, `app.select` and `app.contextMenu` (open and pick in one
  step, so the user's typing never lands in an open menu), window controls
  (`app.window(i).move/resize/minimize/restore/zoom/fullScreen/close`),
  `app.quit/hide/unhide`, `gb.quitLaunched()`, hover, press and hold, middle
  click, trackpad pinch and rotate, `app.paste`, `app.choosePath` for open
  and save panels, `app.dropFiles`, `app.open`, and window-opened notices in
  reads. Fields are named by their labels.
- macOS: Chrome, Edge and Electron apps (VS Code, Slack...) now show their web
  content and editors in reads.
- macOS: the rest of the Mac. `gb.windows`, `gb.screenshot` and `gb.ocr` for
  the whole screen, `gb.menuExtras`/`gb.menuExtra` for the menu bar and
  Control Center, `gb.notifications`, system-wide `gb.pressKey`/`gb.typeText`
  and `gb.spotlight`, `gb.clipboard`, `gb.open`, `gb.displays`. Each asks
  first under its own `macos:` key.
- macOS: a background click on a window that is not key makes it key first,
  so the click lands.
- `glovebox smoke --macos`: 51 checks on a new test app, Glovebox Fixture,
  including a SwiftUI window, full screen and Spaces.
- macOS: system-level keys press and release their modifiers, so a shortcut
  can no longer leave Ctrl or Cmd held down system-wide; typed text never
  inherits held modifiers. Ctrl+arrow (Spaces) works.
- macOS: a window on a Space that is not showing fails reads with
  `other_space`; `app.activate()` goes there. `app.swipe` sends a two-finger
  trackpad scroll.
- `glovebox signing --trust`: asks for the keychain password once, so helper
  rebuilds stop asking.
- Android (experimental): `gb.device()` drives Android phones and emulators
  over ADB with a shell-privileged server. Apps run on a hidden screen, so
  the user's screen is not touched (API 34+); the phone's own screen is the
  fallback. Reads, taps, keys, typing any characters (no clipboard), scroll,
  swipe, long press, pinch and rotate, web content inside apps, one-time-code
  fields, `phone.open`, `app.open`, `phone.notifications`, and `phone.push`.
  Several sessions can share one phone. Ask-first approval covers Android
  apps, notifications, and pushed files. `glovebox doctor` and
  `glovebox smoke --android` check a device. Tested on emulators API 34 to 37
  and a Galaxy S24.
- `app.find`, `app.nodes`, and `app.text`: silent lookups that print nothing.
- `app.scrollTo(query)` and `app.expect(query)` for checks inside a script.
- `app.ocr()` reads text from a screen the tree cannot describe (macOS Vision).
- Large trees print as an outline that folds deep branches.
- Reads hide "show menu" actions and ids that name nothing.

## 0.3.2 (2026-11-03)

- List glovebox in the official MCP Registry. No change to behavior.

## 0.3.1 (2026-11-03)

- Fix: the drawn agent cursor now glides to every action. Its animation never
  moved the window, so it froze after the first action, and launching the helper
  hidden could keep it from appearing at all.
- Add a demo to the README.

## 0.3.0 (2026-11-03)

- First npm release, as `@vashp2029/glovebox`. CI runs the unit tests on every
  push and pull request.
- A clearer error when the helper was built from different source than the
  running glovebox, including what a rebuild does to macOS permissions.
- Fix: a read with `{emit: false}` no longer becomes the diff baseline, so
  the next printed read shows every change since the last printed one.
  Before, changes made before a silent read never appeared in a diff.
- `app.waitForChange()` and `app.settle()`: wait silently for a late update
  instead of polling from the script.
- Fix: the default window ignores tooltips, popovers, and Finder's rename
  field, so reads and screenshots no longer land on a 50-pixel window.
- Fix: diffs survive a window title change, a `{frames: true}` read, and
  elements that only moved deeper, instead of reprinting the whole tree.
- Fix: a read that is also returned or passed to `console.log` prints once.
- Fix: a raw click on an open menu's item works in the background, and any
  click on a menu item waits for the menu to close before the next action.
- Fix: keys reach Finder's rename field in the background, and `setValue` on a
  Finder file name fails with the rename steps instead of only relabeling.
- Fix: horizontal background scroll sets the point and fixed-point deltas
  some apps read.
- `settleMs` is in the documented defaults; `npm test` works on Node 22;
  the npm package includes `SECURITY.md` and `CHANGELOG.md`.

## 0.2.0 (2026-10-27)

- Background input by default: keys, typing, clicks, drags, and scrolls reach
  an app without bringing it forward or moving the real cursor (private
  SkyLight event records and per-process events, with a foreground fallback).
- A drawn agent cursor shows where each action lands; Hide Agent Cursor in
  the menu-bar item, or `"cursor": false` in the config.
- `glovebox signing --create`: a local signing certificate so macOS keeps the
  helper's permissions across rebuilds.
- `glovebox setup` asks for one permission at a time and waits for each.
- `glovebox smoke --full` checks background click, drag, and scroll in TextEdit
  and that the frontmost app never changed.
- `input`, `foregroundApps`, and `cursor` config keys; `app.lastRoute`.

### Upgrading

If the helper was signed ad hoc (you did not run `glovebox signing --create`),
rebuilding it makes macOS treat it as a new app. Reset the old grants and run
setup again:

```bash
for s in Accessibility ScreenCapture ListenEvent; do
  tccutil reset $s io.github.vpatel9202.glovebox.helper
done
glovebox setup
```

## 0.1.0 (2026-10-27)

First release.

- One persistent JavaScript session, reachable over MCP (`js`, `js_reset`) and
  the CLI (`glovebox run`, backed by a daemon).
- macOS backend: Glovebox Helper.app (Swift, public APIs) with accessibility
  trees, stable element indices, diffs, window screenshots, keyboard and mouse
  input, and background key delivery.
- Image-pixel coordinates shared by screenshots, frames, and clicks.
- Per-app approval dialogs enforced in the helper, blocked-by-default apps,
  Escape to stop, and an action log.
