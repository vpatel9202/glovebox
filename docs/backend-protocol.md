# Backend protocol

A backend is the native piece for one OS. The scripting layer talks to it with
JSON lines: one request `{"id", "method", "params"}` per line, one reply
`{"id", "result"}` or `{"id", "error": {"message", "code"}}`, and unsolicited
events `{"event": "escape"}`. On macOS the transport is the helper's Unix
socket; a new backend may use a socket, a named pipe, or stdio.

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
| `permissions` | `prompt`, `inputMonitoring` | `{accessibility, screenRecording, escapeWatcher, inputMonitoring}` |
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

`cursor` draws the agent cursor (a decoration; clients ignore its failures).
`move` moves the real pointer. `makeKey` makes a window key inside its app
without activating the app. `forget` drops the element table kept for `pid`.
The scripting layer does not call `move`, `makeKey`, or `forget` today; a
port may leave them out. `format` is `png` or `jpeg`; `quality` is 0 to 1.

`ping.background` reports which private functions the macOS helper found, as
booleans: `postEventRecord`, `postToPid`, `setWindowLocation`,
`setIntegerField`, `processSerialNumber`. Background input needs
`postEventRecord`, `setIntegerField`, and `processSerialNumber`.
`glovebox doctor` prints this; it is informational. Clients decide to fall
back from the error codes below, not from `ping`.

`permissions` returns `inputMonitoring` (listening for key events, which
Escape-to-stop needs on macOS) next to `accessibility` and `screenRecording`.
`prompt: true` asks the OS to prompt; with `inputMonitoring: true` it also
asks for Input Monitoring. `escapeWatcher` says whether an Escape watcher is
running.

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
| `blocked` | The app is blocked by default (terminals, password managers, ...). |
| `denied` | On the `deny` list, or the user chose Deny. |
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
