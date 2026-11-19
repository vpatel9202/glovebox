# Security

glovebox lets an AI agent click, type, and read the screen in apps on your
computer. Treat it with the same care as giving someone remote control.

## What protects you

- **Per-app approval.** By default, the first action a session takes in an app
  shows a dialog: Allow for This Session, Always Allow, or Deny. The check runs
  inside Glovebox Helper, the process that holds the macOS permissions, so
  scripts cannot skip it.
- **Ask-first apps.** Nothing is blocked outright: you decide. Apps that can
  run commands, hold secrets, send messages, or change system settings always
  show the dialog, even under `approval: "allow-all"`, unless you add them
  with `glovebox allow` (see the list below). The dialog says why. An agent
  with terminal access could use the GUI to run commands its sandbox would
  not allow, so approve a terminal only when you mean to. Surfaces that are
  not one app (the whole screen, the clipboard, notifications, the Dock and
  menu bar, opening files) are ask first too. An app on the `deny` list is
  refused even if it is also allowed.
- **System-wide keys ask twice.** `gb.pressKey` and `gb.typeText` go to
  whatever app is in front, so they need `macos:system` and that app's
  approval too.
- **Unanswered dialogs deny.** A dialog nobody answers denies after two
  minutes, so an unattended agent cannot wait on it forever.
- **Taking over stops a script.** If a script had to bring an app forward and
  you switch away, the script stops instead of taking focus back. A script
  working in the background keeps running while you use other apps, so switching
  apps does not stop it. With the optional Input Monitoring permission, pressing
  Escape stops any script (glovebox marks its own key events, so its own Escapes
  do not count).
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

## Ask-first apps

This is the full default list, from `askFirstByDefault` in
`native/macos/GloveboxHelper.swift`. Bundle ids are matched case-insensitively.
`glovebox allow <name or bundle id>` skips the dialog for one; `askFirst` in
`config.json` adds more.

| Kind | Bundle ids |
|---|---|
| Terminals | `com.apple.terminal`, `com.googlecode.iterm2`, `com.mitchellh.ghostty`, `dev.warp.warp-stable`, `com.github.wez.wezterm`, `org.alacritty`, `net.kovidgoyal.kitty`, `org.tabby`, `co.zeit.hyper`, `com.cmuxterm.app`, `com.termius.mac` |
| Scripting | `com.apple.scripteditor2`, `com.apple.automator`, `com.apple.shortcuts` |
| System and security prompts | `com.apple.systempreferences`, `com.apple.installer`, `com.apple.securityagent`, `com.apple.coreservices.uiagent`, `com.apple.usernotificationcenter`, `com.apple.appstore` |
| Password managers | `com.apple.keychainaccess`, `com.apple.passwords`, `com.1password.1password`, `com.agilebits.onepassword7`, `com.bitwarden.desktop`, `com.lastpass.lastpassmacdesktop` |
| Messages and calls | `com.apple.mobilesms`, `com.apple.facetime`, `com.apple.mail` |
| Not one app | `macos:screen`, `macos:clipboard`, `macos:notifications`, `macos:system`, `macos:files` |

Order of checks for each app: `deny`, then `allow`, then this list (ask), then
the `approval` mode.

One target is refused: Glovebox Helper itself
(`io.github.vpatel9202.glovebox.helper`). Its windows are the approval
dialogs, and an agent that could press them would approve itself.

## What does not

- Code running as your user can edit `~/.glovebox/config.json` and approve
  apps for itself, or talk to the helper directly. glovebox does not defend
  against malware already running as you.
- `approval: "allow-all"` removes the dialogs for every app that is not ask
  first.
  Use it only when you trust every agent you attach.
- An approved app is approved for everything in it. Allowing a browser lets
  the agent use every site you are signed in to.
- Background input uses two private macOS (SkyLight) functions, the same
  approach as yabai, cua-driver, and Peekaboo. They are looked up at runtime;
  if a macOS update removes them, glovebox falls back to bringing the app
  forward. They do not bypass any permission: the helper still needs
  Accessibility.
- Scripts have no `require`, `fs`, or dynamic `import`, and see an empty
  `process.env`. That limits a script to the `gb` API and approved apps, but an
  approved app can still reach whatever that app can reach. Finder is not on the
  ask-first list, and approving it lets an agent read or change any file Finder
  can.
- glovebox does not screen app or page content for prompt injection. Text an
  agent reads in an approved app can try to steer it.
- The optional "glovebox local signing" certificate lives in your login
  keychain and signs only the helper you build. Without it, macOS ties
  privacy grants to an ad-hoc signature and a rebuild means granting again.

## Android devices

- **ADB is the grant.** The glovebox server on a phone runs with shell
  privileges over ADB. Anything else on the Mac that can run `adb` (an agent
  with a terminal, for one) can do the same without glovebox, so approve
  terminal access with that in mind.
- **Ask first, never forbid.** glovebox asks before acting in apps and screens
  that can move money, read messages or one-time codes, or change the phone's
  settings, even under `allow-all`, and it asks again when one of them shows
  inside an app you already approved. It does not block an action you approve.
- **Notifications.** `phone.notifications()` reads the whole shade, which
  can show messages and one-time codes from any app, so it asks first even
  under `allow-all` (approval key `android:notifications`), and each read
  is logged.
- **Files.** Scripts cannot read files, but `phone.push(path)` copies a file
  from this computer to the phone, so each file asks first, naming the path
  and size, and each copy is logged.
- **Locked phones.** The server can reach apps behind the lock screen (a
  hidden screen runs even while the phone is locked), so acting on, or
  reading a hidden screen of, a phone locked with a PIN, pattern, password or
  biometric asks once per session. A swipe-only lock screen guards nothing
  and does not ask.
- **Hidden screens.** On Android 14 and later the agent's apps run on private
  displays that never take focus from the phone's screen and show no
  keyboard; input and typing are addressed to that display only and fail
  rather than fall back to the user's screen. glovebox will not open an app
  there that the user is running, since a second copy can close or take over
  theirs. The displays and their apps are destroyed when the session ends or
  the server dies, and never appear in the phone's recent apps. Hidden-screen work
  wakes the phone and keeps it awake until a minute after the last action.
- **No network socket.** The server on the phone talks only over the `adb
  shell` that started it. On the computer, a per-phone broker process owns
  that shell and relays for every glovebox session through a Unix socket in
  `~/.glovebox` that only your user can open; it exits, and the server with
  it, ten seconds after the last session ends.
- **Personal phones.** Developer options and USB debugging are themselves a
  weaker security setting. Use the emulator, or a phone set aside for agents,
  when you can.

## Reporting a vulnerability

Please open a private security advisory at
https://github.com/vpatel9202/glovebox/security/advisories/new rather than a
public issue.
