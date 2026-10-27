# Attaching glovebox to an agent

glovebox speaks MCP over stdio (`glovebox mcp`) and also has a CLI
(`glovebox run`) for agents that can only run shell commands. Both expose the
same persistent JavaScript session.

Install once, then attach to as many agents as you like:

```bash
npm install -g github:vpatel9202/glovebox
glovebox setup     # macOS: builds Glovebox Helper.app and walks through permissions
glovebox doctor    # everything should say ok
glovebox smoke     # optional: a real end-to-end check on Calculator
```

If `glovebox` is not on your PATH (for example, under a version manager), use
the absolute path from `which glovebox`, or run it as
`node /path/to/glovebox/bin/glovebox.mjs mcp`.

The MCP server exposes two tools: `js` (run a script) and `js_reset` (drop the
session). Most agents name them `<server>__js` or `mcp__<server>__js`.

## Claude Code

```bash
claude mcp add --scope user glovebox -- glovebox mcp
```

Check with `/mcp` in a session. To teach Claude the loop, copy the skill:

```bash
mkdir -p ~/.claude/skills && cp -R "$(npm root -g)/@vpatel9202/glovebox/skills/glovebox" ~/.claude/skills/
```

## Grok CLI

Add to `~/.grok/config.toml`, then start a new session:

```toml
[mcp_servers.glovebox]
command = "glovebox"
args = ["mcp"]
enabled = true
```

Verify with `grok mcp doctor glovebox`. Skill:

```bash
mkdir -p ~/.grok/skills && cp -R "$(npm root -g)/@vpatel9202/glovebox/skills/glovebox" ~/.grok/skills/
```

## OpenCode

Add to `opencode.json` (project) or `~/.config/opencode/opencode.json` (global):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "glovebox": {
      "type": "local",
      "command": ["glovebox", "mcp"],
      "enabled": true
    }
  }
}
```

## Codex CLI

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.glovebox]
command = "glovebox"
args = ["mcp"]
```

## Gemini CLI, Cursor, and other MCP clients

Most clients accept the common `mcpServers` JSON shape:

```json
{
  "mcpServers": {
    "glovebox": { "command": "glovebox", "args": ["mcp"] }
  }
}
```

## Agents without MCP: the CLI

`glovebox run` sends a script to a background daemon that keeps the session
alive between calls, so bindings persist exactly as they do over MCP.

```bash
glovebox run 'const calc = await gb.getApp("Calculator"); await calc.typeText("2+2="); await calc.getAXState()'
glovebox run 'await calc.getAXState()'          # calc is still bound
glovebox run -f step.js --title "fill form"     # or from a file, or stdin
glovebox reset                                   # drop the bindings
```

Screenshots are written to `~/.glovebox/screenshots/` and the path is printed,
so an agent that can read image files can look at them. Use `--session name`
to keep separate sessions. The daemon exits after an hour idle
(`daemon.idleMinutes` in the config).

## Approval prompts

The first time a session touches an app, glovebox shows a native dialog:
**Allow for This Session**, **Always Allow**, or **Deny**. "Session" means one
MCP connection or one CLI session. To pre-approve apps without dialogs:

```bash
glovebox allow Calculator TextEdit
glovebox approval allowlist   # never prompt; only allowlisted apps work
```

`glovebox approval allow-all` turns prompts off for every app except the
blocked ones (terminals, password managers, System Settings, Script Editor).
Those need an explicit `glovebox allow <bundle id>`.
