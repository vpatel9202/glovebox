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
| `codex-cu` | Codex computer use: the `js` and `js_reset` tools of the `cua_repl` MCP server bundled in the ChatGPT app, started with the command and environment from its Codex plugin config | No Codex and no OpenAI model; the same Claude loop as every other setup. App approvals arrive as MCP elicitations; the harness approves only the bench apps, for the session. The harness sends `turn_ended` after each user turn, as Codex does. Its first call returns about 20,000 characters of documentation, counted as shipped. |
| `agent-desktop` | One tool that runs the [agent-desktop](https://github.com/lahfir/agent-desktop) 1.0.1 CLI, described by its bundled `desktop` and macOS guides | Agents normally run it from a shell; here the tool runs only that binary. Screenshots come back as images. |
| `peekaboo` | The MCP tools of [Peekaboo](https://github.com/openclaw/Peekaboo) 4.9.7, without `agent` and `analyze` | Those two call their own AI model, so they are withheld. |

Choices that affect the comparison:

- **Same loop for every setup.** `lib/agent.mjs` calls the Messages API
  directly with adaptive thinking, one `effort` level, and automatic prompt
  caching. History is append-only: nothing is pruned or summarized.
- **System prompt.** One short prompt for every setup, plus the MCP server's
  own `instructions` when it sends them. All other guidance comes from each
  setup's tool descriptions.
- **Screenshot-first sees one window.** The `cu` screenshot is the target
  app's focused window (glovebox's default window, which skips tooltips and
  field editors) at glovebox's capture size (1568 px long side), not the
  whole display. On macOS 27 that capture includes the app's open menus. It is
  cheaper than a full-display screenshot, so it favors `cu`. Members the
  executor can't run (`zoom`, `left_mouse_down`, `left_mouse_up`, `hold_key`,
  `middle_click`) are withheld through `configs`.
- **Why foreground input for `cu`.** Anthropic's reference environment drives
  a real display, so `cu` clicks go to the front app. In the 2026-10-28
  baseline, glovebox's background pixel clicks also missed open pop-up menus;
  that is fixed since, but `cu` stays on the foreground route.
- **No refusal fallback.** A fallback model would mix two models in one
  measurement, so a refusal counts as a failed run.
- **Image types come from the bytes.** A tool that labels a JPEG as PNG
  (Codex's `cua_repl` does) would get a 400 from the API, so the harness
  sends the type the image data actually has.
- **Same result limits for every setup.** Tool text over 100,000 characters
  is truncated and images are scaled to a 1568 px long side
  (`LIMITS` in `lib/setups.mjs`), so no tool can send more than another.
- **Side doors fail the run.** A run whose tool inputs contain `require(`,
  `import(`, `fs.`, `child_process`, `exec(`, `spawn(`, `osascript`, or
  `defaults write` counts as failed, with the pattern in `detail`
  (`sideDoors`). A tool that is a full Node REPL could otherwise rename the
  file or write the setting without touching the UI.
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
| `form-repeat` | Bench Fixture (form) | text | fixture output file, five records |
| `bulk-entry` | Bench Fixture (form) | text | ten records from one prompt, in order |
| `large-table` | Bench Fixture (table) | text | the West total of 200 random rows |
| `remote-desktop` | Bench Fixture (remote) | pixel | the target row opened and confirmed |
| `signup-recovery` | Bench Fixture (signup) | text | account created with the suggested name |
| `coexistence` | Bench Fixture (form) + TextEdit | text | form record, and the user's typing intact |

`fixture/BenchFixture.swift` is a small AppKit app built on first run into
`.build/`. Its canvas draws numbered tiles with no accessibility children,
standing in for a remote desktop or a game. `form-repeat` is the replay
baseline: the same form five times in one conversation, with round trips
recorded per repetition.

The tasks added for v2 each test one thing the first seven did not:

- `bulk-entry`: ten records in one prompt, so a tool that can loop inside one
  call has room to.
- `large-table`: 200 rows with random values per launch. glovebox's default
  read stops at 800 elements, so the Answer field is not in the first read.
- `remote-desktop`: modeled on the 2026-10-29 Citrix field run. One
  accessibility node, 11 pt text, the target row's Open button is off to the
  right (scroll, or the Right arrow), the record loads two seconds after Open,
  and an untitled tooltip panel takes key focus. The view takes the first
  click even when its window isn't key, as remote clients do. The target ID
  is random per run.
- `signup-recovery`: the username check answers after two seconds with an
  alert sheet and a random suggestion, which the next step must use.
- `coexistence`: while the agent works, the harness types words into a
  TextEdit document, but only while that document is frontmost (System Events
  `keystroke`, so nothing is typed into another app). The run passes only if
  the form is right, every word arrived, and no word was blocked because
  another app was in front.

Every new task has a scripted solve that `--dry-run` runs through the
harness's own glovebox session, twice, to prove the task can be done and that
verify notices.

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
`--model claude-sonnet-5-5`, `--effort medium`, `--max-turns` (40; `bulk-entry`
and `form-repeat` allow 80), `--label v2` (a second file on the same day). Leave the Mac alone
while it runs: apps open on screen, and glovebox stops a script if you switch
into the app it is driving.

Spend and restarts:

- `--budget` caps the whole output file, including runs already in it. A run
  is skipped, and the file stops, when the remaining budget is under three
  times that task and setup's most expensive runs so far (p90).
- `--run-cap` caps one run (default $0.75 on Sonnet, scaled by input price,
  never under $0.15).
  It is checked before each request, so a looping run ends as
  `stopReason: "run-cap"` before it crosses the cap.
- `--stop-after-rep 1` stops after the first pass so you can look at it;
  `--resume <file>` continues a file, skipping every run already recorded.
  The file's first line records the git SHA and tool versions, and resume
  refuses a different SHA. Paid runs need a clean checkout (`--allow-dirty`
  for throwaway runs).
- Infrastructure failures (a task or tool server that fails to start, an API
  error past 8 retries, a verify that throws) are recorded with
  `infra: true`, retried once, and left out of the report. Three in a row
  for one setup, or three runs where every tool call errored, stop the file.
- Ctrl-C restores your settings; resume picks up where it stopped.
- `node bench/usage.mjs` checks the records against Anthropic's own usage
  data. It needs an Admin API key in `bench/.env` as `ANTHROPIC_ADMIN_KEY`.
  It prints the org's month-to-date billing and each key's usage, then the
  bench key's tokens beside the harness's. `--watch 10 --file <run.jsonl>
  --pid <pid>` repeats the check every 10 minutes during a run and sends the
  run Ctrl-C if the API side gets well ahead of the records.

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
- `contextPerCall`: median and p90 growth of the prompt per request
- `sideDoors`, `longPromptTurns` (Haiku requests over 100K prompt tokens,
  billed at the higher rate), `smallWindowReads` (glovebox reads that landed
  on a tooltip-sized window)
- `infra`: true for runs that say nothing about the tool
- `reads` (glovebox only): `fullReads`, `diffReads`, `noChangeReads`,
  `reprints` (a full tree printed again for a window already printed), and
  `noChangeThenRead` (a "no change" result followed by another read before
  any action)

Per-run tool calls and results, without images, go to `results/transcripts/`
(gitignored; they can include window contents).

`node bench/report.mjs` writes `results/summary.md` and `results/chart.svg`
from everything in `results/raw/`. `results/pilot/` holds the first pass (one
run per task and setup), kept apart so it doesn't mix with the full runs.
