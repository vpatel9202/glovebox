# Changelog

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
