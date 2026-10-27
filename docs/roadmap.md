# Roadmap

What works today is macOS (14+, tested on 27). Everything below is planned,
not shipped. Nothing here has been tested unless it says so.

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

- Reliable background keys and mouse input, detecting per app whether
  per-process events are accepted, so only apps that need it come to the front.
- A prebuilt, Developer ID signed and notarized helper in each release, so
  installs need no compiler and grants survive upgrades.
- MCP elicitation as an alternative to the native approval dialog when the
  client supports it.
- `app.menu(["File", "Export…"])` through the menu bar tree.
- Optional settle detection (wait until the tree stops changing) instead of
  a fixed delay after actions.
