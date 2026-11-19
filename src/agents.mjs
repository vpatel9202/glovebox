// Finds the coding agents installed on this machine and connects nostrings to
// each one: the MCP server, plus the skill where the agent reads skills.
// Every change is described before it is made, and making it twice changes
// nothing. A config file that cannot be parsed is left alone.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const SKILL_DIR = path.join(here, "..", "skills", "nostrings");

function onPath(name) {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// How agents should start the server. A global install is on PATH; otherwise
// (npx, a git checkout) npx fetches the published package.
export function serverCommand() {
  return onPath("nostrings") ? { command: "nostrings", args: ["mcp"] } : { command: "npx", args: ["-y", "nostrings", "mcp"] };
}

function readJson(file) {
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function backup(file) {
  const copy = `${file}.before-nostrings`;
  if (fs.existsSync(file) && !fs.existsSync(copy)) fs.copyFileSync(file, copy);
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  backup(file);
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function tomlBlock({ command, args }, extra = "") {
  return `\n[mcp_servers.nostrings]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(args)}\n${extra}`;
}

function appendToml(file, block) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  backup(file);
  fs.appendFileSync(file, block);
}

function tomlHasServer(file) {
  return fs.existsSync(file) && /^\[mcp_servers\.nostrings\]/m.test(fs.readFileSync(file, "utf8"));
}

function copySkill(dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(SKILL_DIR, dest, { recursive: true, force: true });
}

function skillCurrent(dest) {
  const mine = path.join(SKILL_DIR, "SKILL.md");
  const theirs = path.join(dest, "SKILL.md");
  return fs.existsSync(theirs) && fs.readFileSync(theirs, "utf8") === fs.readFileSync(mine, "utf8");
}

// A JSON config whose servers live under `key` ("mcpServers", or "mcp" for
// OpenCode). `entry` builds this agent's server entry.
function jsonAgent({ id, name, file, key, entry, detect, seed = {} }) {
  return {
    id,
    name,
    detect,
    plan(home) {
      const target = file(home);
      let data;
      try {
        data = readJson(target);
      } catch {
        return { status: "manual", changes: [`${target} is not plain JSON (comments?); add this under "${key}" yourself:\n${JSON.stringify({ nostrings: entry(serverCommand()) }, null, 2)}`] };
      }
      if (data?.[key]?.nostrings) return { status: "done", changes: [] };
      return {
        status: "todo",
        changes: [`add "nostrings" to "${key}" in ${target}`],
        apply() {
          const next = Object.keys(data).length ? data : { ...seed };
          next[key] = { ...(next[key] ?? {}), nostrings: entry(serverCommand()) };
          writeJson(target, next);
        },
      };
    },
  };
}

export function knownAgents() {
  const home = os.homedir();
  const dir = (p) => fs.existsSync(path.join(home, p));
  return [
    {
      id: "claude",
      name: "Claude Code",
      detect: () => onPath("claude"),
      plan(homeDir) {
        const skill = path.join(homeDir, ".claude", "skills", "nostrings");
        let registered = false;
        try {
          execFileSync("claude", ["mcp", "get", "nostrings"], { stdio: "ignore", timeout: 20_000 });
          registered = true;
        } catch {}
        const { command, args } = serverCommand();
        const changes = [];
        if (!registered) changes.push(`claude mcp add --scope user nostrings -- ${command} ${args.join(" ")}`);
        if (!skillCurrent(skill)) changes.push(`copy the nostrings skill to ${skill}`);
        if (!changes.length) return { status: "done", changes };
        return {
          status: "todo",
          changes,
          apply() {
            if (!registered) execFileSync("claude", ["mcp", "add", "--scope", "user", "nostrings", "--", command, ...args], { stdio: "ignore", timeout: 30_000 });
            copySkill(skill);
          },
        };
      },
    },
    {
      id: "codex",
      name: "Codex CLI",
      detect: () => onPath("codex") || dir(".codex"),
      plan(homeDir) {
        const file = path.join(homeDir, ".codex", "config.toml");
        if (tomlHasServer(file)) return { status: "done", changes: [] };
        return { status: "todo", changes: [`add [mcp_servers.nostrings] to ${file}`], apply: () => appendToml(file, tomlBlock(serverCommand())) };
      },
    },
    {
      id: "grok",
      name: "Grok CLI",
      detect: () => onPath("grok") || dir(".grok"),
      plan(homeDir) {
        const file = path.join(homeDir, ".grok", "config.toml");
        const skill = path.join(homeDir, ".grok", "skills", "nostrings");
        const has = tomlHasServer(file);
        const changes = [];
        if (!has) changes.push(`add [mcp_servers.nostrings] to ${file}`);
        if (!skillCurrent(skill)) changes.push(`copy the nostrings skill to ${skill}`);
        if (!changes.length) return { status: "done", changes };
        return {
          status: "todo",
          changes,
          apply() {
            if (!has) appendToml(file, tomlBlock(serverCommand(), "enabled = true\n"));
            copySkill(skill);
          },
        };
      },
    },
    jsonAgent({
      id: "cursor",
      name: "Cursor",
      detect: () => dir(".cursor"),
      file: (h) => path.join(h, ".cursor", "mcp.json"),
      key: "mcpServers",
      entry: (c) => c,
    }),
    jsonAgent({
      id: "gemini",
      name: "Gemini CLI",
      detect: () => onPath("gemini") || dir(".gemini"),
      file: (h) => path.join(h, ".gemini", "settings.json"),
      key: "mcpServers",
      entry: (c) => c,
    }),
    jsonAgent({
      id: "opencode",
      name: "OpenCode",
      detect: () => onPath("opencode") || dir(".config/opencode"),
      file: (h) => path.join(h, ".config", "opencode", "opencode.json"),
      key: "mcp",
      entry: (c) => ({ type: "local", command: [c.command, ...c.args], enabled: true }),
      seed: { $schema: "https://opencode.ai/config.json" },
    }),
  ];
}

// Each installed agent with its plan, against `home` (a test passes a temp dir).
export function planAgents({ home = os.homedir(), only } = {}) {
  return knownAgents()
    .filter((a) => (only ? only.includes(a.id) : a.detect()))
    .map((a) => ({ id: a.id, name: a.name, ...a.plan(home) }));
}
