# Backend protocol

A backend is the native piece for one OS. The scripting layer talks to it with
JSON lines: one request `{"id", "method", "params"}` per line, one reply
`{"id", "result"}` or `{"id", "error": {"message", "code"}}`, and unsolicited
events `{"event": "escape"}`. On macOS the transport is the helper's Unix
socket; a new backend may use a socket, a named pipe, or stdio.

All coordinates are global screen points with a top-left origin. The
scripting layer owns the image-pixel mapping, so a backend never scales.

The backend enforces approval: every method that names a `pid` (or launches
an app) must pass the policy in `config.json` before it acts. See
`design.md`.

| Method | Params | Result |
|---|---|---|
| `hello` | `client` | `{version, platform, pid}` |
| `ping` | | `{version, platform, pid}` |
| `permissions` | `prompt` | `{accessibility, screenRecording, escapeWatcher}` |
| `listApps` | | `[{name, bundleId, pid?, path?, running, active?}]` |
| `resolveApp` | `query` (name, bundle id, `pid:N`, path) | one app |
| `launch` | `bundleId`, `path`, `name`, `activate` | the running app |
| `activate` | `pid` | |
| `windows` | `pid` | `[{index, title, frame: [x,y,w,h], scale, focused, main, minimized, windowId?}]` |
| `axTree` | `pid`, `window`, `maxNodes`, `maxDepth`, `maxText`, `menus` | `{window, nodes, truncated}` |
| `hitTest` | `pid`, `x`, `y` | `{index, role, actions, frame}` or `{}` |
| `elementFrame` | `pid`, `index` | `{frame}` |
| `actionNames` | `pid`, `index` | `{actions}` |
| `performAction` | `pid`, `index`, `action` | |
| `setValue` | `pid`, `index`, `value`, `attribute?` | |
| `focusElement` | `pid`, `index` | |
| `selectText` | `pid`, `index`, `start`, `length` | |
| `keys` | `pid`, `chords: [{key, mods}]` | |
| `type` | `pid`, `text` | |
| `click` | `pid`, `x`, `y`, `button`, `count`, `mods` | |
| `scroll` | `pid`, `x`, `y`, `dy`, `dx` | |
| `drag` | `pid`, `path: [[x, y], ...]`, `button` | |
| `screenshot` | `pid`, `windowId`, `width`, `height`, `format`, `quality` | `{data (base64), width, height, mimeType}` |

Node shape in `axTree`: `{i, d, role, subrole?, title?, value?, desc?, help?,
placeholder?, id?, frame?, actions?, focused?, selected?, disabled?,
settable?}`. `i` must be stable for the same element for as long as the
backend runs. `role` uses the macOS AX names (`AXButton`, `AXTextField`, ...);
other backends map their native roles onto those.

Key names are xdotool keysyms after parsing (`Return`, `Tab`, `Page_Down`,
single characters); modifiers are `ctrl`, `shift`, `alt`, `super`, `fn`.
