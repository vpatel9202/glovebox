# Testing

nostrings has two kinds of tests. Unit tests cover the pure parts and run
anywhere. The smoke test drives real apps through the real MCP server and
helper, so it runs only on macOS with the helper built and permissions granted.
Nothing in the smoke test is mocked.

## What has been run for real on macOS 27 (Apple silicon)

- `nostrings smoke` over MCP: one batched call types `6*7=` and reads `42`;
  the binding persists to the next call; index clicks compute `7+1=8` and
  the read comes back as a diff; a pixel click lands on the `9` key; the
  screenshot is 460x816, the same space as clicks; `js_reset` drops bindings.
- Claude Code (headless) attached through `nostrings mcp`: two calls, the
  second reusing the first call's binding.
- `nostrings smoke --full` with Firefox frontmost the whole time: background
  keys in Calculator; in TextEdit, a pixel click placed the caret, a drag
  selected a line, a scroll moved the view; the frontmost app never changed.
- The approval dialog and Escape to stop a script. (Terminal used to be
  refused outright; since 2026-11-19 it is ask first.)
- `nostrings smoke --macos`, 2026-11-19: all 51 checks pass (37 earlier that day) on the fixture
  app (below). By hand the same day: Control Center read through
  `ui.menuExtra("Control Center")`, Notification Center through
  `ui.notifications()`, Chrome page content after the first read, VS Code
  Insiders' full tree (about 3,700 elements), background typing in Chrome's
  address bar. Approval: under `allow-all` an unlisted app (Stickies) opened
  without a dialog, an ask-first app (Script Editor) showed one, and an
  unanswered one (Automator) denied after 121 s without launching it.
  `pressKey("super+shift+p")` opened VS Code's Command Palette in the
  background through its menu. `ui.spotlight("Chess")` opened Chess twice.

The Grok, OpenCode, and Codex configs in `agents.md` follow each client's
documented MCP format but have not been exercised end to end yet.

## Unit tests

```bash
npm test    # node --test test/ (Node 22+: node --test test/unit.test.mjs)
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
nostrings smoke
```

Starts `nostrings mcp` as a client would and works on Calculator. It prints one
`PASS` or `FAIL` line per check and exits 0 only if all pass. Calculator's
state changes during the run. The first time, macOS may ask to approve
Calculator for "nostrings smoke"; run `nostrings allow Calculator TextEdit`
first to skip the dialogs. Checks:

1. MCP handshake: the server is named `nostrings` and lists two tools.
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
nostrings smoke --full
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

## Android smoke test

```bash
npm run build:android                 # a git checkout only: the npm package includes both
nostrings smoke --android [--serial s] # --keep leaves the fixture installed
```

Installs a small test app (`com.nostrings.fixture`, built from
`native/android/fixture` without Gradle) for the run and removes it after.
Each control reports what it received in a label next to it. Over MCP, with
the fixture's approval skipped (ask-first apps and a locked phone still ask):

1. The device connects and the fixture's tree reads.
2. An index click and a pixel tap on the button both count.
3. A long press counts.
4. `typeText` fills the field; `pressKey("BackSpace")` deletes a character.
5. A `drag` moves the slider up; a `swipe` moves it back down.
6. `scroll` moves the list past its first row.
7. The screenshot is in the same pixel space as clicks.
8. `Back` leaves the app, and the next read fails with `not_visible`.
9. The code screen: `typeText("123456")` into the first of six one-digit
   boxes fills all six. The web screen (a WebView): the heading reads, the
   link and the Greet button work, and typed text reaches the page.
10. On the hidden screen (the default on Android 14+): `lastRoute` says
   `hidden screen`, the phone's top-focused display did not change, and on an
   emulator a hash of the phone's screen (status and navigation bars cropped)
   is the same before and after. On a physical phone the hash is reported,
   not checked, since the user may be using it. Only hashes are kept.
11. `js_reset` drops the binding.
12. `getApp(..., {foreground: true})` taps the fixture on the phone's own
    screen (it shows there for a moment, then `Back`).

Failure details print only the fixture's labels and error codes, never other
screen content. On an emulator, the phone's screen is first set to a static
settings page, since the home screen's app suggestions change after any
launch.

Passed (2026-11-18) on the API 34, 35, 36 and 37 emulators and on a Galaxy
S24 Ultra (One UI 9, Android 17) over wireless debugging. Alongside it, three
probes ran on each emulator (scripts not in the repo):
- The user has an app running on the phone's screen (the fixture with
  "user" typed in its focused field, Clock, Chrome): opening it on a hidden
  screen fails with `open_on_phone`, and the user's copy keeps its text, its
  place and focus. (Before this rule, Clock's task moved to the hidden screen
  and Chrome closed the user's tab task.)
- `kill -9` of the server removes every hidden screen and its tasks; top
  focus stays on the phone's screen.
- With the phone asleep, opening, reading, tapping and a screenshot on a
  hidden screen work (nostrings wakes it).

Emulator notes: a fresh boot can show a System UI "not responding" dialog,
and the Play Store image runs at a load average of 20 to 50 for several
minutes after boot. Both fail the smoke for reasons outside nostrings; wait,
or dismiss the dialog first.

### Two sessions on one phone

On the API 36 emulator, two CLI sessions ran at once through the per-phone
broker: one tapped and typed in the fixture, the other read Clock and took a
screenshot, each on its own hidden screen (displays 3 and 4), with the
phone's top focus on display 0 throughout. Opening the fixture from the
second session failed with `open_in_other_session`. Resetting one session
closed only its display; the other kept reading. After `nostrings stop` the
broker exited within its ten-second idle window, and no display, socket or
server was left.

Also on API 36:
- Both sessions injecting at once (A: drags with a hold, swipes, taps and
  long presses on the fixture; B: taps, swipes and keys in Clock for 15 s).
  Every drag and swipe landed (slider 94 and 6, four times each), A's
  counters held exactly its own taps (4) and long presses (4), B saw no
  errors, and top focus stayed on display 0. B ran at about 4.1 s a round
  next to A, against 3.1 s alone.
- A refused launch (`open_on_phone`) leaves no display behind, and another
  session can open the app once the user has closed it.
- Session A opening an app on the phone's screen while session B has it on
  a hidden screen is refused (`open_in_other_session`); before that guard,
  the launch moved B's task onto the phone's screen. B switching its own
  handle to `{foreground: true}` brings its copy over.
- `kill -9` of the broker mid-session: the server exits on end of input and
  its displays go; the session's next request starts a fresh broker (past
  the stale socket), a read says `not_visible`, and `activate()` reopens.
- A rebuilt server gets a fresh broker (the socket name carries a hash of
  the dex); before that, a session within an old broker's idle window got
  the old server.

On the Galaxy S24 Ultra (One UI 9, Android 17, wireless debugging), with
the phone dozing and its screen off at the start:
- `smoke --android` passes every check; nostrings woke the phone for both
  the hidden screen and the phone's-screen step.
- Two sessions at once, one per fixture package (`com.nostrings.fixture`
  and `com.nostrings.fixture2`, both built by `npm run build:android`): A
  dragged and swiped the slider (93 and 7, three times each) and tapped and
  long-pressed (3 and 3); B tapped six times and typed (`echo: bravO` after
  a BackSpace and a key). Each landed only on its own hidden screen, and
  top focus stayed on display 0.
- Two sessions starting at the same moment share one broker, which exits
  ten seconds after both end, leaving no socket, display or package.

### Emulator run, 2026-11-19

After Phase 4 and the usability work, `smoke --android` (now also covering
the code screen, the web screen with `nostrings é 😀 日本` typed into it,
and pinch and rotate) passes on API 34, 35, 36 and 37. The run found:
- Typing right after tapping a web field failed on a freshly booted API 37
  emulator: the page gave the field focus late. typeText now waits up to
  1.5 s for a focused field.
- WebView 124 (API 35) exposes no HTML ids, so the smoke finds the web
  page's output line by its text.
- On API 37 (the Play Store image) the "phone's screen did not change"
  check failed in two runs out of three; when it fails, the smoke now
  reports the changed region.

## macOS capability test

```bash
nostrings smoke --macos [--keep]
```

Builds Nostrings Fixture (`native/macos/fixture`, ad hoc signed into
`~/.nostrings`) and drives it over MCP. The fixture logs every event it gets to
`~/.nostrings/fixture.log`, and each check reads that log, so no model is
involved. Checks, in order: labeled form fields; web content; menu bar and
submenu items; a menu shortcut in the background; `select` on a pop-up;
`contextMenu`; checkbox; typing accents, emoji and CJK; `paste` (the clipboard
is kept in the helper and put back); typing into and clicking web content;
press and hold; double, right and middle click; scroll; pinch and rotate;
window move, resize, minimize and restore; a new window and the read's notice;
a sheet; an alert; hide and unhide; each SwiftUI control in the fixture's
SwiftUI window; then a check that the frontmost app never changed. The last checks use the foreground route on purpose: drop a file,
hover, an open panel, a save panel, then a whole-screen screenshot, the
window list, menu bar extras, full screen and Spaces (`other_space`, then
`activate` and `restore`), a check that no modifier key is left held down,
and quitting the app. `--keep` leaves the
fixture running. The fixture never writes files.
