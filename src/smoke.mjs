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

function client() {
  const child = spawn(process.execPath, [cli, "mcp"], { stdio: ["pipe", "pipe", "inherit"] });
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
