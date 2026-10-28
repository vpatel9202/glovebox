# glovebox benchmark

Runs the same seven macOS tasks through three computer-use setups with the
same model, prompt, and agent loop, and records what each run costs. Results
are raw JSON lines in `results/raw/`, one per run.

This folder is not part of the published package.

## Setups

| Setup | What the model gets | Notes |
|---|---|---|
| `glovebox` | The `js` and `js_reset` tools from `glovebox mcp` | Exactly what an MCP client sees. |
| `cu` | Anthropic's computer use toolset (`computer_toolset_20260801`) | Screenshot-first. Actions run through a glovebox session on its foreground route (window screenshots, raw pixel clicks, keys to the frontmost app), like Anthropic's reference environment, which drives a real display. |
| `ocu` | The 10 tools from [open-computer-use](https://github.com/iFurySt/open-computer-use) 1.1.2 (`ocu mcp`) | One action per call over the accessibility tree. |

Choices that affect the comparison:

- **Same loop for all three.** `lib/agent.mjs` calls the Messages API
  directly with adaptive thinking, one `effort` level, and automatic prompt
  caching. History is append-only: nothing is pruned or summarized.
- **System prompt.** One short prompt for every setup, plus the MCP server's
  own `instructions` when it sends them. All other guidance comes from each
  setup's tool descriptions.
- **Screenshot-first sees one window.** The `cu` screenshot is the target
  app's focused window at glovebox's capture size (1568 px long side), not the
  whole display. On macOS 27 that capture includes the app's open menus. It is
  cheaper than a full-display screenshot, so it favors `cu`. Members the
  executor can't run (`zoom`, `left_mouse_down`, `left_mouse_up`, `hold_key`,
  `middle_click`) are withheld through `configs`.
- **Why foreground input for `cu`.** glovebox's background pixel clicks don't
  reach an open pop-up menu (a known glovebox gap; its accessibility route
  works). Charging that to the screenshot-first baseline would be unfair.
- **No refusal fallback.** A fallback model would mix two models in one
  measurement, so a refusal counts as a failed run.
- **Verification never uses the tool under test.** Each task checks files,
  `defaults`, or the fixture app's output file. Calculator's display is read
  by a separate glovebox session that the model never sees.

## Tasks

| Task | App | Kind | Verified by |
|---|---|---|---|
| `calculator` | Calculator | text | display shows 68315 |
| `textedit-edit` | TextEdit | text | saved file contents |
| `finder-rename` | Finder | text | folder listing |
| `textedit-setting` | TextEdit settings | text | `defaults read com.apple.TextEdit RichText` |
| `form` | Bench Fixture (form) | text | fixture output file |
| `canvas` | Bench Fixture (canvas) | pixel | fixture output file |
| `form-repeat` | Bench Fixture (form) | text | fixture output file, three records |

`fixture/BenchFixture.swift` is a small AppKit app built on first run into
`.build/`. Its canvas draws numbered tiles with no accessibility children,
standing in for a remote desktop or a game. `form-repeat` is the replay
baseline: the same form three times in one conversation, with round trips
recorded per repetition.

Task files live in `~/glovebox-bench/`. The harness touches only its own
documents and windows. It closes TextEdit only when no other document is open,
and restores the TextEdit default-format setting and your glovebox config when
it finishes.

## Running

One-time setup:

```bash
cd bench && npm install
```

```bash
bench/node_modules/.bin/ocu doctor
```

`ocu doctor` asks you to grant Accessibility and Screen Recording to Open
Computer Use. Put your API key in `bench/.env` (gitignored) as
`ANTHROPIC_API_KEY=...`, or export it.

Check every task and setup without calling the model:

```bash
node bench/run.mjs --dry-run
```

Run the pilot, one pass of every task through every setup, capped at $10:

```bash
node bench/run.mjs --n 1 --budget 10
```

Options: `--setups glovebox,cu,ocu`, `--tasks calculator,form`, `--n 5`,
`--model claude-sonnet-5-5`, `--effort medium`, `--max-turns 40`. Leave the
Mac alone while it runs: apps open on screen, and glovebox stops a script if
you switch into the app it is driving.

## What each record holds

- `success`, `detail`, `error`, `stopReason`, `finalText`
- `roundTrips` (model calls) and `roundTripsPerSegment` (per user turn, for
  `form-repeat`)
- `usage`: `input` (uncached), `cacheWrite`, `cacheRead`, `output` tokens, and
  `costUsd` at list price
- `images`, `imagePixels`, and `imageTokensEst` (an estimate from image size;
  the API bills images inside input tokens and doesn't report them apart)
- `screenshotsOnTextTask`: images returned on tasks the tree can solve
- `resultChars`: text returned by tools
- `wallMs`, `modelMs`, `toolMs`
- `reads` (glovebox only): `fullReads`, `diffReads`, `noChangeReads`,
  `reprints` (a full tree printed again for a window already printed), and
  `noChangeThenRead` (a "no change" result followed by another read before
  any action)

Per-run tool calls and results, without images, go to `results/transcripts/`
(gitignored; they can include window contents).

`node bench/report.mjs` writes `results/summary.md` and `results/chart.svg`
from everything in `results/raw/`. `results/pilot/` holds the first pass (one
run per task and setup), kept apart so it doesn't mix with the full runs.
