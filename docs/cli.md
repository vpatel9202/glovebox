# CLI reference

`glovebox` is one executable (`bin/glovebox.mjs`). This page lists every
subcommand and flag, the environment variables, the config file, the two MCP
tools, and how the helper and daemon start and stop. For attaching an agent
see `agents.md`; for the scripting API see `api.md`.

Run `glovebox` with no arguments, `help`, `-h`, or `--help` to print usage.
A failing command exits with status 1.

## Subcommands

| Command | What it does |
|---|---|
| `glovebox setup [--rebuild] [--restart]` | Builds Glovebox Helper if it is missing or its source changed, then walks through Accessibility and Screen Recording, one at a time, and offers Input Monitoring. Exits 1 if the first two are not granted. macOS only. |
| `glovebox signing [--create]` | Reports whether the local signing certificate exists. With `--create`, makes it in the login keychain. Run `setup --rebuild` afterwards to re-sign. macOS only. |
| `glovebox doctor` | Checks Node (20.10+), the config, the helper build, that the helper answers, background input, Accessibility, Screen Recording, and Input Monitoring. Exits 1 on any `FAIL`. |
| `glovebox mcp` | Runs the stdio MCP server (tools `js`, `js_reset`). |
| `glovebox run [code] [-f file] [-s name] [-t title] [--timeout ms]` | Runs a script in a persistent CLI session and prints the result. |
| `glovebox reset [-s name]` | Drops a CLI session's bindings. |
| `glovebox stop` | Stops the CLI daemon and every session in it. |
| `glovebox smoke [--full]` | End-to-end test on Calculator. See `testing.md`. |
| `glovebox allow <app>...` | Adds apps to `allow`, and removes them from `deny`. |
| `glovebox deny <app>...` | Adds apps to `deny`, and removes them from `allow`. |
| `glovebox revoke <app>...` | Removes apps from both lists. |
| `glovebox approval <ask\|allowlist\|allow-all>` | Sets `approval` in the config. |
| `glovebox config` | Prints the effective configuration as JSON: defaults, then the config file, then `GLOVEBOX_APPROVAL`. |
| `glovebox log [-n N]` | Prints the last N (default 20) lines of the action log. |
| `glovebox version` | Prints the version. Also `--version` and `-v`. |
| `glovebox daemon` | Internal. Runs the CLI daemon; `run` starts it when needed. Do not call it directly. |

### Flags

| Flag | Applies to | Meaning |
|---|---|---|
| `-f`, `--file path` | `run` | Read the script from a file. |
| `-s`, `--session name` | `run`, `reset` | Session name. Default `default`. Each name has its own bindings. `stop` ignores it. |
| `-t`, `--title text` | `run` | A few words naming the step, written to the action log as `step`. |
| `--timeout ms` | `run` | Time limit for the script. Default is `timeoutMs` from the config (120000). |
| `--rebuild` | `setup` | Rebuild the helper even if its source is unchanged. Quits a running helper first. |
| `--restart` | `setup` | Quit the running helper so it relaunches with new grants (needed after enabling Input Monitoring). |
| `--create` | `signing` | Create the certificate `glovebox local signing` if it does not exist. |
| `--full` | `smoke` | Also run the background click, drag, and scroll checks in TextEdit. |
| `-n N` | `log` | Number of lines. |

Notes:

- `run` takes code from the arguments (joined with spaces), else from
  `-f file`, else from stdin. With none of them it exits with an error. Text
  results print to stdout; screenshots are saved under
  `~/.glovebox/screenshots/` and the path is printed. Exit status is 1 if the
  script failed or was stopped.
- `run` starts the daemon if none is listening. `reset` and `stop` do not; with
  no daemon they print `No daemon running.`
- `allow`, `deny`, and `revoke` match names and bundle ids case-insensitively,
  rewrite `config.json`, and do not affect approvals a running session already
  holds. Use `glovebox reset` or `js_reset` to make a session re-check.
- `approval allow-all` prints a warning: every app except the blocked ones is
  then controllable without asking.
- `setup` and `signing` are macOS only; elsewhere they exit with an error.

## Environment variables

| Variable | Effect |
|---|---|
| `GLOVEBOX_HOME` | State directory. Default `~/.glovebox`. Holds `config.json`, `actions.log`, `screenshots/`, `daemon.sock`, `helper.sock`, and `Glovebox Helper.app`. The helper receives it when glovebox launches it. |
| `GLOVEBOX_APPROVAL` | Overrides `approval` (`ask`, `allowlist`, `allow-all`) without editing the file. glovebox passes it to the helper when it launches it; a helper that is already running keeps the value it started with. |
| `GLOVEBOX_SOCKET` | Path of the helper's socket. Default `$GLOVEBOX_HOME/helper.sock`. Also passed to the helper at launch. It does not move the CLI daemon's socket. |
| `GLOVEBOX_CLIENT` | Name of the agent, shown in the approval dialog and menu-bar item and written to the log as `client`. `glovebox run` sends it when it creates a session; the default is `glovebox CLI (<session>)`. Over MCP the name is the client's own `clientInfo.name`. |
| `GLOVEBOX_DEBUG` | When set, the session process's stderr is copied to the host's stderr. Useful with `glovebox mcp`; the CLI daemon runs detached with no stderr. |

glovebox also sets `GLOVEBOX_IMAGE_MODE` (`inline` over MCP, `file` over the
CLI) on its session processes. It is internal.

## Config file

Location: `$GLOVEBOX_HOME/config.json` (default `~/.glovebox/config.json`),
created with mode 0600 by `allow`, `deny`, `revoke`, `approval`, or the
"Always Allow" button. A missing file means all defaults; a file that is not
valid JSON is an error. Any subset of keys may be set. Nested objects are
merged key by key; arrays and scalars replace the default.

| Key | Default | Meaning |
|---|---|---|
| `approval` | `"ask"` | `ask`: native dialog on first use of each app per session. `allowlist`: never prompt; only apps in `allow` work. `allow-all`: no prompts; blocked apps still need `allow`. |
| `allow` | `[]` | App names or bundle ids that are always approved. Also unlocks blocked apps. |
| `deny` | `[]` | App names or bundle ids that are always refused. Wins over `allow`. |
| `input` | `"background"` | `background`: input reaches apps without focusing them, with a foreground fallback. `foreground`: always bring the app forward. |
| `foregroundApps` | `[]` | App names or bundle ids that always use the foreground route. |
| `cursor` | `true` | Draw the agent cursor where actions land. `false` turns it off. |
| `screenshot.maxLongSide` | `1568` | Longest side of a window image, in pixels. |
| `screenshot.maxPixels` | `1150000` | Pixel budget of a window image. |
| `screenshot.format` | `"png"` | `png` or `jpeg`. |
| `screenshot.quality` | `80` | JPEG quality as a percentage. Ignored for PNG. |
| `ax.maxNodes` | `800` | Elements per `getAXState` read. |
| `ax.maxDepth` | `40` | Tree depth per read. |
| `ax.maxTextLength` | `160` | Longest label or value kept, in characters. |
| `log.enabled` | `true` | Write `actions.log`. |
| `log.text` | `false` | Log typed text instead of only its length. |
| `daemon.idleMinutes` | `60` | The CLI daemon exits after this long without requests. `0` never exits. |
| `timeoutMs` | `120000` | Default script time limit for `js` and `run`. |
| `settleMs` | `80` | Pause after each action, in milliseconds. Not in the defaults, so not shown by `glovebox config`. |

`screenshot.maxLongSide` and `maxPixels` set the image scale; see "Coordinates
and images" in `design.md`. Check order for each app: `deny`, `allow`, the
blocked list (`SECURITY.md`), then `approval`.

When changes apply: the session process reloads the config before every call,
and the helper reads it on every approval check. The CLI daemon reads it once
at startup, so `timeoutMs` and `daemon.idleMinutes` need `glovebox stop`.

## MCP tools

`glovebox mcp` speaks MCP over stdio and exposes two tools. The session starts
on the first `js` call and lives until `js_reset` or the connection closes.

| Tool | Parameters | Notes |
|---|---|---|
| `js` | `code` (string, required), `title` (string), `timeout_ms` (integer) | Runs `code` in the persistent session. `title` names the step in the action log. `timeout_ms` defaults to `timeoutMs`; a value that is not a positive integer is ignored. Result content is text, plus inline images for screenshots; `isError` is true if the script threw or was stopped. |
| `js_reset` | none | Restarts the session and drops every binding. |

On timeout the script is asked to stop at its next action and the result says
`Stopped: the script ran longer than N ms.` If it has not stopped five seconds
later, the session process is killed and the bindings are lost.

## Helper and daemon lifecycle

Glovebox Helper (macOS):

- `setup` builds it into `$GLOVEBOX_HOME/Glovebox Helper.app`. It is rebuilt
  only when its source changes; until then, or after an upgrade, clients fail
  with a message to run `glovebox setup`.
- The first client request launches it through LaunchServices; no agent has to
  start it. It listens on `helper.sock`, mode 0600, and refuses other users.
- While at least one client is connected it shows a menu-bar item with the
  connected sessions and their approved apps, and the entries Stop Running
  Scripts, Revoke Session Approvals, Hide Agent Cursor, and Quit Glovebox
  Helper.
- It quits by itself after 30 minutes with no connected clients, checked once a
  minute. The next client relaunches it. Quit Glovebox Helper, `setup
  --restart`, and `setup --rebuild` also stop it.

CLI daemon:

- `glovebox run` starts it on first use, detached, listening on
  `$GLOVEBOX_HOME/daemon.sock` (mode 0600).
- Each session name is its own session process, created by the first `run`
  that names it.
- It exits after `daemon.idleMinutes` of no requests, or on `glovebox stop`.
  Its sessions go with it.
