#!/usr/bin/env node
// Runs benchmark tasks against each setup and appends one JSON line per run
// to bench/results/raw/. See bench/README.md.
//
//   node bench/run.mjs --dry-run
//   node bench/run.mjs --setups glovebox,cu,ocu --tasks all --n 1 --budget 10
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { BudgetError, PRICES, costOf, runAgent } from "./lib/agent.mjs";
import { FIXTURE_BUNDLE_ID, benchDir, buildFixture, closeOracle, repoDir, sh, workDir } from "./lib/env.mjs";
import { summarize } from "./lib/metrics.mjs";
import { SETUPS } from "./lib/setups.mjs";
import { TASKS } from "./lib/tasks.mjs";

const { values: opts } = parseArgs({
  options: {
    setups: { type: "string", default: "glovebox,cu,ocu" },
    tasks: { type: "string", default: "all" },
    n: { type: "string", default: "1" },
    model: { type: "string", default: "claude-sonnet-5-5" },
    effort: { type: "string", default: "medium" },
    budget: { type: "string", default: "10" },
    "max-turns": { type: "string", default: "40" },
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
const budget = { cap: Number(opts.budget), spent: 0 };

function fail(message) {
  throw new Error(message);
}

// TextEdit's default-format setting is changed by one task; put the user's
// value back when the run ends.
const richText = await sh("defaults", ["read", "com.apple.TextEdit", "RichText"]).catch(() => null);
async function restoreTextEdit() {
  if (richText == null) await sh("defaults", ["delete", "com.apple.TextEdit", "RichText"]).catch(() => {});
  else await sh("defaults", ["write", "com.apple.TextEdit", "RichText", "-int", richText]).catch(() => {});
}

// Approval dialogs would stall unattended runs, so the bench apps are allowed
// for the length of the run and the user's glovebox config is put back after.
const configFile = path.join(process.env.GLOVEBOX_HOME ?? path.join(os.homedir(), ".glovebox"), "config.json");
const savedConfig = fs.existsSync(configFile) ? fs.readFileSync(configFile, "utf8") : null;
function restoreConfig() {
  if (savedConfig == null) fs.rmSync(configFile, { force: true });
  else fs.writeFileSync(configFile, savedConfig);
}

fs.mkdirSync(workDir, { recursive: true });
await buildFixture();
await sh(process.execPath, [path.join(repoDir, "bin", "glovebox.mjs"), "allow", ...new Set(TASKS.map((t) => t.app)), FIXTURE_BUNDLE_ID]);

try {
  if (opts["dry-run"]) await dryRun();
  else await benchmark();
} finally {
  restoreConfig();
  await restoreTextEdit();
  closeOracle();
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
  for (const name of setupNames) {
    const setup = await SETUPS[name](tasks[0]);
    const tools = setup.tools.map((t) => t.name ?? t.type).join(", ");
    console.log(`ok   ${name}: ${setup.tools.length} tool entr${setup.tools.length === 1 ? "y" : "ies"} (${tools})`);
    setup.close();
  }
}

async function benchmark() {
  if (!PRICES[opts.model]) fail(`No price for ${opts.model}`);
  const stamp = new Date().toISOString().slice(0, 10);
  const rawDir = path.join(benchDir, "results", "raw");
  const transcriptDir = path.join(benchDir, "results", "transcripts");
  fs.mkdirSync(rawDir, { recursive: true });
  fs.mkdirSync(transcriptDir, { recursive: true });
  const outFile = path.join(rawDir, `${stamp}-${opts.model}-${opts.effort}.jsonl`);

  for (let rep = 0; rep < n; rep++) {
    for (const task of tasks) {
      // Setups take turns on each task so drift over the session hits all of them.
      for (const setupName of setupNames) {
        const label = `[${rep + 1}/${n}] ${task.id} × ${setupName}`;
        try {
          await task.setup();
        } catch (e) {
          console.log(`SKIP ${label}: setup failed (${e.message})`);
          await task.teardown().catch(() => {});
          continue;
        }
        // A task that starts solved would pass for free; skip the run instead.
        const before = await task.verify();
        if (before.ok) {
          console.log(`SKIP ${label}: the task was already solved after setup (${before.detail})`);
          await task.teardown();
          continue;
        }
        const setup = await SETUPS[setupName](task);
        const started = Date.now();
        let agent = null;
        let error = null;
        try {
          agent = await runAgent({
            model: opts.model,
            effort: opts.effort,
            setup,
            prompt: task.prompt,
            followUps: task.followUps,
            maxTurns: Number(opts["max-turns"]),
            budget,
          });
        } catch (e) {
          error = e;
          if (e instanceof BudgetError) agent = { usage: e.usage, turns: e.turns, segments: [], finalText: "", stopReason: "budget", cost: costOf(opts.model, e.usage) };
        }
        const wallMs = Date.now() - started;
        const check = await task.verify().catch((e) => ({ ok: false, detail: `verify failed: ${e.message}` }));
        setup.close();
        await task.teardown();

        const record = {
          date: new Date().toISOString(),
          model: opts.model,
          effort: opts.effort,
          setup: setupName,
          task: task.id,
          kind: task.kind,
          rep,
          success: check.ok && !error,
          detail: check.detail,
          error: error ? String(error.message) : null,
          stopReason: agent?.stopReason ?? null,
          finalText: agent?.finalText?.slice(0, 300) ?? null,
          usage: agent?.usage ?? null,
          costUsd: agent ? Number(agent.cost.toFixed(4)) : null,
          wallMs,
          ...(agent ? summarize(setupName, task, agent) : {}),
        };
        fs.appendFileSync(outFile, `${JSON.stringify(record)}\n`);
        if (agent) {
          budget.spent += agent.cost;
          const name = `${record.date.replace(/[:.]/g, "-")}-${task.id}-${setupName}.json`;
          fs.writeFileSync(path.join(transcriptDir, name), JSON.stringify({ record, turns: agent.turns }, null, 1));
        }
        console.log(
          `${record.success ? "PASS" : "FAIL"} ${label}: ${record.roundTrips ?? "?"} round trips, $${record.costUsd ?? "?"}, ${(wallMs / 1000).toFixed(0)} s` +
            (record.success ? "" : ` — ${record.error ?? record.detail}`),
        );
        if (error instanceof BudgetError) {
          console.log(`Stopping: ${error.message} ($${budget.spent.toFixed(2)} spent).`);
          return;
        }
      }
    }
  }
  console.log(`Done. $${budget.spent.toFixed(2)} spent. Results: ${path.relative(process.cwd(), outFile)}`);
}
