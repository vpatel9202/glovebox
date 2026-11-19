// `nostrings conformance`: checks that a backend speaks the protocol in
// docs/backend-protocol.md well enough for the scripting layer to drive it.
// It runs against any `request(method, params)`: a new backend started as a
// command that reads JSON lines on stdin and answers on stdout (the way to
// test a Windows or Linux port), the macOS helper, or an Android device.
//
// Core checks only read, except `launch`, which starts the target app if it
// is not running. `input: true` adds an Escape key press and a click in the
// middle of the target's first window.
import { spawn } from "node:child_process";
import readline from "node:readline";

const PNG = "iVBORw0KGgo";
const JPEG = "/9j/";

// A backend running as a child process: JSON lines over stdio.
export function commandBackend(command) {
  const child = spawn(command, { shell: true, stdio: ["pipe", "pipe", "inherit"] });
  const pending = new Map();
  let nextId = 1;
  let exited = null;
  child.on("exit", (code) => {
    exited = `exited with code ${code}`;
    for (const { reject } of pending.values()) reject(new Error(`The backend ${exited}`));
    pending.clear();
  });
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return; // not protocol; a backend may log on stdout by mistake
    }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) {
      const error = new Error(message.error.message ?? "error");
      error.code = message.error.code;
      waiter.reject(error);
    } else waiter.resolve(message.result);
  });
  return {
    request(method, params = {}) {
      if (exited) return Promise.reject(new Error(`The backend ${exited}`));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      });
    },
    close() {
      child.stdin.end();
      child.kill();
    },
  };
}

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isFrame = (f) => Array.isArray(f) && f.length === 4 && f.every(isNum);

async function expectError(promise, codes) {
  try {
    await promise;
    return { ok: false, detail: "succeeded; expected an error" };
  } catch (error) {
    if (!error.code) return { ok: false, detail: `error has no code: ${error.message}` };
    return codes.includes(error.code) ? { ok: true } : { ok: false, detail: `code ${error.code}, expected ${codes.join(" or ")}` };
  }
}

// Runs the checks. `app` names the target (a name or id resolveApp accepts).
// Returns [{name, ok, detail}] and calls `report` with each as it finishes.
export async function runConformance(backend, { app, input = false, report = () => {} } = {}) {
  const results = [];
  const state = {};
  const check = async (name, fn) => {
    let result;
    try {
      const out = await fn();
      result = out === true || out === undefined ? { ok: true } : out === false ? { ok: false } : out;
    } catch (error) {
      result = { ok: false, detail: `${error.code ? `${error.code}: ` : ""}${error.message}` };
    }
    const entry = { name, ok: !!result.ok, detail: result.detail };
    results.push(entry);
    report(entry);
    return entry.ok;
  };
  const need = (key) => {
    if (state[key] === undefined) throw new Error(`skipped: needs ${key} from an earlier check`);
    return state[key];
  };

  await check("hello returns {version, platform, pid}", async () => {
    const r = await backend.request("hello", { client: "nostrings conformance" });
    state.platform = r?.platform;
    return typeof r?.version === "string" && typeof r?.platform === "string" ? true : { ok: false, detail: JSON.stringify(r) };
  });
  await check("ping returns {version, platform}", async () => {
    const r = await backend.request("ping");
    return typeof r?.version === "string" && typeof r?.platform === "string";
  });
  await check("permissions reports booleans and prompts for nothing", async () => {
    const r = await backend.request("permissions", {});
    const keys = ["accessibility", "screenRecording"];
    const bad = keys.filter((k) => typeof r?.[k] !== "boolean");
    return bad.length ? { ok: false, detail: `not boolean: ${bad.join(", ")}` } : true;
  });
  await check("listApps returns [{name, running}]", async () => {
    const r = await backend.request("listApps");
    if (!Array.isArray(r) || !r.length) return { ok: false, detail: "empty or not an array" };
    const bad = r.find((a) => typeof a?.name !== "string" || typeof a?.running !== "boolean");
    return bad ? { ok: false, detail: `bad entry ${JSON.stringify(bad)}` } : true;
  });
  await check("resolveApp of an unknown app fails with not_found", () => expectError(backend.request("resolveApp", { query: "no-such-app-nostrings-conformance" }), ["not_found"]));
  await check(`resolveApp finds ${JSON.stringify(app)}`, async () => {
    if (!app) throw new Error("skipped: pass --app with an app to test against");
    state.resolved = await backend.request("resolveApp", { query: app });
    return state.resolved?.name || state.resolved?.bundleId ? true : { ok: false, detail: JSON.stringify(state.resolved) };
  });
  await check("launch returns the running app with a pid", async () => {
    const r = need("resolved");
    // As the scripting layer does: launch only an app that is not running.
    if (r.running && r.pid !== undefined && r.pid !== null) {
      state.pid = r.pid;
      return { ok: true, detail: "already running; launch not called" };
    }
    const running = await backend.request("launch", { bundleId: r.bundleId, path: r.path, name: r.name, pid: r.pid, activate: false });
    state.pid = running?.pid;
    return state.pid !== undefined && state.pid !== null ? true : { ok: false, detail: JSON.stringify(running) };
  });
  await check("windows returns [{index, frame}] with at least one window", async () => {
    let list = [];
    let activated = false;
    for (let i = 0; i < 20 && !list.length; i++) {
      try {
        list = await backend.request("windows", { pid: need("pid") });
      } catch (error) {
        // not_visible is allowed (Android): a script then calls activate.
        if (error.code !== "not_visible" || activated) throw error;
        await backend.request("activate", { pid: need("pid") });
        activated = true;
      }
      if (!list.length) await new Promise((r) => setTimeout(r, 500));
    }
    state.window = list[0];
    const bad = list.find((w) => !isNum(w.index) || !isFrame(w.frame));
    return !list.length ? { ok: false, detail: "no windows" } : bad ? { ok: false, detail: JSON.stringify(bad) } : true;
  });
  await check("axTree returns nodes with unique numeric indices and roles", async () => {
    const r = await backend.request("axTree", { pid: need("pid"), window: need("window").index, maxNodes: 500 });
    const nodes = r?.nodes ?? [];
    if (!nodes.length) return { ok: false, detail: "no nodes" };
    const bad = nodes.find((n) => !isNum(n.i) || !isNum(n.d) || typeof n.role !== "string");
    if (bad) return { ok: false, detail: `bad node (needs numeric i and d, string role) ${JSON.stringify(bad).slice(0, 200)}` };
    if (new Set(nodes.map((n) => n.i)).size !== nodes.length) return { ok: false, detail: "duplicate indices" };
    state.node = nodes.find((n) => isFrame(n.frame)) ?? nodes[0];
    return { ok: true, detail: `${nodes.length} nodes` };
  });
  await check("elementFrame gives [x, y, w, h] for an element", async () => {
    const r = await backend.request("elementFrame", { pid: need("pid"), index: need("node").i });
    return isFrame(r?.frame) ? true : { ok: false, detail: JSON.stringify(r) };
  });
  await check("an index that was never read fails with stale_index", () => expectError(backend.request("elementFrame", { pid: need("pid"), index: 987654 }), ["stale_index", "no_frame"]));
  await check("screenshot is exactly the size asked for", async () => {
    const w = need("window");
    const width = 320;
    const height = Math.max(1, Math.round((320 * w.frame[3]) / Math.max(1, w.frame[2])));
    const r = await backend.request("screenshot", { pid: need("pid"), windowId: w.windowId, width, height, format: "png" });
    if (r?.width !== width || r?.height !== height) return { ok: false, detail: `asked ${width}x${height}, got ${r?.width}x${r?.height}` };
    if (typeof r.data !== "string" || !(r.data.startsWith(PNG) || r.data.startsWith(JPEG))) return { ok: false, detail: "data is not base64 PNG or JPEG" };
    return true;
  });
  if (input) {
    await check("keys presses Escape", () => backend.request("keys", { pid: need("pid"), chords: [{ key: "Escape", mods: [] }] }).then(() => true));
    await check("click lands in the middle of the window", async () => {
      const [x, y, w, h] = need("window").frame;
      await backend.request("click", { pid: need("pid"), x: x + w / 2, y: y + h / 2, button: "left", count: 1, mods: [] });
      return true;
    });
  }
  return results;
}
