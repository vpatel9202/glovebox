// Background process that keeps CLI sessions alive between `glovebox run` calls,
// so shell-only agents get the same persistent bindings as MCP clients.
// One JSON request per connection, one JSON reply.
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, paths } from "./config.mjs";
import { Session } from "./session.mjs";

export function runDaemon() {
  const sessions = new Map();
  const config = loadConfig();
  let lastActivity = Date.now();

  const sessionFor = (name, client) => {
    let session = sessions.get(name);
    if (!session) {
      session = new Session({ client: client || `glovebox CLI (${name})`, imageMode: "file" });
      sessions.set(name, session);
    }
    return session;
  };

  async function handle(request) {
    lastActivity = Date.now();
    const name = request.session || "default";
    switch (request.op) {
      case "run":
        return sessionFor(name, request.client).run(request.code, {
          title: request.title,
          timeoutMs: request.timeoutMs || config.timeoutMs,
        });
      case "reset":
        sessions.get(name)?.reset();
        sessions.delete(name);
        return { ok: true, content: [{ type: "text", text: `Session "${name}" reset.` }] };
      case "list":
        return { ok: true, content: [{ type: "text", text: [...sessions.keys()].join("\n") || "(no sessions)" }] };
      case "stop":
        setTimeout(shutdown, 50);
        return { ok: true, content: [{ type: "text", text: "Daemon stopped." }] };
      default:
        return { ok: false, content: [{ type: "text", text: `Unknown op ${request.op}` }] };
    }
  }

  if (process.platform !== "win32") {
    fs.mkdirSync(paths.home, { recursive: true, mode: 0o700 });
    try {
      fs.unlinkSync(paths.socket);
    } catch {}
  }
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", async (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      let reply;
      try {
        reply = await handle(JSON.parse(buffer.slice(0, newline)));
      } catch (error) {
        reply = { ok: false, content: [{ type: "text", text: error.message }] };
      }
      socket.end(`${JSON.stringify(reply)}\n`);
    });
    socket.on("error", () => {});
  });
  server.listen(paths.socket, () => {
    if (process.platform !== "win32") fs.chmodSync(paths.socket, 0o600);
  });

  function shutdown() {
    for (const session of sessions.values()) session.close();
    server.close();
    process.exit(0);
  }
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  const idleMs = (config.daemon.idleMinutes ?? 60) * 60_000;
  if (idleMs > 0) {
    setInterval(() => {
      if (Date.now() - lastActivity > idleMs) shutdown();
    }, 30_000).unref();
  }
}

function send(request) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(paths.socket);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => (buffer += chunk));
    socket.on("end", () => {
      try {
        resolve(JSON.parse(buffer));
      } catch {
        reject(new Error("Bad reply from glovebox daemon"));
      }
    });
    socket.on("error", reject);
  });
}

// Sends a request, starting the daemon first if nothing is listening.
export async function daemonRequest(request, { autostart = true } = {}) {
  try {
    return await send(request);
  } catch (error) {
    if (!autostart || !["ENOENT", "ECONNREFUSED"].includes(error.code)) throw error;
  }
  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "glovebox.mjs");
  const child = spawn(process.execPath, [cli, "daemon"], { detached: true, stdio: "ignore", env: process.env });
  child.unref();
  for (let attempt = 0; attempt < 50; attempt++) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      return await send(request);
    } catch {}
  }
  throw new Error(`glovebox daemon did not start (socket ${paths.socket})`);
}
