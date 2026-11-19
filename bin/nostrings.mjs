#!/usr/bin/env node
// nostrings command line: MCP server, CLI sessions, setup, and approvals.
import fs from "node:fs";
import { parseArgs } from "node:util";
import { loadConfig, paths, readUserConfig, VERSION, writeUserConfig } from "../src/config.mjs";

const USAGE = `nostrings ${VERSION} — scriptable computer use for coding agents

Usage:
  nostrings init [--yes] [--android-only]
                                    Set up everything: helper, permissions, agents, a test
  nostrings setup [--rebuild] [--input-monitoring]
                                    Build the helper and ask macOS for permissions
  nostrings signing [--create] [--trust]  Make grants survive rebuilds; --trust stops keychain prompts
  nostrings doctor                   Check that everything is ready
  nostrings mcp                      Run the stdio MCP server (tools: js, js_reset)
  nostrings run [code] [-f file]     Run a script in a persistent CLI session
        [--session name] [--title t] [--timeout ms]
                                    Reads code from stdin when no code or file is given.
                                    Screenshots are saved to files and printed as paths.
  nostrings scripts [--examples]     List saved scripts (~/.nostrings/scripts);
                                    --examples adds the ones in examples/
  nostrings script <name> [k=v ...]  Run a saved script again, no model needed
        [--session name] [--timeout ms]
  nostrings reset [--session name]   Drop a CLI session's bindings
  nostrings stop                     Stop the CLI daemon and its sessions
  nostrings smoke [--full]           Batched, persistent smoke test on Calculator
  nostrings smoke --macos [--keep] [--background-only]  Every macOS capability, on Nostrings Fixture
                                    (--full adds background click/drag/scroll in TextEdit)
  nostrings smoke --android [--serial s] [--keep]
                                    The same on a phone or emulator, with a test app
                                    that is installed for the run (--keep leaves it)
  nostrings conformance [--command "cmd"] [--android [--serial s]] [--app name] [--input]
                                    Check a backend against docs/backend-protocol.md
  nostrings allow <app>...           Always allow an app (name or bundle id)
  nostrings deny <app>...            Never allow an app
  nostrings revoke <app>...          Remove an app from both lists
  nostrings approval <ask|allowlist|allow-all>
  nostrings config                   Print the effective configuration
  nostrings log [-n 20]              Show recent actions
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
    check(built, `Helper built at ${helper.appPath()}`, "Run: nostrings setup");
    if (built) {
      const { MacBackend } = await import("../src/backends/macos.mjs");
      const backend = new MacBackend({ client: "nostrings doctor" });
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
        check(perms.accessibility, "Accessibility granted to Nostrings Helper", "System Settings > Privacy & Security > Accessibility: enable Nostrings Helper");
        check(perms.screenRecording, "Screen Recording granted to Nostrings Helper", "System Settings > Privacy & Security > Screen & System Audio Recording: enable Nostrings Helper, then run: nostrings setup --restart");
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
    lines.push(`info  No desktop backend for ${process.platform}; Android devices only. See docs/roadmap.md.`);
  }
  const { doctorChecks } = await import("../src/backends/android.mjs");
  for (const { level, label, fix } of await doctorChecks()) {
    if (level === "fail") check(false, label, fix);
    else lines.push(`${level === "ok" ? "ok  " : level}  ${label}${level !== "ok" && fix ? `\n      ${fix}` : ""}`);
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
    say("To stop this happening on every rebuild: nostrings signing --create");
  }

  let backend = new MacBackend({ client: "nostrings setup" });
  let perms = await backend.request("permissions", { prompt: false });
  if (!perms.accessibility) {
    say('\n1/2 Accessibility: macOS is asking now. Turn on "Nostrings Helper" in');
    say("    System Settings > Privacy & Security > Accessibility. Waiting...");
    await backend.request("permissions", { ask: "accessibility" });
    if (!(await waitFor(backend, (p) => p.accessibility))) die("Timed out waiting for Accessibility. Run nostrings setup again.");
    say("    Accessibility granted.");
  }
  perms = await backend.request("permissions", { prompt: false });
  if (!perms.screenRecording) {
    say('\n2/2 Screen Recording: macOS is asking now. Turn on "Nostrings Helper" in');
    say("    System Settings > Privacy & Security > Screen & System Audio Recording.");
    say("    If macOS offers to quit and reopen it, accept. If no prompt appears, use + and add");
    say(`    ${helper.appPath()} (press Cmd+Shift+G in the file picker). Waiting...`);
    await backend.request("permissions", { ask: "screenRecording" });
    if (!(await waitFor(backend, (p) => p.screenRecording))) die("Timed out waiting for Screen Recording. Run nostrings setup again.");
    say("    Screen Recording granted.");
    // Relaunch so the key monitor and capture start with the new grants.
    backend.close();
    await helper.quit();
    backend = new MacBackend({ client: "nostrings setup" });
  }
  perms = await backend.request("permissions", { prompt: false });
  if (!perms.inputMonitoring && flags["input-monitoring"]) {
    say('\nInput Monitoring: macOS is asking now. Turn on "Nostrings Helper" in');
    say("    System Settings > Privacy & Security > Input Monitoring. Waiting...");
    await backend.request("permissions", { ask: "inputMonitoring" });
    if (await waitFor(backend, (p) => p.inputMonitoring, 2)) {
      say("    Input Monitoring granted. Restarting the helper so Escape works.");
      backend.close();
      await helper.quit();
      backend = new MacBackend({ client: "nostrings setup" });
    } else say("    Not granted; Escape will not stop scripts. Switching apps still does.");
  } else if (!perms.inputMonitoring) {
    // Not prompted here: an unanswered prompt would sit in front of the next command.
    say("\nOptional: Input Monitoring lets you stop a running script by pressing Escape.");
    say("Without it, switching to another app (or js_reset) still stops a script.");
    say("To turn it on: nostrings setup --input-monitoring");
  }
  backend.close();
  const ready = perms.accessibility && perms.screenRecording;
  say(ready ? "\nReady. Check with `nostrings doctor`, then try `nostrings smoke`." : "\nNot ready yet; run `nostrings doctor` to see what is missing.");
  if (!ready) process.exitCode = 1;
}

// One command from install to a working agent: helper and permissions (Mac),
// a phone check (Android), the MCP server and skill in each agent found, and a
// short real test. Asks before each change; --yes accepts them all.
async function init(flags) {
  const say = (text = "") => process.stdout.write(`${text}\n`);
  const interactive = process.stdin.isTTY && !flags.yes;
  const { createInterface } = await import("node:readline/promises");
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  const ask = async (question, yes = true) => {
    if (flags.yes) return true;
    if (!rl) return false;
    const answer = (await rl.question(`${question} ${yes ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
    return answer ? answer.startsWith("y") : yes;
  };
  if (!process.stdin.isTTY && !flags.yes) say("Not a terminal: showing what init would do. Pass --yes to do it.\n");

  say(`nostrings ${VERSION} init\n`);
  let macReady = false;
  if (process.platform === "darwin" && !flags["android-only"]) {
    say(flags.yes || rl ? "Mac: building the helper and asking for permissions." : "Mac: would build the helper and ask for Accessibility, then Screen Recording.");
    const helper = await import("../src/macos-helper.mjs");
    if (!(await helper.signingIdentity())) {
      say("A local signing certificate keeps macOS permissions across nostrings upgrades.");
      say(`It is self-signed, lives in your login keychain, and signs only the helper.`);
      if (await ask("Create it?")) await helper.createSigningIdentity({ log: say });
    }
    if (flags.yes || rl) {
      await setup(flags);
      macReady = process.exitCode !== 1;
    }
    say();
  }

  const { doctorChecks } = await import("../src/backends/android.mjs");
  const android = await doctorChecks();
  const phones = android.filter((c) => c.level === "ok" && /screen \d+x\d+/.test(c.label));
  if (phones.length) for (const c of phones) say(`Android: ${c.label}`);
  else say("Android: no phone or emulator in `adb devices` (optional). Connect one any time; nothing else to set up.");
  say();

  const { planAgents } = await import("../src/agents.mjs");
  const agents = planAgents();
  if (!agents.length) say("Agents: none found. See docs/agents.md, or use `nostrings run` from any shell.");
  for (const agent of agents) {
    if (agent.status === "done") {
      say(`${agent.name}: already connected.`);
      continue;
    }
    say(`${agent.name}:`);
    for (const change of agent.changes) say(`  - ${change}`);
    if (agent.status === "manual") continue;
    if (await ask(`Connect ${agent.name}?`)) {
      try {
        agent.apply();
        say(`  Connected. Start a new ${agent.name} session to pick it up.`);
      } catch (error) {
        say(`  Failed: ${error.message}`);
      }
    }
  }
  say();

  if (macReady && (await ask("Run a 20-second test on Calculator? It opens Calculator and types into it."))) {
    const { runSmoke } = await import("../src/smoke.mjs");
    await runSmoke({});
  }
  if (phones.length === 1 && (await ask("Run the Android test? It installs a small test app for the run.", false))) {
    const { runAndroidSmoke } = await import("../src/smoke.mjs");
    await runAndroidSmoke({});
  }
  rl?.close();
  say("\nDone. In a new agent session, try:");
  say('  "Use nostrings to open Calculator, work out 1234 * 5678, and tell me the result."');
  if (phones.length) say('  "Use nostrings to open Clock on my phone and read the alarms."');
  say("Docs: https://github.com/vpatel9202/nostrings#readme");
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
      "input-monitoring": { type: "boolean" },
      create: { type: "boolean" },
      trust: { type: "boolean" },
      macos: { type: "boolean" },
      "background-only": { type: "boolean" },
      full: { type: "boolean" },
      android: { type: "boolean" },
      serial: { type: "string" },
      keep: { type: "boolean" },
      yes: { type: "boolean", short: "y" },
      examples: { type: "boolean" },
      command: { type: "string" },
      app: { type: "string" },
      input: { type: "boolean" },
      "android-only": { type: "boolean" },
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
      if (!code.trim()) die("nostrings run: no code. Pass it as an argument, with -f file, or on stdin.");
      const { daemonRequest } = await import("../src/daemon.mjs");
      printResult(
        await daemonRequest({
          op: "run",
          code,
          title: flags.title,
          session: flags.session,
          timeoutMs: flags.timeout ? Number(flags.timeout) : undefined,
          client: process.env.NOSTRINGS_CLIENT,
        }),
      );
      return;
    }
    case "scripts": {
      const { installExamples, listScripts, scriptsDir } = await import("../src/scripts.mjs");
      if (flags.examples) {
        const added = installExamples();
        process.stdout.write(added.length ? `Added ${added.join(", ")} to ${scriptsDir()}.\n` : "The examples are already in your scripts.\n");
      }
      const list = listScripts();
      if (!list.length) process.stdout.write(`No saved scripts in ${scriptsDir()}. Agents save one with ui.scripts.save(name, code, description).\n`);
      for (const s of list) process.stdout.write(`${s.name.padEnd(24)} ${s.description}\n`);
      return;
    }
    case "script": {
      const [name, ...pairs] = positionals;
      if (!name) die("nostrings script <name> [key=value ...]: name a saved script (see: nostrings scripts)");
      const { parseArgPairs, readScript } = await import("../src/scripts.mjs");
      readScript(name); // fails early, with the list of saved names
      const args = parseArgPairs(pairs);
      const { daemonRequest } = await import("../src/daemon.mjs");
      printResult(
        await daemonRequest({
          op: "run",
          code: `await ui.scripts.run(${JSON.stringify(name)}, ${JSON.stringify(args)})`,
          title: `script ${name}`,
          session: flags.session ?? `script-${name}`,
          timeoutMs: flags.timeout ? Number(flags.timeout) : undefined,
          client: process.env.NOSTRINGS_CLIENT,
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
      const { runSmoke, runAndroidSmoke, runMacSmoke } = await import("../src/smoke.mjs");
      const passed = flags.android ? await runAndroidSmoke({ serial: flags.serial, keep: flags.keep }) : flags.macos ? await runMacSmoke({ keep: flags.keep, foreground: !flags["background-only"] }) : await runSmoke({ full: flags.full });
      process.exitCode = passed ? 0 : 1;
      return;
    }
    case "conformance": {
      const { commandBackend, runConformance } = await import("../src/conformance.mjs");
      let backend;
      if (flags.command) backend = commandBackend(flags.command);
      else if (flags.android) {
        const { createDeviceBackend } = await import("../src/backends/index.mjs");
        backend = createDeviceBackend({ serial: flags.serial ?? null, client: "nostrings conformance" });
      } else {
        const { createBackend } = await import("../src/backends/index.mjs");
        backend = createBackend({ client: "nostrings conformance" });
      }
      const app = flags.app ?? (flags.android ? "Clock" : process.platform === "darwin" && !flags.command ? "Calculator" : undefined);
      const results = await runConformance(backend, {
        app,
        input: flags.input,
        report: (r) => process.stdout.write(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `\n      ${r.detail}` : ""}\n`),
      });
      backend.close?.();
      const failed = results.filter((r) => !r.ok).length;
      process.stdout.write(failed ? `\n${failed} of ${results.length} checks failed.\n` : `\nAll ${results.length} checks passed.\n`);
      process.exitCode = failed ? 1 : 0;
      return;
    }
    case "setup":
      await setup(flags);
      return;
    case "init":
      await init(flags);
      return;
    case "signing": {
      if (process.platform !== "darwin") die("Signing applies to the macOS helper only.");
      const helper = await import("../src/macos-helper.mjs");
      let identity = await helper.signingIdentity();
      if (!identity && flags.create) {
        await helper.createSigningIdentity({ log: (m) => process.stdout.write(`${m}\n`) });
        identity = await helper.signingIdentity();
      }
      if (identity && flags.trust) {
        await helper.trustSigningKey({ log: (m) => process.stdout.write(`${m}\n`) });
        return;
      }
      if (identity) {
        process.stdout.write(`Signing identity "${helper.SIGNING_NAME}" (${identity}) is ready.\n`);
        process.stdout.write("If macOS asks for your keychain password on each rebuild, run once: nostrings signing --trust\n");
        process.stdout.write("Run `nostrings setup --rebuild` once to re-sign the helper with it, and grant permissions one last time.\n");
      } else {
        process.stdout.write(
          [
            "No local signing identity. The helper is signed ad hoc, so every rebuild resets its macOS permissions.",
            `Create one (a self-signed certificate named "${helper.SIGNING_NAME}" in your login keychain):`,
            "  nostrings signing --create",
            "",
          ].join("\n"),
        );
      }
      return;
    }
    case "doctor":
      await doctor();
      return;
    case "android-broker": {
      // Internal: started by the first session that uses a phone.
      const { runDeviceBroker } = await import("../src/backends/android.mjs");
      await runDeviceBroker(positionals[0], positionals[1]);
      return;
    }
    case "allow":
    case "deny":
    case "revoke": {
      if (positionals.length === 0) die(`nostrings ${command}: name at least one app`);
      const next = editList(command, positionals, command !== "revoke");
      process.stdout.write(`allow: ${JSON.stringify(next.allow)}\ndeny: ${JSON.stringify(next.deny)}\n`);
      process.stdout.write("Running sessions keep approvals they already have; js_reset or nostrings reset to re-check.\n");
      return;
    }
    case "approval": {
      const mode = positionals[0];
      if (!["ask", "allowlist", "allow-all"].includes(mode)) die("nostrings approval: use ask, allowlist, or allow-all");
      writeUserConfig({ approval: mode });
      process.stdout.write(`approval: ${mode}\n`);
      if (mode === "allow-all") {
        process.stdout.write("Warning: agents can now control any app without asking, except ask-first apps (terminals, password managers, System Settings, messages), which still ask.\n");
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
