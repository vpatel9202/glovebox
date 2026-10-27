# Security

glovebox lets an AI agent click, type, and read the screen in apps on your
computer. Treat it with the same care as giving someone remote control.

## What protects you

- **Per-app approval.** By default, the first action a session takes in an app
  shows a dialog: Allow for This Session, Always Allow, or Deny. The check runs
  inside Glovebox Helper, the process that holds the macOS permissions, so
  scripts cannot skip it.
- **Blocked apps.** Terminals, password managers, Keychain Access, System
  Settings, Script Editor, and Automator are refused unless you run
  `glovebox allow <bundle id>` yourself. An agent with terminal access could
  otherwise use the GUI to run commands its sandbox would not allow.
- **Taking over stops a script.** If you switch to another app while a
  script is driving one, the script stops instead of taking focus back. With
  the optional Input Monitoring permission, pressing Escape also stops it
  (glovebox marks its own key events, so its own Escapes do not count). The
  menu-bar item shown while an agent is connected has Stop Running Scripts.
- **Action log.** `~/.glovebox/actions.log` records each action with the
  agent's name, the app, and the target. Typed text is recorded as a length
  only, unless you set `"log": {"text": true}`.
- **Local only.** Nothing is sent over the network. The helper listens on a
  Unix socket that only your user can open.

## What does not

- Code running as your user can edit `~/.glovebox/config.json` and approve
  apps for itself, or talk to the helper directly. glovebox does not defend
  against malware already running as you.
- `approval: "allow-all"` removes the dialogs for every non-blocked app.
  Use it only when you trust every agent you attach.
- An approved app is approved for everything in it. Allowing a browser lets
  the agent use every site you are signed in to.
- macOS ties privacy grants to the helper's ad-hoc signature, which is
  created on your machine. Rebuilding the helper means granting again.

## Reporting a vulnerability

Please open a private security advisory at
https://github.com/vpatel9202/glovebox/security/advisories/new rather than a
public issue.
