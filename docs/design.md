# Design

This is the design glovebox follows. It records what we chose and why, so
changes can argue with the reasons rather than the code.

## The bar

Measured against a real Codex computer-use trace (786 calls in one session,
median script about 130 characters), the properties that made that loop cheap:

1. One tool call holds a whole step: several actions, then one read.
2. The session persists. A handle bound in one call exists in the next, and
   the model can define its own helpers.
3. The default read is accessibility text that diffs after the first read.
4. Screenshots are an explicit choice, never a side effect of an action.
5. Clicks land in the same pixel space as the image the model saw.
6. Pixel actions and element actions are both cheap, because some apps
   (Citrix, canvases) expose a single accessibility node.
7. No documentation dump in tool results, and no idle teardown that throws
   away bindings.

The shapes we compared against:

| | Codex (`@oai/sky`) | Claude computer use | Orca | glovebox |
|---|---|---|---|---|
| Calls per step | 1 script | 1 per action, or a fixed batch list | 1 CLI call per action | 1 script |
| Persistent bindings | yes | no | no | yes |
| Default read | AX text, diffed | screenshot plus AX summary | AX text plus screenshot | AX text, diffed |
| Model-defined helpers | yes | no | no | yes |
| Pixel space | screenshot pixels | screenshot frame | window coordinates | window image pixels |
| Background input | yes | yes | partial | yes (keys, clicks, drag, scroll; foreground fallback) |
| Drawn agent cursor | yes | yes | no | yes |
| Works without vendor app | no | no | no | yes |

Claude's tools and Orca's CLI both make the model pay a round trip per
action, and every state read carries an image or a full tree. Codex's REPL is
the right shape but is tied to OpenAI's signed binaries and service.

## Interface: one persistent JavaScript session

We expose a JavaScript session, not a set of action tools, because it is the
only shape that gets properties 1, 2, and 6 at once. Every agent we target
writes JavaScript fluently, and the surface stays close to the one Codex
models already know (`getApp`, `click`, `pressKey`, `typeText`,
`getAXState`), with `cua` kept as an alias for `gb`.

The same session is reachable two ways:

- **MCP** (`glovebox mcp`): two tools, `js` and `js_reset`. The tool
  description is the cheat sheet (about 1.8 KB, sent once with `tools/list`).
  `help()` prints the full reference only when asked.
- **CLI** (`glovebox run`): a background daemon keeps named sessions alive,
  so agents that can only run shell commands get the same persistence.
  Images go to files and the path is printed.

### Persistence

A cell is rewritten (with acorn) so that top-level `const`, `let`, `class`,
and `import` become assignments to context-level `var`s, function
declarations are hoisted, and the body runs in an async function. The last
expression is the result. This is what Node's REPL does, without its
problem that a rejected top-level `await` is printed and swallowed instead of
failing the call.

The session runs in its own process (the kernel), so the host can stop a
runaway script. A timeout first sets an abort flag that every action checks;
if the script still has not stopped after five seconds, the kernel is killed
and the result says the bindings were lost. MCP sessions live as long as the
connection. CLI sessions live until `glovebox reset`, `glovebox stop`, or an
idle limit (an hour by default).

## Reads and output

`getAXState` prints one line per element: index, role, label, value, id,
flags, and non-obvious actions, indented by depth. The format is close to
Codex's on purpose. Element indices are stable for the session, because the
backend keeps a table of the elements it has seen (`CFEqual` on macOS), so a
diff only shows real changes: `~` changed, `+` added, then a list of removed
indices. Frames are off by default (they are tokens most steps do not need)
and on with `{frames: true}`.

Reads emit into the result by default and return their value; `{emit:
false}` returns only. Actions emit nothing.

## Coordinates and images

Image space is per window: `(0, 0)` is the window's top-left corner, and one
image pixel is `1 / s` screen points, where

    s = min(backing scale, maxLongSide / max(w, h), sqrt(maxPixels / (w * h)))

with defaults `maxLongSide = 1568` and `maxPixels = 1.15 M`. The scale depends
only on the window size and display, so screenshots, `frames`, `center()`, and
`click([x, y])` agree even when no screenshot was taken. The screenshot is
captured at exactly that size, so there is no resize without a matching
transform. The header of every read prints the image size.

## Input delivery

Input goes to apps in the background, the way Codex computer use does it:
the user's frontmost app keeps focus and the real cursor never moves.

- A plain left click on a pressable element (button, checkbox, link, menu
  item) is sent as an accessibility press.
- Keys and typing: the helper makes the target window key *inside its app*
  without activating the app, using two private SkyLight event records
  (`SLPSPostEventRecordTo`: a focus record and a make-key pair, 248 bytes
  each). It confirms through Accessibility that the window is key, then posts
  the key events to the process (`SLEventPostToPid`). Plain
  `CGEventPostToPid` is not enough: Calculator dropped those keys when another
  app was frontmost, because a background app has no key window.
- Mouse clicks, drags, and scrolls: a focus record for the target window only,
  then a `mouseMoved` and the button events posted to the process, each
  stamped with the target pid and window (event fields 40, 51, 58, 91, 92)
  and a window-local location (`CGEventSetWindowLocation`). AppKit apps get
  the public `CGEventPostToPid`; Chromium/Electron apps get the SkyLight route
  plus an off-screen primer click. Scroll events go through both routes.
  Background events carry no click count unless one is set, and AppKit
  ignores a mouse-down without it.
- A focus guard notes the frontmost app before each background action and
  gives it focus back if the target took it anyway.
- Each private function is looked up at runtime. If one is missing (a future
  macOS may remove it), the helper says so and glovebox falls back to the
  foreground route: bring the app forward once per call, then post events.
  On that route, switching to another app stops the script. `glovebox doctor`
  reports whether background input is available, and `app.lastRoute` shows
  which route the last action took.
- The record layouts and event fields come from open-source tools that do the
  same: yabai, trycua's cua-driver, and Peekaboo (all MIT). Codex's service
  links only public frameworks and resolves these calls by hashed name at
  runtime, and Claude desktop's helper references the same calls, so this is
  the established approach, not a novel hack. It is still private API.
- A drawn agent cursor (a borderless, click-through window ordered just above
  the target window, not above everything) animates to each action's point.
  It is included in screen recordings and hides after a few seconds idle.
- Pixel targets outside the window image are refused, so a bad coordinate
  cannot click into another app.
- While any agent is connected the helper shows a menu-bar item listing the
  sessions and their approved apps, with Stop Running Scripts, Revoke Session
  Approvals, Hide Agent Cursor, and Quit.

Measured on macOS 27 with Firefox frontmost throughout (`glovebox smoke
--full`): background keys in Calculator, a pixel click that placed TextEdit's
caret at the start of the text, a drag that selected a line, and a scroll
that moved the scroll bar, with the frontmost app unchanged.

## Approval and safety

Computer use can click anything, so approval is part of the product:

- The gate lives in the helper, the process that holds the macOS grants, not
  in the scripting layer. A client cannot skip it by talking to the socket.
- Default `approval: "ask"`: the first action in each app shows a native
  dialog naming the agent (from the MCP `clientInfo`) and the app: Allow for
  This Session, Always Allow (persisted to `config.json`), or Deny.
- `allowlist` mode never prompts. `allow-all` is an explicit opt-in.
- Terminals, password managers, Keychain Access, System Settings, Script
  Editor, Automator, and the helper itself are blocked by default and never
  offered in a dialog. Only an explicit `glovebox allow` unlocks one. The
  full list is in `SECURITY.md`.
- Switching to another app stops the running script. A script brings an app
  forward at most once per call; if the app is no longer in front later in
  the same call, the user took over, and the script stops rather than taking
  focus back. (An earlier version re-activated before every key and fought
  the user for focus.)
- With Input Monitoring granted, Escape pressed by the user (glovebox marks
  its own events) stops the running script. In testing on macOS 27, an
  Accessibility-only global key monitor saw no key events, so Escape is
  documented as needing Input Monitoring.
- Every action is appended to `~/.glovebox/actions.log` as one JSON object:
  `ts`, `client`, `step` (the call's title, when given), then the action's own
  fields (`app`, `action`, and for example `target`, `keys`, or `length`).
  Typed text is logged as a length unless `log.text` is true.
- The helper's socket is mode 0600 and checks the peer's uid.

## Signing and permissions

macOS ties Accessibility, Screen Recording, and Input Monitoring grants to the
helper's designated requirement. An ad-hoc signature's requirement is the
binary's hash, so every rebuild lost the grants (and stale entries kept
showing as on). `glovebox signing --create` makes a self-signed code-signing
certificate in the login keychain; signed with it, the requirement becomes
"identifier + certificate", and grants survive rebuilds. The certificate
does not need to be trusted. Verified by rebuilding twice without re-granting.

## The macOS backend

Glovebox Helper is a small Swift app (`native/macos/GloveboxHelper.swift`)
built locally by `glovebox setup` with the Xcode command line tools. It is
signed with the local certificate from `glovebox signing --create` when one
exists, and ad hoc otherwise. It runs as its own app, launched through LaunchServices, so
macOS attributes Accessibility and Screen Recording to "Glovebox Helper"
rather than to whatever terminal or agent started it. One grant covers every
agent. (The first prototype ran the native code as a child process; macOS
then charges the permission to the parent, and some hosts disclaim
responsibility for their children, so the grant never applies.)

It uses AXUIElement for the tree and actions, CGEvent for input, and
ScreenCaptureKit for window capture, all public APIs. Background input
(see Input delivery) also uses private SkyLight functions, looked up at
runtime, with a foreground fallback when they are missing. It speaks JSON
lines over `~/.glovebox/helper.sock`. See `backend-protocol.md`.

## What we did not do

- **Wrap OpenAI's Sky service.** It works on a Mac with ChatGPT installed, but
  only by launching OpenAI's signed binaries to satisfy the service's
  sender check. That is fragile across updates, depends on a vendor install,
  and works around an access control, which is a poor fit for a public tool.
- **One tool per action.** Every action becomes a model round trip.
- **Screenshots after every action.** Images are the most expensive thing in
  the context; the model asks when it needs one.
