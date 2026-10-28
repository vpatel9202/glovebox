# Roadmap

What works today is macOS (14+, tested on 27). Everything below is planned,
not shipped. Nothing here has been tested unless it says so.

## Diff fixes

These cost tokens, not correctness, and can follow the benchmark so it shows
a before and after. (The silent-read baseline bug that had to come first is
fixed; see the changelog.)

1. **Diff key includes the window title and list position.** A title change
   (a document name, an unread count) reprints the full tree. Key the
   baseline by the window's element index, with one baseline per key.
2. **Depth-only changes show as `~`.** `diffTrees` in `src/axformat.mjs`
   compares whole lines including indentation, so wrapping content in a new
   container reprints every node below it. Compare lines without
   indentation.
3. **Non-string return values print twice.** A read whose value is already
   printed prints again as the cell result, because the dedupe in `runCell`
   in `src/kernel.mjs` only handles strings. `console.log(await
   app.getAXState())` also prints the tree twice: the read emits it, then the
   log prints it again.
4. **`frames` and `menus` are part of the diff key.** A `{frames: true}` read
   followed by a plain read reprints the whole tree. The benchmark counted 16
   full reprints of an already-printed window across 35 glovebox runs; how
   many come from this and how many from item 1 is not yet split out.

## Found by the benchmark

The 2026-10-28 baseline ([bench/results](../bench/results/summary.md))
surfaced these. Fix them after the diff fixes, then rerun the benchmark.

1. **Background pixel clicks don't reach an open pop-up menu.** A click on a
   menu item does nothing in the background; the foreground route and
   accessibility presses work.
2. **Menu picks aren't settled before the next action.** Picking a pop-up
   item and clicking Submit in one call can submit the old value.
3. **Finder's rename field becomes "the window".** While an inline rename is
   active, window selection picks the 138x33 field editor, and screenshots
   fail with "Cannot find a capturable window id".
4. **`setValue` on a Finder name cell changes only the label.** The tree then
   shows the new name though the file was never renamed, which cost glovebox
   3 of 5 Finder runs. Warn in the result, or point agents at the rename
   flow (Return, type, Return).
5. **Background keys don't start a Finder rename.** Return on a selected file
   works only on the foreground route.

## Credibility and distribution

Ordered by expected impact. These come before new platforms.

1. **Benchmark harness (`bench/`).** Done 2026-10-28: harness, raw results,
   and chart are in [bench/](../bench/README.md). The original scope follows.
   About five fixed tasks: Calculator
   arithmetic, editing a TextEdit document, a Finder rename, toggling a
   setting in a non-blocked app, and filling a form in a native app. Add two
   more: a Citrix-or-canvas task (pixel fallback, one-node tree) and a replay
   task (run the same task again from a saved script), so the differentiators
   below are measured against this baseline. Compare glovebox, Anthropic
   computer use (screenshot-first), and one per-action AX MCP server
   (open-computer-use or agent-desktop). Measure model round trips,
   input tokens including image tokens, output tokens, wall-clock time, and
   success over N runs per task, plus the token cost of a diff versus a full
   tree. For the token work below, also count full re-prints caused by a
   baseline mismatch, "no change" reads followed by another read, screenshots
   per text task, and per-result text characters and image pixels (logged by
   the kernel). Results must split input tokens into uncached, cache write,
   and cache read, because with prompt caching round trips dominate cost.
   Done when the raw results and the harness are in the repo and one chart is
   in the README.
2. **npm publish and a prebuilt helper.** Publish `@vpatel9202/glovebox` to
   npm and ship a Developer ID signed, notarized helper in each release.
   Done when `npx -y @vpatel9202/glovebox setup` works on a Mac without the
   Xcode command line tools and grants survive an upgrade.
3. **Demo media, then launch.** Record the GIF from the shot list in the
   README comment, and a short video. Launch (Show HN, X, Codex computer-use
   threads) only after one or two of these exist. Done when the GIF is at the
   top of the README.
4. **Exercise every documented client.** Run the Codex, Grok CLI, OpenCode,
   Gemini CLI, and Cursor configs end to end, with a short clip for each.
   Done when `docs/agents.md` and the README's "Works with" line list each
   client as verified or say what failed.
5. **CI.** After the `test` script fix in item 7, GitHub Actions running
   `npm test` on ubuntu and macos runners.
   Done when it runs on every push and PR, and a CI badge is in the README.
6. **Listings.** The official MCP registry, the Claude Code plugin
   marketplace, and skills.sh (for `skills/glovebox/SKILL.md`). Done when each
   listing is live and links back to the repo.
7. **Packaging and docs fixes found in review.** `files` in `package.json`
   omits `SECURITY.md` and `CHANGELOG.md`; `settleMs` is read in
   `src/kernel.mjs` but missing from `DEFAULTS` in `src/config.mjs`; a comment
   in `native/macos/GloveboxHelper.swift` says the Escape monitor needs only
   Accessibility, but it needs Input Monitoring; the `test` script
   (`node --test test/`) fails on Node 22 because a bare directory is no
   longer accepted (`node --test test/unit.test.mjs` passes, 7 of 7). Done
   when all four are fixed.

After these, Windows is the highest-priority platform: cross-platform support
is what lcu, agent-desktop, open-computer-use, and cua have over glovebox, and
Windows-MCP has about 10.5k stars.

## Token efficiency

Ranked by round trips saved. Each call re-reads the cached context and adds
reasoning and output tokens, so a round trip costs more than trimming one
read. Savings are estimates from reading the code, to be confirmed by the
benchmark. Effort: S is small, M is medium.

1. **Silent structured lookups.** Add `app.find({role, label, id})`,
   `app.text(i)`, and `app.nodes()`, which return data without printing, plus
   one instruction line in the tool description and `skills/glovebox/SKILL.md`.
   `app.text` also gives the full value of a field, which a read truncates at
   160 characters. Saves 1-2 round trips on text and web tasks. S.
2. **A read that waits for change.** `getAXState({waitForChange: ms})` polls
   silently until the tree changes, instead of relying on the fixed 80 ms
   settle after an action. Saves 0.5-1.5 round trips on sheets and async UIs.
   S-M.
3. **Checks inside the script.** An `expect` helper lets one call chain
   several steps, stop at the first failed check, and print state on failure
   or error. Per-action tools cannot do this. Saves 0.5-1 round trip per task
   and per error. S.
4. **Outline for large trees.** Above about 250 nodes, show an outline
   instead of the full tree, and prune offscreen nodes with a summary line.
   Helps Electron and web apps and saves 5-8k tokens per full read. Adds no
   round trip, because the script can call `find` in the same call. M.
5. **Field labels and window notices.** Resolve `AXTitleUIElement` and
   `AXLabelUIElements` into field labels, and add a one-line notice when a
   window, sheet, or alert opens. Helps forms and save sheets by avoiding
   screenshots, and makes scripts that skip the read safe. S.
6. **Line-format cleanup.** Quiet `AXShowMenu` (it is not in `QUIET_ACTIONS`),
   drop auto-generated `_NS:` ids, show `help=` only when there is no label,
   collapse scroll bars into `scrolled N%`, and drop single-child unlabeled
   groups. A guess of 20-40% off a full tree, to be verified. S.
7. **Diffs that survive context clearing.** A `read #N` header on each read,
   and role plus label in short removed lists, so a diff still makes sense
   after the earlier tree has left the context. S.
8. **Cheaper images.** `getScreenshot({region})` crops, and a hint when the
   tree has two or fewer nodes. JPEG and grayscale save no tokens, because
   images are charged by pixel size. Lowering the default scale would change
   the click coordinate space, so it is not planned. S-M.

Not doing (backfires):

- An automatic read after every action: it adds tokens to calls that did not
  need a read.
- Aggressive pruning: the agent loses elements it needs and spends a round
  trip finding them.
- Diffs that show only changed attributes: they are harder to read and the
  line no longer identifies the element.
- A smaller default screenshot scale: it changes the click coordinate space.
- An outline-first read for small trees: it adds a round trip below about
  2-3k tokens.

## Differentiators

Two features no other tool checked has, as far as their READMEs show (eight
competitors checked on 2026-10-27).

1. **Local OCR text.** `app.getText()` runs Vision `VNRecognizeTextRequest`
   in the helper and returns diffable `"text" @x,y` lines in click
   space. It targets Citrix, canvases, and remote desktops, where the tree is
   one node. None of the eight competitors checked documents this. The OCR
   runs locally, but the recognized text still goes to the model.
2. **Durable scripts and replay.** Selectors (token item 1) and `waitFor`
   (token item 2) feed functions saved to `~/.glovebox/lib/*.mjs`, which load
   automatically. `glovebox run file.mjs` replays a script with zero model
   calls. For comparison, ghost-os recipes appear to need a small model, and
   Peekaboo and open-computer-use replay JSON step lists with no branching.

## Windows backend

Plan: a PowerShell helper (no install beyond Windows itself) that speaks the
backend protocol over a named pipe.

- Tree and actions: UI Automation through `System.Windows.Automation`
  (`InvokePattern` for presses, `ValuePattern` for `setValue`,
  `TextPattern`/`SelectionItemPattern` where present). Stable indices from
  `RuntimeId`.
- Input: `SendInput` via a small `Add-Type` C# shim; `PostMessage` for
  background keys where the target accepts it.
- Screenshots: `PrintWindow` with `PW_RENDERFULLCONTENT`, resized to the
  requested size.
- Approval dialog: a WinForms message box from the helper.

## Linux backend

Plan: a Python helper.

- Tree and actions: AT-SPI over D-Bus (`pyatspi` or `gi.repository.Atspi`).
- Input: XTest on X11. Wayland compositors restrict synthetic input and
  screen capture; support will be per compositor (portal-based capture,
  `ydotool` or the RemoteDesktop portal for input), and some will not work.
- Screenshots: X11 `XGetImage` on the window; the ScreenCast portal on Wayland.
- Approval dialog: `zenity` or `kdialog`, else allowlist mode only.

## macOS improvements

- Chromium/Electron keyboard input on macOS 15+ may need an
  `SLSEventAuthenticationMessage` attached to each key event; not done yet.
- Menu shortcuts (⌘S and friends) in background apps: press the menu item
  through accessibility instead of sending the key.
- Detect apps that ignore background input and fall back automatically,
  instead of relying on `foregroundApps` in the config.
- Test matrix beyond AppKit: Safari/WebKit, Electron apps, SwiftUI-only apps,
  Citrix Viewer.
- MCP elicitation as an alternative to the native approval dialog when the
  client supports it.
- `app.menu(["File", "Export…"])` through the menu bar tree.
- Optional settle detection (wait until the tree stops changing) instead of
  a fixed delay after actions.
