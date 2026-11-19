// Unit tests for the pure parts: cell rewriting, key parsing, tree diffs, and
// the image/screen coordinate mapping. GUI behavior is covered by `nostrings smoke`.
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { App, pickWindow } from "../src/api.mjs";
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

test("an element that only moved deeper is not a change", () => {
  const before = formatTree(nodes);
  const after = formatTree([nodes[0], { i: 9, d: 1, role: "AXGroup" }, { ...nodes[1], d: 2 }, { ...nodes[2], d: 2 }]);
  assert.deepEqual(diffTrees(before, after), ["+\t9 group"]);
});

test("tooltips and field editors never become the default window", () => {
  const main = { index: 1, windowId: 10, frame: [0, 0, 900, 500], main: true, focused: false, title: "Docs" };
  const tooltip = { index: 0, windowId: 11, frame: [100, 100, 362, 50], focused: true, title: "" };
  const editor = { index: 0, frame: [100, 100, 55, 16], focused: true, title: "" };
  const desktop = { index: 2, frame: [0, 0, 1710, 1112], title: "" };
  assert.equal(pickWindow([tooltip, main, desktop]), main);
  assert.equal(pickWindow([editor, main, desktop], { windowId: 10 }), main);
  // A new normal window that takes focus (settings, a new document) wins.
  const settings = { index: 0, windowId: 12, frame: [50, 50, 600, 400], focused: true, title: "Settings" };
  assert.equal(pickWindow([settings, main], { windowId: 10 }), settings);
  // ...unless the caller picked a window explicitly.
  assert.equal(pickWindow([settings, main], { windowId: 10, explicit: true }), main);
});

// An App over a fake backend whose tree the test can change between reads.
function fakeApp() {
  const state = { value: "0", title: "Calc" };
  const printed = [];
  const ctx = {
    config: { screenshot: { maxLongSide: 1568, maxPixels: 1_150_000 }, ax: { maxNodes: 800, maxDepth: 40, maxTextLength: 160 } },
    checkAbort() {},
    out: { text: (t) => printed.push(t) },
    backend: {
      async request(method) {
        if (method === "windows") return [{ index: 0, windowId: 7, frame: [0, 0, 200, 300], scale: 2, title: state.title, focused: true }];
        if (method === "axTree") {
          return {
            window: { title: state.title, windowId: 7 },
            nodes: [
              { i: 0, d: 0, role: "AXWindow", title: state.title, frame: [0, 0, 200, 300] },
              { i: 1, d: 1, role: "AXStaticText", desc: "Edit field", value: state.value, frame: [10, 10, 100, 20] },
            ],
          };
        }
        throw new Error(`unexpected ${method}`);
      },
    },
  };
  return { app: new App(ctx, { name: "Calc", pid: 1 }), state, printed };
}

test("a silent read does not move the diff baseline", async () => {
  const { app, state, printed } = fakeApp();
  await app.getAXState();
  state.value = "42";
  await app.getAXState({ emit: false, disableDiffing: true });
  await app.getAXState();
  assert.equal(printed.length, 2);
  assert.match(printed[1], /changes since last read/);
  assert.match(printed[1], /~\t1 text "Edit field" value="42"/);
});

test("a title change or a frames read does not reprint the tree", async () => {
  const { app, state, printed } = fakeApp();
  await app.getAXState();
  state.title = "Calc — 42";
  state.value = "42";
  await app.getAXState();
  assert.match(printed[1], /changes since last read/);
  assert.equal(printed[1].split("\n").length, 3);
  // The first frames read is printed in full; the plain read after it diffs.
  await app.getAXState({ frames: true });
  assert.match(printed[2], /@20,20 200x40/);
  await app.getAXState();
  assert.match(printed[3], /no change/);
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

test("ui.device binds getApp to that device and keeps handles apart", async () => {
  const { createApi } = await import("../src/api.mjs");
  const calls = [];
  const fake = (platform, pid) => ({
    platform,
    label: platform,
    async request(method, params) {
      calls.push([platform, method, params]);
      if (method === "resolveApp") return { name: "Clock", bundleId: "com.clock", pid, running: true };
      throw new Error(`unexpected ${method}`);
    },
  });
  const host = fake("macos", 42);
  const devices = new Map();
  const ctx = {
    backend: host,
    device: (serial) => devices.get(serial) ?? devices.set(serial, fake("android", "com.clock")).get(serial),
    checkAbort() {},
    log() {},
    out: { text() {} },
  };
  const ui = createApi(ctx);
  const mac = await ui.getApp("Clock");
  const phone = ui.device("emulator-5554");
  const droid = await phone.getApp("Clock");
  assert.equal(mac.platform, "macos");
  assert.equal(droid.platform, "android");
  assert.equal(droid.pid, "com.clock");
  assert.notEqual(mac, droid);
  // The same device hands back the same handle.
  assert.equal(await ui.device("emulator-5554").getApp("Clock"), droid);
  assert.deepEqual(calls.map(([p, m]) => `${p}:${m}`), ["macos:resolveApp", "android:resolveApp", "android:resolveApp"]);
});

test("Android handles use the hidden screen unless told otherwise", async () => {
  const { createApi } = await import("../src/api.mjs");
  const sent = [];
  const device = (hiddenScreen) => ({
    platform: "android",
    label: "Phone",
    info: { hiddenScreen },
    async request(method, params) {
      sent.push(params);
      return { name: params.query, bundleId: params.query, pid: params.query, running: true };
    },
  });
  const make = (dev, config = {}) => createApi({ backend: {}, device: () => dev, config, checkAbort() {}, log() {}, out: { text() {} } });
  const modern = device(true);
  assert.equal((await make(modern).device().getApp("com.a")).screen, "hidden");
  assert.equal((await make(modern).device().getApp("com.b", { foreground: true })).screen, "phone");
  assert.equal((await make(modern, { androidScreen: "phone" }).device().getApp("com.c")).screen, "phone");
  // On Android, foreground also switches a handle that already exists.
  const api = make(modern);
  const first = await api.device().getApp("com.e");
  assert.equal(await api.device().getApp("com.e", { foreground: true }), first);
  assert.equal(first.screen, "phone");
  // Before Android 14 there is no hidden screen.
  assert.equal((await make(device(false)).device().getApp("com.d")).screen, "phone");
});

test("device approval asks first for sensitive apps and never blocks outright", async () => {
  const { authorize, authorizeLocked, isAskFirst } = await import("../src/approval.mjs");
  const asked = [];
  const answer = (value) => async (q) => (asked.push(q.detail), value);
  const base = { client: "Agent", device: "Phone", approved: new Set() };
  const cfg = (approval, extra = {}) => ({ approval, allow: [], deny: [], ...extra });

  // allow-all: ordinary apps pass silently; ask-first apps still ask.
  await authorize({ ...base, pkg: "com.example.notes", config: cfg("allow-all"), prompt: answer("deny") });
  assert.equal(asked.length, 0);
  await assert.rejects(authorize({ ...base, pkg: "com.android.vending", config: cfg("allow-all"), prompt: answer("deny") }), { code: "denied" });
  assert.equal(asked.length, 1);
  assert.ok(isAskFirst("com.google.android.apps.messaging"));

  // ask: one prompt per app per session.
  const approved = new Set();
  await authorize({ ...base, approved, pkg: "com.example.maps", config: cfg("ask"), prompt: answer("session") });
  await authorize({ ...base, approved, pkg: "com.example.maps", config: cfg("ask"), prompt: answer("deny") });
  assert.equal(asked.length, 2);

  // allowlist: ordinary apps need `allow`; ask-first apps can still be approved.
  await assert.rejects(authorize({ ...base, pkg: "com.example.x", config: cfg("allowlist"), prompt: answer("session") }), { code: "not_allowed" });
  await authorize({ ...base, pkg: "com.android.settings", config: cfg("allowlist"), prompt: answer("session") });

  // deny wins; allow skips the prompt even for ask-first apps.
  await assert.rejects(authorize({ ...base, pkg: "com.example.y", config: cfg("allow-all", { deny: ["com.example.y"] }) }), { code: "denied" });
  const before = asked.length;
  await authorize({ ...base, pkg: "com.android.vending", config: cfg("ask", { allow: ["com.android.vending"] }), prompt: answer("deny") });
  assert.equal(asked.length, before);

  // No dialog on this host: a coded error that says how to approve.
  await assert.rejects(authorize({ ...base, pkg: "com.example.z", config: cfg("ask"), prompt: async () => null }), { code: "needs_approval" });

  // A locked phone asks once per session.
  const lockApproved = new Set();
  await authorizeLocked({ ...base, approved: lockApproved, prompt: answer("session") });
  await authorizeLocked({ ...base, approved: lockApproved, prompt: answer("deny") });
});

test("app.find, app.nodes and app.text return data and print nothing", async () => {
  const { createApi } = await import("../src/api.mjs");
  const printed = [];
  const nodes = [
    { i: 1, d: 0, role: "AXWindow", title: "Form", frame: [0, 0, 100, 100] },
    { i: 2, d: 1, role: "AXButton", title: "Save", actions: ["AXPress"], frame: [10, 10, 20, 10] },
    { i: 3, d: 1, role: "AXTextField", value: "x".repeat(300), placeholder: "Notes", settable: true, frame: [10, 30, 80, 10] },
    { i: 4, d: 1, role: "AXButton", title: "Cancel", disabled: true, frame: [40, 10, 20, 10] },
  ];
  const backend = {
    platform: "macos",
    async request(method, params) {
      if (method === "resolveApp") return { name: "Form", bundleId: "com.form", pid: 7, running: true };
      if (method === "windows") return [{ index: 0, windowId: 9, title: "Form", frame: [0, 0, 100, 100], scale: 2, focused: true, main: true }];
      if (method === "axTree") return { window: { windowId: 9, title: "Form" }, nodes: nodes.map((n) => (n.value ? { ...n, value: n.value.slice(0, params.maxText) } : n)) };
      throw new Error(`unexpected ${method}`);
    },
  };
  const config = { ax: { maxNodes: 800, maxDepth: 40, maxTextLength: 160 }, screenshot: {} };
  const ui = createApi({ backend, config, checkAbort() {}, log() {}, out: { text: (t) => printed.push(t) } });
  const app = await ui.getApp("Form");
  assert.equal((await app.find({ role: "button", label: "save" })).index, 2);
  assert.equal((await app.find("notes")).index, 3); // a bare string matches placeholder too
  assert.equal((await app.find({ role: "button", disabled: false }, { all: true })).length, 1);
  assert.equal(await app.find({ label: /^Nope$/ }), null);
  const save = (await app.nodes()).find((n) => n.index === 2);
  assert.deepEqual(save.actions, ["press"]);
  assert.equal(save.frame.length, 4);
  assert.equal((await app.text(3)).length, 300);
  assert.deepEqual(printed, []);
  // expect: returns the match, or prints the window and throws.
  assert.equal((await app.expect({ label: "Save" }, { timeout: 0 })).index, 2);
  assert.equal(await app.expect({ label: "Nope" }, { gone: true, timeout: 0 }), true);
  await assert.rejects(app.expect({ role: "button", label: "Delete" }, { timeout: 0 }), /expect failed in Form: an element matching \{role: "button", label: "Delete"\} not found/);
  assert.equal(printed.length, 1); // the read printed on failure
});

test("large trees read as an outline; find still sees every element", async () => {
  const { outlineTree } = await import("../src/axformat.mjs");
  // A window, 30 sections, each with 20 rows; half the sections are below the window.
  const nodes = [{ i: 1, d: 0, role: "AXWindow", frame: [0, 0, 100, 100] }];
  let i = 2;
  for (let s = 0; s < 30; s++) {
    const y = s < 15 ? s * 6 : 200 + s;
    nodes.push({ i: i++, d: 1, role: "AXGroup", title: `Section ${s}`, frame: [0, y, 100, 5] });
    for (let r = 0; r < 20; r++) nodes.push({ i: i++, d: 2, role: "AXStaticText", title: `row ${r}`, frame: [0, y, 100, 5] });
  }
  const small = outlineTree(nodes.slice(0, 100), { limit: 250 });
  assert.equal(small.nodes.length, 100); // under the limit: unchanged
  const big = outlineTree(nodes, { limit: 250, bounds: [0, 0, 100, 100] });
  assert.equal(big.offscreen, 15 * 21);
  // Level by level: the window, the 15 on-screen sections, then rows in
  // order until 250; the rest count on their section.
  assert.equal(big.nodes.length, 250);
  assert.equal(big.deeper, 1 + 15 * 21 - 250);
  assert.equal(big.folded.get(2), undefined); // section 0 shows all its rows
  assert.equal(big.folded.get(2 + 11 * 21), 6); // section 11 shows 14 of 20
  assert.equal(big.folded.get(2 + 14 * 21), 20);
});

test("init connects agents once, keeps backups, and leaves unparseable configs alone", async () => {
  const { planAgents } = await import("../src/agents.mjs");
  const fsm = await import("node:fs");
  const osm = await import("node:os");
  const pathm = await import("node:path");
  const home = fsm.mkdtempSync(pathm.join(osm.tmpdir(), "nostrings-agents-"));
  const only = ["codex", "cursor", "gemini", "opencode"];
  fsm.mkdirSync(pathm.join(home, ".gemini"));
  fsm.writeFileSync(pathm.join(home, ".gemini", "settings.json"), JSON.stringify({ theme: "dark" }));
  const first = planAgents({ home, only });
  assert.deepEqual(first.map((a) => a.status), ["todo", "todo", "todo", "todo"]);
  for (const a of first) a.apply();
  assert.deepEqual(planAgents({ home, only }).map((a) => a.status), ["done", "done", "done", "done"]);
  const gemini = JSON.parse(fsm.readFileSync(pathm.join(home, ".gemini", "settings.json"), "utf8"));
  assert.equal(gemini.theme, "dark");
  assert.ok(gemini.mcpServers.nostrings.args.includes("mcp"));
  assert.ok(fsm.existsSync(pathm.join(home, ".gemini", "settings.json.before-nostrings")));
  const opencode = JSON.parse(fsm.readFileSync(pathm.join(home, ".config", "opencode", "opencode.json"), "utf8"));
  assert.equal(opencode.mcp.nostrings.type, "local");
  assert.match(fsm.readFileSync(pathm.join(home, ".codex", "config.toml"), "utf8"), /^\[mcp_servers\.nostrings\]$/m);
  fsm.writeFileSync(pathm.join(home, ".cursor", "mcp.json"), "{ // a comment\n}");
  assert.equal(planAgents({ home, only: ["cursor"] })[0].status, "manual");
  fsm.rmSync(home, { recursive: true, force: true });
});
