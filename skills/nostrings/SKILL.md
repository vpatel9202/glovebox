---
name: nostrings
description: >-
  Control Mac apps and Android phones (click, type, read the screen) through nostrings's
  persistent JavaScript session, exposed as the MCP tool `js` (often
  `nostrings__js` or `mcp__nostrings__js`) or the `nostrings run` CLI. Use for GUI
  work that has no API, CLI, or file-based path. Prefer a programmatic path
  when one can finish the task.
---

# nostrings

Drive the GUI through one persistent JavaScript session. Each `js` call should
be a whole step: several actions, then one read. Bindings persist between
calls until `js_reset`.

```js
const calc = await ui.getApp("Calculator");
await calc.pressKey("Escape");
await calc.typeText("12*3=");
await calc.getAXState();
```

The loop:

1. Bind the app once: `const app = await ui.getApp("Name")`. Reuse `app` in
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
`ui.windows()` finds an unexpected dialog's owner, `ui.menuExtra("Control
Center")`, `ui.notifications()`, `ui.spotlight("Name")`. `help("macOS")`
lists them. Call `ui.quitLaunched()` when done with apps you opened.

Saved scripts: at the start of a GUI task, check `ui.scripts.list()`; if a
saved script fits, `await ui.scripts.run("name", {…args})` does it in one
call. After a multi-step task works, offer to save it:
`ui.scripts.save("name", code, "what it does. args: …")`, where the code uses
`args` and `return`. The user can then rerun it with `nostrings script name
key=value` and no model. `help("Saved scripts")` has the details.

Android phones and emulators (over `adb`) use the same loop:
`const phone = ui.device()` (or `ui.device("emulator-5554")` when several are
connected), then `const app = await phone.getApp("Clock")` and the same read,
click, type and scroll calls. On Android 14+ the app runs on a hidden screen,
so the phone's own screen is untouched. If `activate()` fails with
`open_on_phone`, the user has the app open; ask them, or pass
`{foreground: true}` to `getApp`. `help("Android")` lists the rest.

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
