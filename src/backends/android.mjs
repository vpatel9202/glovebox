// Client for the glovebox server on an Android device. The server is a dex
// run over ADB with shell privileges (app_process) that speaks the backend
// protocol as JSON lines on the adb shell's stdin and stdout. One server per
// phone is shared by every session through the phone's broker
// (android-broker.mjs), which owns that adb shell and listens on a Unix
// socket only this user can open; nothing listens on the phone.
import { EventEmitter } from "node:events";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import net from "node:net";
import { authorize, authorizeLocked, isAskFirst } from "../approval.mjs";
import { paths } from "../config.mjs";
import { brokerSocket, runBroker } from "./android-broker.mjs";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_DEX = path.join(here, "..", "..", "native", "android", "build", "glovebox-server.dex");
export const FIXTURE_APK = path.join(here, "..", "..", "native", "android", "build", "glovebox-fixture.apk");
export const FIXTURE_PACKAGE = "com.glovebox.fixture";
const REMOTE_DEX = "/data/local/tmp/glovebox-server.dex";
const SERVER_CLASS = "com.glovebox.server.Server";

// Methods that only read the app list or the server's own state.
const UNGATED = new Set(["hello", "ping", "permissions", "listApps", "resolveApp", "resolveIntent", "forget", "cursor", "inspect", "waitEvent", "waitQuiet", "_createDisplay", "_displayTree", "_removeRecents", "_tapDisplay", "_events"]);
// Methods that act. Each checks the window it acts on and the lock screen.
const ACTING = new Set(["activate", "keys", "type", "click", "scroll", "drag", "longPress", "performAction", "setValue", "focusElement", "selectText"]);

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

export async function adb(args, options = {}) {
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

// Processes that hold the one shell automation connection a phone allows.
const COMPETING = [
  [/^uiautomator$|com\.android\.commands\.uiautomator/, "uiautomator"],
  [/io\.appium\.uiautomator2/, "Appium"],
  [/dev\.mobile\.maestro/, "Maestro"],
  [/com\.github\.uiautomator/, "uiautomator2 (Python)"],
];

// `glovebox doctor` checks: [{level: "ok"|"fail"|"warn"|"info", label, fix}].
// A phone with a glovebox server already running is reported, not
// connected to: connecting would stop that session's server.
export async function doctorChecks({ client = "glovebox doctor" } = {}) {
  const out = [];
  const add = (level, label, fix) => out.push({ level, label, fix });
  let version;
  try {
    version = (await adb(["version"])).split("\n")[0].trim();
  } catch (error) {
    add("info", "Android: adb not found (optional)", "Install Android platform-tools, or set GLOVEBOX_ADB");
    return out;
  }
  add("ok", `${version} (${adbPath()})`);
  const built = fs.existsSync(SERVER_DEX);
  const devices = await listDevices();
  // Not built only matters once there is a phone to use it on.
  const usable = devices.some((d) => d.state === "device");
  add(built ? "ok" : usable ? "fail" : "info", built ? "Android server built" : "Android server not built", "Run: npm run build:android");
  if (devices.length === 0) add("info", "No Android device connected (adb devices is empty)");
  const seen = new Set();
  for (const { serial, state } of devices) {
    if (state === "unauthorized") {
      add("fail", `${serial}: not authorized`, "Unlock the phone and accept the USB debugging prompt");
      continue;
    }
    if (state !== "device") {
      add("fail", `${serial}: ${state}`, "Reconnect the cable, or for wireless debugging run: adb connect <ip:port>");
      continue;
    }
    const hardware = await hardwareSerial(serial);
    if (seen.has(hardware)) {
      add("ok", `${serial}: same phone as above`);
      continue;
    }
    seen.add(hardware);
    const ps = await adb(["-s", serial, "shell", "ps", "-A", "-o", "ARGS"]).catch(() => "");
    const lines = ps.split("\n");
    const competing = COMPETING.filter(([re]) => lines.some((l) => re.test(l.trim()))).map(([, name]) => name);
    if (competing.length) {
      add("fail", `${serial}: ${competing.join(", ")} is running and holds the screen reader`, "Stop it first; only one automation tool can read the screen at a time");
      continue;
    }
    if (!built) continue;
    const backend = new AndroidBackend({ serial, client });
    try {
      await backend.connect();
      const info = backend.info;
      add("ok", `${serial}: ${info.manufacturer} ${info.model}, Android ${info.release} (API ${info.sdk}), screen ${info.display.join("x")}`);
      add(info.accessibility ? "ok" : "fail", `${serial}: accessibility connection${info.accessibility ? "" : `: ${info.error ?? "failed"}`}`, "Turn off other automation tools, or reboot the phone");
    } catch (error) {
      add("fail", `${serial}: glovebox server did not start`, error.message);
    } finally {
      backend.close();
    }
  }
  return out;
}

const BROKER_LOG = path.join(paths.home, "android-broker.log");
const CLI = path.join(here, "..", "..", "bin", "glovebox.mjs");

// A short hash of the server dex, so a rebuilt server gets its own broker.
function serverBuild() {
  return createHash("sha1").update(fs.readFileSync(SERVER_DEX)).digest("hex").slice(0, 8);
}

function openSocket(socket) {
  return new Promise((resolve, reject) => {
    const conn = net.connect(socket);
    conn.once("connect", () => resolve(conn));
    conn.once("error", reject);
  });
}

function startBroker(transport, hardware) {
  fs.mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  const log = fs.openSync(BROKER_LOG, "a", 0o600);
  const child = spawn(process.execPath, [CLI, "android-broker", transport, hardware], { detached: true, stdio: ["ignore", "ignore", log], env: process.env });
  child.unref();
  fs.closeSync(log);
}

// `glovebox android-broker <transport> <hardware serial>` (started by the first session).
export function runDeviceBroker(transport, hardware) {
  return runBroker({ transport, hardware, build: serverBuild(), adb, adbBin: adbPath(), dex: SERVER_DEX, remoteDex: REMOTE_DEX, serverClass: SERVER_CLASS });
}

export class AndroidBackend extends EventEmitter {
  platform = "android";

  constructor({ serial = null, client = "An agent", prompt } = {}) {
    super();
    this.serial = serial;
    this.client = client;
    this.prompt = prompt; // approval dialog; tests replace it
    this.approved = new Set(); // packages approved this session, and lock grants
    this.names = new Map(); // package -> label, for dialogs
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
    const socket = brokerSocket(await hardwareSerial(transport), serverBuild());
    // The phone's broker (android-broker.mjs) owns its one server; start it
    // if no session has.
    let conn = await openSocket(socket).catch(() => null);
    if (!conn) {
      startBroker(transport, await hardwareSerial(transport));
      for (let i = 0; i < 150 && !conn; i++) {
        await new Promise((r) => setTimeout(r, 100));
        conn = await openSocket(socket).catch(() => null);
      }
      if (!conn) throw codedError(`The glovebox device broker for ${transport} did not start; see ${BROKER_LOG}`, "failed");
    }
    this.child = conn;
    let buffer = "";
    let exitReason = null;
    conn.setEncoding("utf8");
    conn.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("{")) continue;
        try {
          const message = JSON.parse(line);
          if (message.event === "exit") exitReason = message.reason;
          else this.#onMessage(message);
        } catch {
          // A malformed line is noise.
        }
      }
    });
    conn.on("error", () => {});
    conn.on("close", () => {
      if (this.child === conn) this.child = null;
      const reason = exitReason ?? "the connection to the device broker closed";
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(codedError(`The glovebox server on ${this.label} stopped: ${reason}`, "failed"));
      }
      this.pending.clear();
      if (!this.closing) this.emit("exit", { reason });
    });
    this.info = await this.#send("hello", { client: this.client }, 20_000);
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
    if (!UNGATED.has(method)) await this.#gate(method, params);
    // A cold start on a hidden screen can take tens of seconds on a slow device.
    const result = await this.#send(method, params, method === "activate" ? Math.max(timeout, 60_000) : timeout);
    if (method === "listApps") for (const a of result) this.names.set(a.bundleId, a.name);
    if (method === "resolveApp") this.names.set(result.bundleId, result.name);
    return result;
  }

  // The approval gate (src/approval.mjs): the app, then for actions the
  // package of the window acted on (a payment sheet or permission prompt
  // inside an approved app asks again) and the lock screen.
  async #gate(method, params) {
    const pkg = params.pid;
    if (typeof pkg !== "string" || !pkg) throw codedError(`${method} needs an app (pid)`, "bad_request");
    const common = { client: this.client, device: this.label, approved: this.approved, ...(this.prompt ? { prompt: this.prompt } : {}) };
    const name = this.names.get(pkg);
    await authorize({ ...common, pkg, name });
    if (!ACTING.has(method)) {
      // A hidden screen runs behind the lock screen, so reading it while the
      // phone is locked asks too (once per session, like acting).
      if (params.screen !== "hidden" || this.approved.has(`locked:${this.label}`)) return;
      const info = await this.#send("inspect", { pid: pkg, screen: "hidden", lockOnly: true }, 10_000);
      if (info.locked) await authorizeLocked(common);
      return;
    }
    const point = params.path?.[0] ?? (params.x != null ? [params.x, params.y] : null);
    const info = await this.#send(
      "inspect",
      { pid: pkg, screen: params.screen, for: method, ...(point ? { x: point[0], y: point[1] } : {}), ...(Number.isInteger(params.index) ? { index: params.index } : {}) },
      10_000,
    );
    if (info.locked) await authorizeLocked(common);
    const inner = info.windowPackage;
    if (inner && inner !== pkg && isAskFirst(inner)) {
      await authorize({ ...common, pkg: inner, name: info.windowLabel ?? this.names.get(inner), reason: `It is showing inside ${name ?? pkg}.` });
    }
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
      child.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  // Leaves the phone's broker; it closes this session's hidden screens.
  close() {
    const conn = this.child;
    this.child = null;
    this.closing = true;
    if (conn) conn.destroy();
  }
}
