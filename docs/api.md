# glovebox API

Scripts run in one persistent JavaScript session. Top-level `const`, `let`,
`function`, `class`, and `await` persist until `js_reset` (MCP) or
`glovebox reset` (CLI). Redeclaring a name is allowed. `gb` is the entry
point; `cua` is an alias.

```js
const calc = await gb.getApp("Calculator");
await calc.pressKey("Escape");
await calc.typeText("12*3=");
await calc.getAXState();
```

## gb

- `gb.getApp(query, {activate})` returns an App handle. `query` is a display
  name, a bundle id, or `"pid:123"`. Launches the app if it is not running,
  without bringing it to the front unless `activate: true`. The first action in
  each app may show an approval dialog to the user.
- `gb.listApps({installed})` lists running apps (or installed ones too) and
  returns `[{name, bundleId, pid, running, active}]`.
- `gb.sleep(ms)` waits. Also available as `sleep(ms)`.
- `gb.permissions()` reports Accessibility and Screen Recording status.
- `help(topic)` prints this document, or the sections mentioning `topic`.
- `console.log(...)` and `nodeRepl.write(value)` add text to the result. The
  value of the last expression is added too, unless a read already printed it.

## Reading state

- `app.getAXState({disableDiffing, frames, menus, window, maxNodes, emit})`
  returns the accessibility tree as text. The first read of a window is the
  full tree; later reads print only lines that changed (`~`), were added
  (`+`), or a list of removed indices. `disableDiffing: true` prints the full
  tree. `frames: true` appends `@x,y wxh` in image pixels. `menus: true` adds
  the menu bar. `window` picks a window index from `app.windows()`.
- Line format: `<index> <role> "<label>" value="..." id=... help="..."
  (focused, selected, disabled, settable) actions: ...`. Indentation is depth.
  Indices are stable for the life of the session, so a diff means what it says.
- `app.getScreenshot({window, format, quality, emit})` returns
  `{width, height, mimeType, data}` and adds the image to the result. Over the
  CLI the image is saved to a file and the path is printed.
- `app.getAXStateAndScreenshot(options)` does both.
- `app.windows()` lists windows with their frames and image size.
- `app.frame(index)` and `app.center(index)` give an element's rectangle or
  center in image pixels.
- Every read emits by default. Pass `{emit: false}` to only return the value.

## Coordinates

A target is either an element index (a number) or `[x, y]` in **image
pixels** of the window: `(0, 0)` is the window's top-left corner, and the
space is exactly the screenshot's pixels. The scale is fixed by the window
size and display, so `frames`, `center`, screenshots, and clicks always
agree, even if no screenshot was taken. The header of each read prints the
image size. If the window is resized, read again before clicking by pixels.

## Actions

- `app.click(target, {button, count, modifiers, raw})`. A plain left click on
  a button, checkbox, link, or menu item is delivered through accessibility,
  which works with the app in the background. Anything else brings the app
  to the front and clicks with the mouse. `raw: true` always uses the mouse.
  `modifiers` is a list such as `["shift"]`.
- `app.doubleClick(target)`, `app.rightClick(target)`.
- `app.pressKey(keys, {repeat})`. xdotool syntax: `Return`, `Tab`, `Escape`,
  `BackSpace`, `Delete`, `Up`, `Page_Down`, `F5`, `ctrl+a`, `shift+Tab`,
  `super+c` (super is Cmd on macOS). Space-separated keys press in sequence:
  `"ctrl+a BackSpace"`. Keys bring the app to the front first; pass
  `{background: true}` (or `gb.getApp(name, {background: true})`) to post
  them to the app without focusing it. Many apps accept that, some silently
  ignore it, so check the result with a read.
- `app.typeText(text, {background})`. Types literal text; `\n` presses
  Return and `\t` presses Tab.
- `app.scroll(target, dy, {dx})`. Positive `dy` scrolls down, in lines.
- `app.drag(from, to)` or `app.drag([[x, y], [x, y], ...])`.
- `app.setValue(index, value)` sets a field's value directly.
- `app.focus(index)` gives an element keyboard focus.
- `app.selectText(index, {start, length})` selects text in a field.
- `app.listActions(index)` and `app.performSecondaryAction(index, name)`
  run an accessibility action such as `"Show Menu"` or `"Increment"`.
- `app.activate()` brings the app to the front.

## Approval and stopping

The first time a session touches an app, the user sees a dialog: Allow for
This Session, Always Allow, or Deny. Terminals, password managers, and System
Settings are blocked unless the user runs `glovebox allow <app>`. If the user
switches to another app or presses Escape while a script runs, the script
stops with a "Stopped: ..." message; do not continue GUI work until they ask.
A script brings an app forward at most once per call. Every action is
appended to `~/.glovebox/actions.log` (typed text is logged as a length only).

## Tips

- Bind each app once and reuse the handle; define helpers in the session.
- Batch a whole step into one call: several actions, then one read.
- Read the tree first. Use screenshots only when the tree has nothing useful
  (remote desktops such as Citrix, canvases, games) or you need to see layout.
- When the tree is a single node, work in pixels from the latest screenshot.
