// One glovebox server per phone, shared by every glovebox session on this
// computer. A phone allows a single shell accessibility connection, so the
// first session to use a phone starts this broker (a detached process); it
// owns the adb shell that runs the server and relays JSON lines between the
// server and each session over a Unix socket that only this user can open.
// Each connection is a session: its requests are tagged with a session key,
// so the server keeps that session's element indices and hidden screens
// apart, and when the connection closes the server closes its hidden
// screens. The broker exits a few seconds after the last session leaves,
// and the server with it.
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { paths } from "../config.mjs";

const IDLE_EXIT_MS = 10_000;

export function brokerSocket(hardwareSerial) {
  return path.join(paths.home, `android-${String(hardwareSerial).replace(/[^A-Za-z0-9._-]/g, "_")}.sock`);
}

// Resolves true if a broker answers on `socket`.
export function brokerAlive(socket) {
  return new Promise((resolve) => {
    const probe = net.connect(socket);
    probe.on("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.on("error", () => resolve(false));
  });
}

async function listen(socket) {
  fs.mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  const server = net.createServer();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(socket, resolve);
      });
      fs.chmodSync(socket, 0o600);
      return server;
    } catch (error) {
      if (error.code !== "EADDRINUSE") throw error;
      if (await brokerAlive(socket)) return null; // another broker has this phone
      fs.rmSync(socket, { force: true }); // left by a broker that died
    }
  }
  return null;
}

export async function runBroker({ transport, hardware, adb, adbBin, dex, remoteDex, serverClass }) {
  const socket = brokerSocket(hardware);
  const listener = await listen(socket);
  if (!listener) process.exit(0);
  const log = (message) => process.stderr.write(`${new Date().toISOString()} ${hardware}: ${message}\n`);
  // Sessions can connect while the server is still being pushed; hold them.
  const early = [];
  const hold = (conn) => early.push(conn);
  listener.on("connection", hold);

  await adb(["-s", transport, "push", dex, remoteDex]);
  // Only one shell automation connection can exist; a server left by a
  // broker that died would hold it and make this one fail without a word.
  await adb(["-s", transport, "shell", "pkill", "-f", serverClass]).catch(() => {});
  const child = spawn(adbBin, ["-s", transport, "shell", `CLASSPATH=${remoteDex} app_process / ${serverClass}`], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.on("error", () => {});
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-4000);
  });

  const clients = new Set();
  const pending = new Map(); // server id -> { client, id }
  let nextId = 1;
  let nextSession = 1;
  let idleTimer = null;

  const toServer = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const shutdown = (code = 0) => {
    for (const c of clients) c.socket.destroy();
    listener.close();
    fs.rmSync(socket, { force: true });
    child.stdin.end();
    setTimeout(() => {
      child.kill();
      process.exit(code);
    }, 500).unref();
  };
  const idle = () => {
    clearTimeout(idleTimer);
    if (clients.size === 0) idleTimer = setTimeout(() => shutdown(0), IDLE_EXIT_MS);
  };

  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith("{")) continue; // anything but protocol is noise
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.event) {
        for (const c of clients) c.socket.write(`${line}\n`);
        continue;
      }
      const route = pending.get(message.id);
      if (!route) continue;
      pending.delete(message.id);
      if (!route.client.socket.destroyed) route.client.socket.write(`${JSON.stringify({ ...message, id: route.id })}\n`);
    }
  });
  child.on("exit", (code, signal) => {
    const reason = stderr.trim().split("\n").filter(Boolean).at(-1) ?? `exit ${code ?? signal}`;
    log(`server stopped: ${reason}`);
    for (const c of clients) c.socket.end(`${JSON.stringify({ event: "exit", reason })}\n`);
    shutdown(1);
  });

  const accept = (conn) => {
    const client = { socket: conn, session: `s${nextSession++}` };
    clients.add(client);
    idle();
    let input = "";
    conn.setEncoding("utf8");
    conn.on("data", (chunk) => {
      input += chunk;
      let newline;
      while ((newline = input.indexOf("\n")) >= 0) {
        const line = input.slice(0, newline).trim();
        input = input.slice(newline + 1);
        if (!line) continue;
        let request;
        try {
          request = JSON.parse(line);
        } catch {
          continue;
        }
        const id = nextId++;
        pending.set(id, { client, id: request.id });
        toServer({ id, method: request.method, params: { ...(request.params ?? {}), session: client.session } });
      }
    });
    conn.on("error", () => {});
    conn.on("close", () => {
      clients.delete(client);
      for (const [id, route] of pending) if (route.client === client) pending.delete(id);
      toServer({ id: nextId++, method: "_closeSession", params: { session: client.session } });
      idle();
    });
  };
  listener.off("connection", hold);
  listener.on("connection", accept);
  for (const conn of early.splice(0)) accept(conn);
  idle();

  process.on("SIGTERM", () => shutdown(0));
  process.on("SIGINT", () => shutdown(0));
  log(`broker up on ${transport}`);
}
