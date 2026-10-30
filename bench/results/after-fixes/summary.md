# glovebox after the benchmark fixes (2026-10-30)

The seven baseline tasks, glovebox only, five runs each, with the same model,
effort, prompts, and harness as the
[2026-10-28 baseline](../summary.md). glovebox was at commit `2acf938`, which
fixes the bugs that run found. Raw records:
`raw-2026-10-30-glovebox-claude-sonnet-5-5-medium.jsonl`.

| glovebox | Before (2026-10-28) | After (2026-10-30) |
|---|---|---|
| Passed | 32/35 | 35/35 |
| Model round trips | 193 | 158 |
| Full trees printed again | 16 | 1 |
| Output tokens | 20.3k | 15.7k |
| Images returned | 17 | 12 |
| Wall time | 483 s | 338 s |

| Task | Passed | Median round trips |
|---|---|---|
| calculator | 5 → 5 | 2 → 2 |
| textedit-edit | 5 → 5 | 4 → 4 |
| finder-rename | 2 → 5 | 10 → 5 |
| textedit-setting | 5 → 5 | 3 → 3 |
| form | 5 → 5 | 4 → 4 |
| canvas | 5 → 5 | 4 → 3 |
| form-repeat | 5 → 5 | 11 → 10 |

Cost is left out on purpose. The baseline ran three setups in turn on each
task, while this run was glovebox alone, so more of its prompt stayed in the
prompt cache between runs (cache writes fell from 163k to 81k tokens, and
Calculator cost a third as much for the same two round trips). The list-price
totals ($0.75 before, $0.44 after) are not comparable.
