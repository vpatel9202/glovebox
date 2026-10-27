# glovebox

Scriptable computer use for coding agents. One persistent JavaScript session,
many GUI actions per call, accessibility text by default, screenshots only
when the model asks.

```js
const calc = await gb.getApp("Calculator");
await calc.pressKey("Escape");
await calc.typeText("6*7=");
await calc.getAXState();
```

```
Calculator — window 0 "Calculator" — image 460x816 — changes since last read (~ changed, + added):
~					8 scroll area id=StandardInputView;value:42
~						9 text "Edit field" value="42"
```

On the next call `calc` is still bound. That is the whole idea: an agent
writes a few lines per step instead of making one tool call per click, and
reads a diff of the accessibility tree instead of a screenshot.

Input goes to apps in the background, like Codex computer use: the app is
not brought to the front, your real cursor does not move, and a drawn agent
cursor shows where each action lands.

glovebox works with any agent that speaks MCP (Claude Code, Grok CLI,
OpenCode, Codex, Gemini CLI, Cursor) and with agents that can only run shell
commands, through `glovebox run`.

## Why

Most computer-use tools give the model one tool per action and return a
screenshot after each one. Every click is a model round trip, and every read
fills the context with an image. OpenAI's Codex computer use showed a better
shape: a persistent script session where one call does a whole step. In one
real Codex session, 786 calls had a median length of about 130 characters.
glovebox brings that shape to every agent, without depending on any vendor's
app. See [docs/design.md](docs/design.md) for the comparison and the
reasoning.

## Status

| Platform | Status |
|---|---|
| macOS 14+ | Works. Tested on macOS 27 (Apple silicon). |
| Windows | Planned (UI Automation). See [roadmap](docs/roadmap.md). |
| Linux | Planned (AT-SPI; Wayland limited). See [roadmap](docs/roadmap.md). |

What has been run for real on macOS 27 (Apple silicon), not mocked:

- `glovebox smoke` over MCP: one batched call types `6*7=` and reads `42`;
  the binding persists to the next call; index clicks compute `7+1=8` and
  the read comes back as a diff; a pixel click lands on the `9` key; the
  screenshot is 460x816, the same space as clicks; `js_reset` drops bindings.
- Claude Code (headless) attached through `glovebox mcp`: two calls, the
  second reusing the first call's binding.
- `glovebox smoke --full` with Firefox frontmost the whole time: background
  keys in Calculator; in TextEdit, a pixel click placed the caret, a drag
  selected a line, a scroll moved the view; the frontmost app never changed.
- The approval dialog, a blocked app (Terminal) being refused, and Escape to
  stop a script.

The Grok, OpenCode, and Codex configs below follow each client's documented
MCP format but have not been exercised end to end yet.

## Install (macOS)

Requires Node 20.10+ and the Xcode command line tools (`xcode-select --install`).

```bash
npm install -g github:vpatel9202/glovebox
glovebox signing --create   # optional, recommended: grants survive helper rebuilds
glovebox setup
```

`setup` builds **Glovebox Helper.app** into `~/.glovebox/` (about a minute),
then walks you through two macOS permissions for it, one at a time, waiting
while you turn on "Glovebox Helper" in System Settings > Privacy & Security >
**Accessibility** and then **Screen & System Audio Recording**. It also offers
**Input Monitoring**, which is optional and only needed for Escape-to-stop.
Then:

```bash
glovebox doctor    # every line should say ok
glovebox smoke     # a real end-to-end test on Calculator
```

The helper is its own app so that one grant covers every agent and terminal.
To keep those grants when the helper is rebuilt (for example after an
upgrade), create a local signing certificate once, before `setup`:

```bash
glovebox signing --create
```

Without it the helper is signed ad hoc, and macOS treats every rebuild as a
new app: clear the old grants with `tccutil reset Accessibility|ScreenCapture|ListenEvent io.github.vpatel9202.glovebox.helper`
and run `glovebox setup` again.

## Attach to your agent

Claude Code:

```bash
claude mcp add --scope user glovebox -- glovebox mcp
```

Grok CLI (`~/.grok/config.toml`) and Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.glovebox]
command = "glovebox"
args = ["mcp"]
```

OpenCode (`opencode.json`):

```json
{ "mcp": { "glovebox": { "type": "local", "command": ["glovebox", "mcp"], "enabled": true } } }
```

Shell-only agents:

```bash
glovebox run 'const calc = await gb.getApp("Calculator"); await calc.getAXState()'
glovebox run 'await calc.typeText("2+2="); await calc.getAXState()'
```

More clients, the agent skill file, and CLI details: [docs/agents.md](docs/agents.md).

## The API in one screen

- `gb.getApp(name)` launches or finds an app without stealing focus. `gb.listApps()`.
- `app.getAXState()` returns the accessibility tree as text; later reads are
  diffs. `{frames: true}` adds element boxes, `{disableDiffing: true}` the
  full tree.
- `app.getScreenshot()` is the only way to get an image.
- `app.click(target)`, `doubleClick`, `rightClick`, `scroll`, `drag`,
  `setValue`, `focus`, `selectText`, `performSecondaryAction`.
- `app.pressKey("ctrl+a")` uses xdotool names (`super` is Cmd).
  `app.typeText("text\n")`.
- A target is an element index from the tree or `[x, y]` pixels in the
  window image, which is exactly the screenshot's pixel space.

Full reference: [docs/api.md](docs/api.md), or `help()` inside a session.

## Safety

The first time a session touches an app, you get a dialog: Allow for This
Session, Always Allow, or Deny. Terminals, password managers, and System
Settings are blocked unless you run `glovebox allow <bundle id>`. To stop a
running script, switch to another app; with the optional Input Monitoring
permission, Escape works too. Every action is logged to
`~/.glovebox/actions.log`. Details and limits: [SECURITY.md](SECURITY.md).

```bash
glovebox allow Calculator        # pre-approve
glovebox approval allowlist      # never prompt; only allowlisted apps
glovebox log                     # recent actions
```

## How it works

```
agent ──MCP stdio──▶ glovebox mcp ──▶ kernel (persistent JS session)
agent ──shell──▶ glovebox run ──▶ daemon ──▶ kernel        │
                                                            ▼ Unix socket
                                        Glovebox Helper.app (Swift: AX, CGEvent,
                                        ScreenCaptureKit, approval dialogs)
```

Background input uses private macOS (SkyLight) functions, looked up at
runtime with a foreground fallback; everything else is public API. No OpenAI,
Anthropic, or other vendor binaries. Details: [docs/design.md](docs/design.md).

## Development

```bash
npm test          # unit tests (cell rewriting, keys, diffs, coordinates)
glovebox smoke    # GUI test on Calculator
glovebox smoke --full   # adds background click/drag/scroll checks in TextEdit
GLOVEBOX_DEBUG=1 glovebox mcp   # kernel logs on stderr
```

## License

MIT
