## Read this first

Author-run, on one Mac, in one sitting (2026-11-03), with two runs per task. The
author also designed the tasks, and `bulk-entry`, `remote-desktop`, and
`coexistence` were written around things glovebox set out to do. Pass counts at
this size are not significant (24/24 against 20/24 is about p = 0.055, one-sided).
The per-task cost comparison is the sturdier result.

What the labels mean:

- **Anthropic toolset, run by glovebox** is Anthropic's API computer-use toolset
  (`computer_toolset_20260801`), executed through glovebox's foreground route with
  window screenshots. It is not Claude Code's built-in computer use, which was not
  tested. Its `coexistence` failures come from that route.
- **Codex cua_repl, driven by Claude** is the tool from the ChatGPT app under
  Claude Sonnet. It measures the tool's shape, not Codex with its own model.

Changes during the run:

- Peekaboo's rep 1 first ran background-only (9/12, kept in `results/pilot/`), then
  the harness was changed to `--allow-foreground` and rep 1 was recorded again
  (10/12). The change favored Peekaboo.
- Both `bulk-entry × peekaboo` failures stopped at the $0.75 per-run budget cap
  (`stopReason: "run-cap"`), not on a wrong result.
- The harness commit changed twice mid-file (721c756, 85edbf3, 93264b8). Bench files
  only; `src/` and `native/` did not change.
- agent-desktop ran through its CLI, not its MCP mode.
- Result files say glovebox 0.2.0. The code is what was released as 0.3.0.
