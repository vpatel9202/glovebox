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
4. When the tree is empty or nearly so (a read shows one or two elements:
   Citrix, remote desktops, canvases, games), the screen is drawn, not
   described. Use `app.ocr()`: text lines with `@x,y wxh` frames you can click
   (`[x + w/2, y + h/2]`), and a repeat call prints only what changed. Do not
   fall back to screenshots for reading text.

Token cost, cheapest first. Pick the cheapest call that answers the question:

| Need | Call | Cost |
|---|---|---|
| One element or value | `app.find(...)`, `app.text(i)`, `app.nodes()` | data, prints nothing |
| What changed | `app.getAXState()` | text diff |
| Text on a drawn screen | `app.ocr()` (`{emit: false}` for data only) | text, diffed on repeat |
| Layout, colors, images | `app.getScreenshot()` | an image: by far the most |

Collect long content in one call, not one call per page. For a list that
scrolls on a drawn screen, loop scroll and OCR inside the script and return
only what you need:

```js
const seen = new Set(), rows = [];
for (let page = 0; page < 30; page++) {
  const before = seen.size;
  for (const t of await app.ocr({ emit: false })) if (!seen.has(t.text)) { seen.add(t.text); rows.push(t.text); }
  if (seen.size === before) break;           // nothing new: the end of the list
  await app.scroll([400, 300], 5);           // a point inside the list
  await app.settle();
}
rows;
```

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
