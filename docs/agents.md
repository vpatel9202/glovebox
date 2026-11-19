# Attaching nostrings to an agent

nostrings speaks MCP over stdio (`nostrings mcp`) and also has a CLI
(`nostrings run`) for agents that can only run shell commands. Both expose the
same persistent JavaScript session.

Install once, then attach to as many agents as you like:

```bash
npm install -g nostrings
nostrings setup     # macOS: builds Nostrings Helper.app and walks through permissions
nostrings doctor    # everything should say ok
nostrings smoke     # optional: a real end-to-end check on Calculator
```

If `nostrings` is not on your PATH (for example, under a version manager), use
the absolute path from `which nostrings`, or run it as
`node /path/to/nostrings/bin/nostrings.mjs mcp`.

The MCP server exposes two tools: `js` (run a script) and `js_reset` (drop the
session). Most agents name them `<server>__js` or `mcp__<server>__js`.

## Claude Code

```bash
claude mcp add --scope user nostrings -- nostrings mcp
```

Check with `/mcp` in a session. To teach Claude the loop, copy the skill:

```bash
mkdir -p ~/.claude/skills && cp -R "$(npm root -g)/nostrings/skills/nostrings" ~/.claude/skills/
```

## Grok CLI

Add to `~/.grok/config.toml`, then start a new session:

```toml
[mcp_servers.nostrings]
command = "nostrings"
args = ["mcp"]
enabled = true
```

Verify with `grok mcp doctor nostrings`. This config, and the OpenCode and
Codex ones below, follow each client's documented MCP format but have not been
exercised end to end. Skill:

```bash
mkdir -p ~/.grok/skills && cp -R "$(npm root -g)/nostrings/skills/nostrings" ~/.grok/skills/
```

## OpenCode

Add to `opencode.json` (project) or `~/.config/opencode/opencode.json` (global):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "nostrings": {
      "type": "local",
      "command": ["nostrings", "mcp"],
      "enabled": true
    }
  }
}
```

## Codex CLI

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.nostrings]
command = "nostrings"
args = ["mcp"]
```

## Gemini CLI, Cursor, and other MCP clients

Most clients accept the common `mcpServers` JSON shape:

```json
{
  "mcpServers": {
    "nostrings": { "command": "nostrings", "args": ["mcp"] }
  }
}
```

## Agents without MCP: the CLI

`nostrings run` sends a script to a background daemon that keeps the session
alive between calls, so bindings persist exactly as they do over MCP.

```bash
nostrings run 'const calc = await ui.getApp("Calculator"); await calc.typeText("2+2="); await calc.getAXState()'
nostrings run 'await calc.getAXState()'          # calc is still bound
nostrings run -f step.js --title "fill form"     # or from a file, or stdin
nostrings reset                                   # drop the bindings
```

Screenshots are written to `~/.nostrings/screenshots/` and the path is printed,
so an agent that can read image files can look at them. Use `--session name`
to keep separate sessions. The daemon exits after an hour idle
(`daemon.idleMinutes` in the config).

## Approval prompts

The first time a session touches an app, nostrings shows a native dialog:
**Allow for This Session**, **Always Allow**, or **Deny**. "Session" means one
MCP connection or one CLI session. To pre-approve apps without dialogs:

```bash
nostrings allow Calculator TextEdit
nostrings approval allowlist   # never prompt; only allowlisted apps work
```

`nostrings approval allow-all` turns prompts off for every app except the
blocked ones (terminals, password managers, and a few others). Those need an
explicit `nostrings allow`. The full list is in
[SECURITY.md](../SECURITY.md#blocked-apps).
