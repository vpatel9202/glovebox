// Unit tests for the pure parts: cell rewriting, key parsing, tree diffs, and
// the image/screen coordinate mapping. GUI behavior is covered by `glovebox smoke`.
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { diffTrees, formatTree } from "../src/axformat.mjs";
import { toImage, toScreen, viewFor } from "../src/geometry.mjs";
import { parseChord, parseKeys } from "../src/keys.mjs";
import { transformCell } from "../src/transform.mjs";

function session() {
  const context = vm.createContext({});
  return (code) => vm.runInContext(transformCell(code), context);
}

test("top-level bindings persist across cells and can be redeclared", async () => {
  const run = session();
  assert.equal(await run("const a = await Promise.resolve(2); let b = a * 3; b"), 6);
  assert.equal(await run("a + b"), 8);
  assert.equal(await run("const a = 10; a"), 10);
  assert.equal(await run("function twice(x) { return x * 2 } class Box { constructor(v) { this.v = v } }"), undefined);
  assert.equal(await run("new Box(twice(a)).v"), 20);
});

test("destructuring and imports become persistent bindings", async () => {
  const run = session();
  await run("const { x, y: [z] } = { x: 1, y: [2] }");
  assert.equal(await run("x + z"), 3);
});

test("rejected top-level await surfaces as a rejection, not a hang", async () => {
  const run = session();
  await assert.rejects(run("await Promise.reject(new Error('boom'))"), /boom/);
});

test("syntax errors report a location", () => {
  assert.throws(() => transformCell("const = 1"), /SyntaxError: .*line 1/);
});

test("key chords parse xdotool syntax", () => {
  assert.deepEqual(parseChord("ctrl+a"), { key: "a", mods: ["ctrl"] });
  assert.deepEqual(parseChord("super+shift+Tab"), { key: "Tab", mods: ["super", "shift"] });
  assert.deepEqual(parseChord("Return"), { key: "Return", mods: [] });
  assert.deepEqual(parseChord("cmd+c"), { key: "c", mods: ["super"] });
  assert.deepEqual(parseChord("ctrl++"), { key: "plus", mods: ["ctrl"] });
  assert.deepEqual(parseKeys("ctrl+a BackSpace").map((c) => c.key), ["a", "BackSpace"]);
  assert.throws(() => parseChord("hyper+a"), /Unknown modifier/);
});

const nodes = [
  { i: 0, d: 0, role: "AXWindow", title: "Calc" },
  { i: 1, d: 1, role: "AXStaticText", desc: "Edit field", value: "42" },
  { i: 2, d: 1, role: "AXButton", desc: "7", actions: ["AXPress"] },
];

test("tree lines are compact and diffs are keyed by index", () => {
  const before = formatTree(nodes);
  assert.deepEqual(before, ['0 window "Calc"', '\t1 text "Edit field" value="42"', '\t2 button "7"']);
  const after = formatTree([nodes[0], { ...nodes[1], value: "7" }, { i: 3, d: 1, role: "AXButton", desc: "8" }]);
  assert.deepEqual(diffTrees(before, after), ['~\t1 text "Edit field" value="7"', '+\t3 button "8"', "- removed: 2"]);
  assert.deepEqual(diffTrees(before, before), []);
});

test("image space round-trips to screen points", () => {
  const limits = { maxLongSide: 1568, maxPixels: 1_150_000 };
  const view = viewFor({ index: 0, frame: [405, 531, 230, 408], scale: 2 }, limits);
  assert.equal(view.scale, 2);
  assert.deepEqual([view.width, view.height], [460, 816]);
  assert.deepEqual(toScreen(view, [230, 408]), [520, 735]);
  assert.deepEqual(toImage(view, [520, 735, 10, 10]), [230, 408, 20, 20]);

  // A large window is scaled down to the pixel budget, and clicks follow.
  const big = viewFor({ index: 0, frame: [0, 25, 2560, 1415], scale: 2 }, limits);
  assert.ok(big.width * big.height <= limits.maxPixels + big.width + big.height);
  const [sx, sy] = toScreen(big, [big.width / 2, big.height / 2]);
  assert.ok(Math.abs(sx - 1280) < 1 && Math.abs(sy - (25 + 1415 / 2)) < 1);
});
