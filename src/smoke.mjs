// `glovebox smoke`: proves the loop end to end on Calculator through the same
// MCP server an agent would use. It checks that a batched call lands, that a
// binding survives to the next call, that reads diff, and that js_reset drops
// the binding. Nothing here is mocked.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "glovebox.mjs");

function client(env = process.env) {
  const child = spawn(process.execPath, [cli, "mcp"], { stdio: ["pipe", "pipe", "inherit"], env });
  const pending = new Map();
  let nextId = 1;
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  const request = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const js = async (code) => {
    const reply = await request("tools/call", { name: "js", arguments: { code, title: "glovebox smoke" } });
    const text = (reply.result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    return { text, isError: reply.result?.isError ?? true, images: (reply.result?.content ?? []).filter((c) => c.type === "image") };
  };
  return { request, js, close: () => child.stdin.end() };
}

// The frontmost app's name, so the smoke test can prove input stayed in the background.
function frontmostApp() {
  if (process.platform !== "darwin") return null;
  try {
    return execFileSync("osascript", ["-l", "JavaScript", "-e", 'ObjC.import("AppKit"); $.NSWorkspace.sharedWorkspace.frontmostApplication.localizedName.js']).toString().trim();
  } catch {
    return null;
  }
}

export async function runSmoke({ screenshot = true, full = false } = {}) {
  const frontBefore = frontmostApp();
  const mcp = client();
  const results = [];
  const step = (name, pass, detail) => {
    results.push(pass);
    process.stdout.write(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `\n      ${detail.split("\n").join("\n      ")}` : ""}\n`);
  };
  try {
    const init = await mcp.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "glovebox smoke", version: "1" },
    });
    const list = await mcp.request("tools/list", {});
    step("MCP handshake", init.result?.serverInfo?.name === "glovebox" && list.result?.tools?.length === 2);

    // One call: bind the app, several actions, one read.
    const first = await mcp.js(`
const calc = await gb.getApp("Calculator");
await calc.pressKey("Escape");
await calc.typeText("6*7=");
await calc.getAXState();`);
    step("batched call types 6*7= and reads 42", !first.isError && /value="42"/.test(first.text), first.isError ? first.text : undefined);

    // Next call: the binding is still there; click by element index; read is a diff.
    const second = await mcp.js(`
const tree = await calc.getAXState({ emit: false, disableDiffing: true });
const idx = (label) => Number(tree.match(new RegExp("^\\\\s*(\\\\d+) button \\"" + label + "\\"", "m"))[1]);
await calc.click(idx("All Clear"));
for (const label of ["7", "Add", "1", "Equals"]) await calc.click(idx(label));
await calc.getAXState();`);
    step("binding persists; index clicks compute 7+1=8; read is a diff", !second.isError && /value="8"/.test(second.text) && /changes since last read/.test(second.text), second.isError ? second.text : undefined);

    // Pixel click on the same space a screenshot uses.
    const third = await mcp.js(`
const tree2 = await calc.getAXState({ emit: false, disableDiffing: true });
const at = (label) => Number(tree2.match(new RegExp("^\\\\s*(\\\\d+) button \\"" + label + "\\"", "m"))[1]);
await calc.click(at("All Clear"));
const [x, y] = await calc.center(at("9"));
await calc.click([x, y]);
await calc.getAXState();`);
    step("pixel click [x, y] lands on the 9 key", !third.isError && /value="9"/.test(third.text), third.isError ? third.text : undefined);

    if (screenshot) {
      const shot = await mcp.js(`const s = await calc.getScreenshot(); s.width + "x" + s.height + " vs view " + calc.view.width + "x" + calc.view.height`);
      const match = shot.text.match(/(\d+)x(\d+) vs view (\d+)x(\d+)/);
      step(
        "screenshot is an image in the same pixel space as clicks",
        !shot.isError && shot.images.length === 1 && match && match[1] === match[3] && match[2] === match[4],
        shot.isError ? shot.text : undefined,
      );
    }

    await mcp.request("tools/call", { name: "js_reset", arguments: {} });
    const after = await mcp.js("typeof calc");
    step("js_reset drops the binding", !after.isError && after.text.trim() === "undefined", after.text);

    if (full) {
      // Raw mouse input in a background text editor: a click places the caret,
      // a drag selects, a scroll moves the view. Only real mouse events do these.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glovebox-smoke-"));
      const short = path.join(dir, "glovebox-smoke.txt");
      const long = path.join(dir, "glovebox-smoke-long.txt");
      fs.writeFileSync(short, "AAAA\nBBBB\nCCCC\n");
      fs.writeFileSync(long, Array.from({ length: 300 }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n"));
      execFileSync("open", ["-g", "-a", "TextEdit", short, long]);
      await new Promise((r) => setTimeout(r, 2500));
      const te = await mcp.js(`
const te = await gb.getApp("TextEdit");
const wins = await te.windows();
const shortWin = wins.find((w) => w.title.startsWith("glovebox-smoke.txt"));
const longWin = wins.find((w) => w.title.startsWith("glovebox-smoke-long"));
const area = async (i) => (await te.getAXState({ window: i, emit: false, disableDiffing: true, frames: true })).match(/text area value="([^"]*)".*@(\\d+),(\\d+)/);
let a = await area(shortWin.index);
const [ax, ay] = [Number(a[2]), Number(a[3])];
await te.click([ax + 8, ay + 10]);
await te.typeText("Y");
const afterClick = (await area(shortWin.index))[1];
await te.drag([ax + 8, ay + 10], [ax + 300, ay + 10]);
await te.typeText("Q");
const afterDrag = (await area(shortWin.index))[1];
const bars = async () => [...(await te.getAXState({ window: longWin.index, emit: false, disableDiffing: true })).matchAll(/scroll bar value="([^"]+)"/g)].map((m) => m[1]).join(",");
const before = await bars();
await te.scroll([300, 300], 15);
const afterScroll = await bars();
JSON.stringify({ afterClick, afterDrag, before, afterScroll, route: te.lastRoute });`);
      let r = {};
      try {
        r = JSON.parse(te.text.trim().split("\n").at(-1));
      } catch {}
      step("background click places the caret (TextEdit)", !te.isError && /^Y/.test(r.afterClick ?? ""), te.isError ? te.text : r.afterClick);
      step("background drag selects text (TextEdit)", !te.isError && /^Q /.test(r.afterDrag ?? ""), te.isError ? undefined : r.afterDrag);
      step("background scroll moves the view (TextEdit)", !te.isError && r.before !== r.afterScroll, te.isError ? undefined : `${r.before} -> ${r.afterScroll}`);
      process.stdout.write(`      (Two test documents are open in TextEdit; close them without saving: ${dir})\n`);
    }

    const frontAfter = frontmostApp();
    if (frontBefore) {
      step("input stayed in the background (frontmost app unchanged)", frontBefore === frontAfter, `${frontBefore} -> ${frontAfter}`);
    }
  } finally {
    mcp.close();
  }
  const passed = results.every(Boolean);
  process.stdout.write(passed ? "\nAll smoke checks passed.\n" : "\nSome smoke checks failed.\n");
  return passed;
}

// `glovebox smoke --android`: the same loop on a phone or emulator, against
// the fixture app (native/android/fixture), which reports every tap, key,
// long press, drag and scroll in a label. The fixture is installed for the
// run and removed after it unless `keep`. Failure details print only the
// fixture's own labels and error codes, never other screen content.
// Where two display-0 captures differ, as "in [x0,y0]-[x1,y1] (n px)".
function changedBox(a, b) {
  if (!a.body || !b.body || a.body.length !== b.body.length) return "";
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1, n = 0;
  for (let i = 0; i < a.body.length; i += 4) {
    if (a.body[i] === b.body[i] && a.body[i + 1] === b.body[i + 1] && a.body[i + 2] === b.body[i + 2]) continue;
    const p = i / 4, x = p % a.w, y = Math.floor(p / a.w) + a.top;
    n++;
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  return n ? `in [${x0},${y0}]-[${x1},${y1}] (${n} px)` : "";
}

export async function runAndroidSmoke({ serial, keep = false } = {}) {
  const { FIXTURE_APK, FIXTURE_PACKAGE, resolveSerial, adb } = await import("./backends/android.mjs");
  const results = [];
  const step = (name, pass, detail) => {
    results.push(pass);
    process.stdout.write(`${pass ? "PASS" : "FAIL"}  ${name}${!pass && detail ? `\n      ${String(detail).split("\n")[0]}` : ""}\n`);
  };
  if (!fs.existsSync(FIXTURE_APK)) {
    step("fixture app built", false, "Run: npm run build:android");
    return false;
  }
  let transport;
  try {
    transport = await resolveSerial(serial ?? process.env.ANDROID_SERIAL);
    const install = () => adb(["-s", transport, "install", "-r", "--user", "0", FIXTURE_APK], { timeout: 120_000 });
    await install().catch(async (error) => {
      // A fixture signed by an older build key: replace it.
      if (!/INSTALL_FAILED_UPDATE_INCOMPATIBLE|signatures do not match/i.test(error.message)) throw error;
      await adb(["-s", transport, "uninstall", FIXTURE_PACKAGE]);
      await install();
    });
    await adb(["-s", transport, "shell", "am", "force-stop", FIXTURE_PACKAGE]);
  } catch (error) {
    step("fixture app installs", false, error.message);
    return false;
  }
  // The user's screen, watched from outside glovebox: which display has top
  // focus, and a hash of display 0 without its status and navigation bars.
  // Only the hash is kept, never the image.
  const emulator = transport.startsWith("emulator-");
  const watch = async () => {
    const focus = (await adb(["-s", transport, "shell", "dumpsys", "window"]).catch(() => "")).match(/mTopFocusedDisplayId=(-?\d+)/)?.[1] ?? null;
    let hash = null;
    try {
      const raw = execFileSync(process.env.GLOVEBOX_ADB || "adb", ["-s", transport, "exec-out", "screencap"], { maxBuffer: 128 << 20 });
      const w = raw.readUInt32LE(0), h = raw.readUInt32LE(4);
      const header = raw.length - w * h * 4;
      const crypto = await import("node:crypto");
      const body = raw.subarray(header + Math.floor(h * 0.08) * w * 4, header + Math.floor(h * 0.92) * w * 4);
      hash = crypto.createHash("sha1").update(body).digest("hex");
      return { focus, hash, body, w, top: Math.floor(h * 0.08) };
    } catch {}
    return { focus, hash };
  };
  // An emulator's home screen updates its app suggestions after any launch,
  // hidden or not; a static Files screen shows only what glovebox changes.
  if (emulator) {
    await adb(["-s", transport, "shell", "input", "keyevent", "KEYCODE_WAKEUP"]).catch(() => {});
    await adb(["-s", transport, "shell", "wm", "dismiss-keyguard"]).catch(() => {});
    // (Not Settings: it is an ask-first app, and a stray inspect of it would
    // raise an approval dialog on the Mac.)
    const files = (await adb(["-s", transport, "shell", "cmd", "package", "resolve-activity", "--brief", "-c", "android.intent.category.LAUNCHER", "-a", "android.intent.action.MAIN", "com.google.android.documentsui"]).catch(() => "")).trim().split("\n").at(-1);
    if (files && files.includes("/")) await adb(["-s", transport, "shell", "am", "start", "-W", "-n", files]).catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));
  }
  const before = await watch();
  // The fixture is ours: skip its dialog. Ask-first apps and a locked phone still ask.
  const mcp = client({ ...process.env, GLOVEBOX_APPROVAL: "allow-all" });
  // Runs `code` and parses the JSON its last line prints.
  const run = async (code) => {
    const reply = await mcp.js(code);
    if (reply.isError) return { error: reply.text.trim().split("\n").at(-1) };
    try {
      return { ...JSON.parse(reply.text.trim().split("\n").at(-1)), images: reply.images.length };
    } catch {
      return { error: "unexpected output" };
    }
  };
  try {
    await mcp.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "glovebox smoke", version: "1" } });
    const hello = await run(`
const phone = gb.device(${JSON.stringify(transport)});
const fx = await phone.getApp(${JSON.stringify(FIXTURE_PACKAGE)});
await fx.activate();
const tree = () => fx.getAXState({ emit: false, disableDiffing: true, frames: true });
const idx = async (re) => Number((await tree()).match(re)?.[1]);
const label = async (prefix) => (await tree()).match(new RegExp('text "(' + prefix + '[^"]*)"'))?.[1];
JSON.stringify({ ok: /text field/.test(await tree()), device: String(phone), screen: fx.screen });`);
    step(`device connects and reads the fixture (${hello.screen ?? "?"} screen)`, hello.ok === true, hello.error);
    if (!hello.ok) return false;

    const tap = await run(`
await fx.click(await idx(/^\\s*(\\d+) button "Tap me"/im));
const r1 = fx.lastRoute;
await fx.click(await fx.center(await idx(/^\\s*(\\d+) button "Tap me"/im)));
JSON.stringify({ counts: await label("taps"), r1, r2: fx.lastRoute });`);
    step("index click and pixel tap both land", tap.counts?.startsWith("taps: 2"), tap.error ?? tap.counts);

    const long = await run(`
await fx.longPress(await idx(/^\\s*(\\d+) button "Tap me"/im));
JSON.stringify({ counts: await label("taps") });`);
    step("long press lands", /long presses: 1$/.test(long.counts ?? ""), long.error ?? long.counts);

    const typed = await run(`
await fx.click(await idx(/^\\s*(\\d+) text field/m));
await fx.typeText("hello glovebox");
const route = fx.lastRoute;
const echo1 = await label("echo");
await fx.pressKey("BackSpace");
JSON.stringify({ echo1, echo2: await label("echo"), route });`);
    step("typeText fills the field", typed.echo1 === "echo: hello glovebox", typed.error ?? typed.echo1);
    step("pressKey BackSpace deletes a character", typed.echo2 === "echo: hello glovebo", typed.error ?? typed.echo2);
    if (hello.screen === "hidden") step("input went to the hidden screen", /^hidden screen/.test(typed.route ?? ""), typed.route);

    const code = await run(`
await fx.click((await fx.find({ role: "button", label: "Code screen" })).index);
await sleep(600);
await fx.click((await fx.find({ label: "Digit 1" })).index);
await fx.typeText("123456");
const got = (await fx.find("code:"))?.label;
await fx.pressKey("Back");
await sleep(400);
if (/window "keyboard/.test(await tree())) await fx.pressKey("Back");
JSON.stringify({ got, back: Boolean(await fx.find({ role: "button", label: "Tap me" })) });`);
    step("typeText fills a six-box code field", code.got === "code: 123456" && code.back === true, code.error ?? `${code.got}, back on main: ${code.back}`);

    const web = await run(`
await fx.click((await fx.find({ role: "button", label: "Web screen" })).index);
let heading, link, greet;
try {
await sleep(1000);
heading = (await fx.find({ role: "heading" }))?.label;
await fx.click((await fx.find({ role: "link" })).index);
// The output line, by its text: older WebViews expose no HTML ids.
const out = async () => (await fx.find({ role: "text", label: /^(nothing yet|link tapped|hello)/ }))?.label;
link = await out();
await fx.click((await fx.find({ role: "text field" })).index);
await fx.typeText("glovebox é 😀 日本");
await fx.click((await fx.find({ role: "button", label: "Greet" })).index);
greet = await out();
} catch (e) {
  greet = "error: " + e.message.split("\\n")[0];
} finally {
  // Back to the main screen even after a failure, so later steps still run.
  await fx.pressKey("Back");
  await sleep(400);
  if (/window "keyboard/.test(await tree())) await fx.pressKey("Back");
}
JSON.stringify({ heading, link, greet, back: Boolean(await fx.find({ role: "button", label: "Tap me" })) });`);
    step("web content reads (heading, link)", web.heading === "Web fixture", web.error ?? `heading ${web.heading}`);
    step("web link, typing and button work", web.link === "link tapped" && web.greet === "hello glovebox é 😀 日本" && web.back === true, web.error ?? `${web.link} / ${web.greet} / back ${web.back}`);

    const gest = await run(`
await fx.click((await fx.find({ role: "button", label: "Gesture screen" })).index);
const pad = await fx.expect({ label: "Gesture pad" });
await fx.pinch(pad.index, { scale: 2 });
await fx.rotate(pad.index, { degrees: 45 });
const got = (await fx.find(/^scale:/))?.label;
await fx.pressKey("Back");
JSON.stringify({ got, back: Boolean(await fx.expect({ role: "button", label: "Tap me" })) });`);
    step("pinch and rotate with two fingers", /^scale: 2\.0\d, angle: 4[45]$/.test(gest.got ?? "") && gest.back === true, gest.error ?? gest.got);

    const slid = await run(`
if (/window "keyboard/.test(await tree())) await fx.pressKey("Back"); // hide the keyboard
const s = (await tree()).match(/^\\s*\\d+ slider "Slider".*@(\\d+),(\\d+) (\\d+)x(\\d+)/m).slice(1).map(Number);
const y = s[1] + s[3] / 2;
await fx.drag([s[0] + s[2] * 0.1, y], [s[0] + s[2] * 0.9, y]);
const v1 = Number((await label("slider")).split(" ")[1]);
await fx.swipe([s[0] + s[2] * 0.9, y], [s[0] + s[2] * 0.3, y]);
JSON.stringify({ v1, v2: Number((await label("slider")).split(" ")[1]) });`);
    step("drag moves the slider", slid.v1 >= 70, slid.error ?? `slider ${slid.v1}`);
    step("swipe moves it back", slid.v2 <= 45 && slid.v2 < slid.v1, slid.error ?? `slider ${slid.v2}`);

    const scrolled = await run(`
const listAt = (await tree()).match(/^\\s*\\d+ list.*@(\\d+),(\\d+) (\\d+)x(\\d+)/m).slice(1).map(Number);
await fx.scroll([listAt[0] + listAt[2] / 2, listAt[1] + listAt[3] / 2], 15);
const t = await tree();
JSON.stringify({ row0: /button "Row 0"/.test(t), first: t.match(/button "(Row \\d+)"/)?.[1] });`);
    step("scroll moves the list", scrolled.row0 === false, scrolled.error ?? `first row ${scrolled.first}`);

    const shot = await run(`
const img = await fx.getScreenshot({ format: "png" });
// A blank or one-color frame would mean nothing was captured: count distinct
// byte values in the compressed image as a cheap proxy for content.
const bytes = new Set(Buffer.from(img.data, "base64").subarray(64, 4096)).size;
JSON.stringify({ same: img.width === fx.view.width && img.height === fx.view.height, bytes, size: img.data.length });`);
    step("screenshot is in the same pixel space as clicks", shot.same === true && shot.images === 1, shot.error);
    step("screenshot has content", shot.bytes > 100 && shot.size > 20_000, shot.error ?? `${shot.bytes} distinct bytes, ${shot.size} base64 chars`);

    const gone = await run(`
await fx.pressKey("Back");
let code = null;
for (let i = 0; i < 12 && !code; i++) {
  await sleep(250);
  try { await fx.getAXState({ emit: false }); } catch (e) { code = e.code; }
}
JSON.stringify({ code });`);
    step("Back leaves the app, and a read says not_visible", gone.code === "not_visible", gone.error ?? `code ${gone.code}`);

    if (hello.screen === "hidden") {
      const after = await watch();
      step("the phone's screen kept focus", after.focus === before.focus, `top focused display ${before.focus} -> ${after.focus}`);
      // An emulator's screen holds still; a phone's can change under the user.
      if (emulator) step("the phone's screen did not change", after.hash != null && after.hash === before.hash, `display 0 changed ${changedBox(before, after)}`);
      else process.stdout.write(`info  the phone's screen ${after.hash === before.hash ? "did not change" : "changed (the user, a notification, or glovebox)"}\n`);
    }

    await mcp.request("tools/call", { name: "js_reset", arguments: {} });
    const after = await mcp.js("typeof fx");
    step("js_reset drops the binding", !after.isError && after.text.trim() === "undefined", after.text);

    // The phone's own screen, as getApp(name, {foreground: true}) asks.
    const phoneRoute = await run(`
const fp = await gb.device(${JSON.stringify(transport)}).getApp(${JSON.stringify(FIXTURE_PACKAGE)}, { foreground: true });
await fp.activate();
const t1 = await fp.getAXState({ emit: false, disableDiffing: true });
await fp.click(await fp.center(Number(t1.match(/^\\s*(\\d+) button "Tap me"/im)[1])), { raw: true });
const route = fp.lastRoute;
const counts = (await fp.getAXState({ emit: false, disableDiffing: true })).match(/text "(taps[^"]*)"/)?.[1];
await fp.pressKey("Back");
JSON.stringify({ screen: fp.screen, route, counts });`);
    step("{foreground: true} works on the phone's own screen", phoneRoute.screen === "phone" && /^taps: 1/.test(phoneRoute.counts ?? "") && /^foreground/.test(phoneRoute.route ?? ""), phoneRoute.error ?? `${phoneRoute.screen} ${phoneRoute.route} ${phoneRoute.counts}`);
  } finally {
    mcp.close();
    if (!keep) {
      await adb(["-s", transport, "uninstall", FIXTURE_PACKAGE]).catch((error) => {
        process.stdout.write(`      (Could not remove the fixture app; run: adb -s ${transport} uninstall ${FIXTURE_PACKAGE})\n      ${error.message.split("\n")[0]}\n`);
      });
    }
  }
  const passed = results.every(Boolean);
  process.stdout.write(passed ? "\nAll Android smoke checks passed.\n" : "\nSome Android smoke checks failed.\n");
  return passed;
}

// `glovebox smoke --macos`: every capability row the fixture app
// (native/macos/fixture) can show, through the MCP server. The fixture logs
// what reached it, so each check reads that log, not a model. Background
// checks run first with the frontmost app checked; the last few use the
// foreground route on purpose. The fixture is quit at the end and the
// clipboard is put back.
export async function runMacSmoke({ keep = false, foreground = true } = {}) {
  const fixture = await import("./macos-fixture.mjs");
  const { MacBackend } = await import("./backends/macos.mjs");
  const results = [];
  const step = (name, pass, detail) => {
    results.push(pass);
    process.stdout.write(`${pass ? "PASS" : "FAIL"}  ${name}${detail && !pass ? `\n      ${String(detail).split("\n").slice(0, 6).join("\n      ")}` : ""}\n`);
  };
  process.stdout.write("Building Glovebox Fixture if needed...\n");
  await fixture.buildFixture();
  await fixture.launchFixture();
  const raw = new MacBackend({ client: "glovebox smoke" });
  // Keep the user's clipboard (all of it) in the helper; put it back at the
  // end. The stash is the helper's, so the fixture's pid just passes the gate.
  const fixturePid = (await raw.request("resolveApp", { query: fixture.FIXTURE_BUNDLE_ID })).pid;
  await raw.request("pasteStash", { pid: fixturePid, op: "stash", text: "" }).catch(() => {});
  const frontBefore = frontmostApp();
  const mcp = client();
  const since = () => fixture.readFixtureLog().length;
  const events = (from, name) => fixture.readFixtureLog().slice(from).filter((e) => e.event === name);
  const run = async (code) => {
    const r = await mcp.js(code);
    return r;
  };
  const check = async (name, code, eventName, test = () => true) => {
    const from = since();
    const r = await run(code);
    await new Promise((res) => setTimeout(res, 300));
    const got = events(from, eventName);
    step(name, !r.isError && got.some(test), r.isError ? r.text : JSON.stringify(got.slice(-2)) || "no event");
    return r;
  };
  try {
    await mcp.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "glovebox smoke", version: "1" } });
    const first = await run(`const fx = await gb.getApp("${fixture.FIXTURE_BUNDLE_ID}"); await fx.getAXState();`);
    step("read: form fields are named by their labels", !first.isError && /text field "Name"/.test(first.text) && /pop up button "Color"/.test(first.text), first.text.slice(0, 400));
    const web = await run(`await fx.expect({role: "heading", label: "Web Fixture"}, {timeout: 5000}); (await fx.find({role: "button", label: "Web button"})) != null`);
    step("read: web content inside the app", !web.isError && /true/.test(web.text), web.text.slice(0, 300));
    await check("menu bar item, background", `await fx.menu("Fixture > Beta")`, "menu", (e) => e.item === "Beta");
    await check("submenu item", `await fx.menu(["Fixture", "More", "Gamma"])`, "menu", (e) => e.item === "Gamma");
    await check("menu shortcut in the background (Cmd+Shift+A)", `await fx.pressKey("super+shift+a"); console.log(fx.lastRoute)`, "menu", (e) => e.item === "Alpha");
    await check("pop-up: open and pick in one step", `await fx.select({id: "color"}, "Purple")`, "popup", (e) => e.item === "Purple");
    await check("context menu pick", `await fx.contextMenu({id: "contextTarget"}, "Rename Item")`, "menu", (e) => e.item === "Rename Item");
    await check("checkbox through accessibility", `await fx.click((await fx.find({role: "checkbox", label: "Subscribe"})).index)`, "checkbox");
    await check("type any characters (accents, emoji, CJK)", `await fx.click((await fx.find({id: "name"})).index); await fx.pressKey("super+a BackSpace"); await fx.typeText("Zoë 🎉 東京")`, "text", (e) => e.value === "Zoë 🎉 東京");
    await check("paste long text, clipboard put back", `await fx.click((await fx.find({id: "notes"})).index); await fx.paste("${"lorem ipsum ".repeat(20).trim()} ✓")`, "notes", (e) => e.value.endsWith("✓"));
    await check("type into web content", `await fx.click((await fx.find({role: "text field", text: "Web field"})).index); await fx.typeText("web ok")`, "web", (e) => e.what === "input:web ok");
    await check("click web content", `await fx.click((await fx.find({role: "button", label: "Web button"})).index)`, "web", (e) => e.what === "button");
    const canvas = `(await fx.find({id: "canvas"})).index`;
    await check("press and hold (700 ms)", `await fx.press(${canvas}, {ms: 700})`, "canvas.up", (e) => e.heldMs >= 650);
    await check("double click", `await fx.doubleClick(${canvas})`, "canvas.down", (e) => e.clicks === 2);
    await check("right click", `await fx.rightClick(${canvas}, {raw: true})`, "canvas.right");
    await check("middle click", `await fx.click(${canvas}, {button: "middle"})`, "canvas.other", (e) => e.button === 2);
    await check("scroll", `await fx.scroll(${canvas}, 3)`, "canvas.scroll", (e) => e.dy !== 0);
    await check("pinch (trackpad gesture)", `await fx.pinch(${canvas}, {scale: 1.5})`, "canvas.pinch", (e) => Math.abs(e.total - 0.5) < 0.05);
    await check("rotate (trackpad gesture)", `await fx.rotate(${canvas}, {degrees: 30})`, "canvas.rotate", (e) => e.total === -30);
    await check("window move", `await fx.window().move(180, 140)`, "window.moved");
    await check("window resize", `await fx.window().resize(800, 790)`, "window.resized", (e) => e.w === 800);
    await check("window minimize", `await fx.window().minimize()`, "window.minimized");
    await check("window restore", `await fx.window().restore()`, "window.restored");
    await check("new window, from the menu", `await fx.menu("File > New Window")`, "window.new");
    const notice = await run(`await fx.getAXState()`);
    step("read notes the window that opened", /\(windows: .*opened/.test(notice.text), notice.text.split("\n").slice(-2).join(" "));
    await check("sheet: open, type, OK", `await fx.click((await fx.find({label: "Show Sheet"})).index); await fx.expect({id: "sheetField"}); await fx.click((await fx.find({id: "sheetField"})).index); await fx.typeText("in sheet"); await fx.click((await fx.find({role: "button", label: "OK"})).index)`, "sheet", (e) => e.result === "OK" && e.text === "in sheet");
    await check("alert: pick a button", `await fx.click((await fx.find({label: "Show Alert"})).index); await fx.click((await fx.expect({role: "button", label: "Discard"})).index)`, "alert", (e) => e.result === "Discard");
    await check("hide and unhide the app", `await fx.hide(); await sleep(300); await fx.unhide()`, "app.unhidden");
    // SwiftUI exposes the same controls differently; drive each one.
    await check("SwiftUI window opens", `await fx.menu("File > SwiftUI Window"); await sleep(600); const SW = {window: (await fx.windows()).find((w) => w.title === "SwiftUI Fixture").index}; const sf = (q) => fx.find(q, SW);`, "window.new", (e) => e.title === "SwiftUI Fixture");
    await check("SwiftUI toggle", `await fx.click((await sf({role: "checkbox", label: "Dark Roast"})).index)`, "swiftui.toggle", (e) => e.on === true);
    await check("SwiftUI picker", `await fx.select((await sf({role: "pop up button", label: "Flavor"})).index, "Caramel")`, "swiftui.picker", (e) => e.item === "Caramel");
    await check("SwiftUI text field", `await fx.click((await sf({role: "text field"})).index); await fx.typeText("Zoë")`, "swiftui.text", (e) => e.value === "Zoë");
    await check("SwiftUI slider", `await fx.performSecondaryAction((await sf({role: "slider"})).index, "Increment")`, "swiftui.slider", (e) => e.value === 4);
    await check("SwiftUI stepper", `await fx.performSecondaryAction((await sf({role: "stepper"})).index, "Increment")`, "swiftui.stepper", (e) => e.value === 2);
    await check("SwiftUI menu", `await fx.select((await sf({role: "menu button", label: "More Actions"})).index, "Archive")`, "swiftui.menu", (e) => e.item === "Archive");
    await check("SwiftUI list row", `await fx.click((await sf({role: "text", value: "Banana"})).index)`, "swiftui.list", (e) => e.item === "Banana");
    await check("SwiftUI button", `await fx.click((await sf({role: "button", label: "Place Order"})).index)`, "swiftui.button", (e) => e.flavor === "Caramel" && e.name === "Zoë");
    await run(`await fx.window(SW.window).close()`);
    const frontAfter = frontmostApp();
    if (frontBefore) step("everything above stayed in the background", frontBefore === frontAfter, `${frontBefore} -> ${frontAfter}`);

    // Foreground on purpose: these move the real pointer or need the app in
    // front, so they are skipped with --background-only (someone is at the Mac).
    if (!foreground) {
      process.stdout.write("      (foreground checks skipped: --background-only)\n");
      if (!keep) await check("quit the app", `await fx.quit()`, "quit");
      const ok = results.every(Boolean);
      process.stdout.write(ok ? `\nAll ${results.length} background macOS checks passed.\n` : `\n${results.filter((r) => !r).length} of ${results.length} macOS checks failed.\n`);
      return ok;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glovebox-smoke-"));
    const file = path.join(dir, "pick-me.txt");
    fs.writeFileSync(file, "glovebox smoke\n");
    await check("drop a file on the app (foreground)", `await fx.dropFiles((await fx.find({id: "dropTarget"})).index, ${JSON.stringify([file])})`, "drop", (e) => e.files === "pick-me.txt");
    await check("hover (foreground)", `await fx.hover([20, 20]); await fx.hover(${canvas})`, "canvas.enter");
    await check("open panel: choose a file (foreground)", `await fx.menu("File > Open…"); await sleep(1200); await fx.choosePath(${JSON.stringify(file)})`, "open", (e) => e.ok && e.path.endsWith("pick-me.txt"));
    await check("save panel: name and folder (foreground)", `await fx.menu("File > Save…"); await sleep(1200); await fx.choosePath(${JSON.stringify(path.join(dir, "named.txt"))})`, "save", (e) => e.ok && e.path.endsWith("named.txt"));
    await check("full screen", `await fx.window().fullScreen(true); await sleep(2500)`, "window.fullscreen", (e) => e.on === true);
    const away = await run(`await gb.pressKey("ctrl+Left"); await sleep(1500); let code = "read"; try { await fx.getAXState({emit: false}); } catch (e) { code = e.code; } code`);
    step("a full-screen window on another Space says so (other_space)", /other_space/.test(away.text), away.text);
    await check("activate switches to its Space; restore leaves full screen", `await fx.activate(); await sleep(1500); await fx.window().restore(); await sleep(2500)`, "window.fullscreen", (e) => e.on === false);
    const mods = execFileSync("osascript", ["-l", "JavaScript", "-e", 'ObjC.import("AppKit"); $.NSEvent.modifierFlags']).toString().trim();
    step("no modifier key left held down", mods === "0", `modifier flags ${mods}`);
    const shot = await run(`const s = await gb.screenshot({emit: false}); s.width + "x" + s.height`);
    step("whole-screen screenshot", !shot.isError && /\d+x\d+/.test(shot.text), shot.text);
    const wins = await run(`(await gb.windows({emit: false})).some((w) => w.bundleId === "${fixture.FIXTURE_BUNDLE_ID}")`);
    step("every window on screen, with owners", !wins.isError && /true/.test(wins.text), wins.text);
    const extras = await run(`(await gb.menuExtras({emit: false})).length`);
    step("menu bar extras listed", !extras.isError && Number(extras.text.trim()) > 0, extras.text);
    if (!keep) await check("quit the app", `await fx.quit()`, "quit");
    fs.rmSync(dir, { recursive: true, force: true });
  } finally {
    mcp.close();
    const finder = await raw.request("resolveApp", { query: "com.apple.finder" }).catch(() => null);
    const ok = await raw.request("pasteStash", { pid: fixturePid, op: "restore" }).then(() => true, () => false);
    if (!ok && finder) await raw.request("pasteStash", { pid: finder.pid, op: "restore" }).catch(() => {});
    if (!keep) await fixture.quitFixture();
    raw.close?.();
  }
  const passed = results.every(Boolean);
  process.stdout.write(passed ? `\nAll ${results.length} macOS checks passed.\n` : `\n${results.filter((r) => !r).length} of ${results.length} macOS checks failed.\n`);
  return passed;
}
