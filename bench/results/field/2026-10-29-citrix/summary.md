# Field run: Citrix Viewer → a remote line-of-business app (2026-10-29)

This is one descriptive run, not a benchmark comparison. Claude Code drove glovebox over MCP (`js` tool) to do a read-only review inside a Citrix-published Windows client, while the user kept using the laptop. No tool comparisons were run.

Files:
- `calls.jsonl`: one row per `js` call wrapped in the in-session `step()` helper (66 rows). Each row has reads, routes, wall ms, outcome tag, and context-token delta.
- `actions.jsonl`: `~/.glovebox/actions.log` filtered to `client=claude-code`, the Citrix app, and this run's time window (94 rows). Step titles are dropped. Typed text was already logged as length only.

No screenshots and no app content are in this folder.

## Headline numbers

| Metric | Value |
|---|---|
| Wall time, first to last action | 17.4 min (session 20 min including setup and report writing) |
| `js` calls | 70 (66 step-wrapped + 4 bookkeeping) |
| Tool time inside `js` | 514 s total, median 4.1 s per call |
| ...of which settle/poll loops | 230 s (45%) |
| Actions | 94: 68 click, 14 scroll, 7 pressKey, 5 typeText |
| Route mix | **94 background**, 0 foreground, 0 accessibility, 0 background-skylight |
| Reads | 1 AX tree, 69 screenshots returned to the model, 60 settle polls (333 frames compared in-session, not returned) |
| Screenshot size | 1199×959 every time (1.15 MP cap from a 2564×2050 window). Est. 1,533 image tokens each, about 106k total |
| Context added per call | median 2,105 tokens, mean 2,315, p90 2,743 (65 valid deltas; 1 negative delta where the harness dropped older images) |
| Driver output tokens | 27.1k on `js` turns (34.2k for the whole session) |
| Human interventions | 0. No approval dialog was observed by the driver, no "Stopped:", the user's frontmost app never changed |
| Review items checked | 41 in 66 steps (0.62 per step) |

## AX coverage

`getAXState()` on the Citrix window returns **one node**: `dialog "<window title>"`. Nothing inside the remote session is exposed. Every step therefore ran on screenshots. 55 of 69 screenshots are tagged `fallback:ax-single-node`. The other 14 were confirmation shots taken before risky clicks (`confirm-*`) or re-reads after slow renders (`stale-*`).

## Probes

| Probe | Result | Repro |
|---|---|---|
| (a) AX coverage | 1 node, depth 0 | `await app.getAXState({disableDiffing:true, frames:true})` |
| (b) Background input into Citrix | **Works.** Clicks, typing, Escape and vertical wheel all landed while Citrix was not frontmost. `lastRoute` was `background` for all 94 | `await app.click([150,169]); app.lastRoute` |
| (c) Readability at the 1.15 MP cap | Readable: 10 px table text, chart labels. No zoom or region capture needed | `await app.getScreenshot()` |
| (d) Held click needed? | **No.** Plain background clicks always registered. Earlier cua sessions needed a 100-150 ms hold; glovebox's background route did not | — |
| (e) Stale read after action | Common. The remote UI repaints 1-4 s after input, sometimes 20-30 s for report or dashboard loads. Solved with a session-side `settle()` that hashes main-window frames until 2 identical in a row | see `settle()` below |
| (f) User switching apps | No "Stopped:" events. The user worked in other apps throughout, and background scripts were never interrupted | — |

```js
async function settle(reason, { min = 600, timeout = 12000, stableFor = 2 } = {}) {
  await sleep(min); let last = null, same = 0, img;
  for (const t0 = Date.now(); Date.now() - t0 < timeout; await sleep(500)) {
    img = await app.getScreenshot({ window: MAIN, emit: false });
    const k = hash(img.data); if (k === last) { if (++same >= stableFor) break; } else same = 0; last = k;
  }
  return img;
}
```

## Failure taxonomy (tagged when observed)

| Tag | Count | Notes |
|---|---|---|
| popup-intercept | 2 | The remote app auto-opened a tutorial pop-over on session load. Escape cleared it |
| route-fallback | 1 | Horizontal wheel (`scroll(.., {dx})`) had no effect in Citrix. Clicking the scrollbar arrow worked |
| stale | 3 | A read right after an action showed the pre-action frame (tagged `stale-*`). Solved with `settle()` |
| wrong-window | 3 | 2 window-guard aborts plus 1 silent 10 s poll against a **tooltip window** (see below) |
| misclick | 0 | |
| unreadable | 0 | |
| needs-human | 0 | |

## What glovebox should change

1. **A tooltip window becomes the default read target (P1).** The remote client opens small untitled windows (68×25, 362×50, 442×25) for hover tooltips. While one exists, macOS reports it as the focused window, so `getScreenshot()` and `windows()[0]` point at it, and the main window's index shifts from 0 to 1. One poll loop silently compared 29 frames of a 362×50 tooltip and timed out. This is the same class as roadmap "Found by the benchmark" #3 (Finder field editor becomes the window). Fix: by default, read the largest titled window, or the one the last action targeted. At minimum, warn when the chosen window is tiny or untitled while a larger window exists.
2. **Horizontal background scroll is ignored (P2).** `scroll(target, {dx})` changed nothing in Citrix. `dy` works. Check whether the synthesized event sets the horizontal axis field the Citrix client reads.
3. **Built-in settle / wait-for-change (P2).** 45% of tool time went to a hand-written frame-hash settle loop, and every remote step needs one. A built-in `app.settle()` or `app.waitForChange()` would remove a whole class of stale reads and keep the polling out of the model's context, since only the final frame is returned.
4. **No sanctioned way to persist telemetry (P3).** The session has no `fs` or `require`, so per-call telemetry had to be printed and then re-parsed from the Claude Code transcript. An append-only `gb.log(obj)` into the actions log, or a scratch-file writer, would make field runs self-recording.

## What worked well

- Background input reached a Citrix remote session reliably, with zero foreground fallbacks, over 17 minutes of concurrent use by the user.
- The persistent session let helpers (`guard`, `settle`, `step`, `shot`) be defined once and reused for 66 steps.
- Screenshots at the 1.15 MP cap were readable enough for dense tables, so no zoom passes were needed.
