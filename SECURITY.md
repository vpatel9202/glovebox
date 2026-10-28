# Security

glovebox lets an AI agent click, type, and read the screen in apps on your
computer. Treat it with the same care as giving someone remote control.

## What protects you

- **Per-app approval.** By default, the first action a session takes in an app
  shows a dialog: Allow for This Session, Always Allow, or Deny. The check runs
  inside Glovebox Helper, the process that holds the macOS permissions, so
  scripts cannot skip it.
- **Blocked apps.** Apps that can run commands or hold secrets are refused,
  and never offered in a dialog, unless you add them with `glovebox allow`
  (see the list below). An agent with terminal access could otherwise use the
  GUI to run commands its sandbox would not allow. An app on the `deny` list
  is refused even if it is also allowed.
- **Taking over stops a script.** If you switch to another app while a
  script is driving one, the script stops instead of taking focus back. With
  the optional Input Monitoring permission, pressing Escape also stops it
  (glovebox marks its own key events, so its own Escapes do not count).
- **Menu-bar item.** While an agent is connected, Glovebox Helper shows a
  menu-bar item listing each session and its approved apps. Stop Running
  Scripts stops every running script. Revoke Session Approvals clears the
  per-session approvals, so apps must be approved again; it does not touch
  `allow` entries in `config.json`. Quit Glovebox Helper exits the helper; the
  next agent call starts it again.
- **Action log.** `~/.glovebox/actions.log` has one JSON object per action:
  `ts`, `client` (the agent's name), `step` (the call's title, when given),
  then the action's own fields (`app`, `action`, and for example `target`,
  `keys`, or `length`). Typed text is recorded as a length only, unless you
  set `"log": {"text": true}`.
- **Local only.** Nothing is sent over the network. The helper listens on a
  Unix socket that only your user can open.

## Blocked apps

This is the full default list, from `blockedByDefault` in
`native/macos/GloveboxHelper.swift`. Bundle ids are matched case-insensitively.
`glovebox allow <name or bundle id>` unlocks one.

| Kind | Bundle ids |
|---|---|
| Terminals | `com.apple.terminal`, `com.googlecode.iterm2`, `com.mitchellh.ghostty`, `dev.warp.warp-stable`, `com.github.wez.wezterm`, `org.alacritty`, `net.kovidgoyal.kitty`, `org.tabby`, `co.zeit.hyper` |
| System settings | `com.apple.systempreferences` |
| Password managers | `com.apple.keychainaccess`, `com.apple.passwords`, `com.1password.1password`, `com.agilebits.onepassword7`, `com.bitwarden.desktop`, `com.lastpass.lastpassmacdesktop` |
| Scripting | `com.apple.scripteditor2`, `com.apple.automator` |
| Glovebox itself | `io.github.vpatel9202.glovebox.helper` |

Order of checks for each app: `deny`, then `allow`, then this list, then the
`approval` mode.

## What does not

- Code running as your user can edit `~/.glovebox/config.json` and approve
  apps for itself, or talk to the helper directly. glovebox does not defend
  against malware already running as you.
- `approval: "allow-all"` removes the dialogs for every non-blocked app.
  Use it only when you trust every agent you attach.
- An approved app is approved for everything in it. Allowing a browser lets
  the agent use every site you are signed in to.
- Background input uses private macOS (SkyLight) functions, the same ones
  Codex and Claude desktop computer use rely on. They are looked up at
  runtime; if a macOS update removes them, glovebox falls back to bringing the
  app forward. They do not bypass any permission: the helper still needs
  Accessibility.
- The optional "glovebox local signing" certificate lives in your login
  keychain and signs only the helper you build. Without it, macOS ties
  privacy grants to an ad-hoc signature and a rebuild means granting again.

## Reporting a vulnerability

Please open a private security advisory at
https://github.com/vpatel9202/glovebox/security/advisories/new rather than a
public issue.
