// Paths and user configuration. Everything lives under one directory so a user
// can inspect or delete it: GLOVEBOX_HOME, else ~/.glovebox.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const VERSION = "0.2.0";

export function homeDir() {
  return process.env.GLOVEBOX_HOME || path.join(os.homedir(), ".glovebox");
}

export const paths = {
  get home() {
    return homeDir();
  },
  get config() {
    return path.join(homeDir(), "config.json");
  },
  get log() {
    return path.join(homeDir(), "actions.log");
  },
  get bin() {
    return path.join(homeDir(), "bin");
  },
  get shots() {
    return path.join(homeDir(), "screenshots");
  },
  get socket() {
    return process.platform === "win32"
      ? `\\\\.\\pipe\\glovebox-${os.userInfo().username}`
      : path.join(homeDir(), "daemon.sock");
  },
};

export const DEFAULTS = {
  // ask: native dialog on first use of each app. allowlist: only apps in `allow`.
  // allow-all: no prompts (explicit opt-in; blocked apps still need `allow`).
  approval: "ask",
  allow: [],
  deny: [],
  // background: input reaches apps without focusing them (falls back to
  // foreground when the app or macOS can't take it). foreground: always front.
  input: "background",
  // Apps that need foreground input, by name or bundle id.
  foregroundApps: [],
  // Draw the agent cursor where actions land.
  cursor: true,
  screenshot: { maxLongSide: 1568, maxPixels: 1_150_000, format: "png", quality: 80 },
  ax: { maxNodes: 800, maxDepth: 40, maxTextLength: 160 },
  log: { enabled: true, text: false },
  daemon: { idleMinutes: 60 },
  timeoutMs: 120_000,
};

function merge(base, extra) {
  const out = { ...base };
  for (const [key, value] of Object.entries(extra ?? {})) {
    out[key] =
      value && typeof value === "object" && !Array.isArray(value) && base[key] && typeof base[key] === "object"
        ? merge(base[key], value)
        : value;
  }
  return out;
}

export function readUserConfig() {
  try {
    return JSON.parse(fs.readFileSync(paths.config, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw new Error(`Cannot read ${paths.config}: ${error.message}`);
  }
}

export function loadConfig() {
  const config = merge(DEFAULTS, readUserConfig());
  if (process.env.GLOVEBOX_APPROVAL) config.approval = process.env.GLOVEBOX_APPROVAL;
  if (!["ask", "allowlist", "allow-all"].includes(config.approval)) {
    throw new Error(`approval must be ask, allowlist, or allow-all (got ${config.approval})`);
  }
  return config;
}

export function writeUserConfig(update) {
  fs.mkdirSync(homeDir(), { recursive: true, mode: 0o700 });
  const next = { ...readUserConfig(), ...update };
  fs.writeFileSync(paths.config, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return next;
}
