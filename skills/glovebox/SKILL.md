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
   `app.setValue(9, "text")`. Then read again in the same call. When you
   already know what you want, look it up silently in the same call instead
   of printing a read: `const ok = await app.find({role: "button", label:
   "OK"}); await app.click(ok.index)`. `app.text(i)` gives a field's full text, and `app.scrollTo(query)` scrolls a
   list until the element shows. Check steps in the same call with
   `await app.expect({label: "Saved"})`; it stops the call and shows the
   window if the check fails.
4. Take `app.getScreenshot()` only when the tree cannot tell you what you need
   (remote desktops such as Citrix, canvases, visual layout). Click with
   `[x, y]` pixels from that screenshot; they are the same pixels the image
   shows. `getAXState({frames: true})` gives element boxes in that same space.

On macOS a few calls save a lot of steps: `app.menu("File > Export…")` for
menu items, `app.select(popup, "Blue")` and `app.contextMenu(el, "Rename")`
to pick from menus, `app.window().resize(w, h)`, `app.choosePath(path)` in
open and save panels, and `app.paste(text)` for long text. Beyond one app:
`gb.windows()` finds an unexpected dialog's owner, `gb.menuExtra("Control
Center")`, `gb.notifications()`, `gb.spotlight("Name")`. `help("macOS")`
lists them. Call `gb.quitLaunched()` when done with apps you opened.

Keys use xdotool syntax: `Return`, `Tab`, `Escape`, `ctrl+a`, `shift+Tab`,
`super+c` (Cmd on macOS). `typeText` treats `\n` as Return. Input stays in
the background: the app is not brought forward and the user's cursor does
not move. If an app ignores it, pass `{foreground: true}` to that action.

`help()` prints the full API; `help("scroll")` prints one part.

Approval: the user may see a dialog the first time you touch an app. If a
call fails with "denied", tell the user what you need and why;
do not look for a way around it. If a result starts with "Stopped:" (the user
switched away or pressed Escape), stop GUI work and ask before continuing. Call `js_reset` when the session is
stuck or a binding should be dropped.
