# Changelog

## Unreleased

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
