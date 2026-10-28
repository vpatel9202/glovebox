# glovebox

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform: macOS 14+](https://img.shields.io/badge/platform-macOS%2014%2B-lightgrey.svg)](#status)
[![Node >=20.10](https://img.shields.io/badge/node-%3E%3D20.10-green.svg)](package.json)

Computer use for coding agents: drive Mac apps by writing a few lines of
JavaScript per step, and read accessibility-tree diffs instead of screenshots.

<!--
Demo GIF goes here. Shot list:
1. Split screen: the user typing in an editor on the left; Calculator or
   TextEdit in the background on the right.
2. The agent sends one `js` call that runs a five-step task in the background
   app. The drawn agent cursor moves to each action; the user's real cursor
   and frontmost app never change.
3. The tool result: the accessibility diff (`~` changed, `+` added lines).
4. A second call reuses the binding from the first.
Keep it under 15 seconds.
-->

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

Input goes to apps in the background: the app is not brought to the front,
your real cursor does not move, and a drawn agent cursor shows where each
action lands. glovebox is one MCP tool (`js`) and needs no vendor app.

**Works with:** Claude Code (verified end to end). Codex, Grok CLI, OpenCode,
Gemini CLI, and Cursor (configs documented, not yet exercised). Any agent that
can run shell commands, through `glovebox run`.

## Quickstart (macOS)

Requires Node 20.10+ and the Xcode command line tools (`xcode-select --install`).

```bash
npm install -g github:vpatel9202/glovebox
glovebox signing --create   # optional: macOS keeps the grants across helper rebuilds
glovebox setup              # builds the helper, walks through permissions
glovebox doctor             # every line should say ok
glovebox smoke              # a real end-to-end test on Calculator
claude mcp add --scope user glovebox -- glovebox mcp
```

`setup` builds **Glovebox Helper.app** into `~/.glovebox/` and asks you to turn
it on under System Settings > Privacy & Security > **Accessibility** and
**Screen & System Audio Recording**. **Input Monitoring** is optional and only
enables Escape-to-stop. The helper is its own app, so one grant covers every
agent and terminal. Without `signing --create`, macOS treats each rebuild as a
new app; see the [upgrade note](CHANGELOG.md#upgrading) for the reset command.

Other clients, the agent skill file, and shell-only agents:
[docs/agents.md](docs/agents.md).

## How it compares

As of 2026-10. "—" means not documented. Longer comparison and reasoning:
[docs/design.md](docs/design.md).

| | Actions per call | State persists between calls | Default read | Diffed reads | Needs a vendor app |
|---|---|---|---|---|---|
| glovebox | many (one script) | yes | accessibility text | yes | no |
| Codex computer use | many (one script) | yes | accessibility text | yes | yes (Codex app + Computer Use plugin) |
| [lcu](https://github.com/amontlabs/lcu) | — | — | — | — | yes (runs Codex's runtime from the ChatGPT app) |
| [open-computer-use](https://github.com/iFurySt/open-computer-use) | one per tool call | — | app state | — | no |
| [agent-desktop](https://github.com/lahfir/agent-desktop) | one per command (plus a batch command) | refs tied to a snapshot | accessibility tree JSON | no | no |
| [Peekaboo](https://github.com/openclaw/Peekaboo) | one per command | — | screenshot or JSON UI map | — | no |
| Anthropic computer use | several per response, run in order | no | screenshot | no | no (you supply the environment) |

## Why

Many computer-use tools make each action a model round trip, and many return
an image after each one. Codex computer use showed a cheaper shape: a
persistent script session where one call does a whole step and reads come back
as accessibility text diffs. (In one Codex session we traced, 786 calls had a
median script of about 130 characters. That measures Codex, not glovebox.)
glovebox brings that shape to any MCP or shell agent.

## Benchmark

Seven macOS tasks, five runs each, with the same model, prompt, and agent loop
for every setup. Measured 2026-10-28 on one Mac; method and raw results are in
[bench/](bench/README.md).

| Setup | Passed | Model round trips | Images returned | Cost at list price |
|---|---|---|---|---|
| glovebox | 32/35 | 193 | 17 | $0.75 |
| Anthropic computer use | 30/35 | 249 | 198 | $1.83 |
| open-computer-use | 26/35 | 325 | 375 | $3.16 |

![Median round trips and cost per task for each setup](bench/results/chart.svg)

glovebox's three failures were Finder renames where `setValue` changed the
name Finder displayed but not the file. That and the other bugs the run found
are on the [roadmap](docs/roadmap.md#found-by-the-benchmark).

## Status

| Platform | Status |
|---|---|
| macOS 14+ | Works. Tested on macOS 27 (Apple silicon). |
| Windows | Planned (UI Automation). See [roadmap](docs/roadmap.md). |
| Linux | Planned (AT-SPI; Wayland limited). See [roadmap](docs/roadmap.md). |

Run for real, not mocked: `glovebox smoke` and `smoke --full` over MCP
(batched steps, persistent bindings, diffs, pixel clicks, and background
click, drag, and scroll with another app frontmost), and Claude Code attached
through `glovebox mcp`. Full list: [docs/testing.md](docs/testing.md).

## The API in one screen

- `gb.getApp(name)` launches or finds an app without stealing focus. `gb.listApps()`.
- `app.getAXState()` returns the accessibility tree as text; later reads are
  diffs. `{frames: true}` adds element boxes, `{disableDiffing: true}` the full tree.
- `app.getScreenshot()` is the only way to get an image.
- `app.click(target)`, `doubleClick`, `rightClick`, `scroll`, `drag`,
  `setValue`, `focus`, `selectText`, `performSecondaryAction`.
- `app.pressKey("ctrl+a")` uses xdotool names (`super` is Cmd). `app.typeText("text\n")`.
- A target is an element index from the tree or `[x, y]` pixels in the
  window image, which is the screenshot's pixel space.

Full reference: [docs/api.md](docs/api.md), or `help()` inside a session.

## Safety

The first time a session touches an app, you get a dialog: Allow for This
Session, Always Allow, or Deny. Terminals, password managers, System Settings,
and a few others are blocked unless you run `glovebox allow <bundle id>`; the
list is in [SECURITY.md](SECURITY.md#blocked-apps). Switching to another app
stops a running script (Escape too, with Input Monitoring). Every action is
logged to `~/.glovebox/actions.log`.

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
Anthropic, or other vendor binaries.

## Docs

- [docs/api.md](docs/api.md): the scripting API, for agents and script authors.
- [docs/agents.md](docs/agents.md): attaching each MCP client or a shell-only agent.
- [docs/cli.md](docs/cli.md): every subcommand, flag, config key, and environment variable.
- [docs/recipes.md](docs/recipes.md): short scripts to paste into one `js` call.
- [docs/design.md](docs/design.md): decisions and their reasons, for contributors and evaluators.
- [docs/backend-protocol.md](docs/backend-protocol.md): the helper protocol, for porting to a new platform.
- [docs/testing.md](docs/testing.md): unit and smoke tests, and what has been run on real hardware.
- [docs/roadmap.md](docs/roadmap.md): planned work; nothing there is shipped.
- [SECURITY.md](SECURITY.md): what protects you, what does not, and how to report a vulnerability.
- [CONTRIBUTING.md](CONTRIBUTING.md): setup from a clone, tests, and pull request rules.
- [CHANGELOG.md](CHANGELOG.md): changes per release and upgrade notes.

## Development

`npm test` runs the unit tests anywhere (on Node 22+, use
`node --test test/unit.test.mjs` until the script is fixed); `glovebox smoke` and
`glovebox smoke --full` drive real apps on macOS. Setup from a clone and PR
rules: [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
