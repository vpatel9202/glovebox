// Client for the glovebox server on an Android device. The host pushes the
// server dex over ADB and runs it with shell privileges (app_process); it
// speaks the backend protocol as JSON lines on the adb shell's stdin and
// stdout. Nothing listens on a socket, so only this process can reach it, and
// the server dies with the adb connection.
import { EventEmitter } from "node:events";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_DEX = path.join(here, "..", "..", "native", "android", "build", "glovebox-server.dex");
const REMOTE_DEX = "/data/local/tmp/glovebox-server.dex";
const SERVER_CLASS = "com.glovebox.server.Server";

function adbPath() {
  if (process.env.GLOVEBOX_ADB) return process.env.GLOVEBOX_ADB;
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (sdk && fs.existsSync(path.join(sdk, "platform-tools", "adb"))) return path.join(sdk, "platform-tools", "adb");
  return "adb";
}

function codedError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function adb(args, options = {}) {
  try {
    const { stdout } = await execFileAsync(adbPath(), args, { timeout: options.timeout ?? 20_000, maxBuffer: 8 << 20 });
    return stdout.replace(/\r/g, "");
  } catch (error) {
    if (error.code === "ENOENT") throw codedError("adb not found. Install Android platform-tools or set GLOVEBOX_ADB.", "permission");
    throw codedError(`adb ${args.join(" ")} failed: ${(error.stderr || error.message).trim()}`, "failed");
  }
}

// Online devices as [{serial, state}].
export async function listDevices() {
  const out = await adb(["devices"]);
  return out
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter(([serial, state]) => serial && state)
    .map(([serial, state]) => ({ serial, state }));
}

// Picks the transport for `wanted`: that serial if it is online, else any
// online transport of the same phone (its USB serial and its wireless
// "adb-<serial>-..." entry are one device), else the only device when none
// was named.
export async function resolveSerial(wanted) {
  const online = (await listDevices()).filter((d) => d.state === "device");
  if (!wanted) {
    if (online.length === 0) throw codedError("No Android device is connected. Check `adb devices`.", "not_found");
    const physical = new Map();
    for (const d of online) physical.set(await hardwareSerial(d.serial), d.serial);
    if (physical.size > 1) {
      throw codedError(`More than one Android device is connected; name one: gb.device("${[...physical.keys()].join('") or gb.device("')}")`, "bad_request");
    }
    return [...physical.values()][0];
  }
  if (online.some((d) => d.serial === wanted)) return wanted;
  for (const d of online) if ((await hardwareSerial(d.serial)) === wanted) return d.serial;
  throw codedError(`Android device ${wanted} is not connected. Check \`adb devices\`.`, "not_found");
}

async function hardwareSerial(transport) {
  return (await adb(["-s", transport, "shell", "getprop", "ro.serialno"]).catch(() => transport)).trim() || transport;
}

export class AndroidBackend extends EventEmitter {
  platform = "android";

  constructor({ serial = null, client = "An agent" } = {}) {
    super();
    this.serial = serial;
    this.client = client;
    this.transport = null;
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this.connecting = null;
    this.info = null;
  }

  get label() {
    return this.info?.model ? `${this.info.model} (${this.transport})` : (this.transport ?? this.serial ?? "Android device");
  }

  async connect() {
    if (this.child) return;
    this.connecting ??= this.#connect().finally(() => {
      this.connecting = null;
    });
    await this.connecting;
  }

  async #connect() {
    if (!fs.existsSync(SERVER_DEX)) {
      throw codedError("The glovebox Android server is not built. Run: npm run build:android", "not_found");
    }
    const transport = await resolveSerial(this.serial);
    this.transport = transport;
    await adb(["-s", transport, "push", SERVER_DEX, REMOTE_DEX]);
    // Only one shell automation connection can exist; a stale server would
    // hold it and make this one fail without a word.
    // (Match the class: the dex path is in CLASSPATH, not on the command line.)
    await adb(["-s", transport, "shell", "pkill", "-f", SERVER_CLASS]).catch(() => {});
    const child = spawn(adbPath(), ["-s", transport, "shell", `CLASSPATH=${REMOTE_DEX} app_process / ${SERVER_CLASS}`], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    let stderr = "";
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("{")) continue; // anything but protocol is noise
        try {
          this.#onMessage(JSON.parse(line));
        } catch {
          // A malformed line is noise too.
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    child.on("exit", (code, signal) => {
      if (this.child === child) this.child = null;
      const reason = stderr.trim().split("\n").filter(Boolean).at(-1) ?? `exit ${code ?? signal}`;
      for (const { reject } of this.pending.values()) reject(codedError(`The glovebox server on ${this.label} stopped: ${reason}`, "failed"));
      this.pending.clear();
      this.emit("exit", { code, signal, reason });
    });
    child.stdin.on("error", () => {});
    this.info = await this.#send("hello", { client: this.client }, 15_000);
  }

  #onMessage(message) {
    if (message.event) {
      this.emit(message.event, message);
      return;
    }
    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    this.pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(codedError(message.error.message, message.error.code));
    else waiter.resolve(message.result);
  }

  async request(method, params = {}, { timeout = 30_000 } = {}) {
    if (!this.child) await this.connect();
    return this.#send(method, params, timeout);
  }

  #send(method, params, timeout) {
    const child = this.child;
    if (!child) throw codedError(`The glovebox server on ${this.label} is not running`, "failed");
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(codedError(`${method} timed out after ${timeout} ms on ${this.label}`, "failed"));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  close() {
    const child = this.child;
    this.child = null;
    if (child) {
      child.stdin.end();
      child.kill();
    }
  }
}
