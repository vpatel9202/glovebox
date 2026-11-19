# Changelog

## 0.6.0 (2026-11-19)

- `nostrings init`: one command from install to a working agent. On a Mac it
  offers the signing certificate, builds the helper and asks for each
  permission; it lists Android devices; it finds Claude Code, Codex CLI,
  Grok CLI, Cursor, Gemini CLI and OpenCode, shows the change for each and
  makes it when you say yes (idempotent, with a backup); then it offers a
  short real test. `--yes` accepts everything, `--android-only` skips the Mac.
- Saved scripts: `ui.scripts.save(name, code, description)`,
  `ui.scripts.list()`, `ui.scripts.run(name, args)` and `ui.scripts.source`.
  From a shell, `nostrings scripts` lists them and `nostrings script <name>
  key=value` reruns one with no model. Scripts live in `~/.nostrings/scripts`
  and never run unless called. `examples/` ships five, two of them using the
  Mac and the phone in one script (`nostrings scripts --examples`).
- `nostrings conformance` checks a backend against the protocol: a new port
  run as a command, the Android server, or the macOS helper.
  `test/fake-backend.mjs` is the smallest backend that passes.
- macOS: setup asks for one permission at a time. It used to fire the
  Accessibility and Screen Recording prompts together, and macOS dropped one.
  Input Monitoring is asked only with `setup --input-monitoring`, so no
  unanswered prompt sits in front of the first test. The helper's
  `permissions` request takes `ask` (one permission) in place of `prompt`.
- Docs: a new README, a porting guide in CONTRIBUTING, the axTree node
  fields in the protocol doc. Internal plans moved to `docs/internal` and
  out of the npm package.

## 0.5.1 (2026-11-19)

- Docs: the README, package description, MCP Registry entry, skill and MCP
  server instructions now say what shipped in 0.4.0: Android works
  (experimental) alongside macOS. The roadmap no longer lists shipped work as
  planned. `docs/agents.md` installs from npm.

## 0.5.0 (2026-11-19)

glovebox is now **nostrings**. Nothing else changed in this release.

- npm package `nostrings` (was `@vashp2029/glovebox`), command `nostrings`,
  MCP Registry name `io.github.vpatel9202/nostrings`, repo
  `vpatel9202/nostrings` (the old URLs redirect).
- In scripts, the global is `ui` (was `gb`): `ui.getApp("Calculator")`,
  `ui.device()`. `cua` still works.
- The helper is **Nostrings Helper.app** (`io.github.vpatel9202.nostrings.helper`),
  the state folder is `~/.nostrings`, and environment variables start with
  `NOSTRINGS_`. The Android server and test apps are `com.nostrings.*`.

### Upgrading from glovebox

macOS sees the renamed helper as a new app, so grant it again:

```bash
npm uninstall -g @vashp2029/glovebox
npm install -g nostrings
mkdir -p ~/.nostrings && cp ~/.glovebox/config.json ~/.nostrings/   # keeps your allow list
nostrings signing --create   # optional, as before
nostrings setup
claude mcp remove glovebox --scope user
claude mcp add --scope user nostrings -- nostrings mcp
```

Then delete `~/.glovebox` and the old grants:

```bash
for s in Accessibility ScreenCapture ListenEvent; do
  tccutil reset $s io.github.vpatel9202.glovebox.helper
done
```

On Android, `adb uninstall com.glovebox.fixture` and `com.glovebox.fixture2`
if you ran the smoke test.

## 0.4.1 (2026-11-19)

- Android: the npm package now includes the Android server and the two test
  apps, built in the release workflow from the tagged source with a pinned
  SDK. Android needs only `adb`; `npm run build:android` is for git checkouts.

## 0.4.0 (2026-11-19)

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
