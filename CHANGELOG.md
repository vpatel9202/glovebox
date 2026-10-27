# Changelog

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
