---
name: glovebox
description: >-
  Control desktop apps (click, type, read the screen) through glovebox's
  persistent JavaScript session, exposed as the MCP tool `js` (often
  `glovebox__js` or `mcp__glovebox__js`) or the `glovebox run` CLI. Use for GUI
  work that has no API, CLI, or file-based path. Prefer a programmatic path
  when one can finish the task.
---

# glovebox

Drive the GUI through one persistent JavaScript session. Each `js` call should
be a whole step: several actions, then one read. Bindings persist between
calls until `js_reset`.

```js
const calc = await gb.getApp("Calculator");
await calc.pressKey("Escape");
await calc.typeText("12*3=");
await calc.getAXState();
```

The loop:

1. Bind the app once: `const app = await gb.getApp("Name")`. Reuse `app` in
   later calls. Define helpers in the session when you repeat yourself.
2. Read with `app.getAXState()`. The first read is the full tree; later reads
   show only changes. Lines look like `14 button "7" id=Seven`; the leading
   number is the element index.
3. Act by index when the tree has the element: `app.click(14)`,
   `app.setValue(9, "text")`. Then read again in the same call.
4. Take `app.getScreenshot()` only when the tree cannot tell you what you need
   (remote desktops such as Citrix, canvases, visual layout). Click with
   `[x, y]` pixels from that screenshot; they are the same pixels the image
   shows. `getAXState({frames: true})` gives element boxes in that same space.

Keys use xdotool syntax: `Return`, `Tab`, `Escape`, `ctrl+a`, `shift+Tab`,
`super+c` (Cmd on macOS). `typeText` treats `\n` as Return. Input stays in
the background: the app is not brought forward and the user's cursor does
not move. If an app ignores it, pass `{foreground: true}` to that action.

`help()` prints the full API; `help("scroll")` prints one part.

Approval: the user may see a dialog the first time you touch an app. If a
call fails with "denied" or "blocked", tell the user what you need and why;
do not look for a way around it. If a result starts with "Stopped:" (the user
switched away or pressed Escape), stop GUI work and ask before continuing. Call `js_reset` when the session is
stuck or a binding should be dropped.
