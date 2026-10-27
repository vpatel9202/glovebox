#!/usr/bin/env node
// glovebox command line: MCP server, CLI sessions, setup, and approvals.
import fs from "node:fs";
import { parseArgs } from "node:util";
import { loadConfig, paths, readUserConfig, VERSION, writeUserConfig } from "../src/config.mjs";

const USAGE = `glovebox ${VERSION} — scriptable computer use for coding agents

Usage:
  glovebox setup [--rebuild]        Build the helper and ask macOS for permissions
  glovebox signing [--create]       Make permission grants survive helper rebuilds
  glovebox doctor                   Check that everything is ready
  glovebox mcp                      Run the stdio MCP server (tools: js, js_reset)
  glovebox run [code] [-f file]     Run a script in a persistent CLI session
        [--session name] [--title t] [--timeout ms]
                                    Reads code from stdin when no code or file is given.
                                    Screenshots are saved to files and printed as paths.
  glovebox reset [--session name]   Drop a CLI session's bindings
  glovebox stop                     Stop the CLI daemon and its sessions
  glovebox smoke [--full]           Batched, persistent smoke test on Calculator
                                    (--full adds background click/drag/scroll in TextEdit)
  glovebox allow <app>...           Always allow an app (name or bundle id)
  glovebox deny <app>...            Never allow an app
  glovebox revoke <app>...          Remove an app from both lists
  glovebox approval <ask|allowlist|allow-all>
  glovebox config                   Print the effective configuration
  glovebox log [-n 20]              Show recent actions
`;

function die(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function printResult(result) {
  for (const block of result.content ?? []) {
    if (block.type === "text") process.stdout.write(`${block.text}\n`);
  }
  if (!result.ok) process.exitCode = 1;
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

function editList(list, apps, add) {
  const config = readUserConfig();
  const lower = apps.map((a) => a.toLowerCase());
  const next = { ...config };
  for (const key of ["allow", "deny"]) {
    next[key] = (config[key] ?? []).filter((entry) => !lower.includes(entry.toLowerCase()));
  }
  if (add) next[list] = [...next[list], ...apps];
  writeUserConfig(next);
  return next;
}

async function doctor() {
  const lines = [];
  let ok = true;
  const check = (pass, label, fix) => {
    lines.push(`${pass ? "ok  " : "FAIL"}  ${label}${!pass && fix ? `\n      ${fix}` : ""}`);
    if (!pass) ok = false;
  };
  const [major, minor] = process.versions.node.split(".").map(Number);
  check(major > 20 || (major === 20 && minor >= 10), `Node ${process.versions.node} (need 20.10+)`);
  let config;
  try {
    config = loadConfig();
    check(true, `Config ${fs.existsSync(paths.config) ? paths.config : "(defaults)"}, approval: ${config.approval}`);
  } catch (error) {
    check(false, "Config", error.message);
  }
  if (process.platform === "darwin") {
    const helper = await import("../src/macos-helper.mjs");
    const built = helper.isBuilt();
    check(built, `Helper built at ${helper.appPath()}`, "Run: glovebox setup");
    if (built) {
      const { MacBackend } = await import("../src/backends/macos.mjs");
      const backend = new MacBackend({ client: "glovebox doctor" });
      try {
        const ping = await backend.request("ping");
        check(true, `Helper running (pid ${ping.pid}, v${ping.version})`);
        const bg = ping.background ?? {};
        const bgOk = bg.postEventRecord && bg.setIntegerField && bg.processSerialNumber;
        lines.push(
          bgOk
            ? "ok    Background input available (apps stay in the background)"
            : `warn  Background input unavailable on this macOS; apps will be brought forward (${Object.entries(bg).filter(([, v]) => !v).map(([k]) => k).join(", ") || "old helper"})`,
        );
        const perms = await backend.request("permissions", { prompt: false });
        check(perms.accessibility, "Accessibility granted to Glovebox Helper", "System Settings > Privacy & Security > Accessibility: enable Glovebox Helper");
        check(perms.screenRecording, "Screen Recording granted to Glovebox Helper", "System Settings > Privacy & Security > Screen & System Audio Recording: enable Glovebox Helper, then run: glovebox setup --restart");
        // In testing, Escape only reached the helper with Input Monitoring.
        lines.push(
          perms.inputMonitoring
            ? "ok    Input Monitoring granted: pressing Escape stops a running script"
            : "info  Input Monitoring not granted (optional): Escape will not stop scripts; switching to another app still does",
        );
      } catch (error) {
        check(false, "Helper reachable", error.message);
      } finally {
        backend.close();
      }
    }
  } else {
    check(false, `Platform ${process.platform}`, "Only macOS has a backend today. See docs/roadmap.md.");
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  if (!ok) process.exitCode = 1;
}

// Polls the helper until `check(perms)` holds, or gives up after `minutes`.
async function waitFor(backend, check, minutes = 5) {
  const deadline = Date.now() + minutes * 60_000;
  while (Date.now() < deadline) {
    if (check(await backend.request("permissions", { prompt: false }))) return true;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

// Builds the helper if needed, then walks through the macOS permissions one
// at a time: macOS drops a second prompt that arrives while the first is open.
async function setup(flags) {
  if (process.platform !== "darwin") die(`No backend for ${process.platform} yet. See docs/roadmap.md.`);
  const helper = await import("../src/macos-helper.mjs");
  const { MacBackend } = await import("../src/backends/macos.mjs");
  const say = (text) => process.stdout.write(`${text}\n`);
  const rebuilding = flags.rebuild || !helper.isBuilt();
  const hadBuild = fs.existsSync(helper.appPath());
  if (rebuilding || flags.restart) await helper.quit();
  if (rebuilding) await helper.build({ log: say });
  if (rebuilding && hadBuild && !(await helper.signingIdentity())) {
    // An ad-hoc signed rebuild is a new app to macOS; stale grants keep showing as on.
    say("The helper was rebuilt ad hoc, so macOS treats it as a new app. If old grants still show as");
    say("on but this step never finishes, clear them in another terminal and run setup again:");
    say(`  tccutil reset Accessibility ${helper.BUNDLE_ID}`);
    say(`  tccutil reset ScreenCapture ${helper.BUNDLE_ID}`);
    say(`  tccutil reset ListenEvent ${helper.BUNDLE_ID}`);
    say("To stop this happening on every rebuild: glovebox signing --create");
  }

  let backend = new MacBackend({ client: "glovebox setup" });
  let perms = await backend.request("permissions", { prompt: false });
  if (!perms.accessibility) {
    say('\n1/2 Accessibility: macOS is asking now. Turn on "Glovebox Helper" in');
    say("    System Settings > Privacy & Security > Accessibility. Waiting...");
    await backend.request("permissions", { prompt: true });
    if (!(await waitFor(backend, (p) => p.accessibility))) die("Timed out waiting for Accessibility. Run glovebox setup again.");
    say("    Accessibility granted.");
  }
  perms = await backend.request("permissions", { prompt: false });
  if (!perms.screenRecording) {
    say('\n2/2 Screen Recording: macOS is asking now. Turn on "Glovebox Helper" in');
    say("    System Settings > Privacy & Security > Screen & System Audio Recording.");
    say("    If macOS offers to quit and reopen it, accept. If no prompt appears, use + and add");
    say(`    ${helper.appPath()} (press Cmd+Shift+G in the file picker). Waiting...`);
    await backend.request("permissions", { prompt: true });
    if (!(await waitFor(backend, (p) => p.screenRecording))) die("Timed out waiting for Screen Recording. Run glovebox setup again.");
    say("    Screen Recording granted.");
    // Relaunch so the key monitor and capture start with the new grants.
    backend.close();
    await helper.quit();
    backend = new MacBackend({ client: "glovebox setup" });
  }
  perms = await backend.request("permissions", { prompt: false });
  if (!perms.inputMonitoring) {
    say("\nOptional: Input Monitoring lets you stop a running script by pressing Escape.");
    say("Without it, switching to another app (or js_reset) still stops a script.");
    say('To enable it, turn on "Glovebox Helper" in System Settings > Privacy & Security >');
    say(`Input Monitoring (use + and ${helper.appPath()} if it is not listed), then run`);
    say("`glovebox setup --restart`.");
    await backend.request("permissions", { prompt: true, inputMonitoring: true });
  }
  backend.close();
  const ready = perms.accessibility && perms.screenRecording;
  say(ready ? "\nReady. Check with `glovebox doctor`, then try `glovebox smoke`." : "\nNot ready yet; run `glovebox doctor` to see what is missing.");
  if (!ready) process.exitCode = 1;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { values: flags, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      file: { type: "string", short: "f" },
      session: { type: "string", short: "s" },
      title: { type: "string", short: "t" },
      timeout: { type: "string" },
      rebuild: { type: "boolean" },
      restart: { type: "boolean" },
      create: { type: "boolean" },
      full: { type: "boolean" },
      n: { type: "string", short: "n" },
      help: { type: "boolean", short: "h" },
    },
  });

  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(USAGE);
      return;
    case "--version":
    case "-v":
    case "version":
      process.stdout.write(`${VERSION}\n`);
      return;
    case "mcp": {
      const { serveMcp } = await import("../src/mcp.mjs");
      serveMcp();
      return;
    }
    case "daemon": {
      const { runDaemon } = await import("../src/daemon.mjs");
      runDaemon();
      return;
    }
    case "run": {
      const code = flags.file ? fs.readFileSync(flags.file, "utf8") : positionals.join(" ") || (await readStdin());
      if (!code.trim()) die("glovebox run: no code. Pass it as an argument, with -f file, or on stdin.");
      const { daemonRequest } = await import("../src/daemon.mjs");
      printResult(
        await daemonRequest({
          op: "run",
          code,
          title: flags.title,
          session: flags.session,
          timeoutMs: flags.timeout ? Number(flags.timeout) : undefined,
          client: process.env.GLOVEBOX_CLIENT,
        }),
      );
      return;
    }
    case "reset":
    case "stop": {
      const { daemonRequest } = await import("../src/daemon.mjs");
      try {
        printResult(await daemonRequest({ op: command, session: flags.session }, { autostart: false }));
      } catch {
        process.stdout.write("No daemon running.\n");
      }
      return;
    }
    case "smoke": {
      const { runSmoke } = await import("../src/smoke.mjs");
      process.exitCode = (await runSmoke({ full: flags.full })) ? 0 : 1;
      return;
    }
    case "setup":
      await setup(flags);
      return;
    case "signing": {
      if (process.platform !== "darwin") die("Signing applies to the macOS helper only.");
      const helper = await import("../src/macos-helper.mjs");
      let identity = await helper.signingIdentity();
      if (!identity && flags.create) {
        await helper.createSigningIdentity({ log: (m) => process.stdout.write(`${m}\n`) });
        identity = await helper.signingIdentity();
      }
      if (identity) {
        process.stdout.write(`Signing identity "${helper.SIGNING_NAME}" (${identity}) is ready.\n`);
        process.stdout.write("Run `glovebox setup --rebuild` once to re-sign the helper with it, and grant permissions one last time.\n");
      } else {
        process.stdout.write(
          [
            "No local signing identity. The helper is signed ad hoc, so every rebuild resets its macOS permissions.",
            `Create one (a self-signed certificate named "${helper.SIGNING_NAME}" in your login keychain):`,
            "  glovebox signing --create",
            "",
          ].join("\n"),
        );
      }
      return;
    }
    case "doctor":
      await doctor();
      return;
    case "allow":
    case "deny":
    case "revoke": {
      if (positionals.length === 0) die(`glovebox ${command}: name at least one app`);
      const next = editList(command, positionals, command !== "revoke");
      process.stdout.write(`allow: ${JSON.stringify(next.allow)}\ndeny: ${JSON.stringify(next.deny)}\n`);
      process.stdout.write("Running sessions keep approvals they already have; js_reset or glovebox reset to re-check.\n");
      return;
    }
    case "approval": {
      const mode = positionals[0];
      if (!["ask", "allowlist", "allow-all"].includes(mode)) die("glovebox approval: use ask, allowlist, or allow-all");
      writeUserConfig({ approval: mode });
      process.stdout.write(`approval: ${mode}\n`);
      if (mode === "allow-all") {
        process.stdout.write("Warning: agents can now control any app without asking, except blocked apps (terminals, password managers, System Settings).\n");
      }
      return;
    }
    case "config":
      process.stdout.write(`${JSON.stringify(loadConfig(), null, 2)}\n`);
      return;
    case "log": {
      const n = Number(flags.n ?? 20);
      const lines = fs.existsSync(paths.log) ? fs.readFileSync(paths.log, "utf8").trim().split("\n").slice(-n) : [];
      process.stdout.write(lines.length ? `${lines.join("\n")}\n` : "No actions logged yet.\n");
      return;
    }
    default:
      die(`Unknown command "${command}".\n\n${USAGE}`);
  }
}

main().catch((error) => die(error.message));
