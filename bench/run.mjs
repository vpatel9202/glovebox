#!/usr/bin/env node
// Runs benchmark tasks against each setup and appends one JSON line per run
// to bench/results/raw/. See bench/README.md.
//
//   node bench/run.mjs --dry-run
//   node bench/run.mjs --setups glovebox,cu,ocu --tasks all --n 3 --budget 30 --stop-after-rep 1
//   node bench/run.mjs --resume bench/results/raw/<file>.jsonl --n 3 --budget 30
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { PRICES, runAgent } from "./lib/agent.mjs";
import { FIXTURE_BUNDLE_ID, benchDir, buildFixture, closeOracle, readJsonLines, repoDir, sh, workDir } from "./lib/env.mjs";
import { quantile, summarize } from "./lib/metrics.mjs";
import { SETUPS } from "./lib/setups.mjs";
import { TASKS } from "./lib/tasks.mjs";

const { values: opts } = parseArgs({
  options: {
    setups: { type: "string", default: "glovebox,cu,ocu" },
    tasks: { type: "string", default: "all" },
    n: { type: "string", default: "1" },
    model: { type: "string", default: "claude-sonnet-5-5" },
    effort: { type: "string", default: "medium" },
    // Dollar cap for the whole output file, including runs already in it.
    budget: { type: "string", default: "10" },
    // Most one run may spend; default scales with the model's input price.
    "run-cap": { type: "string" },
    "max-turns": { type: "string" },
    resume: { type: "string" },
    label: { type: "string", default: "" },
    "stop-after-rep": { type: "string" },
    "allow-dirty": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
  },
});

// ANTHROPIC_API_KEY may live in bench/.env (gitignored).
const envFile = path.join(benchDir, ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const setupNames = opts.setups.split(",").map((s) => s.trim());
for (const name of setupNames) if (!SETUPS[name]) throw new Error(`Unknown setup ${name}; use ${Object.keys(SETUPS).join(", ")}`);
const tasks = opts.tasks === "all" ? TASKS : opts.tasks.split(",").map((id) => TASKS.find((t) => t.id === id) ?? fail(`Unknown task ${id}`));
const n = Number(opts.n);
const haiku = opts.model.includes("haiku");
const maxTurns = Number(opts["max-turns"] ?? (haiku ? 25 : 40));
const runCap = Number(opts["run-cap"] ?? 0.375 * (PRICES[opts.model]?.input ?? 2));
const budget = { cap: Number(opts.budget), spent: 0 };

function fail(message) {
  throw new Error(message);
}

// TextEdit's default-format setting is changed by one task; put the user's
// value back when the run ends.
const richText = await sh("defaults", ["read", "com.apple.TextEdit", "RichText"]).catch(() => null);
function restoreTextEdit() {
  try {
    if (richText == null) execFileSync("defaults", ["delete", "com.apple.TextEdit", "RichText"], { stdio: "ignore" });
    else execFileSync("defaults", ["write", "com.apple.TextEdit", "RichText", "-int", richText], { stdio: "ignore" });
  } catch {
    // Nothing to delete.
  }
}

// Approval dialogs would stall unattended runs, so the bench apps are allowed
// for the length of the run and the user's glovebox config is put back after.
const configFile = path.join(process.env.GLOVEBOX_HOME ?? path.join(os.homedir(), ".glovebox"), "config.json");
const savedConfig = fs.existsSync(configFile) ? fs.readFileSync(configFile, "utf8") : null;
function restoreConfig() {
  if (savedConfig == null) fs.rmSync(configFile, { force: true });
  else fs.writeFileSync(configFile, savedConfig);
}

let caffeinate = null;
function cleanUp() {
  restoreConfig();
  restoreTextEdit();
  closeOracle();
  caffeinate?.kill();
}
// Ctrl-C mid-run still restores the user's settings; the runs so far are on disk.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log(`\n${signal}: restoring settings. Continue later with --resume.`);
    cleanUp();
    process.exit(130);
  });
}

fs.mkdirSync(workDir, { recursive: true });
await buildFixture();
await sh(process.execPath, [path.join(repoDir, "bin", "glovebox.mjs"), "allow", ...new Set(TASKS.map((t) => t.app)), FIXTURE_BUNDLE_ID]);

try {
  if (opts["dry-run"]) await dryRun();
  else await benchmark();
} finally {
  cleanUp();
}

// No model calls: check that every task resets cleanly and starts unsolved,
// and that every setup starts and lists its tools.
async function dryRun() {
  for (const task of tasks) {
    await task.setup();
    const before = await task.verify();
    await task.teardown();
    console.log(`${before.ok ? "BAD " : "ok  "} ${task.id}: before the task, verify says ${before.ok ? "solved" : "unsolved"} (${before.detail})`);
  }
  for (const name of setupNames) await smoke(name);
}

async function smoke(name) {
  const setup = await SETUPS[name](tasks[0]);
  const tools = setup.tools.map((t) => t.name ?? t.type).join(", ");
  console.log(`ok   ${name}: ${setup.tools.length} tool entr${setup.tools.length === 1 ? "y" : "ies"} (${tools})`);
  setup.close();
}

function git(...args) {
  return execFileSync("git", ["-C", repoDir, ...args], { encoding: "utf8" }).trim();
}

function versions() {
  const lock = JSON.parse(fs.readFileSync(path.join(benchDir, "package-lock.json"), "utf8")).packages ?? {};
  const plist = (app, key) => {
    try {
      return execFileSync("plutil", ["-extract", key, "raw", path.join(app, "Contents", "Info.plist")], { encoding: "utf8" }).trim();
    } catch {
      return null;
    }
  };
  const cuaRepl = "/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/cua-repl/package.json";
  return {
    glovebox: JSON.parse(fs.readFileSync(path.join(repoDir, "package.json"), "utf8")).version,
    sdk: lock["node_modules/@anthropic-ai/sdk"]?.version ?? null,
    ocu: lock["node_modules/open-computer-use"]?.version ?? null,
    chatgpt: plist("/Applications/ChatGPT.app", "CFBundleShortVersionString"),
    cuaRepl: fs.existsSync(cuaRepl) ? JSON.parse(fs.readFileSync(cuaRepl, "utf8")).version : null,
    node: process.version,
  };
}

function runKey(r) {
  return `${r.setup}|${r.task}|${r.rep}`;
}

async function benchmark() {
  if (!PRICES[opts.model]) fail(`No price for ${opts.model}`);
  const sha = git("rev-parse", "--short", "HEAD");
  const dirty = git("status", "--porcelain", "--", "src", "native", "bin", "bench", ":!bench/results") !== "";
  if (dirty && !opts["allow-dirty"]) fail("glovebox or the harness has uncommitted changes; commit first so the SHA in the results means something, or pass --allow-dirty for a throwaway run");

  const rawDir = path.join(benchDir, "results", "raw");
  const transcriptDir = path.join(benchDir, "results", "transcripts");
  fs.mkdirSync(rawDir, { recursive: true });
  fs.mkdirSync(transcriptDir, { recursive: true });

  let outFile;
  let records = [];
  if (opts.resume) {
    outFile = path.resolve(opts.resume);
    const lines = readJsonLines(outFile);
    const header = lines.find((r) => r.type === "header");
    if (!header) fail(`${outFile} has no header record; it was written by an older harness`);
    if (header.sha !== sha || header.dirty !== dirty) fail(`${outFile} was recorded at ${header.sha}${header.dirty ? " (dirty)" : ""}; this checkout is ${sha}${dirty ? " (dirty)" : ""}`);
    if (header.model !== opts.model || header.effort !== opts.effort) fail(`${outFile} is ${header.model} ${header.effort}; pass the same --model and --effort`);
    records = lines.filter((r) => r.type !== "header");
  } else {
    const stamp = new Date().toISOString().slice(0, 10);
    outFile = path.join(rawDir, `${stamp}-${opts.model}-${opts.effort}${opts.label ? `-${opts.label}` : ""}.jsonl`);
    if (fs.existsSync(outFile)) fail(`${path.relative(process.cwd(), outFile)} exists; continue it with --resume, or pass --label for a new file`);
    const header = { type: "header", date: new Date().toISOString(), model: opts.model, effort: opts.effort, sha, dirty, versions: versions() };
    fs.writeFileSync(outFile, `${JSON.stringify(header)}\n`);
  }
  budget.spent = records.reduce((s, r) => s + (r.costUsd ?? 0), 0);
  const done = new Set(records.filter((r) => !r.infra).map(runKey));

  // Fail fast, before any spend: every setup must start.
  caffeinate = spawn("caffeinate", ["-dimsu", "-w", String(process.pid)], { stdio: "ignore" });
  console.log("Keep Do Not Disturb on and ChatGPT auto-update off for the length of the run.");
  for (const name of setupNames) await smoke(name);

  const infraStreak = new Map();
  const brokenStreak = new Map();
  const stopAfter = opts["stop-after-rep"] ? Number(opts["stop-after-rep"]) : null;

  for (let rep = 0; rep < n; rep++) {
    for (const task of tasks) {
      // Setups take turns on each task so drift over the session hits all of them.
      for (const setupName of setupNames) {
        if (done.has(runKey({ setup: setupName, task: task.id, rep }))) continue;
        const label = `[${rep + 1}/${n}] ${task.id} × ${setupName}`;
        // Stop while there is still room for this cell's expensive runs.
        const cellCosts = records.filter((r) => r.setup === setupName && r.task === task.id).map((r) => r.costUsd);
        const p90 = quantile(cellCosts, 0.9) ?? runCap / 3;
        if (budget.cap - budget.spent < 3 * p90) {
          console.log(`Stopping before ${label}: $${budget.spent.toFixed(2)} of $${budget.cap} spent, and this cell's runs cost up to $${p90.toFixed(3)}.`);
          return finish(outFile);
        }
        let record;
        for (let attempt = 1; attempt <= 2; attempt++) {
          record = await runOne(task, setupName, rep, Math.min(runCap, budget.cap - budget.spent), transcriptDir);
          fs.appendFileSync(outFile, `${JSON.stringify(record)}\n`);
          records.push(record);
          budget.spent += record.costUsd ?? 0;
          console.log(
            `${record.infra ? "INFRA" : record.success ? "PASS" : "FAIL"} ${label}: ${record.roundTrips ?? 0} round trips, $${record.costUsd ?? 0}, ${(record.wallMs / 1000).toFixed(0)} s` +
              (record.success ? "" : ` — ${record.error ?? record.detail}`),
          );
          if (!record.infra) break;
        }
        // A setup that keeps failing for reasons outside the task is broken;
        // stop instead of filling the file with failures.
        infraStreak.set(setupName, record.infra ? (infraStreak.get(setupName) ?? 0) + 1 : 0);
        const allErrors = record.toolCalls > 0 && record.toolErrors === record.toolCalls;
        brokenStreak.set(setupName, allErrors ? (brokenStreak.get(setupName) ?? 0) + 1 : 0);
        if (infraStreak.get(setupName) >= 3 || brokenStreak.get(setupName) >= 3) {
          console.log(`Stopping: ${setupName} failed three runs in a row on ${record.infra ? "infrastructure" : "every tool call"}. Fix it, then --resume.`);
          return finish(outFile);
        }
      }
    }
    if (stopAfter != null && rep + 1 === stopAfter && rep + 1 < n) {
      console.log(`Stopped after rep ${stopAfter} as asked. Review, then continue with --resume ${path.relative(process.cwd(), outFile)}`);
      return finish(outFile);
    }
  }
  finish(outFile);
}

function finish(outFile) {
  console.log(`$${budget.spent.toFixed(2)} spent in this file. Results: ${path.relative(process.cwd(), outFile)}`);
}

async function runOne(task, setupName, rep, cap, transcriptDir) {
  const base = { date: new Date().toISOString(), model: opts.model, effort: opts.effort, setup: setupName, task: task.id, kind: task.kind, rep };
  const infra = (error) => ({ ...base, infra: true, success: false, error, costUsd: 0, wallMs: 0 });
  try {
    await task.setup();
  } catch (e) {
    await task.teardown().catch(() => {});
    return infra(`task setup failed: ${e.message}`);
  }
  // A task that starts solved would pass for free.
  const before = await task.verify().catch((e) => ({ ok: true, detail: `verify failed: ${e.message}` }));
  if (before.ok) {
    await task.teardown().catch(() => {});
    return infra(`the task was already solved after setup (${before.detail})`);
  }
  let setup;
  try {
    setup = await SETUPS[setupName](task);
  } catch (e) {
    await task.teardown().catch(() => {});
    return infra(`tool server failed to start: ${e.message}`);
  }
  const started = Date.now();
  let agent;
  try {
    agent = await runAgent({ model: opts.model, effort: opts.effort, setup, prompt: task.prompt, followUps: task.followUps, maxTurns, runCap: cap });
  } catch (e) {
    agent = { usage: {}, turns: [], segments: [], finalText: "", stopReason: "harness-error", apiError: e.message, cost: 0 };
  }
  const wallMs = Date.now() - started;
  let check;
  try {
    check = await task.verify();
  } catch (e) {
    check = { ok: false, detail: `verify failed: ${e.message}`, broken: true };
  }
  setup.close();
  await task.teardown().catch(() => {});

  const summary = summarize(setupName, task, agent);
  const cheated = summary.sideDoors.length > 0;
  const isInfra = check.broken === true || ["api-error", "harness-error"].includes(agent.stopReason);
  const record = {
    ...base,
    infra: isInfra,
    success: !isInfra && check.ok && !cheated,
    detail: cheated ? `used a side door: ${summary.sideDoors.join(", ")}` : check.detail,
    error: agent.apiError ?? null,
    stopReason: agent.stopReason,
    finalText: agent.finalText?.slice(0, 300) ?? null,
    usage: agent.usage,
    costUsd: Number(agent.cost.toFixed(4)),
    wallMs,
    ...summary,
  };
  const name = `${record.date.replace(/[:.]/g, "-")}-${task.id}-${setupName}.json`;
  fs.writeFileSync(path.join(transcriptDir, name), JSON.stringify({ record, turns: agent.turns }, null, 1));
  return record;
}
