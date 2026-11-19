# Example scripts

Saved scripts are routines that worked once and run again by name, with no
model in the loop. Copy these into your own scripts with:

```bash
nostrings scripts --examples      # copies them to ~/.nostrings/scripts, keeps yours
nostrings script calc expr=1234*5678
```

Or from an agent session: `await ui.scripts.run("calc", {expr: "1234*5678"})`.

| Script | Does | Runs on | Tested |
|---|---|---|---|
| [calc](calc.js) | Works out an expression in Calculator and returns the display | Mac | not yet on a real machine |
| [textedit-note](textedit-note.js) | Starts a TextEdit document and types into it, in the background | Mac | not yet on a real machine |
| [phone-open](phone-open.js) | Opens a link on the phone and reads the screen | Android | emulator, API 36 |
| [notifications-digest](notifications-digest.js) | Lists the Mac's and the phone's notifications together | Mac + Android | phone side on an emulator |
| [phone-code-to-mac](phone-code-to-mac.js) | Waits for a one-time code on the phone and types it into a Mac app | Mac + Android | not yet on a real machine |

## Writing your own

A script is a plain JavaScript file. The first line is a `// ` comment saying
what it does, `args` holds its arguments, `ui` is the same API as in a session,
and `return` hands back a value. Its variables stay inside it.

```js
// Say hello in TextEdit. args: name
const editor = await ui.getApp("TextEdit");
await editor.typeText(`Hello, ${args.name}!`);
return "done";
```

The easy way is to let the agent do it: once a multi-step task works, ask it
to save the steps with `ui.scripts.save("name", code, "what it does")`. Saved
scripts live in `~/.nostrings/scripts/`, never run unless something calls
them, and each save and run is written to `~/.nostrings/actions.log`.

Arguments from the shell are `key=value` pairs; numbers and `true`/`false`
are converted. Each `nostrings script` call runs in its own CLI session
(`script-<name>`), so it does not disturb an agent's bindings. The first run
in a session asks for approval of each app, as usual; `nostrings allow <app>`
skips that.

Pull requests with new examples are welcome. Say in the table what you ran it
on.
