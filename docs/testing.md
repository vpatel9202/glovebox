# Testing

glovebox has two kinds of tests. Unit tests cover the pure parts and run
anywhere. The smoke test drives real apps through the real MCP server and
helper, so it runs only on macOS with the helper built and permissions granted.
Nothing in the smoke test is mocked.

## What has been run for real on macOS 27 (Apple silicon)

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

The Grok, OpenCode, and Codex configs in `agents.md` follow each client's
documented MCP format but have not been exercised end to end yet.

## Unit tests

```bash
npm test    # node --test test/
```

`test/unit.test.mjs` needs only Node. It checks:

- cell rewriting: top-level bindings persist across cells and can be
  redeclared; destructuring and imports become bindings; a rejected top-level
  `await` rejects instead of hanging; syntax errors report a line.
- key parsing: xdotool chords, modifier aliases, and unknown modifiers.
- tree text: compact lines, and diffs keyed by element index (`~`, `+`,
  removed).
- image space: window pixels round-trip to screen points, and large windows
  are scaled to the pixel budget.

## Smoke test

```bash
glovebox smoke
```

Starts `glovebox mcp` as a client would and works on Calculator. It prints one
`PASS` or `FAIL` line per check and exits 0 only if all pass. Calculator's
state changes during the run. The first time, macOS may ask to approve
Calculator for "glovebox smoke"; run `glovebox allow Calculator TextEdit`
first to skip the dialogs. Checks:

1. MCP handshake: the server is named `glovebox` and lists two tools.
2. A batched call types `6*7=` and the read shows `42`.
3. The binding persists to the next call; clicking by element index computes
   `7+1=8`; the read is a diff ("changes since last read").
4. A pixel click at an element's `center()` presses the `9` key.
5. A screenshot is one image whose size equals `calc.view`, the pixel space
   clicks use.
6. `js_reset` drops the binding: `typeof calc` is `undefined`.
7. The frontmost app was the same before and after (checked with
   `osascript`; skipped if it cannot run).

```bash
glovebox smoke --full
```

Runs the checks above, then writes two temporary text files, opens them in
TextEdit without activating it (`open -g`), and checks raw mouse input in the
background:

1. A pixel click places the caret: typing `Y` lands at the start of the text.
2. A drag selects text: typing `Q` replaces the selection.
3. A scroll moves the view: a scroll bar's value changes on a 300-line file.

The frontmost-app check then covers these steps too. The two documents stay
open in TextEdit; close them without saving (the temp directory is printed).
For a meaningful result, keep some other app frontmost while it runs.
