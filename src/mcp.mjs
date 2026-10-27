// stdio MCP server exposing one persistent session as `js` and `js_reset`.
import { VERSION } from "./config.mjs";
import { loadConfig } from "./config.mjs";
import { Session } from "./session.mjs";

const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

export const JS_DESCRIPTION = `Run JavaScript in a persistent computer-use session. Put a whole step in one call: several actions, then one read. Top-level const/let/function/await persist across calls until js_reset (redeclaring is fine).

const calc = await gb.getApp("Calculator");   // name, bundle id, or "pid:123"; launches if needed, does not steal focus
await calc.pressKey("Escape");                 // xdotool syntax: Return, Tab, ctrl+a, super+c (super = Cmd)
await calc.typeText("12*3=");                  // "\\n" presses Return
await calc.getAXState();                       // text accessibility tree; later reads return only changes

Reads: getAXState({disableDiffing, frames, menus, window}) returns "<index> <role> \\"label\\" value=..." lines. frames:true adds @x,y wxh in image pixels. getScreenshot() and getAXStateAndScreenshot() are the only calls that return an image. Every read emits its output; pass {emit:false} to just get the value.
Actions: click(target, {button, count, modifiers}), doubleClick, rightClick, scroll(target, dy), drag(from, to), setValue(index, v), focus(index), selectText(index, {start, length}), performSecondaryAction(index, "Show Menu"), listActions(index), activate(), windows(), frame(index), center(index).
A target is an element index from the tree, or [x, y] pixels in the window image (same space as the screenshot and frames). Prefer indices; use pixels when the tree has nothing useful (remote desktops, canvases). Input stays in the background (focus and the user's cursor don't move); pass {foreground: true} to an action if an app ignores it.
gb.listApps() lists running apps. console.log adds text to the result. help() or help("click") prints the full API. If a result says "Stopped:" the user took over (switched apps or pressed Escape): stop and ask before continuing.`;

const TOOLS = [
  {
    name: "js",
    description: JS_DESCRIPTION,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        code: { type: "string", description: "JavaScript to run. Top-level await is supported." },
        title: { type: "string", description: "A few words naming this step, for the action log." },
        timeout_ms: { type: "integer", description: "Time limit in milliseconds (default 120000)." },
      },
      required: ["code"],
    },
  },
  {
    name: "js_reset",
    description: "Restart the session and drop every binding. Use when a script is stuck or you want a clean slate.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
];

export function serveMcp({ input = process.stdin, output = process.stdout } = {}) {
  let session = null;
  let clientName = "An agent";

  const write = (message) => output.write(`${JSON.stringify(message)}\n`);
  const reply = (id, result) => write({ jsonrpc: "2.0", id, result });
  const fail = (id, code, message) => write({ jsonrpc: "2.0", id, error: { code, message } });

  async function call(name, args) {
    if (name === "js_reset") {
      session?.reset();
      return { content: [{ type: "text", text: "Session reset. All bindings are gone." }], isError: false };
    }
    if (name !== "js") throw Object.assign(new Error(`Unknown tool ${name}`), { rpc: -32602 });
    if (typeof args?.code !== "string" || !args.code.trim()) {
      return { content: [{ type: "text", text: "js needs non-empty code" }], isError: true };
    }
    session ??= new Session({ client: clientName, imageMode: "inline" });
    const timeoutMs = Number.isInteger(args.timeout_ms) && args.timeout_ms > 0 ? args.timeout_ms : loadConfig().timeoutMs;
    const result = await session.run(args.code, { title: args.title, timeoutMs });
    const content = result.content?.length ? result.content : [{ type: "text", text: result.ok ? "(no output)" : "Script failed" }];
    return { content, isError: !result.ok };
  }

  async function handle(message) {
    const { id, method, params } = message;
    const isRequest = Object.hasOwn(message, "id") && method;
    try {
      switch (method) {
        case "initialize": {
          clientName = params?.clientInfo?.name || clientName;
          const requested = params?.protocolVersion;
          reply(id, {
            protocolVersion: PROTOCOLS.includes(requested) ? requested : PROTOCOLS[0],
            capabilities: { tools: {} },
            serverInfo: { name: "glovebox", version: VERSION },
            instructions:
              "glovebox drives desktop apps through one persistent JavaScript session. Use the js tool for every GUI step and batch several actions per call.",
          });
          return;
        }
        case "ping":
          if (isRequest) reply(id, {});
          return;
        case "tools/list":
          reply(id, { tools: TOOLS });
          return;
        case "tools/call":
          reply(id, await call(params?.name, params?.arguments ?? {}));
          return;
        default:
          if (isRequest) fail(id, -32601, `Method not found: ${method}`);
      }
    } catch (error) {
      if (isRequest) fail(id, error.rpc ?? -32603, error.message);
    }
  }

  let buffer = "";
  input.setEncoding("utf8");
  input.on("data", (chunk) => {
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
        fail(null, -32700, "Parse error");
        continue;
      }
      void handle(message);
    }
  });
  const shutdown = () => {
    session?.close();
    process.exit(0);
  };
  input.on("end", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
