// The three setups under test. Each exposes the same shape to the agent loop:
//   { name, tools, instructions, execute(toolUseBlocks) -> toolResultBlocks, close() }
//
// glovebox and open-computer-use run as stdio MCP servers, exactly as an agent
// would attach them. The screenshot-first setup is Anthropic's computer use
// toolset, executed through a glovebox session so input reliability is the
// same and only the tool shape differs.
import { spawn } from "node:child_process";
import path from "node:path";
import { Session } from "../../src/session.mjs";
import { benchDir, repoDir } from "./env.mjs";

class McpClient {
  constructor(command, args) {
    this.child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = "";
    let buffer = "";
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        const waiter = this.pending.get(message.id);
        if (!waiter) continue;
        this.pending.delete(message.id);
        if (message.error) waiter.reject(new Error(`${message.error.code}: ${message.error.message}`));
        else waiter.resolve(message.result);
      }
    });
    this.child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-4000);
    });
    this.child.on("exit", (code) => {
      for (const waiter of this.pending.values()) waiter.reject(new Error(`MCP server exited (${code}): ${this.stderr.trim().slice(-500)}`));
      this.pending.clear();
    });
  }

  request(method, params = {}, timeoutMs = 180_000) {
    const id = this.nextId++;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async start() {
    const init = await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "glovebox-bench", version: "1" },
    });
    this.notify("notifications/initialized");
    const { tools } = await this.request("tools/list");
    return { instructions: init.instructions ?? "", tools };
  }

  close() {
    this.child.stdin.end();
    this.child.kill("SIGTERM");
  }
}

function mcpContentToApi(content = []) {
  const blocks = [];
  for (const c of content) {
    if (c.type === "text" && c.text) blocks.push({ type: "text", text: c.text });
    else if (c.type === "image") blocks.push({ type: "image", source: { type: "base64", media_type: c.mimeType, data: c.data } });
  }
  return blocks.length ? blocks : [{ type: "text", text: "(no output)" }];
}

async function mcpSetup(name, command, args) {
  const client = new McpClient(command, args);
  const { instructions, tools } = await client.start();
  return {
    name,
    instructions,
    tools: tools.map((t) => ({ name: t.name, description: t.description ?? "", input_schema: t.inputSchema })),
    async execute(blocks) {
      const results = [];
      for (const block of blocks) {
        try {
          const result = await client.request("tools/call", { name: block.name, arguments: block.input ?? {} });
          results.push({ type: "tool_result", tool_use_id: block.id, content: mcpContentToApi(result.content), is_error: result.isError === true });
        } catch (error) {
          results.push({ type: "tool_result", tool_use_id: block.id, content: [{ type: "text", text: String(error.message) }], is_error: true });
        }
      }
      return results;
    },
    close: () => client.close(),
  };
}

// Members the glovebox executor can't express are withheld rather than left
// to fail. zoom is withheld because glovebox captures at the same capped size
// its own agent sees (1568 px long side), so a zoom would add no detail.
const WITHHELD = ["zoom", "left_mouse_down", "left_mouse_up", "hold_key", "middle_click"];
const HALT = "Not executed: an earlier computer action in this turn failed.";

async function computerUseSetup(task) {
  const session = new Session({ client: "glovebox bench (screenshot-first)" });
  let cursor = [0, 0];

  async function js(code) {
    const result = await session.run(code, { timeoutMs: 60_000 });
    if (!result.ok) throw new Error(result.content.map((c) => c.text ?? "").join("\n") || "action failed");
    return result.content;
  }
  // Foreground input, like Anthropic's reference environment, which drives a
  // real display. glovebox's background pixel clicks don't reach an open
  // pop-up menu, and that limit belongs to glovebox, not to this baseline.
  await js(`const __cu = await gb.getApp(${JSON.stringify(task.app)}, { foreground: true });`);

  // The screenshot follows the app's focused window, so settings windows and
  // dialogs are visible, and clicks land in that same window. On macOS 27 a
  // window capture includes the app's open menus.
  async function screenshot() {
    const content = await js(`const __ws = await __cu.windows();
const __w = __ws.find((w) => w.focused) ?? __ws.find((w) => w.main) ?? __ws[0];
await __cu.getScreenshot({ window: __w.index, format: "jpeg", quality: 80 }); undefined;`);
    const image = content.find((c) => c.type === "image");
    if (!image) throw new Error("no screenshot returned");
    return image.data;
  }

  const point = (p) => `[${Math.round(p[0])}, ${Math.round(p[1])}]`;
  const modifiers = (text) => (text ? JSON.stringify(String(text).split("+")) : "[]");

  async function run(name, input) {
    switch (name) {
      case "screenshot":
        return [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: await screenshot() } }];
      case "left_click":
      case "right_click":
      case "double_click":
      case "triple_click": {
        if (input.coordinate) cursor = input.coordinate;
        const button = name === "right_click" ? "right" : "left";
        const count = name === "double_click" ? 2 : name === "triple_click" ? 3 : 1;
        await js(`await __cu.click(${point(cursor)}, { raw: true, button: "${button}", count: ${count}, modifiers: ${modifiers(input.text)} }); undefined;`);
        return "OK";
      }
      case "left_click_drag":
        await js(`await __cu.drag(${point(input.start_coordinate)}, ${point(input.coordinate)}); undefined;`);
        cursor = input.coordinate;
        return "OK";
      case "mouse_move":
        cursor = input.coordinate;
        return "OK";
      case "cursor_position":
        return `X=${Math.round(cursor[0])}, Y=${Math.round(cursor[1])}`;
      case "scroll": {
        if (input.coordinate) cursor = input.coordinate;
        const n = input.scroll_amount ?? 3;
        const delta = { up: { dy: -n }, down: { dy: n }, left: { dx: -n }, right: { dx: n } }[input.scroll_direction] ?? { dy: n };
        await js(`await __cu.scroll(${point(cursor)}, ${JSON.stringify({ dy: 0, dx: 0, ...delta })}); undefined;`);
        return "OK";
      }
      case "type":
        await js(`await __cu.typeText(${JSON.stringify(String(input.text))}); undefined;`);
        return "OK";
      case "key":
        await js(`await __cu.pressKey(${JSON.stringify(String(input.text))}, { repeat: ${Number(input.repeat) || 1} }); undefined;`);
        return "OK";
      case "wait":
        await new Promise((r) => setTimeout(r, Math.min(Number(input.duration) || 1, 30) * 1000));
        return "OK";
      default:
        throw new Error(`${name} is not available in this environment`);
    }
  }

  return {
    name: "computer-use",
    instructions: "",
    tools: [{ type: "computer_toolset_20260801", configs: Object.fromEntries(WITHHELD.map((m) => [m, { enabled: false }])) }],
    async execute(blocks) {
      const results = [];
      let failed = false;
      for (const block of blocks) {
        const base = { type: "tool_result", tool_use_id: block.id, toolset_name: block.toolset_name };
        if (failed) {
          results.push({ ...base, content: [{ type: "text", text: HALT }], is_error: true });
          continue;
        }
        try {
          const out = await run(block.name, block.input ?? {});
          results.push({ ...base, content: typeof out === "string" ? [{ type: "text", text: out }] : out });
        } catch (error) {
          failed = true;
          results.push({ ...base, content: [{ type: "text", text: String(error.message).slice(0, 2000) }], is_error: true });
        }
      }
      return results;
    },
    close: () => session.close(),
  };
}

export const SETUPS = {
  glovebox: () => mcpSetup("glovebox", process.execPath, [path.join(repoDir, "bin", "glovebox.mjs"), "mcp"]),
  ocu: () => mcpSetup("open-computer-use", path.join(benchDir, "node_modules", ".bin", "ocu"), ["mcp"]),
  cu: (task) => computerUseSetup(task),
};
