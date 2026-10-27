// The persistent session. Runs as its own process so the host (MCP server or
// CLI daemon) can stop a runaway script without going down with it.
//
// stdin:  {"id": n, "op": "eval", "code": "...", "title": "..."} | {"op": "abort"}
// stdout: {"id": n, "ok": bool, "content": [{type: "text"|"image", ...}]}
import fs from "node:fs";
import path from "node:path";
import util from "node:util";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { createApi } from "./api.mjs";
import { createBackend } from "./backends/index.mjs";
import { loadConfig, paths } from "./config.mjs";
import { transformCell } from "./transform.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const client = process.env.GLOVEBOX_CLIENT || "An agent";
const imageMode = process.env.GLOVEBOX_IMAGE_MODE === "file" ? "file" : "inline";

// Anything a dependency prints must not corrupt the protocol on stdout.
const protocolOut = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => process.stderr.write(chunk, ...rest);

function send(message) {
  protocolOut(`${JSON.stringify(message)}\n`);
}

class StoppedError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "Stopped";
  }
}

let config = loadConfig();
let content = [];
let running = false;
let abortReason = null;
let cellTitle = null;
let cellNumber = 0;

function pushText(text) {
  if (!running || text === "") return;
  const last = content.at(-1);
  if (last?.type === "text") last.text += `\n${text}`;
  else content.push({ type: "text", text });
}

function show(value) {
  return typeof value === "string" ? value : util.inspect(value, { depth: 4, maxArrayLength: 50, maxStringLength: 4000, breakLength: 120 });
}

const out = {
  text: (value) => pushText(show(value)),
  async image(data, mimeType, label) {
    if (!running) return;
    if (imageMode === "file") {
      fs.mkdirSync(paths.shots, { recursive: true, mode: 0o700 });
      const ext = mimeType === "image/jpeg" ? "jpg" : "png";
      const safe = label.replace(/[^A-Za-z0-9._-]+/g, "_");
      const file = path.join(paths.shots, `${new Date().toISOString().replace(/[:.]/g, "-")}-${safe}.${ext}`);
      fs.writeFileSync(file, Buffer.from(data, "base64"));
      pushText(`Image saved: ${file}`);
    } else {
      content.push({ type: "image", mimeType, data });
    }
  },
};

function log(entry) {
  if (!config.log.enabled) return;
  try {
    fs.mkdirSync(paths.home, { recursive: true, mode: 0o700 });
    fs.appendFileSync(paths.log, `${JSON.stringify({ ts: new Date().toISOString(), client, step: cellTitle ?? undefined, ...entry })}\n`, { mode: 0o600 });
  } catch {
    // Logging must never break an action.
  }
}

function help(topic) {
  const doc = fs.readFileSync(path.join(here, "..", "docs", "api.md"), "utf8");
  if (!topic) return doc;
  const sections = doc.split(/^(?=## )/m);
  const hit = sections.filter((s) => s.toLowerCase().includes(String(topic).toLowerCase()));
  return hit.length ? hit.join("\n") : `No help for "${topic}". Call help() for everything.`;
}

const backend = createBackend({ client });
backend.on("escape", () => {
  if (running) abortReason = "Stopped: the user pressed Escape. Do not continue GUI actions until the user asks.";
});

const ctx = {
  backend,
  get config() {
    return config;
  },
  out,
  log,
  help,
  get cell() {
    return cellNumber;
  },
  checkAbort() {
    if (abortReason) throw new StoppedError(abortReason);
  },
  stop(reason) {
    abortReason = reason;
    throw new StoppedError(reason);
  },
  settle() {
    return new Promise((resolve) => setTimeout(resolve, config.settleMs ?? 80));
  },
};

function makeContext() {
  const gb = createApi(ctx);
  const consoleProxy = Object.fromEntries(
    ["log", "info", "warn", "error", "debug"].map((name) => [name, (...args) => pushText(args.map(show).join(" "))]),
  );
  const sandbox = {
    gb,
    cua: gb,
    help: gb.help,
    sleep: gb.sleep,
    console: consoleProxy,
    nodeRepl: { write: (value) => out.text(value) },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    structuredClone,
    URL,
    TextEncoder,
    TextDecoder,
    Buffer,
    fetch,
    process: { platform: process.platform, env: {} },
  };
  return vm.createContext(sandbox, { name: "glovebox" });
}

let context = makeContext();

async function runCell(message) {
  content = [];
  cellNumber += 1;
  running = true;
  abortReason = null;
  cellTitle = message.title || null;
  config = loadConfig();
  try {
    const code = transformCell(String(message.code ?? ""));
    const result = await vm.runInContext(code, context, { filename: "cell.js", timeout: 30_000 });
    if (result !== undefined && typeof result !== "function") {
      const text = show(result);
      // Reads already emitted their text; don't print it twice.
      const already = content.some((c) => c.type === "text" && c.text.endsWith(text));
      if (!already) pushText(text);
    }
    send({ id: message.id, ok: true, content });
  } catch (error) {
    const text =
      error instanceof Error
        ? error.name === "Stopped" || error.name === "SyntaxError"
          ? error.message
          : `${error.name}: ${error.message}`
        : `Thrown: ${show(error)}`;
    pushText(text);
    send({ id: message.id, ok: false, content });
  } finally {
    running = false;
    cellTitle = null;
  }
}

let chain = Promise.resolve();
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.op === "abort") {
      if (running) abortReason = message.reason || "Stopped: the script timed out.";
    } else if (message.op === "eval") {
      chain = chain.then(() => runCell(message));
    }
  }
});
process.stdin.on("end", () => process.exit(0));
process.on("unhandledRejection", (error) => {
  process.stderr.write(`glovebox kernel: unhandled rejection: ${error?.stack ?? error}\n`);
});
