// Client for Glovebox Helper.app over its Unix socket.
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import * as helper from "../macos-helper.mjs";

function connectOnce(path) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(path);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

export class MacBackend extends EventEmitter {
  platform = "macos";

  constructor({ client = "An agent" } = {}) {
    super();
    this.client = client;
    this.socket = null;
    this.pending = new Map();
    this.nextId = 1;
    this.connecting = null;
  }

  async connect() {
    if (this.socket) return;
    this.connecting ??= this.#connect().finally(() => {
      this.connecting = null;
    });
    await this.connecting;
  }

  async #connect() {
    if (!fs.existsSync(helper.appPath()) || !helper.isBuilt()) {
      throw new Error("Glovebox Helper is not built or is out of date. Run: glovebox setup");
    }
    const path = helper.socketPath();
    let socket;
    try {
      socket = await connectOnce(path);
    } catch {
      await helper.launch();
      for (let attempt = 0; attempt < 50 && !socket; attempt++) {
        await new Promise((r) => setTimeout(r, 100));
        socket = await connectOnce(path).catch(() => null);
      }
      if (!socket) throw new Error(`Glovebox Helper did not start (no socket at ${path}). Run: glovebox doctor`);
    }
    this.socket = socket;
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line) this.#onMessage(JSON.parse(line));
      }
    });
    socket.on("close", () => {
      if (this.socket === socket) this.socket = null;
      for (const { reject } of this.pending.values()) reject(new Error("Glovebox Helper disconnected"));
      this.pending.clear();
    });
    socket.on("error", () => {});
    await this.request("hello", { client: this.client });
  }

  #onMessage(message) {
    if (message.event) {
      this.emit(message.event, message);
      return;
    }
    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    this.pending.delete(message.id);
    if (message.error) {
      const error = new Error(message.error.message);
      error.code = message.error.code;
      waiter.reject(error);
    } else {
      waiter.resolve(message.result);
    }
  }

  async request(method, params = {}) {
    if (!this.socket) await this.connect();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  close() {
    this.socket?.destroy();
    this.socket = null;
  }
}
