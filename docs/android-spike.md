# Android Phase 0 spike results

Results of the Phase 0 spike in [android-plan.md](android-plan.md), run
2026-11-18. Four arm64 emulators (API 34, 35, 36, 37) and one Galaxy S24
Ultra (Android 17, API 37, One UI 9). Tools: scrcpy 5.0.1
(`--new-display`), `am start --display`, `input -d`, `uiautomator dump` and
`events`, `dumpsys`. With the user's approval, one exception to "no code": a
throwaway `app_process` probe (about 60 lines of Java, not kept) that creates
a virtual display with a flag scrcpy does not set. It ran on emulators only.
To rebuild it: make an `ActivityThread` with its hidden constructor, take its
system context and wrap it so the package name reads `com.android.shell`,
build `DisplayManager` through its hidden `DisplayManager(Context)`
constructor, and call `createVirtualDisplay` with an `ImageReader` surface at
1080x2400, 420 dpi. Flags were `0xfdcb` (scrcpy's set plus `OWN_FOCUS` and
`DEVICE_DISPLAY_GROUP`, no decorations) and `0x1fdcb` (the same plus
`STEAL_TOP_FOCUS_DISABLED`). scrcpy 5.0.1 sets `OWN_FOCUS` on API 34 and
later but never `STEAL_TOP_FOCUS_DISABLED`; both are hidden flags in AOSP
`DisplayManager`.

The S24 is a personal phone, so it drove only Clock and Calculator, with
clipboard sync off. Q5, Q7 and the `--no-vd-destroy-content` variant of Q6
were not run there, nor was the probe.

## By device

Pass means the answer is what glovebox needs. Q7 "bypass" is a finding
against the user, not a pass.

| Device | Q1 stock | Q1 probe | Q2 | Q3 | Q4 | Q5 | Q6 | Q7 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Emulator API 34 | fail | pass | pass while focused | 71% | task moves to the phone screen | pass (`local`, `hide`) | destroyed | bypass |
| Emulator API 35 | fail | pass | one dump failed, one other run passed | 72% | same | pass | destroyed | bypass |
| Emulator API 36 | fail | pass; BACK reaches the display | pass while focused | 56%, 83% | same | pass | destroyed | bypass |
| Emulator API 37 | fail | focus kept; keyboard unverified | pass while focused | 61% | same | pass | destroyed | launch and tap work while asleep; read failed |
| Galaxy S24 Ultra | fail | not run | pass while focused | 2 of 2 | same | not run | destroyed | not run |

Q2 "one other run passed" on API 35: the Q2 script's dump failed, while the
Q7 script's dump of the virtual display worked on the same image.

## Answers

| # | Question | Answer |
| --- | --- | --- |
| 1 | Does display 0 keep focus while the agent works on a virtual display? | **Not with scrcpy's flags; yes with `STEAL_TOP_FOCUS_DISABLED`.** With stock scrcpy, starting or tapping an app on the virtual display makes it the top focused display, display 0 loses its focused window, and the user's keyboard closes. Same on every emulator level and on the S24. The probe display adds the hidden flag `VIRTUAL_DISPLAY_FLAG_STEAL_TOP_FOCUS_DISABLED` (`1 << 16`): display 0 then keeps top focus, its focused window and its keyboard on API 34, 35 and 36. On API 36, BACK sent to the virtual display still reached the agent's app there; text was injected but not read back, since stock tools cannot read an unfocused display (Q2). API 37 kept focus too; its keyboard check was spoiled by a System UI "not responding" dialog on that image |
| 2 | Does the accessibility tree include windows on the virtual display? | **Yes, but stock tools read it only while that display has focus.** `uiautomator dump` returned the virtual display's app when it was top focused, on all levels but one run (API 35: "null root node"), and on the S24. It reads only the top focused display, so with focus kept on display 0 (Q1) stock tools cannot read the virtual display. Reading it without focus needs our own `UiAutomation` code (`getWindowsOnAllDisplays`), which this spike did not test. A second shell automation connection fails silently while one is open: `uiautomator dump` printed nothing while `uiautomator events` ran |
| 3 | How many of about 20 apps launch on the virtual display, respond and stay there? | **Launch and stay: nearly all. Full pass: 56 to 83%, below the 80% gate on most runs.** See the Q3 table. Two failure kinds. BACK did not change the top activity (search screens, Gmail, Maps), probably because the app spent BACK closing its keyboard or a tour; that was not measured. And something of the app showed up on display 0, the user's screen: for Docs on API 36 and 37 it was the Google sign-in flow (`AccountIntroActivity`); for Messages, Calendar and Contacts the check fired but nothing was left on display 0 when it was listed, so it was brief or a false match. The rate moves between runs: API 36 scored 10/18, then 15/18 |
| 4 | What happens when the user opens the same app on the phone screen? | **It depends on how they open it.** `am start --display 0` moves the agent's task off the virtual display onto the phone screen. A launcher-style intent brings the existing task forward where it already is, on the virtual display, so the user's tap appears to do nothing. Same on all levels and the S24 |
| 5 | Can text be entered without a keyboard showing on the phone screen? | **Yes, with `--display-ime-policy=local` or `hide`.** Injected text (`input -d N text`) reached the field under all three policies. `local` shows the keyboard on the virtual display, `hide` shows none, `fallback` shows it on display 0, the user's screen (API 34, 36, 37; on API 35 it was not visible). Emulators only |
| 6 | What happens to the virtual display's apps when the server is killed? | **Default: destroyed. With `--no-vd-destroy-content`: they land on the phone screen.** Killing the scrcpy server removes the display; with the default flag its apps go away (emulators and S24); without it they move to display 0 (emulators). The plan's "always destroy content on removal" holds |
| 7 | Does any of this survive the screen being locked or off? | **Yes, which is a lock-screen bypass.** With a PIN set and the screen off (emulators only), `am start --display` on the virtual display woke the device (API 34 to 36) and the agent launched, tapped and read the app while the keyguard stayed up on display 0. On API 37 the device stayed asleep; launch and tap still worked, but `uiautomator dump` could not read it. scrcpy sets `ALWAYS_UNLOCKED` on its display |

One more finding: when the virtual display goes away after it took focus,
focus does not always return to display 0 (scrcpy on API 34, 35 and 36 in at
least one variant each, the probe's default display on all levels): `mTopFocusedDisplayId`
still names the removed display and display 0 has no focused window until the
user taps it. Teardown has to hand focus back.

## Q1 detail

Each row is the state after the step: top focused display, display 0's
focused window, keyboard visible on display 0. The user's app on display 0 was
a settings search field with the keyboard up (Clock, with no keyboard, on the
S24).

| Step | scrcpy, decorations | scrcpy, no decorations | probe, default | probe, steal disabled |
| --- | --- | --- | --- | --- |
| Display created | VD, none, closed | 0, kept, up | 0, kept, up | 0, kept, up |
| Agent taps the display before starting an app (with decorations it shows a home screen; otherwise it is empty) | VD, none, still drawn but unfocused | 0, kept, up | 0, kept, up | 0, kept, up |
| Agent starts an app there | VD, none, closed | VD, none, closed | VD, none, closed | **0, kept, up** |
| Agent taps that app | VD, none, closed | VD, none, closed | VD, none, closed | **0, kept, up** |

Columns 1 and 2: emulators 34 to 37 and the S24 agree on focus; the keyboard
was measured on API 35 and 36, and on API 34 without decorations (in API 34's
first run the search field had not raised it yet, API 37 showed a System UI
dialog, and Clock on the S24 has no keyboard).
Columns 3 and 4: emulators 34 to 36; API 37 matches on focus. With decorations, the secondary
home screen scrcpy puts on the display takes focus as soon as the display
exists.

## Q3 detail

Criteria, fixed before the runs: **launched**, the task is on the virtual
display after `am start --display`; **stays**, still there after 10 s;
**responds**, BACK on that display changes its top activity; **trampolined**,
the app or a screen it opened shows up on display 0. Pass is launched, stays,
responds and not trampolined.

| Device | Apps | Launched and stayed | Responded to BACK | Trampolined | Pass |
| --- | --- | --- | --- | --- | --- |
| Emulator API 34 | 17 | 17 | 12 | 0 | 12 (71%) |
| Emulator API 35 | 18 | 18 | 14 | 1 (Messages) | 13 (72%) |
| Emulator API 36, run 1 | 18 | 17 | 13 | 3 (Docs, Messages, Safety) | 10 (56%) |
| Emulator API 36, run 2 | 18 | 18 | 15 | 0 | 15 (83%) |
| Emulator API 37 | 18 | 17 | 14 | 3 (Docs, Calendar, Contacts) | 11 (61%) |
| S24 | 2 (Clock, Calculator) | 2 | 2 | 0 | 2 |

API 36 run 1 also had a quoting bug in the spike script that kept YouTube
from launching; run 2 fixed it. Apps: Camera, Chrome, Settings, Docs, Maps,
Messages, Photos, Safety, YouTube Music, Calendar, Contacts, Clock, Phone,
Files, Gmail, Google search, YouTube and the Settings search screen, all on
emulators with no Google account. The sign-in trampolines come from that
account-less state, but they show a real class: account and sign-in screens
open on display 0, which is the case the plan's per-action display check is
for.

## What this means for the gates

These are recommendations; the decision is bead `gb-7my.3`.

**Gate A (route).** Not met as written. Q1 passes only with a flag scrcpy does
not set, Q2 is untested in the configuration Q1 needs (reading a display that
does not have focus), and Q3 is under 80% on four of five runs. Recommended:
Phase 1 builds on the default display, and the Phase 1 server creates its own
virtual display with `STEAL_TOP_FOCUS_DISABLED` and `OWN_FOCUS`, then tests
reading it through `getWindowsOnAllDisplays`. If that read works, Phase 3
makes the virtual display the default after all; the Q3 shortfall is mostly
the BACK criterion and sign-in screens, which the per-action display check
handles by stopping.

**Gate B (privilege).** Met: a shell accessibility connection worked on every
emulator level and on the S24, so the accessibility half stays in the shell
server and no instrumentation APK is needed. The single-connection limit is
real and silent, so `doctor` has to detect a competing tool rather than wait
for an error.

**For the plan.** Q5 picks the keyboard policy (`hide` or `local`, never
`fallback`). Q6 confirms destroy-on-removal. Q7 confirms Security model item
5: refuse to act while the phone is locked unless the user opts in. Teardown
must return focus to display 0. The probe has not run on the S24, so whether
Samsung honours `STEAL_TOP_FOCUS_DISABLED` is still open.
