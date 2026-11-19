# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:1105d646 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/core-concepts/sync-concepts.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->


## Build & Test

```bash
npm install
npm test                                  # unit tests, no GUI, any OS
node bin/nostrings.mjs setup --rebuild    # rebuild the macOS helper after Swift changes
node bin/nostrings.mjs smoke              # Calculator, real GUI (macOS)
node bin/nostrings.mjs smoke --macos      # 51 checks on Nostrings Fixture
npm run build:android                     # Android server and test apps (SDK + JDK)
node bin/nostrings.mjs smoke --android --serial emulator-5554
```

Smoke tests drive real apps: read docs/testing.md first. On the maintainer's
Mac, test Android on the API 36 emulator only and always pass `--serial`; a
real phone may also be connected.

## Architecture Overview

nostrings is a persistent JavaScript session for driving GUIs. `src/mcp.mjs`
(MCP stdio) and `src/daemon.mjs` (CLI) host `src/session.mjs`, which runs
`src/kernel.mjs` in its own process. The kernel evaluates cells in a `vm`
context with the `ui` API from `src/api.mjs`. Backends speak the protocol in
docs/backend-protocol.md: `src/backends/macos.mjs` talks to the Swift helper
(`native/macos/NostringsHelper.swift`) over a Unix socket, and
`src/backends/android.mjs` talks to a Java server (`native/android/`) over
ADB. `src/axformat.mjs` formats and diffs trees; `src/approval.mjs` decides
which apps need a dialog. More in docs/design.md.

## Conventions & Patterns

- Plain ESM JavaScript, Node 20.10+, one dependency (acorn). No build step.
- No claim in docs without a run behind it: say what was tested, on what.
- Changing the Swift helper changes its source hash; the next session asks
  for `setup` (a rebuild), which may show a keychain prompt.
- Never fire two macOS privacy prompts at once; macOS drops the second.
- Releases: `npm run version:bump X.Y.Z`, commit "Release X.Y.Z: ...", tag
  `vX.Y.Z`, push; CI publishes npm (trusted publishing), the MCP Registry and
  the GitHub release.
