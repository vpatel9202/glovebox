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

- `gb.getApp(query, {activate, foreground})` returns an App handle. `query` is
  a display name, a bundle id, or `"pid:123"`. Launches the app if it is not
  running, without bringing it to the front unless `activate: true`.
  `foreground: true` makes every input to the handle use the foreground
  route; it takes effect only on the call that first creates the handle.
  The first action in each app may show an approval dialog to the user.
- `gb.listApps({installed, emit})` lists running apps (or installed ones too)
  and returns `[{name, bundleId, pid, running, active}]`. It prints the list
  unless `emit: false`.
- `gb.device(serial)` returns an Android device with the same `listApps`,
  `getApp` and `permissions`. `serial` is the ADB serial (`adb devices`);
  either the USB or the wireless serial names the same phone, and it may be
  left out when one device is connected. See [Android](#android).
- `gb.sleep(ms)` waits. Also available as `sleep(ms)`.
- `gb.permissions()` reports Accessibility and Screen Recording status.
- `help(topic)` prints this document, or the sections mentioning `topic`.
- `console.log(...)` and `nodeRepl.write(value)` add text to the result. The
  value of the last expression is added too, unless a read already printed it.

## Reading state

- `app.name`, `app.bundleId`, and `app.pid` identify the handle.
  `app.view` is `{window, width, height, scale, ...}` for the window last read
  (`null` before the first read); `scale` is image pixels per screen point.
- `app.getAXState({disableDiffing, frames, menus, window, maxNodes, maxDepth, emit})`
  returns the accessibility tree as text. The first read of a window is the
  full tree; later reads print only lines that changed (`~`), were added
  (`+`), or a list of removed indices. `disableDiffing: true` prints the full
  tree. `frames: true` appends `@x,y wxh` in image pixels. `menus: true` adds
  the menu bar. `window` picks a window index from `app.windows()`.
  Without `window`, reads and clicks use the focused window if it is a normal
  one, else the window last used, else the main window; tooltips, popovers,
  and rename fields never take over. Diffs compare against the last printed
  read of the same window; `{emit: false}` reads don't change that.
  `maxNodes` (default 800) and `maxDepth` (default 40) bound the tree; a
  truncated tree says so. A tree over 250 elements (`ax.outlineAbove` in the
  config) prints as an outline: elements outside the window are left out,
  then the tree is shown level by level up to 250 lines, and each shown
  line that hides more ends in `(+N inside)`. A note under the read says
  what was left out. `find()` and `nodes()` still see every element;
  `getAXState({full: true})` prints all of them.
- Line format: `<index> <role> "<label>" value="..." id=... help="..."
  (focused, selected, disabled, settable) actions: ...`. Indentation is depth.
  Indices are stable for the life of the session, so a diff means what it says.
- `app.getScreenshot({window, format, quality, emit})` returns
  `{width, height, mimeType, data}` and adds the image to the result. Over the
  CLI the image is saved to a file and the path is printed.
- `app.getAXStateAndScreenshot(options)` does both.
- `app.find(query, {all, window})` looks elements up without printing
  anything. `query` is `{role, label, id, value, text}`, each a string
  (case-insensitive substring; `role` exact, as reads print it) or a RegExp,
  plus flags such as `{focused: true}`; a bare string matches `text` (label,
  value, placeholder or id). Returns the first match or `null`, or every
  match with `{all: true}`. Each element is `{index, role, label, value, id,
  placeholder, focused, selected, disabled, settable, actions, depth,
  frame}`, with `frame` as `[x, y, w, h]` in image pixels. Use it to act in
  the same call: `await app.click((await app.find({role: "button", label:
  "Save"})).index)`.
- `app.expect(query, {timeout, gone, message})` checks a step inside a
  script: it waits up to `timeout` ms (default 3000) for an element matching
  `query` (or, with `{gone: true}`, for none) and returns it. If the check
  fails it prints a read of the window and throws, so one call can chain
  several steps and stop at the first that did not work:
  `await app.click(save.index); await app.expect({label: "Saved"});`.
- `app.scrollTo(query, {container, dy, max})` scrolls until an element
  matching `query` is fully in view and returns it, or `null` at the end of
  the content: one call instead of a read-scroll-read loop. It scrolls the
  largest list or scroll area unless `container` names one by index; on
  Android each step is about a page, elsewhere `dy` lines (default 5). A
  negative `dy` scrolls back. Labels match as substrings, so use a RegExp
  such as `/^Row 3$/` for an exact label.
- `app.nodes(options)` returns every element in that form, and
  `app.text(index)` the full text of one; reads cut text at 160 characters.
  Neither prints nor changes what the next read diffs against.
- `app.ocr({window, languages, emit})` reads text from the window's
  screenshot on the host (macOS Vision) for screens the tree cannot describe
  (canvases, games, remote desktops; a read with two or fewer elements
  suggests it). Returns `[{text, confidence, frame}]` with the frame in
  image pixels, ready to click, and prints one line per text unless
  `{emit: false}`. The first call builds the OCR tool with `swiftc` (about a
  minute); later calls take well under a second. OCR text can be wrong
  (`0` read as `O`).
- `app.windows()` lists windows with their frames and image size.
- `app.frame(index)` and `app.center(index)` give an element's rectangle or
  center in image pixels.
- Every read emits by default. Pass `{emit: false}` to only return the value.
- `app.waitForChange({timeout, window})` waits silently until the window
  differs from the last printed read (pixels after a screenshot, the tree
  after a tree read), then settles. Returns `{changed, ms}`; `changed: false`
  at the timeout (default 10000 ms). Use it after an action in an app that
  updates late. A blinking caret counts as a change in pixel mode.
- `app.settle({timeout, stableFor, window})` waits until two screenshots in a
  row match (ignoring a blinking caret) and returns `{stable, ms}`. Nothing is
  printed; read afterwards.

## Coordinates

A target is either an element index (a number) or `[x, y]` in **image
pixels** of the window: `(0, 0)` is the window's top-left corner, and the
space is exactly the screenshot's pixels. The scale is fixed by the window
size and display, so `frames`, `center`, screenshots, and clicks always
agree, even if no screenshot was taken. The header of each read prints the
image size. If the window is resized, read again before clicking by pixels.

## Actions

Input stays in the background: the app is not brought to the front, the
user's real cursor does not move, and a drawn agent cursor shows where each
action lands. If this macOS or an app can't take background input, glovebox
brings the app forward instead. `app.lastRoute` says how the last action got
there: `accessibility`, `background`, `background-skylight` (Chromium and
Electron), or `foreground`, with " (focus restored)" appended if the app took
focus and glovebox gave it back. Pass
`{foreground: true}` to `click`, `doubleClick`, `rightClick`, `pressKey`,
`typeText`, `scroll`, or `drag`, or `gb.getApp(name, {foreground: true})` for
every action, for apps that ignore background input (some Java, Tk, and game
windows).

- `app.click(target, {button, count, modifiers, raw, foreground})`. A plain
  left click on a button, checkbox, link, or menu item is pressed through
  accessibility. Anything else is a mouse click sent to the app's window.
  `raw: true` uses the mouse, except on an open menu's items in the
  background, which only accessibility reaches. A click on a menu item waits
  for the menu to close. `modifiers` is a list such as `["shift"]`.
- `app.doubleClick(target)`, `app.rightClick(target)`.
- `app.pressKey(keys, {repeat})`. xdotool syntax: `Return`, `Tab`, `Escape`,
  `BackSpace`, `Delete`, `Up`, `Page_Down`, `F5`, `ctrl+a`, `shift+Tab`,
  `super+c` (super is Cmd on macOS). Space-separated keys press in sequence:
  `"ctrl+a BackSpace"`. Keys go to the app's key window.
- `app.typeText(text)`. Types literal text; `\n` presses Return and `\t`
  presses Tab.
- `app.scroll(target, dy = 3, {dx})` or `app.scroll(target, {dy, dx})`.
  Positive `dy` scrolls down, in lines.
- `app.drag(from, to)` or `app.drag([[x, y], [x, y], ...])`.
- `app.setValue(index, value)` sets a field's value directly. Finder file
  names refuse it (Finder would relabel without renaming); rename with a
  click on the item, `pressKey("Return")`, `typeText(name)`,
  `pressKey("Return")`, which works in the background.
- `app.focus(index)` gives an element keyboard focus.
- `app.selectText(index, {start, length})` selects text in a field.
- `app.listActions(index)` and `app.performSecondaryAction(index, name)`
  run an accessibility action such as `"Show Menu"` or `"Increment"`.
- `app.activate()` brings the app to the front (rarely needed).

## Approval and stopping

The first time a session touches an app, the user sees a dialog: Allow for
This Session, Always Allow, or Deny. Nothing is blocked: terminals, password
managers, System Settings and messaging apps always ask, even under
`allow-all`, unless the user runs `glovebox allow <app>`. A dialog nobody
answers denies after two minutes (`denied`). If a script
brought an app forward and the user switches away, the script stops with a
"Stopped: ..." message. Background scripts keep running while the user works in
other apps. Escape stops any script, but only when the user has granted Input
Monitoring. Do not continue GUI work until the user asks.
On the foreground route a script brings an app forward at most once per call.
Every action is appended to `~/.glovebox/actions.log` (typed text is logged
as a length only).

## Android

Reads, screenshots, clicks, keys, typing, scrolling, swipes and long presses
work. On Android 14 (API 34) and later each app runs on its own **hidden
screen**: a private display only glovebox sees. The phone's own screen keeps
focus and shows what the user had open, the keyboard stays hidden, and the
hidden screen and everything on it close when the session ends. `lastRoute`
starts with `hidden screen`. `gb.device(...).getApp(name, {foreground: true})`
(or `"androidScreen": "phone"` in the config) works on the phone's own screen
instead, as on older Android versions.

Approval uses the same `approval`, `allow` and `deny` settings as macOS, with
a dialog on the Mac (zenity on Linux). Nothing is blocked outright: apps and
screens that can move money, read messages or codes, or change the phone's
settings (Play Store, Messages, Phone, Settings, wallets, password managers,
authenticators, Google sign-in, permission prompts) ask first even under
`allow-all`. A screen from one of them inside an approved app asks again, and
acting on a locked phone asks once per session. `glovebox allow <package>`
skips the dialog. Without a dialog, the error code is `needs_approval`.

```js
const phone = gb.device();               // or gb.device("emulator-5554")
const clock = await phone.getApp("Clock");
await clock.activate();                  // brings it to the phone's screen
await clock.getAXState();
```

- The phone's whole screen is the app's one window (`window 0`). A read shows
  the app and anything on top of it: dialogs, sheets, the keyboard, system
  prompts. The status and navigation bars are left out.
- On a hidden screen, the first read or action of a handle opens the app
  there; no `activate()` is needed. If the app later closes (Back on its
  first screen, a crash), reads fail with `not_visible` until
  `app.activate()` opens it again. On the phone's own screen, `getApp`
  never launches or brings an app forward; call `app.activate()` first.
- A hidden screen opens only apps the user is not running. A second copy can
  take the user's: single-copy apps (Clock) move their task over, and others
  (Chrome) close the older one. So if the user has the app running,
  `activate()` fails with `open_on_phone` and changes nothing; ask the user
  to close it, or pass `{foreground: true}` to `getApp`, which also switches
  an existing handle. While glovebox has a single-copy app on a hidden
  screen, the user opening it on the phone shows nothing until the session
  ends.
- Hidden-screen apps stay out of the phone's recent apps.
- Several glovebox sessions (agents, CLI sessions) can use one phone at the
  same time, each with its own hidden screens and element indices. One app
  can be open in only one session at a time, on a hidden screen or the
  phone's (opening it on the phone's screen would pull the other session's
  copy over); a second fails with `open_in_other_session`. A session that
  switches its own handle to `{foreground: true}` brings its hidden copy to
  the phone's screen. Ending a session closes its hidden screens.
- If an app on a hidden screen moves itself to the phone's own screen (some
  sign-in and system screens might), glovebox stops with
  `moved_to_phone_screen` rather than follow it. (No app has been seen to do
  this in testing yet, so this check is untested.)
- `HomeScreen`, `Recents`, `Notifications` and `QuickSettings` act on the
  phone's own screen, so on a hidden screen they fail with
  `phone_screen_only`; `Back` works on both.
- While the agent works on a hidden screen, the phone stays awake (screen
  dimmed) until a minute after the last action: an asleep phone runs nothing
  on a hidden screen. A sleeping phone is woken.
- Opening an app on a hidden screen counts as using it: the phone's launcher
  may list it in its suggested apps.
- On the phone's own screen, a swipe-only lock screen is dismissed; a phone
  locked with a PIN, pattern or biometric fails with `locked` (the hidden
  screen works while locked, after the one-time approval).
- `query` is the app's label (`"Clock"`) or package (`"com.android.chrome"`).
- `phone.notifications({max, emit})` lists the notifications in the shade,
  newest first, as `[{app, package, title, text, subtext, when, ongoing}]`,
  and prints them unless `{emit: false}`: one-time codes, for one. It
  always asks first (approval key `android:notifications`; `glovebox allow
  android:notifications` skips the dialog, `glovebox revoke` restores it),
  and each read is logged.
- `phone.push(localPath, {to})` copies a file from this computer to the
  phone (default `/sdcard/Download/`; a `to` ending in `/` keeps the name)
  and returns `{path, bytes}`; apps' file and photo pickers list it right
  away. Scripts cannot read files otherwise, so each file asks first (once
  per session), and each copy is logged.
- `phone.open(url)` opens a link in the app that handles it (the user's
  default, else the first; a note lists the others) on that app's hidden
  screen and returns its handle; `{foreground: true}` uses the phone's own
  screen. `phone.open({action, data, type, component, categories,
  extras})` takes an intent instead, and `app.open(...)` sends one to a
  given app, to jump straight to a screen. Approval is the same as opening
  the app.
- `click(index)` presses the element through accessibility; `click([x, y])`
  taps. `rightClick` and `app.longPress(target, {ms})` press and hold.
  `app.swipe(from, to, {ms})` moves a finger without a long press first (pagers,
  sheets, pull to refresh); `drag` holds first, to pick up an item.
  `scroll(target, dy)` swipes about 48 dp per line.
  `app.pinch(target, {scale, ms, distance, angle})` moves two fingers apart
  (`scale` > 1 zooms in) or together, and `app.rotate(target, {degrees,
  ms})` twists them, around an element or point, for maps and photos.
- `typeText` puts text straight into the focused field (no keyboard, any
  characters), then falls back to key events for fields that refuse it.
  `lastRoute` says which: `set-text` or `keys`, after the screen
  (`hidden screen (set-text)`, `foreground (keys)`). Text longer than the
  field holds goes as keys, so a one-time-code row of one-digit boxes that
  moves focus on its own fills box by box: click the first box, then
  `typeText("123456")`. Any characters (accents, emoji, CJK) work in
  fields that take text directly, web page fields included; a field that
  refuses it takes only what the key map has, and other text fails with
  `bad_key`. The clipboard is never used: Android shows clipboard changes
  on the phone's screen.
- A button or checkbox with no name of its own is named by the text inside
  it (Compose apps put a control's text on child nodes), so
  `find({role: "button", label: "All contacts"})` works there too.
- Lists reuse row views as they scroll, so a row's index is tied to its
  position in the list: after a scroll, an index read before it that now
  shows another row fails with `stale_index` instead of acting on the wrong
  row. Read (or `find`) again after scrolling.
- Web content inside apps (WebView) reads with its HTML roles: heading,
  link, button, text field. `click(index)` on web content taps the
  element's center, since web content ignores accessibility clicks, and
  `lastRoute` says `touch`. Every read fetches fresh nodes; the system's
  cache misses web page updates.
- System keys for `pressKey`: `Back`, `HomeScreen`, `Recents`,
  `Notifications`, `QuickSettings`, `VolumeUp`, `VolumeDown`, `Menu`. `Home`
  and `End` move the text cursor.
- After each action glovebox waits until the app has sent no change events
  for 150 ms (at most 1.5 s), instead of a fixed pause: about 150-300 ms
  on the fixture, longer for screens that keep changing. A number in
  `androidSettleMs` (config) restores a fixed pause.
- `waitForChange()` after a tree read waits on the app's own change events
  instead of polling, so it notices a change within about 100 ms.
- The keyboard shows as one `window "keyboard"` line; pass
  `getAXState({keyboard: true})` to list its keys.
- Coordinates are image pixels as on macOS; the image is the screen scaled so
  its long side is at most 1568.
- Needs `adb` and a built server: `npm run build:android` (Android SDK and a
  JDK). The server runs over ADB with shell privileges and stops with the
  session. Only one automation tool can read the screen at a time; stop
  uiautomator, Appium or Maestro first.
- `glovebox doctor` lists connected devices and checks each one;
  `glovebox smoke --android` runs an end-to-end check with a test app.

## Known limits

- **Pop-up menus and your keyboard.** While a background app's pop-up menu is
  open, macOS menu tracking is system-wide, so what you type goes to that app. A
  word you type can land in its field. Keep the time the menu is open short: open
  it and pick the item in one script, with no read in between. A dedicated
  `app.select(popup, item)` is planned.
- **Window controls during background typing.** A target window can show active
  window controls while it receives background keys, even though your app stays
  frontmost and keeps your keyboard.
- **One-node trees.** Remote desktops such as Citrix expose a single accessibility
  node, so work there runs on screenshots and pixel clicks.

## Tips

- Bind each app once and reuse the handle; define helpers in the session.
- Batch a whole step into one call: several actions, then one read.
- Read the tree first. Use screenshots only when the tree has nothing useful
  (remote desktops such as Citrix, canvases, games) or you need to see layout.
- When the tree is a single node, work in pixels from the latest screenshot.
