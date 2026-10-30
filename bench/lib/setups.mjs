// The setups under test. Each exposes the same shape to the agent loop:
//   { name, tools, instructions, execute(toolUseBlocks) -> toolResultBlocks, close() }
//
// glovebox and open-computer-use run as stdio MCP servers, exactly as an agent
// would attach them. The screenshot-first setup is Anthropic's computer use
// toolset, executed through a glovebox session so input reliability is the
// same and only the tool shape differs.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Session } from "../../src/session.mjs";
import { imageSize } from "./agent.mjs";
import { benchDir, repoDir } from "./env.mjs";

// The same limits for every setup's tool results, so no tool can send the
// model something another tool could not. Listed in bench/README.md.
export const LIMITS = { textChars: 100_000, imageLongSide: 1568 };

class McpClient {
  // `onRequest(method, params)` answers requests the server sends the client
  // (elicitation); without it they get an error.
  constructor(command, args, { onRequest, env } = {}) {
    // Its own process group, so close() also ends the server's children.
    this.child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], detached: true, env: env ? { ...process.env, ...env } : process.env });
    this.onRequest = onRequest;
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
        if (message.method && message.id != null) {
          this.#answer(message);
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

  async #answer({ id, method, params }) {
    let reply;
    try {
      if (!this.onRequest) throw new Error(`${method} is not supported`);
      reply = { result: await this.onRequest(method, params ?? {}) };
    } catch (error) {
      reply = { error: { code: -32601, message: String(error.message) } };
    }
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...reply })}\n`);
  }

  notify(method, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async start(capabilities = {}) {
    const init = await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities,
      clientInfo: { name: "glovebox-bench", version: "1" },
    });
    this.notify("notifications/initialized");
    const { tools } = await this.request("tools/list");
    return { instructions: init.instructions ?? "", tools };
  }

  close() {
    this.child.stdin.end();
    try {
      process.kill(-this.child.pid, "SIGTERM");
    } catch {
      this.child.kill("SIGTERM");
    }
  }
}

function sniffImageType(base64) {
  const head = Buffer.from(base64.slice(0, 16), "base64");
  if (head[0] === 0x89 && head[1] === 0x50) return "image/png";
  if (head[0] === 0xff && head[1] === 0xd8) return "image/jpeg";
  if (head.subarray(0, 4).toString() === "RIFF") return "image/webp";
  if (head.subarray(0, 3).toString() === "GIF") return "image/gif";
  return null;
}

// Scales an image down to the shared long-side limit with sips.
function fitImage(data, mimeType) {
  const size = imageSize(data);
  if (!size || Math.max(size.width, size.height) <= LIMITS.imageLongSide) return { data, mimeType };
  const file = path.join(os.tmpdir(), `glovebox-bench-${process.pid}-${Date.now()}.${mimeType === "image/jpeg" ? "jpg" : "png"}`);
  fs.writeFileSync(file, Buffer.from(data, "base64"));
  try {
    execFileSync("sips", ["-Z", String(LIMITS.imageLongSide), file], { stdio: "ignore" });
    return { data: fs.readFileSync(file).toString("base64"), mimeType };
  } finally {
    fs.rmSync(file, { force: true });
  }
}

export function mcpContentToApi(content = []) {
  const blocks = [];
  let chars = 0;
  for (const c of content) {
    if (c.type === "text" && c.text) {
      const room = LIMITS.textChars - chars;
      if (room <= 0) continue;
      const text = c.text.length > room ? `${c.text.slice(0, room)}\n(truncated by the benchmark at ${LIMITS.textChars} characters)` : c.text;
      chars += text.length;
      blocks.push({ type: "text", text });
    } else if (c.type === "image") {
      // Labels can be wrong (Codex's cua_repl marks JPEG screenshots as PNG),
      // and the API rejects a mismatch, so trust the bytes.
      const image = fitImage(c.data, sniffImageType(c.data) ?? c.mimeType);
      blocks.push({ type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } });
    }
  }
  return blocks.length ? blocks : [{ type: "text", text: "(no output)" }];
}

// `withhold` drops tools the comparison excludes, such as tools that call
// their own AI model.
async function mcpSetup(name, command, args, { env, onRequest, capabilities, onTurnEnd, withhold = [] } = {}) {
  const client = new McpClient(command, args, { onRequest, env });
  const { instructions, tools } = await client.start(capabilities);
  return {
    name,
    instructions,
    tools: tools.filter((t) => !withhold.includes(t.name)).map((t) => ({ name: t.name, description: t.description ?? "", input_schema: t.inputSchema })),
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
    onTurnEnd: onTurnEnd && (() => onTurnEnd(client)),
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

  // The screenshot uses glovebox's default window (the focused one, unless it
  // is a tooltip or field editor), so settings windows and dialogs are
  // visible, and clicks land in that same window. On macOS 27 a window capture
  // includes the app's open menus.
  async function screenshot() {
    const content = await js(`await __cu.getScreenshot({ format: "jpeg", quality: 80 }); undefined;`);
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

// Codex computer use, run directly from the ChatGPT app's bundled plugin with
// the command and environment Codex itself uses. App approvals arrive as MCP
// elicitations; only the bench apps are approved, for this session only.
const BENCH_BUNDLES = ["com.apple.calculator", "com.apple.textedit", "com.apple.finder", "dev.glovebox.bench-fixture"];

function codexPluginConfig() {
  const root = path.join(os.homedir(), ".codex", "plugins", "cache", "openai-bundled", "unified-computer-use");
  const versions = fs.existsSync(root) ? fs.readdirSync(root).sort() : [];
  const file = versions.length && path.join(root, versions.at(-1), ".mcp.json");
  if (!file || !fs.existsSync(file)) throw new Error(`Codex computer use is not installed (no ${root}/<version>/.mcp.json)`);
  return JSON.parse(fs.readFileSync(file, "utf8")).mcpServers.cua_repl;
}

async function codexSetup() {
  const config = codexPluginConfig();
  const session = `bench-${process.pid}-${Date.now()}`;
  let turn = 0;
  return mcpSetup("codex-cu", config.command, config.args, {
    env: config.env,
    capabilities: { elicitation: { form: {} } },
    async onRequest(method, params) {
      if (method !== "elicitation/create") throw new Error(`${method} is not supported`);
      const app = String(params._meta?.tool_params?.app ?? "").toLowerCase();
      return BENCH_BUNDLES.includes(app) ? { action: "accept", content: {}, _meta: { persist: "session" } } : { action: "decline" };
    },
    onTurnEnd: (client) => client.request("tools/call", { name: "turn_ended", arguments: { hook_event_name: "Stop", session_id: session, turn_id: String(++turn) } }).catch(() => {}),
    // Codex enables js and js_reset for the model; turn_ended is its hook.
    withhold: ["turn_ended", "js_add_node_module_dir"],
  });
}

// agent-desktop is a CLI that agents run from a shell after loading its
// bundled skill guides. The setup is that, minus the shell: one tool that runs
// only the agent-desktop binary, described by the core and macOS guides.
const AGENT_DESKTOP = path.join(benchDir, "node_modules", "agent-desktop", "bin", "agent-desktop");

function agentDesktopSetup() {
  const guide = (name) => execFileSync(AGENT_DESKTOP, ["skills", "get", name], { encoding: "utf8" });
  const description = `Runs the agent-desktop CLI with the given arguments and returns its JSON output. Screenshots come back as images.\n\n${guide("desktop")}\n\n${guide("platform")}`;
  return {
    name: "agent-desktop",
    instructions: "",
    tools: [
      {
        name: "agent_desktop",
        description,
        input_schema: {
          type: "object",
          properties: { args: { type: "array", items: { type: "string" }, description: 'Arguments after the binary name, e.g. ["snapshot", "--app", "Calculator"]' } },
          required: ["args"],
        },
      },
    ],
    async execute(blocks) {
      return blocks.map((block) => {
        const base = { type: "tool_result", tool_use_id: block.id };
        const args = (block.input?.args ?? []).map(String);
        let out;
        let failed = false;
        try {
          out = execFileSync(AGENT_DESKTOP, args, { encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
        } catch (error) {
          failed = true;
          out = `${error.stdout ?? ""}${error.stderr ?? ""}` || String(error.message);
        }
        // A shell agent would view the PNG; hand it over as an image.
        let parsed = null;
        try {
          parsed = JSON.parse(out);
        } catch {
          // Plain text output.
        }
        if (parsed?.command === "screenshot" && typeof parsed.data?.data === "string") {
          const image = parsed.data.data;
          parsed.data.data = "(image attached)";
          return { ...base, content: mcpContentToApi([{ type: "text", text: JSON.stringify(parsed) }, { type: "image", mimeType: "image/png", data: image }]), is_error: failed };
        }
        return { ...base, content: mcpContentToApi([{ type: "text", text: out }]), is_error: failed };
      });
    },
    close() {},
  };
}

export const SETUPS = {
  glovebox: () => mcpSetup("glovebox", process.execPath, [path.join(repoDir, "bin", "glovebox.mjs"), "mcp"]),
  ocu: () => mcpSetup("open-computer-use", path.join(benchDir, "node_modules", ".bin", "ocu"), ["mcp"]),
  cu: (task) => computerUseSetup(task),
  "codex-cu": () => codexSetup(),
  "agent-desktop": () => agentDesktopSetup(),
  // Peekaboo's agent and analyze tools call their own configured AI model.
  peekaboo: () => mcpSetup("peekaboo", process.execPath, [path.join(benchDir, "node_modules", "@steipete", "peekaboo", "peekaboo-mcp.js")], { withhold: ["agent", "analyze"] }),
};
