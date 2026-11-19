#!/usr/bin/env node
// The smallest backend that passes `nostrings conformance`: one fake app with
// one window and a three-element tree, over JSON lines on stdin/stdout. The
// unit tests run it; a new port (Windows, Linux) can start from its shape:
//
//   nostrings conformance --command "node test/fake-backend.mjs" --app Fake
//
// See docs/backend-protocol.md for every method and error code.
import readline from "node:readline";

// A 1x1 PNG is not what a real backend returns (it must match the size asked
// for), so this builds a blank PNG header with the requested dimensions; the
// conformance check reads only the size and the PNG signature.
function fakePng(width, height) {
  const header = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header.toString("base64");
}

const APP = { name: "Fake", bundleId: "dev.nostrings.fake", running: true, pid: 4242 };
const WINDOW = { index: 0, title: "Fake window", frame: [100, 100, 400, 300], scale: 2, focused: true, main: true, minimized: false, windowId: 1 };
const NODES = [
  { i: 0, d: 0, role: "AXWindow", title: "Fake window", frame: [100, 100, 400, 300] },
  { i: 1, d: 1, role: "AXButton", title: "OK", frame: [120, 350, 80, 30], actions: ["AXPress"] },
  { i: 2, d: 1, role: "AXTextField", desc: "Name", value: "", settable: true, frame: [120, 140, 200, 24] },
];

class Coded extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

function app(pid) {
  if (pid !== APP.pid) throw new Coded(`No running app has pid ${pid}`, "not_running");
  return APP;
}

const methods = {
  hello: () => ({ version: "0.0.0-fake", platform: "fake", pid: process.pid }),
  ping: () => ({ version: "0.0.0-fake", platform: "fake", pid: process.pid, background: {} }),
  permissions: () => ({ accessibility: true, screenRecording: true, escapeWatcher: false, inputMonitoring: false }),
  listApps: () => [APP],
  resolveApp: ({ query }) => {
    if ([APP.name, APP.bundleId, `pid:${APP.pid}`].includes(query)) return APP;
    throw new Coded(`No app matches ${query}`, "not_found");
  },
  launch: () => APP,
  windows: ({ pid }) => (app(pid), [WINDOW]),
  axTree: ({ pid }) => (app(pid), { window: WINDOW, nodes: NODES, truncated: false }),
  elementFrame: ({ pid, index }) => {
    app(pid);
    const node = NODES.find((n) => n.i === index);
    if (!node) throw new Coded(`No element ${index}; read the tree again`, "stale_index");
    return { frame: node.frame };
  },
  screenshot: ({ pid, width, height }) => (app(pid), { data: fakePng(width, height), width, height, mimeType: "image/png" }),
  keys: ({ pid }) => (app(pid), { route: "fake" }),
  click: ({ pid }) => (app(pid), { route: "fake" }),
};

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params = {} } = JSON.parse(line);
  try {
    const handler = methods[method];
    if (!handler) throw new Coded(`Unknown method ${method}`, "bad_request");
    process.stdout.write(`${JSON.stringify({ id, result: handler(params) })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ id, error: { message: error.message, code: error.code ?? "failed" } })}\n`);
  }
});
