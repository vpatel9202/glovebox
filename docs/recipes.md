# Recipes

Short scripts an agent can paste into one `js` call (or `nostrings run`). They
use only the API in `api.md`.

Only recipes 1 and 2, the Calculator and TextEdit flows, match what `nostrings
smoke` has exercised on a real machine (see `testing.md`). Every other recipe
is marked "not yet run on a real machine": it follows the documented API and
the code, but nobody has run it. Treat the details, such as app names and menu
labels, as things to check against the tree.

## 1. Calculator: one batched step

Bind the app, press keys, read once. This is the loop `nostrings smoke` runs.

```js
const calc = await ui.getApp("Calculator");
await calc.pressKey("Escape");
await calc.typeText("6*7=");
await calc.getAXState();   // the display line shows value="42"
```

Clicking by element index works in a later call, because `calc` persists. Find
the index in the tree (`14 button "7"` means index 14), then:

```js
await calc.click(14);
await calc.getAXState();   // prints only what changed
```

## 2. TextEdit: click into the text and type

Uses the tree for the text area's box, a pixel click inside it, then typing.
Assumes TextEdit already has a document window open. This follows the
`nostrings smoke --full` flow.

```js
const te = await ui.getApp("TextEdit");
const tree = await te.getAXState({ frames: true, disableDiffing: true, emit: false });
const [, x, y] = tree.match(/text area[^\n]*@(\d+),(\d+)/);
await te.click([Number(x) + 8, Number(y) + 10]);   // inside the text area
await te.typeText("Hello from nostrings\n");
await te.getAXState();
```

## 3. Open a menu item through the AX tree

Not yet run on a real machine. There is no menu API. `menus: true` adds the
menu bar to the tree, and menu bar items and menu items are pressed through
accessibility like buttons. This clicks the bar item, reads again, then
clicks the item.

```js
const app = await ui.getApp("TextEdit");
const find = (tree, role, label) => {
  const m = tree.match(new RegExp(`^\\s*(\\d+) ${role} "${label}"`, "m"));
  if (!m) throw new Error(`No ${role} "${label}" in the tree`);
  return Number(m[1]);
};
const clickMenu = async (app, menu, item) => {
  let tree = await app.getAXState({ menus: true, disableDiffing: true, emit: false });
  await app.click(find(tree, "menu bar item", menu));
  tree = await app.getAXState({ menus: true, disableDiffing: true, emit: false });
  await app.click(find(tree, "menu item", item));
};
await clickMenu(app, "Edit", "Select All");
await app.getAXState();
```

## 4. Remote desktops, virtual machines and canvases: OCR, then click

Not yet run on a real machine. When a read shows one or two elements, the
screen is drawn, so read its text with `app.ocr()` (text, not an image), and
click the center of the frame you want. Frames are in the window image's
pixels, the same space clicks use.

```js
const app = await ui.getApp("Remote Desktop");   // any app whose read shows one or two elements
const text = await app.ocr({ emit: false });
const save = text.find((t) => /^Save$/i.test(t.text));
const [x, y, w, h] = save.frame;
await app.click([x + w / 2, y + h / 2]);
await app.ocr();                                  // prints only what changed
```

To pull every row out of a long scrolling list (a table, a log, a
report), do it in one call and return the rows, not a screenshot per page:

```js
const seen = new Set(), rows = [];
for (let page = 0; page < 30; page++) {
  const before = seen.size;
  for (const t of await app.ocr({ emit: false })) if (!seen.has(t.text)) { seen.add(t.text); rows.push(t.text); }
  if (seen.size === before) break;               // nothing new: the end of the list
  await app.scroll([400, 300], 5);               // a point inside the list
  await app.settle();
}
rows;
```

Remote screens repaint late, so if a page comes back the same as the last,
`await sleep(300)` before the next OCR. Take a screenshot only to check
layout or visuals that text cannot show. Re-read after a resize: a click
outside the window image throws instead of landing in another app.

## 5. Define a helper once, reuse it

Not yet run on a real machine. Functions and constants persist across calls
until `js_reset`, so a repeated lookup becomes one name.

```js
const clickLabel = async (app, label) => {
  const tree = await app.getAXState({ emit: false, disableDiffing: true });
  const m = tree.match(new RegExp(`^\\s*(\\d+) button "${label}"`, "m"));
  if (!m) throw new Error(`No button "${label}"`);
  await app.click(Number(m[1]));
};
```

Later calls:

```js
const calc = await ui.getApp("Calculator");
for (const label of ["7", "Add", "1", "Equals"]) await clickLabel(calc, label);
await calc.getAXState();
```

## 6. Set a field's value directly

Not yet run on a real machine. A line with `settable` in its flags can take
`setValue`, which is faster and more exact than typing. Read it back to check.

```js
const tree = await app.getAXState({ disableDiffing: true });
// e.g.  9 text field "Name" (settable)
await app.setValue(9, "Ada Lovelace");
await app.getAXState();
```

If the app ignores the new value, fall back to `await app.focus(9)` then
`await app.typeText("Ada Lovelace")`. `help("setValue")` prints the reference.

## 7. Handle a "Stopped:" result

Not yet run on a real machine. A result that starts with `Stopped:` means the
user took over (switched apps, pressed Escape with Input Monitoring granted,
or the script hit its time limit). Do not retry or continue; tell the user and
ask. Inside a script, never swallow it (`clickLabel` is from recipe 5):

```js
try {
  for (const label of ["7", "Add", "1", "Equals"]) await clickLabel(calc, label);
} catch (error) {
  if (error.name === "Stopped") throw error;   // let the result say Stopped:
  console.log(`click failed: ${error.message}`);
}
```

Continue only after the user asks, and start with a fresh read:
`await calc.getAXState({ disableDiffing: true })`.

## 8. Force foreground for an app that ignores background input

Not yet run on a real machine. If background clicks or keys do nothing (some
Java, Tk, and game windows), bring the app forward for those actions. A plain
click on a button is pressed through accessibility and never needs this; it
matters for mouse clicks, keys, typing, scroll, and drag.

```js
const app = await ui.getApp("Some Java App");
await app.click([120, 80], { foreground: true });
await app.typeText("hello", { foreground: true });
app.lastRoute;   // "foreground"
```

To make every action on an app use the foreground route, pass
`ui.getApp(name, {foreground: true})` on the call that first binds it, or ask
the user to add the app to `foregroundApps` in the config (`cli.md`). In
foreground mode a script brings the app forward once per call and stops if
the user switches away.
