# Roadmap

What works today is macOS (14+, tested on 27). Everything below is planned,
not shipped. Nothing here has been tested unless it says so.

## Credibility and distribution

Ordered by expected impact. These come before new platforms.

1. **Benchmark harness (`bench/`).** About five fixed tasks: Calculator
   arithmetic, editing a TextEdit document, a Finder rename, toggling a
   setting in a non-blocked app, and filling a form in a native app. Compare
   glovebox, Anthropic computer use (screenshot-first), and one per-action AX
   MCP server (open-computer-use or agent-desktop). Measure model round trips,
   input tokens including image tokens, wall-clock time, and success over N
   runs per task, plus the token cost of a diff versus a full tree. Done when
   the raw results and the harness are in the repo and one chart is in the README.
2. **npm publish and a prebuilt helper.** Publish `@vpatel9202/glovebox` to
   npm and ship a Developer ID signed, notarized helper in each release.
   Done when `npx -y @vpatel9202/glovebox setup` works on a Mac without the
   Xcode command line tools and grants survive an upgrade.
3. **Demo media, then launch.** Record the GIF from the shot list in the
   README comment, and a short video. Launch (Show HN, X, Codex computer-use
   threads) only after one or two of these exist. Done when the GIF is at the
   top of the README.
4. **Exercise every documented client.** Run the Codex, Grok CLI, OpenCode,
   Gemini CLI, and Cursor configs end to end, with a short clip for each.
   Done when `docs/agents.md` and the README's "Works with" line list each
   client as verified or say what failed.
5. **CI.** After the `test` script fix in item 7, GitHub Actions running
   `npm test` on ubuntu and macos runners.
   Done when it runs on every push and PR, and a CI badge is in the README.
6. **Listings.** The official MCP registry, the Claude Code plugin
   marketplace, and skills.sh (for `skills/glovebox/SKILL.md`). Done when each
   listing is live and links back to the repo.
7. **Packaging and docs fixes found in review.** `files` in `package.json`
   omits `SECURITY.md` and `CHANGELOG.md`; `settleMs` is read in
   `src/kernel.mjs` but missing from `DEFAULTS` in `src/config.mjs`; a comment
   in `native/macos/GloveboxHelper.swift` says the Escape monitor needs only
   Accessibility, but it needs Input Monitoring; the `test` script
   (`node --test test/`) fails on Node 22 because a bare directory is no
   longer accepted (`node --test test/unit.test.mjs` passes, 7 of 7). Done
   when all four are fixed.

After these, Windows is the highest-priority platform: cross-platform support
is what lcu, agent-desktop, open-computer-use, and cua have over glovebox, and
Windows-MCP has about 10.5k stars.

## Windows backend

Plan: a PowerShell helper (no install beyond Windows itself) that speaks the
backend protocol over a named pipe.

- Tree and actions: UI Automation through `System.Windows.Automation`
  (`InvokePattern` for presses, `ValuePattern` for `setValue`,
  `TextPattern`/`SelectionItemPattern` where present). Stable indices from
  `RuntimeId`.
- Input: `SendInput` via a small `Add-Type` C# shim; `PostMessage` for
  background keys where the target accepts it.
- Screenshots: `PrintWindow` with `PW_RENDERFULLCONTENT`, resized to the
  requested size.
- Approval dialog: a WinForms message box from the helper.

## Linux backend

Plan: a Python helper.

- Tree and actions: AT-SPI over D-Bus (`pyatspi` or `gi.repository.Atspi`).
- Input: XTest on X11. Wayland compositors restrict synthetic input and
  screen capture; support will be per compositor (portal-based capture,
  `ydotool` or the RemoteDesktop portal for input), and some will not work.
- Screenshots: X11 `XGetImage` on the window; the ScreenCast portal on Wayland.
- Approval dialog: `zenity` or `kdialog`, else allowlist mode only.

## macOS improvements

- Chromium/Electron keyboard input on macOS 15+ may need an
  `SLSEventAuthenticationMessage` attached to each key event; not done yet.
- Menu shortcuts (⌘S and friends) in background apps: press the menu item
  through accessibility instead of sending the key.
- Detect apps that ignore background input and fall back automatically,
  instead of relying on `foregroundApps` in the config.
- Test matrix beyond AppKit: Safari/WebKit, Electron apps, SwiftUI-only apps,
  Citrix Viewer.
- MCP elicitation as an alternative to the native approval dialog when the
  client supports it.
- `app.menu(["File", "Export…"])` through the menu bar tree.
- Optional settle detection (wait until the tree stops changing) instead of
  a fixed delay after actions.
