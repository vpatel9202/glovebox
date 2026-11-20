# nostrings

[![CI](https://github.com/vpatel9202/nostrings/actions/workflows/test.yml/badge.svg)](https://github.com/vpatel9202/nostrings/actions/workflows/test.yml)
[![npm](https://img.shields.io/npm/v/nostrings.svg)](https://www.npmjs.com/package/nostrings)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platforms: macOS, Android](https://img.shields.io/badge/platforms-macOS%20%7C%20Android-lightgrey.svg)](#requirements-and-limits)

**Computer use for coding agents, with no strings attached.** Your agent
writes a few lines of JavaScript per step to drive your Mac apps and your
Android phone. It reads the accessibility tree as text diffs, not screenshots.
Input goes to apps in the background, so your mouse, keyboard and screen stay
yours.

![Someone browses Wikipedia in Safari while an agent works Calculator and types the result into TextEdit in the background](https://raw.githubusercontent.com/vpatel9202/nostrings/main/media/demo.gif)

```bash
npm install -g nostrings && nostrings init
```

`init` builds the Mac helper, asks for each macOS permission, finds your
agents (Claude Code, Codex, Cursor, Gemini CLI, Grok CLI, OpenCode), shows you
the config change for each and asks first, then runs a 20-second test.

## What a step looks like

One `js` tool call. The agent binds Calculator, types, and reads once:

```js
const calc = await ui.getApp("Calculator");
await calc.pressKey("Escape");
await calc.typeText("6*7=");
await calc.getAXState();
```

```
Calculator — window 0 "Calculator" — image 460x816 — changes since last read (~ changed, + added):
~					8 scroll area id=StandardInputView;value:42
~						9 text "Edit field" value="42"
```

On the next call `calc` is still bound, and the read shows only what changed.
The same session reaches your phone:

```js
const clock = await ui.device().getApp("Clock");   // Android, over adb
await clock.getAXState();
```

- **A script per step, not a tool call per click.** Bindings and helper
  functions persist across calls, so one call can click, type, loop, check and
  read.
- **Diffs, not screenshots.** The default read is the accessibility tree as
  text; later reads show only changes. When the tree is empty (remote
  desktops, canvases), `app.ocr()` reads the screen as text with clickable positions,
  also diffed, so even remote desktops rarely need an image.
- **Background by default.** Keys, clicks, drags and scrolls reach the app
  while you keep working in another one. On Android 14+ apps run on a hidden
  screen, so the phone's own screen is left alone.
- **Mac and phone in one script.** A script can read a code from the phone's
  notifications and type it into a Mac app, with variables shared between
  the two.
- **Saved scripts.** Once a task works, the agent saves it, and you rerun it
  by name with no model at all: `nostrings script calc expr=1234*5678`.

In an [author-run test](#benchmark) of six setups on 12 macOS tasks,
nostrings had the lowest total cost, $0.57 against $1.41 to $5.67, the fewest
round trips, and the most passes. Read the caveats before quoting it.

## Quickstart

Requires Node 20.10+. For the Mac side, also the Xcode command line tools
(`xcode-select --install`).

```bash
npm install -g nostrings
nostrings init
```

Then start a new agent session and ask:

> Use nostrings to open Calculator, work out 1234 * 5678, and tell me the result.

With a phone or emulator in `adb devices`:

> Use nostrings to open Clock on my phone and read the alarms.

**Android only?** `nostrings init --android-only` skips the Mac helper; Android
needs nothing but `adb`. **Prefer to do it by hand?** `nostrings setup`,
`nostrings doctor`, `nostrings smoke`, then
`claude mcp add --scope user nostrings -- nostrings mcp`. Every client's
config is in [docs/agents.md](docs/agents.md), and any agent that can run a
shell command can use `nostrings run` instead of MCP.

On a Mac, setup builds **Nostrings Helper.app** into `~/.nostrings/` and asks
you to turn it on under System Settings > Privacy & Security >
**Accessibility**, then **Screen & System Audio Recording**. The helper is its
own app, so one grant covers every agent and terminal. **Input Monitoring** is
optional (`nostrings setup --input-monitoring`) and only lets Escape stop a
script.

## Saved scripts

The part that keeps paying off. When a multi-step task works, the agent can
save it:

```js
ui.scripts.save("calc", `
const calc = await ui.getApp("Calculator");
await calc.pressKey("Escape");
await calc.typeText(args.expr + "=");
await calc.settle();
return (await calc.find({role: "text", label: "Edit field"}))?.value;
`, "Work out an expression in Calculator. args: expr");
```

From then on it is one call in any session, `await ui.scripts.run("calc",
{expr: "12*34"})`, or one command from any shell, with no model, tokens or
waiting on a reply:

```bash
nostrings script calc expr=12*34
nostrings scripts              # what you have saved
nostrings scripts --examples   # add the examples, including Mac + phone ones
```

Scripts are files in `~/.nostrings/scripts/` that you can read, edit and
share, and they never run unless called. See [examples/](examples/README.md).

## Benchmark

Twelve macOS tasks, six setups, two runs each, 2026-11-03. Same model (Claude
Sonnet 5.5, medium effort), prompt, and agent loop for every setup; only the
tool changes. Task prompts name no tool, and a separate check that doesn't use
the tool under test decides each result.

| Setup | Passed | Round trips | Images returned | Cost at list price |
|---|---|---|---|---|
| nostrings | 24/24 | 128 | 21 | $0.57 |
| Codex `cua_repl`, driven by Claude | 20/24 | 166 | 30 | $1.41 |
| Anthropic toolset, run by nostrings | 22/24 | 187 | 179 | $1.65 |
| agent-desktop | 22/24 | 204 | 22 | $2.32 |
| open-computer-use | 21/24 | 244 | 385 | $2.76 |
| Peekaboo | 20/24 | 359 | 183 | $5.67 |

![Median round trips and cost per task for each setup](bench/results/v2/chart.svg)

**Where nostrings did not win.** It was not cheapest on `finder-rename`
($0.061 against $0.041 for Codex `cua_repl`). It did not have the fewest round
trips on 3 of the 12 tasks, or the fastest time on 3 of the 12. On
`remote-desktop` it took 36 seconds against 22 and 23 for two others.

<details>
<summary><b>How much to trust this</b></summary>

- I wrote the tasks and ran the test, on one Mac, in one sitting. Several tasks
  (`bulk-entry`, `remote-desktop`, `coexistence`) were designed around things
  nostrings set out to do.
- With two runs per task, pass counts mean little: 24/24 against 20/24 is not
  statistically significant. The cost gap is the sturdier result, because it
  holds task by task: nostrings cost less than each other setup on at least 11
  of 12 tasks.
- The version tested is 0.3.0, when the project was called glovebox. Result
  files say 0.2.0, because the version had not been bumped yet. Android was
  not part of the test.
- "Anthropic toolset" is Anthropic's API computer-use toolset, executed through
  nostrings's foreground route. It failed `coexistence` because of that route,
  so that result doesn't describe a shipping product. "Codex `cua_repl`" measures
  the tool shape under Claude, not Codex with its own model.
- Peekaboo's first pass was rerun with foreground input allowed, which helped
  it. Its two `bulk-entry` failures were my $0.75 per-run budget cap stopping
  the run. agent-desktop ran through its CLI, not its MCP mode.
- Claude Code's built-in computer use was not in the test.

Method, per-task numbers, and raw results: [bench/](bench/README.md) and
[bench/results/v2/summary.md](bench/results/v2/summary.md).

</details>

## Why not Claude Code's built-in computer use?

If it fits your setup, it is the easier choice: nothing to install, supported
by Anthropic, and it keeps your terminal out of screenshots. nostrings is for
the cases where it does not fit. From [Anthropic's docs](https://code.claude.com/docs/en/computer-use),
checked 2026-11-03:

| | Claude Code built-in | nostrings |
|---|---|---|
| Your other apps | Hidden while Claude works | Stay visible; input goes to the target app in the background |
| Default read | Downscaled screenshot | Accessibility text diff |
| Your phone | No | Android over adb (experimental) |
| Who can use it | Pro, Max, or Ultra through claude.ai; not Team, Enterprise, Bedrock, Google Cloud, or Foundry | Anyone; it never talks to a model or an account |
| Scripted runs | Not in `-p` mode | Saved scripts run with no model; the benchmark drove it unattended |
| Sessions | One at a time, enforced by a lock file | No global lock; named sessions run side by side |
| Remembering approvals | This session only | Allow for This Session or Always Allow |
| Browsers | View-only | Full control once you approve the browser, which is more power and more risk |

This compares documented behavior, not measured results.

## How it compares

Checked against each project's README and docs on 2026-11-03; the last three
rows on 2026-11-19. "—" means I could not confirm it from those.

| | Platforms | Actions per call | State between calls | Default read | Diffed reads | Background input | Needs |
|---|---|---|---|---|---|---|---|
| **nostrings** | macOS, Android (experimental) | many (one script) | persistent JS session | accessibility text | yes | yes | Xcode CLT to build the Mac helper; `adb` for Android |
| Claude Code built-in | macOS (CLI) | — | — | screenshot | — | no, hides other apps | Pro, Max, or Ultra |
| Codex computer use | macOS, Windows | many (one script) | persistent JS session | accessibility text | yes | yes on macOS | ChatGPT app and plugin |
| [lcu](https://github.com/amontlabs/lcu) | macOS (Apple silicon), Linux | as Codex; it runs Codex's runtime | as Codex | as Codex | as Codex | — | ChatGPT app installed |
| [agent-desktop](https://github.com/vercel-labs/agent-desktop) | macOS, Windows, Linux | one per command, plus `batch` | refs tied to a snapshot | accessibility tree JSON | — | yes | Homebrew or npm |
| [Peekaboo](https://github.com/openclaw/Peekaboo) | macOS 15+ | one per command | element IDs from a snapshot | screenshot or JSON UI map | — | yes | Homebrew or npm |
| [open-computer-use](https://github.com/iFurySt/open-computer-use) | macOS, Linux, Windows | one per MCP call; CLI has sequences | — | app state | — | — | npm |
| [computer-use-mcp](https://github.com/minghinmatthewlam/computer-use-mcp) | macOS 14+ | one per call | element IDs | screenshot and tree per action | — | yes | notarized binary |
| [cua-driver](https://github.com/trycua/cua) | macOS, Windows, Linux | — | — | — | — | yes | see its docs |
| [native-devtools-mcp](https://github.com/sh3ll3x3c/native-devtools-mcp) | macOS, Windows, Android, Chrome/Electron | one per call | — | — | — | yes on macOS (AX dispatch) | npm |
| [OpenComputerUse](https://github.com/IAmJSD/OpenComputerUse) | macOS, Linux, Windows, Android, iOS | one per call, plus step lists and recipes | session ids | — | — | yes | Homebrew or a binary |
| [mobile-mcp](https://github.com/mobile-next/mobile-mcp) | Android, iOS (no desktop) | one per call | — | — | — | n/a | npm |

**Pick something else if** you need Windows or Linux (agent-desktop, cua-driver,
lcu), iOS (mobile-mcp, OpenComputerUse), a notarized binary with no build step
(computer-use-mcp), or want OpenAI's actual runtime and already have the
ChatGPT app (lcu).

## Safety

The first time a session touches an app, you get a dialog: Allow for This
Session, Always Allow, or Deny. Nothing is blocked outright. Terminals,
password managers, System Settings, messaging apps, and a few others always
ask, even under `allow-all`, unless you run `nostrings allow <bundle id>`; the
list is in [SECURITY.md](SECURITY.md#ask-first-apps). A script that had to bring
an app forward stops if you switch away. Scripts running in the background keep
going while you use other apps, and Escape stops any script if you grant Input
Monitoring. On Android, apps and screens that can move money, read messages
or codes, or change settings ask first in the same way, and so does reading
notifications. Every action is logged to `~/.nostrings/actions.log`.

An approved app is approved for everything in it: allowing a browser lets the
agent use every site you are signed in to. nostrings does not screen page
content for prompt injection. Treat it like giving someone remote control of
that app. Details: [SECURITY.md](SECURITY.md).

## Requirements and limits

| Platform | Status |
|---|---|
| macOS | Works. Built for macOS 14+; tested only on macOS 27 (Apple silicon). |
| Android | Experimental. Hidden-screen sessions on Android 14+ (API 34); the phone's own screen below that. Tested on emulators API 34 to 37 and a Galaxy S24. |
| Windows | Planned (UI Automation). [Help wanted](#contributing). |
| Linux | Planned (AT-SPI; Wayland limited). [Help wanted](#contributing). |

- You build the Mac helper locally with the Xcode command line tools; there
  is no notarized binary yet.
- Background input on the Mac uses two private macOS calls, with a
  foreground fallback.
- Only Claude Code has been tested end to end. The other clients' configs
  follow their documented formats.
- Known issue: while a background app's pop-up menu is open, macOS sends your
  keystrokes to that app ([details](docs/api.md#known-limits)).
- nostrings was called glovebox until 0.5.0
  ([upgrade notes](CHANGELOG.md#upgrading-from-glovebox)).

What has been run on real hardware, and how: [docs/testing.md](docs/testing.md).

## How it works

```
agent ──MCP stdio──▶ nostrings mcp ──▶ kernel (persistent JS session)
agent ──shell──▶ nostrings run ──▶ daemon ──▶ kernel
                                                │
                       ┌── Unix socket ─────────┴──────── adb ──┐
                       ▼                                        ▼
       Nostrings Helper.app (Swift: AX,       nostrings server on the phone
       CGEvent, ScreenCaptureKit, dialogs)    (Java, shell user: accessibility,
                                              input, hidden virtual displays)
```

Background input on the Mac uses two private macOS (SkyLight) functions,
looked up at runtime with a foreground fallback; `nostrings doctor` reports
which route you have. On Android, a small server runs with shell privileges
over ADB. It is a file pushed to the phone, not an installed app.
Everything else is public API. No OpenAI, Anthropic, or other vendor binaries.

## The API in one screen

- `ui.getApp(name)` launches or finds an app without stealing focus. `ui.listApps()`.
- `ui.device()` is an Android phone with the same `getApp` and app methods.
- `app.getAXState()` returns the accessibility tree as text; later reads are
  diffs. `{frames: true}` adds element boxes, `{disableDiffing: true}` the full tree.
- `app.find(query)`, `app.nodes()`, `app.text(i)` look things up silently;
  `app.expect(query)` checks a step inside a script.
- `app.click(target)`, `doubleClick`, `rightClick`, `scroll`, `scrollTo`,
  `drag`, `setValue`, `focus`, `selectText`, `menu(["File", "Export…"])`.
- `app.pressKey("ctrl+a")` uses xdotool names (`super` is Cmd). `app.typeText("text\n")`.
- `app.getScreenshot()` is the only way to get an image; `app.ocr()` reads
  text from screens the tree cannot describe.
- `ui.scripts.save / list / run` for saved scripts; `ui.clipboard`,
  `ui.notifications()`, `ui.screenshot()` for the rest of the Mac.
- A target is an element index from the tree or `[x, y]` pixels in the
  window image, which is the screenshot's pixel space.

Full reference: [docs/api.md](docs/api.md), or `help()` inside a session.

## Contributing

The most wanted contributions are a **Windows** or **Linux** backend. A
backend is one native program that speaks JSON lines, and
`nostrings conformance` checks it without a Mac; start with
[Porting a backend](CONTRIBUTING.md#porting-a-backend). New
[example scripts](examples/README.md) are the easiest first pull request.
Questions and ideas go in
[Discussions](https://github.com/vpatel9202/nostrings/discussions).

## Docs

- [docs/api.md](docs/api.md): the scripting API, for agents and script authors.
- [docs/agents.md](docs/agents.md): attaching each MCP client or a shell-only agent.
- [docs/cli.md](docs/cli.md): every subcommand, flag, config key, and environment variable.
- [docs/recipes.md](docs/recipes.md) and [examples/](examples/README.md): scripts to copy.
- [docs/design.md](docs/design.md): decisions and their reasons.
- [docs/backend-protocol.md](docs/backend-protocol.md): the backend contract, for ports.
- [docs/testing.md](docs/testing.md): what has been run on real hardware.
- [docs/roadmap.md](docs/roadmap.md): planned work; nothing there is shipped.
- [SECURITY.md](SECURITY.md), [CONTRIBUTING.md](CONTRIBUTING.md), [CHANGELOG.md](CHANGELOG.md).

## License

MIT
