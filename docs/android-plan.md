# Android plan

A plan to bring glovebox to feature parity on Android. Nothing here is built
or tested; it is a plan, written 2026-11-15.

## Summary

glovebox reaches Android parity as a second backend behind the existing
[backend protocol](backend-protocol.md): the kernel, diffs, sessions, MCP and
CLI stay as they are, and a new on-device server replaces Glovebox
Helper.app. Nothing in this plan has been run on a device, so the first phase
is a throwaway spike, and every later phase depends on it.

**Target architecture.** The host (Mac or Linux) runs the kernel and daemon
as today. Over ADB it starts a server on the phone with shell privileges
(`app_process`, the pattern scrcpy uses), pushed as a dex file, so there is
no APK to install. That server reads the accessibility tree through
`UiAutomation`, injects input, captures the screen, and runs each session on
its own virtual display so the user's real screen is never touched. The
default display is the fallback, the same role the foreground route plays on
macOS. The first target is the Android emulator, not a phone: it is testable
now, has no vendor variance, and is the right home for unattended work anyway.

**What parity means.** Three things, all measured:

1. Every call in [api.md](api.md) works with the same names and semantics, or
   has a documented Android equivalent.
2. The seven properties in [design.md](design.md) "The bar" hold: one call
   per step, persistent session, diffed text reads, screenshots only on
   request, clicks in image-pixel space, cheap pixel and element actions, no
   doc dumps.
3. The safety model (approval, blocked apps, stop, action log) and the
   lifecycle commands (`setup`, `doctor`, `smoke`) exist, and an Android
   version of `bench/` runs.

**Two gates.** After a no-code spike: (A) the virtual display becomes the
default route, or v1 ships on the default display with virtual displays
opt-in; (B) the server builds its accessibility connection from shell, or
that half moves into a small instrumentation APK. Because the virtual display
is a route behind the existing `background_unavailable` fallback, not the
architecture, both answers leave the rest of the plan intact.

## Parity map

Of 33 macOS features, 12 port directly, 15 need a redesign, 4 are better on
Android, and 2 have no equivalent (the menu bar and code signing). Rows follow
the order of `api.md`, then `design.md` and `SECURITY.md`.

| macOS feature | Android approach | Parity |
| --- | --- | --- |
| Persistent JS session, `js` / `js_reset`, CLI daemon | Unchanged; the kernel never sees the OS | Port |
| `gb.getApp(query)` launches without focus | Resolve label or package name; `am start --display <session display>` | Port |
| `gb.listApps({installed})` | PackageManager plus running tasks per display | Port |
| `gb.permissions()` | Reports ADB link, server alive, accessibility connection, virtual display allowed, competing automation | Redesign |
| `getAXState` text tree and diffs | Accessibility node tree; Android, Compose and Flutter roles mapped onto the AX role names | Port |
| Stable element indices (`CFEqual` table) | Table keyed by window id plus node id, with a generation counter: lists reuse nodes and WebView ids reset on reload, so a reused index must raise `stale_index` | Redesign |
| `menus: true` (menu bar) | No menu bar; overflow menus are ordinary popup windows. Drop it | No equivalent |
| `frames: true`, image-pixel coordinates | One display is one image; the scale formula is unchanged | Port |
| `getScreenshot` | Read the virtual display's surface; `screencap` on the default display. Secure windows come back black | Port |
| `waitForChange`, `settle` | Polling first, as today; later driven by the accessibility event stream | Better on Android |
| `windows()` | The glovebox window becomes the display or task, its windows merged in z-order. Dialogs, sheets and the keyboard must take over reads, the opposite of the macOS rule | Redesign |
| `click` (accessibility press, else pointer) | Click action on clickable nodes, else an injected tap | Port |
| `doubleClick`, `rightClick`, modifiers | Double tap; right click becomes long press; most modifiers mean nothing | Redesign |
| `pressKey` (xdotool names) | Android key codes; add Back, Home, Recents as global actions | Redesign |
| `typeText` | Ladder: set the field's text, then key events, then paste, reading back after each | Redesign |
| `scroll` | Scroll actions on the node, else an injected swipe; "lines" needs a new unit | Port |
| `drag` | Injected touch path; add `swipe`, `longPress`, `pinch` | Port |
| `setValue`, `focus`, `selectText`, secondary actions | Matching node actions (set text, focus, set selection, custom actions) | Port |
| `activate()` | Move the task to the default display, or bring it to the front there | Redesign |
| Background input (SkyLight private calls) | One virtual display per session, as a route behind `background_unavailable`; Android 14 (API 34) floor if per-display focus needs it | Better on Android |
| Foreground fallback; switching away stops the script | Default display; stop when the top task changes without the agent causing it | Redesign |
| Focus guard | Becomes "did the task or focus leave my display", checked before each action | Redesign |
| Drawn agent cursor | Nobody sees a virtual display; draw it in a host live view, and use the pointer-location overlay on the default display | Redesign |
| Menu-bar status item (sessions, stop, revoke) | Host tray item; on-phone indicator through a notification if shell can post one, else an optional companion app | Redesign |
| Escape to stop | Host Escape as today; on the phone, a hardware key pattern, or unplugging (server death stops everything) | Redesign |
| Approval dialog in the helper | Prompt on the host; the phone server enforces the decision | Redesign |
| Blocked apps | New Android list, checked against the package of the window being acted on, not only the app launched | Redesign |
| Action log | Host log as today, plus device serial and display id | Port |
| `setup`, `doctor`, `smoke` | ADB discovery and server push; capability probes that name the vendor toggle; smoke against an owned fixture app | Redesign |
| `signing` (keep grants across rebuilds) | Not needed: no grant is tied to the server's signature | No equivalent |
| Named sessions side by side | One virtual display per session: real isolation, not just separate bindings | Better on Android |
| Semantic shortcuts | New: intents and deep links by allowlist, later AppFunctions | Better on Android |
| Pixel fallback for one-node trees | Screenshots and taps; OCR on the host | Port |

## Phases

Eight phases, 0 to 7: a no-code spike, then an emulator MVP on the default
display, then virtual displays, then real phones, then proof of parity.
Phase 7 is beyond parity. Nothing is sized in days, because the spike decides
how hard Phases 3 and 5 are.

```mermaid
flowchart TD
  P0["Phase 0 · Spike with stock tools, no code"]
  GA{"Gate A · route"}
  GB{"Gate B · privilege"}
  P1["Phase 1 · Read-only backend"]
  P2["Phase 2 · Input and safety (emulator MVP)"]
  P3["Phase 3 · Virtual-display sessions"]
  P4["Phase 4 · Tree quality, text and speed"]
  P5["Phase 5 · Physical phones"]
  P6["Phase 6 · Prove parity"]
  P7["Phase 7 · Beyond parity"]
  P0 --> GA & GB
  GA --> P1
  GB --> P1
  P1 --> P2 --> P3 --> P4 --> P5 --> P6 --> P7
```

Phases 0 to 4 run on emulators in CI; only Phase 5 needs physical phones, and
Gate A decides whether Phase 3 makes virtual displays the default or an
option.

### Phase 0: spike with stock tools, no code

Run on emulators for Android 14 through 17 (API 34–37), using only
`scrcpy --new-display`, `am start --display`, `input -d`, `uiautomator dump`
and `dumpsys`. `uiautomator dump` already builds an accessibility connection
from shell, so it tests the riskiest assumption for free.

Questions it must answer:

1. Does the default display keep focus while the agent taps on a virtual
   display?
2. Does the accessibility tree include windows on the virtual display?
3. Out of a list of about 20 apps, how many launch on the virtual display,
   respond, and stay there?
4. What happens when the user opens the same app on the phone screen?
5. Can text be entered on the virtual display without a keyboard showing up on
   the phone screen?
6. What happens to the virtual display's apps when the server is killed?
7. Does any of this survive the screen being locked or off?

**Gate A (route).** The virtual display becomes the default route only if
questions 1 and 2 pass on every API level and at least 80% of the app list
passes question 3. Otherwise the default display is the default route and
virtual displays are opt-in.

**Gate B (privilege).** If an accessibility connection cannot be built from
shell on two or more API levels, the accessibility half moves into a small
instrumentation APK (see Alternatives). Input, capture and displays stay in
the shell server either way.

### Phase 1: read-only backend on the emulator

- On-device server, pushed and started by the host, speaking the existing
  JSON-lines protocol over an ADB-forwarded socket. It answers `hello`,
  `ping`, `listApps`, `resolveApp`, `windows`, `axTree` and `screenshot`.
- `src/backends/android.mjs`, chosen per device rather than by
  `process.platform`, because the host is still a Mac.
- Role map (Views, Compose, Flutter, WebView) onto the AX role names.
- Element index table with a generation counter.
- Window model: the display or task is the glovebox window, with its windows
  merged in z-order.
- Display id kept inside the opaque window and app handles, not added to
  every method.
- A fixture APK glovebox owns (see Test strategy) and a backend conformance
  suite that runs the same protocol scripts against either backend.

**Exit:** conformance read tests pass on the emulator matrix, and tree read
time on the fixture is measured and recorded.

### Phase 2: input and safety, emulator MVP

- `keys`, `type` (the set-text, key events, paste ladder with read-back),
  `click`, `scroll`, `drag`, plus `swipe`, `longPress` and global actions.
- Approval on the host, enforced in the server; blocked apps checked against
  the acted-on window's package; action log with device serial.
- Server death stops everything (no `nohup` in v1); detection of a competing
  automation tool holding the accessibility slot.
- `doctor` and `smoke` for Android, the smoke test against the fixture app.
- A first cut of the Android bench, so later phases are measured.

**Exit:** smoke passes on the emulator matrix, and Claude Code drives an
emulator end to end over MCP.

### Phase 3: virtual-display sessions

Default or opt-in, depending on Gate A.

- One display per session, created with scrcpy's per-API flag choices and
  destroyed with its content on teardown, so agent apps never land on the
  user's screen.
- Check before each action that the task is still on the session's display;
  stop with a coded error if it moved.
- Keyboard policy for the display; parallel named sessions.

**Exit:** the "default display untouched" checks (focus, a screenshot hash
before and after, emulator capture as an independent check) pass across the
matrix with two sessions running.

### Phase 4: tree quality, text and speed

- Hardening against fixture screens: list item reuse, WebView, Compose, a
  split one-time-code field.
- Event-driven `waitForChange`.
- The large-tree outline and the silent lookups from the macOS
  [roadmap](roadmap.md), plus OCR on the host for one-node trees.

**Exit:** the fixture suite passes, and the bench shows round trips and cost
per task.

### Phase 5: physical phones

- USB first, then wireless ADB, with reconnect and re-pair handling.
- `doctor` probes each capability and names the vendor toggle when one blocks
  it.
- Device matrix and the physical-only checks in Test strategy.

**Exit:** a published support matrix per device and Android version.

### Phase 6: prove parity

- Full Android bench, including a comparison on AndroidWorld.
- Android sections in `api.md`, `agents.md` and `SECURITY.md`; the emulator
  matrix in CI.

**Exit:** every row of the parity map is done or documented as a limit, and
the README Status table lists Android as working, with tested versions.

### Phase 7: beyond parity

Allowlisted intents and deep links, AppFunctions if shell can call them, the
on-phone setup through Shizuku, and a separate work profile or a dedicated
phone for agent apps (see Alternatives).

## Risk register

The two assumptions most likely to break are that the phone screen keeps
focus while the agent works on another display, and that an accessibility
connection can be built from shell and share the device with other tools.
Rows run from most to least likely to fail. "Unconfirmed" marks claims from
memory, not from a source.

| Assumption | Why it may fail | Early signal | Mitigation | Fallback |
| --- | --- | --- | --- | --- |
| The phone screen keeps focus while the agent taps elsewhere | Input on another display can move system focus: the user's video pauses, keyboard closes. Per-display focus may need Android 14 and a trusted display (unconfirmed) | Focused display in `dumpsys` before and after a tap; fixture logs focus changes | Android 14 floor for the background route | Answer `background_unavailable`, use the default display |
| Shell can open an accessibility connection that coexists | Only one automation connection system-wide, so Appium, Maestro and `uiautomator dump` conflict. Connecting suspends TalkBack unless a flag is set. The hidden constructor changes between releases. Less prior art than first assumed: uiautomator2 and Maestro use instrumentation APKs, not shell servers | "Already registered" error; `dumpsys accessibility` | Always set the don't-suppress flag; `doctor` names a competing tool | Instrumentation APK using the public API with shell permissions |
| Text can be entered reliably | Setting text skips validation listeners and fails in WebView, Flutter and games; key injection has no emoji or CJK; paste overwrites the user's clipboard; the keyboard may appear on the phone screen | Fixture text screens, including a split one-time-code field | Ladder with read-back after each step; paste off by default | A minimal input method glovebox ships (APK) |
| Apps behave on a virtual display | One task per app; launcher trampolines relaunch on the phone screen; billing, permission and biometric sheets may land there (unconfirmed which); integrity checks | Spike pass rate over about 20 apps | Check the task's display before each action; stop with a coded error | Per-app `foregroundApps`, which the config already has |
| Shell can set the display flags it needs | Trusted, own-group and always-unlocked flags vary by API level (unconfirmed); the secure flag is out of shell's reach, so secure windows capture black | Flags in `dumpsys display` after creation | Copy scrcpy's per-API flag choices | Default display |
| Work continues while locked or screen-off | Doze, app standby and vendor battery killers; keyguard behaviour on a virtual display unknown | The same script locked and unlocked, with frame timestamps | Keep-active; refuse while locked unless opted in | Unattended work on the emulator |
| Clean teardown | An ADB drop kills the server; a display removed without destroying its content moves agent apps onto the user's screen | Kill test in the spike | Always destroy content on removal | Server death is the kill switch, by design |
| Hidden APIs and vendor gates hold | scrcpy needs fixes for most releases; Xiaomi needs "USB debugging (Security settings)" for injection; Samsung Auto Blocker may block USB commands (unconfirmed) | `SecurityException` on the first injection | Reuse scrcpy's wrapper classes (Apache-2.0); `doctor` probes each capability | Per-vendor setup notes |
| Element indices stay stable | Lists reuse nodes for new rows; window ids change when an activity is recreated; WebView ids reset on reload | Fixture list and WebView screens | Generation counter so a reused index raises `stale_index` | Read again |
| Sensitive views are visible | Android 16 lets apps hide views from accessibility services that are not accessibility tools; unknown whether a shell connection counts as one | Fixture screen with a flagged view | Treat hidden views as blocked, which is the safe outcome | Screenshot, black if the window is also secure |
| Advanced Protection leaves shell alone | Android 17 revokes accessibility from non-tool apps when it is on; effect on a shell connection unknown | Physical test with Advanced Protection on | Detect it in `doctor` | Document as unsupported |
| Apps run with developer options on | Banking apps and some games refuse | Launch error or app message | Block those apps | None: by design |

Tree read speed is a smaller risk than it looks: expect roughly 100 to 500 ms
for an 800-node tree, slower in WebView (unconfirmed). Polling is acceptable
until Phase 4.

## Alternatives considered

The pick is a shell server for displays, input and capture, reusing scrcpy's
wrapper classes rather than rewriting them, with an instrumentation APK
designed in as the fallback for the accessibility half.

| Option | What it gives | Cost or catch | Verdict |
| --- | --- | --- | --- |
| Shell server via `app_process` | Displays, input, capture and accessibility with nothing installed | Hidden APIs; lives only as long as ADB | Chosen |
| Instrumentation APK (`am instrument`, shell permissions adopted) | The public accessibility API with shell's permissions; ADB installs skip developer verification | An install; possible Play Protect warning | Fallback at Gate B |
| Accessibility-service APK (the droidrun approach) | Runs with no computer attached; fast actions | User enables it in Settings; Advanced Protection revokes it; sensitive views hidden | Rejected for v1 |
| uiautomator2 or Maestro as the backend | Off the shelf | Holds the single automation slot; no virtual-display control | Throwaway demo only |
| Shizuku | A shell server started on the phone itself | Restart after every reboot | Phase 7, same server code |
| Root | Adds capture of secure windows | Few users; voids the security story | Skip |
| Work profile for agent apps (unconfirmed) | A second copy of each app with its own accounts, so the user and agent never fight over one task | Setup per device; behaviour on a virtual display unknown | Spike item, Phase 7 |
| Device owner on a dedicated agent phone | The OS enforces the blocklist (package suspension) and controls the lock screen | A reset phone with no personal accounts | Phase 7, for unattended phones |
| VirtualDeviceManager | Per-device rules for apps, clipboard and keyboard; virtual input that looks like hardware | Permission likely out of shell's reach (unconfirmed) | Research only |
| Emulator console and gRPC | Input and capture outside the device | Emulator only | Test oracle, not a backend |

## Security model

On Android the ADB key is the grant, so the approval gate means nothing
against an agent that has a shell: it can run `adb shell input` directly and
skip glovebox entirely. On macOS the helper holds the grants, so an agent's
terminal cannot do that. These go into an Android section of
[SECURITY.md](../SECURITY.md).

1. **Key custody.** Keep the ADB key under a different OS user or on a
   different machine, and let agents reach glovebox only over MCP. Without
   this, a prompt-injected coding agent bypasses everything.
2. **No raw shell over the wire.** The server exposes named methods only;
   nothing the kernel can call runs arbitrary commands.
3. **Gate each window, not each app.** Payment sheets, permission dialogs,
   passkey and password sheets, autofill, share choosers and the package
   installer appear inside an approved app's task under other packages. Check
   the package of the window being acted on, every action. Deny by default:
   Play purchase screens, the permission controller, the credential manager,
   the package installer and system UI.
4. **Blocked apps by default.** Settings, Play Store, Shizuku, banking and
   wallet apps, password managers, authenticator apps, Messages, the phone
   dialer, launchers and the notification shade. Messages and notifications
   matter most, because one-time codes land there.
5. **Locked phone.** Refuse to act while a personal phone is locked unless the
   user opts in; a display that stays unlocked behind the lock screen is a
   lock-screen bypass for whoever holds the host.
6. **Make it visible.** A virtual display shows the user nothing, so an
   on-phone indicator and a physical stop are required, not optional.
7. **Shared state.** Clipboard, notifications and signed-in accounts are
   shared across displays. Clipboard paste stays off by default.
8. **Device socket.** A random socket name plus a token, and a peer uid check.
9. **Intents skip the UI and the gate.** `tel:`, `sms:` and payment links act
   without a screen to approve. Allowlist by action and package, no raw URIs,
   no content-provider queries in v1.
10. **Host files.** Screenshots and logs on the host now hold messages and
    codes; set a retention limit.
11. **Developer options are themselves a downgrade** on a personal phone. The
    docs say so and point to the emulator or a dedicated phone.

## Test and benchmark strategy

Phases 0 to 4 run entirely on emulators, so CI can carry them; only Phase 5
needs physical phones.

- **Fixture APK glovebox owns.** Screens for Views, Compose, WebView, a long
  list, a split one-time-code field, a secure window, a view flagged
  sensitive, and a canvas that logs every touch (position, display id, event
  flags) and every focus change to logcat. That log is the ground truth for
  pixel accuracy and focus isolation, the role `bench/fixture/BenchFixture.swift`
  plays on macOS.
- **Conformance suite.** The same JSON-lines protocol scripts run against the
  macOS and Android backends. Unit tests cover the role map, the key map and
  index invalidation.
- **Emulator matrix.** Android 11 and 13 (API 30 and 33) for the
  default-display route only; Android 14 to 17 (API 34–37) for both routes.
  x86_64 Google APIs images on KVM-capable Linux runners. Cuttlefish if
  emulator multi-display proves flaky; Redroid not relied on, since its
  virtual-display support is unknown.
- **Default-display-untouched checks.** Focused display from `dumpsys`, a
  screenshot hash of the phone screen before and after, and a capture through
  the emulator console as a check that does not go through glovebox.
- **Benchmark.** Port the `bench/` metrics (round trips, tokens split by
  cache, wall time, passes) to Android tasks on the emulator, and run
  AndroidWorld, Google's emulator benchmark, for numbers comparable with
  published agents.
- **Physical phones only.** Pixel on the current and previous Android, Samsung
  (One UI), Xiaomi (HyperOS) and one Oppo or OnePlus (ColorOS). Checks: vendor
  injection gates, locked, screen-off and doze behaviour, real keyboards, apps
  with integrity checks, Advanced Protection, wireless ADB reconnect,
  sensitive views in real apps, battery and heat, and latency over USB
  against Wi-Fi.

## Open decisions

Five choices are needed before Phase 1; the recommended answer is listed
first.

1. **How a script names a device.** `gb.device("emulator-5554").getApp(...)`,
   which keeps the App API identical (recommended); or a prefix in the query
   (`"android:com.example"`); or one device per session.
2. **First target.** Emulator only for v1 (recommended), or a Pixel alongside
   it.
3. **Where the ADB key lives.** On a separate machine, reached over MCP
   (recommended), or on the Mac.
4. **Server language.** Java, matching scrcpy's wrapper classes (recommended),
   or Kotlin.
5. **Licensing.** Reusing scrcpy's Apache-2.0 classes in an MIT repo needs a
   NOTICE file and per-file headers; confirm that is acceptable.

## Sources

Checked 2026-11-15.

- [Android 17 Advanced Protection and accessibility](https://thehackernews.com/2026/10/android-17-advanced-protection-locks.html)
- [accessibilityDataSensitive (Android Developers Blog)](https://developer.android.com/blog/posts/enhancing-android-security-stop-malware-from-snooping-on-your-app-data)
- [Developer verification; ADB installs exempt](https://support.google.com/android-developer-console/answer/16561738)
- [scrcpy virtual display docs](https://sources.debian.org/src/scrcpy/3.3.4-1/doc/virtual_display.md)
  and [scrcpy 4.0 release notes](https://ubuntuhandbook.org/index.php/2026/05/scrcpy-4-0-resizable-virtual-display/)
- [UiAutomation API reference](https://developer.android.com/reference/android/app/UiAutomation)
- [AppFunctions overview](https://developer.android.com/ai/appfunctions)
  and [beta status](https://forkast.news/?p=132997)
- [Gemini screen automation in a virtual window](https://techcrunch.com/2026/02/25/gemini-can-now-automate-some-multi-step-tasks-on-android)
