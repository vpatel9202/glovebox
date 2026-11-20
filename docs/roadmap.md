# Roadmap

What works today: macOS (14+, tested on 27) and Android (experimental, API 34+
for hidden-screen sessions). Everything below is planned, not shipped. Nothing
here has been tested unless it says so.

## Next

Ordered by expected impact. Shipped in 0.6.0 and no longer listed: `nostrings
init`, saved scripts, and the backend conformance check.

1. **Exercise every documented client.** Run the Codex, Grok CLI, OpenCode,
   Gemini CLI, and Cursor configs end to end. Done when `docs/agents.md` marks
   each one verified or says what failed.
2. **A prebuilt helper.** A Developer ID signed, notarized helper in each
   release, so the Mac side needs no Xcode tools and grants survive upgrades.
   Waiting on a Developer ID.
3. **Listings.** The Claude Code plugin marketplace and skills.sh. (The
   official MCP Registry listing is live.)
4. **CI on real GUI runs.** Unit tests run on every push and PR. Smoke tests
   still need a Mac with permissions granted, so they run by hand.
5. **Benchmark again** once Windows and Linux exist: the published numbers
   are from 0.3.0 (then called glovebox) and cover macOS only.

Open bug: horizontal background scroll has not been tried in a remote
desktop viewer since the fix. (gb-1iz.12)

## Token efficiency

Each call re-reads the cached context and adds reasoning and output tokens,
so a round trip costs more than trimming one read. Shipped so far: silent
lookups (`app.find`, `app.nodes`, `app.text`), `app.waitForChange` and
`app.settle`, `app.expect`, outlines for large trees, field labels, window
notices, and quieter lines. Still planned (S is small, M is medium):

1. **Diffs that survive context clearing.** A `read #N` header on each read,
   and role plus label in short removed lists, so a diff still makes sense
   after the earlier tree has left the context. S.
2. **Line-format cleanup, the rest.** Show `help=` only when there is no
   label, collapse scroll bars into `scrolled N%`, and drop single-child
   unlabeled groups. S.
3. **Cheaper images.** `app.getScreenshot({region})` crops, and a hint when
   the tree has two or fewer nodes. JPEG and grayscale save no tokens, because
   images are charged by pixel size. S-M.

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
- Detect apps that ignore background input and fall back automatically,
  instead of relying on `foregroundApps` in the config.
- MCP elicitation as an alternative to the native approval dialog when the
  client supports it.

## Android improvements

- Physical phones beyond one Galaxy S24, and a parity check against macOS.
- Tree quality and speed on large apps, and an Android round of the
  benchmark.
- iOS: not planned yet. Its automation needs Xcode and a signed runner, a
  different shape from ADB.
