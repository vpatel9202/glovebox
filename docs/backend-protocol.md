# Backend protocol

A backend is the native piece for one OS. The scripting layer talks to it with
JSON lines: one request `{"id", "method", "params"}` per line, one reply
`{"id", "result"}` or `{"id", "error": {"message", "code"}}`, and unsolicited
events `{"event": "escape"}`. On macOS the transport is the helper's Unix
socket; a new backend may use a socket, a named pipe, or stdio.

Per backend: the macOS helper uses global screen points and numeric pids. The
Android server (`native/android`, over `adb shell` stdio) uses pixels of the
phone's display, and its app handle in `pid` is the package name, an opaque
string to the scripting layer. It reports one window per app (the display,
`windowId` 0) and answers reads of an app that is not on screen with
`not_visible`. Everything below holds for both.

All coordinates are global screen points with a top-left origin. The
scripting layer owns the image-pixel mapping: it picks each window's image
size and converts targets to screen points before calling the backend. The
one place a backend sees image dimensions is `screenshot`, which receives the
`width` and `height` to capture at and must return an image of exactly that
size. A backend does not choose a scale of its own.

The backend enforces approval: every method that names a `pid` (or launches
an app) must pass the policy in `config.json` before it acts, and refuses with
a coded error otherwise. Methods that only read the app list or the backend's
own state are not gated: `hello`, `ping`, `permissions`, `listApps`,
`resolveApp`, `forget`, `cursor`. See `design.md` and `SECURITY.md`.

| Method | Params | Result |
|---|---|---|
| `hello` | `client` (name shown in dialogs and the menu) | `{version, platform, pid}` |
| `ping` | | `{version, platform, pid, background}` |
| `permissions` | `ask?` (`accessibility`, `screenRecording` or `inputMonitoring`) | `{accessibility, screenRecording, escapeWatcher, inputMonitoring}` |
| `listApps` | | `[{name, bundleId, pid?, path?, running, active?}]` |
| `resolveApp` | `query` (name, bundle id, `pid:N`, path) | one app |
| `launch` | `bundleId`, `path`, `name`, `activate` | the running app |
| `activate` | `pid` | |
| `isActive` | `pid` | `{active}` |
| `windows` | `pid` | `[{index, title, frame: [x,y,w,h], scale, focused, main, minimized, subrole?, windowId?}]` |
| `axTree` | `pid`, `window`, `maxNodes`, `maxDepth`, `maxText`, `menus` | `{window, nodes, truncated}` |
| `hitTest` | `pid`, `x`, `y` | `{index, role, actions, frame}` or `{}` |
| `elementFrame` | `pid`, `index` | `{frame}` |
| `actionNames` | `pid`, `index` | `{actions}` |
| `performAction` | `pid`, `index`, `action` | |
| `setValue` | `pid`, `index`, `value`, `attribute?` | |
| `focusElement` | `pid`, `index` | |
| `selectText` | `pid`, `index`, `start`, `length` | |
| `keys` | `pid`, `chords: [{key, mods}]`, input options | input result |
| `type` | `pid`, `text`, input options | input result |
| `click` | `pid`, `x`, `y`, `button`, `count`, `mods`, input options | input result |
| `scroll` | `pid`, `x`, `y`, `dy`, `dx`, input options | input result |
| `drag` | `pid`, `path: [[x, y], ...]`, `button`, input options | input result |
| `move` | `pid` (for the gate), `x`, `y` | |
| `cursor` | `enabled`, `hide`, `x`, `y`, `windowId` | `{enabled}` |
| `makeKey` | `pid`, `windowId` | `{keyed}` |
| `screenshot` | `pid`, `windowId`, `width`, `height`, `format`, `quality` | `{data (base64), width, height, mimeType}` |
| `forget` | `pid` | |
| `menus` | `pid`, `path?`, `depth?` | `{items: [{index, title, shortcut?, disabled?, checked?, submenu?}]}` |
| `menuPress` | `pid`, `path` | `{title, route}` |
| `menuShortcut` | `pid`, `key`, `mods`, `dryRun?` | `{found, pressed, title?}` |
| `selectMenuItem` | `pid`, `index`, `path`, `context?` | `{title, route}` |
| `windowAction` | `pid`, `window`, `op` (move, resize, minimize, restore, raise, close, zoom, fullScreen), `x`, `y`, `width`, `height`, `on` | `{index}` |
| `appAction` | `pid`, `op` (quit, forceQuit, hide, unhide) | `{terminated?}` |
| `hover` | `pid`, `x`, `y`, input options | input result |
| `gesture` | `pid`, `x`, `y`, `kind` (magnify, rotate), `amount`, `ms`, input options | input result |
| `pasteStash` | `pid`, `op` (stash, restore), `text` | |
| `dropFiles` | `pid`, `x`, `y`, `paths` | `{route, ended}` |
| `open` | `target` (path or URL), `bundleId?`, `activate?` | the app that opened it |
| `displays` | | `[{index, displayId, frame, scale, main, name}]` |
| `allWindows` | `all?` | `[{windowId, pid, app, bundleId?, title?, frame, layer, onScreen}]` |
| `screenCapture` | `display`, `width`, `height`, `format`, `quality`, `region?` | like `screenshot` |
| `elementAtPoint` | `x`, `y` | `{pid, app, role, title, index, frame, value?}` |
| `menuExtras` | | `[{pid, app, index, title?, help?, id?, frame}]` |
| `systemKeys` | `chords` or `text` | |
| `clipboard` | `op` (read, write), `text?`, `files?` | `{text?, files?, image?, types}` |
| `approveSurface` | `key` (`macos:...`), `name`, `reason` | |

The macOS-only methods without a `pid` ask under a `macos:` key instead:
`screenCapture`, `allWindows` and `elementAtPoint` (`macos:screen`),
`menuExtras` and `systemKeys` (`macos:system`; `systemKeys` also asks for the
app in front), `clipboard` (`macos:clipboard`), `open` (the app that handles
the target, plus `macos:files` for files), `dropFiles` (`macos:files` and the
target app). `click` takes `holdMs` to keep the button down. A `hitTest` on an
element of another app returns `{foreign, pid, app, bundleId, role}` only.
`axTree` of an app with no windows reads its other children and reports
window index `-1`.

`cursor` draws the agent cursor (a decoration; clients ignore its failures).
`move` moves the real pointer. `makeKey` makes a window key inside its app
without activating the app. `forget` drops the element table kept for `pid`.
The scripting layer does not call `move`, `makeKey`, or `forget` today; a
port may leave them out. `format` is `png` or `jpeg`; `quality` is 0 to 1.

`ping.background` reports which private functions the macOS helper found, as
booleans: `postEventRecord`, `postToPid`, `setWindowLocation`,
`setIntegerField`, `processSerialNumber`. Background input needs
`postEventRecord`, `setIntegerField`, and `processSerialNumber`.
`nostrings doctor` prints this; it is informational. Clients decide to fall
back from the error codes below, not from `ping`.

`permissions` returns `inputMonitoring` (listening for key events, which
Escape-to-stop needs on macOS) next to `accessibility` and `screenRecording`.
`ask` names the one permission to prompt for; without it nothing is
prompted. Never prompt for two at once: macOS shows one privacy prompt at a
time and drops one that arrives while another is open. `escapeWatcher` says
whether an Escape watcher is running.

`axTree` nodes are flat, in depth-first order, one object per element:

| Field | Meaning |
|---|---|
| `i` | element index, stable for the session; actions name elements by it |
| `d` | depth below the window (the window is 0) |
| `role` | the platform role (`AXButton`); the scripting layer maps it to words |
| `subrole`, `title`, `desc`, `value`, `help`, `placeholder`, `id` | optional text |
| `frame` | `[x, y, w, h]` in global screen points, if on screen |
| `actions` | action names `performAction` accepts |
| `settable`, `focused`, `selected`, `disabled` | optional booleans |

## Checking a backend

`nostrings conformance` runs the core of this contract against a backend and
prints PASS or FAIL per check: hello, ping, permissions, listApps, resolveApp
(and its `not_found`), launch, windows, axTree, elementFrame (and
`stale_index`), and screenshot size. `--input` adds an Escape key press and
a click. A new backend started as a command that speaks JSON lines on stdio:

```bash
nostrings conformance --command "python3 my_backend.py" --app gnome-calculator
nostrings conformance --command "node test/fake-backend.mjs" --app Fake   # the reference fake
nostrings conformance --android --serial emulator-5554                    # the Android server
nostrings conformance                                                     # the macOS helper
```

[test/fake-backend.mjs](../test/fake-backend.mjs) is the smallest backend
that passes: one fake app, one window, three elements. Start a port from its
shape.

## Background input

`keys`, `type`, `click`, `scroll`, and `drag` take `mode: "background"` with
the target `windowId` (from `windows`) to deliver input without activating
the app or moving the user's pointer. `windowLocation: "screen"` switches the
event location from window-local to screen coordinates. Without `mode`, input
goes out on the foreground route: the client activates the app first. A
background result is `{route, focusRestored}`, where `route` is `background`
or `background-skylight` (Chromium and Electron apps), and `focusRestored` is
true if the target took focus and the backend gave it back to the user's app.

A backend with no background route should answer `mode: "background"` with
`background_unavailable`; the client then falls back to foreground.

## Errors

Replies carry `{message, code}`. Codes the macOS helper uses:

| Code | Meaning |
|---|---|
| `denied` | On the `deny` list, the user chose Deny, nobody answered within two minutes, or the target is the helper's own dialogs. |
| `not_allowed` | `approval` is `allowlist` and the app is not on `allow`. |
| `background_unavailable` | The private functions background input needs are missing. |
| `background_unconfirmed` | The window could not be made key in the background. |
| `no_window` | No such window, or it is gone or not capturable. |
| `no_frame` | The element has no on-screen frame. |
| `stale_index` | The element index is not in the table; read the tree again. |
| `action_failed` | An accessibility action or attribute write failed. |
| `activate_failed` | The app would not come forward. |
| `not_found` | No app matches the query, or it cannot be located to launch. |
| `not_running` | No running app has that `pid`. |
| `permission` | A needed OS permission (Screen Recording) is missing. |
| `bad_key` | A key name has no key code. |
| `bad_request` | A parameter is missing or invalid, or the method is unknown. |
| `failed` | Anything else. |

Clients act on `background_unavailable` and `background_unconfirmed` by
falling back to the foreground route; every other code is an error.

Node shape in `axTree`: `{i, d, role, subrole?, title?, value?, desc?, help?,
placeholder?, id?, frame?, actions?, focused?, selected?, disabled?,
settable?}`. `i` must be stable for the same element for as long as the
backend runs. `role` uses the macOS AX names (`AXButton`, `AXTextField`, ...);
other backends map their native roles onto those.

Key names are xdotool keysyms after parsing (`Return`, `Tab`, `Page_Down`,
single characters); modifiers are `ctrl`, `shift`, `alt`, `super`, `fn`.
