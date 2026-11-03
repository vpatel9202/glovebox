#!/usr/bin/env node
// Checks the harness's own cost records against Anthropic's usage data.
// Needs ANTHROPIC_ADMIN_KEY in bench/.env (gitignored); the key is never printed.
//
//   node bench/usage.mjs                      month to date: org billing, bench key vs harness records
//   node bench/usage.mjs --watch 5 --file <run.jsonl> --pid <run.mjs pid> --org-cap 90 --cycle-start 2026-10-10
//       every 5 minutes, compare the bench key's usage since the file began
//       with the file's records, and estimate the org's spend this billing
//       cycle. Send SIGINT to the run and exit 3 if the org's spend is within
//       $1 of the cap, or exit 4 if the API side is well ahead of the harness
//       or three checks in a row fail.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { PRICES } from "./lib/agent.mjs";
import { benchDir, readJsonLines } from "./lib/env.mjs";

const { values: opts } = parseArgs({
  options: {
    since: { type: "string" },
    watch: { type: "string" },
    file: { type: "string" },
    pid: { type: "string" },
    "org-cap": { type: "string" },
    "cycle-start": { type: "string" },
  },
});

const env = fs.readFileSync(path.join(benchDir, ".env"), "utf8");
const secret = (name) => process.env[name] ?? env.match(new RegExp(`^${name}=(.+)$`, "m"))?.[1].trim();
const adminKey = secret("ANTHROPIC_ADMIN_KEY");
const benchKey = secret("ANTHROPIC_API_KEY");
if (!adminKey) throw new Error("ANTHROPIC_ADMIN_KEY is not set in bench/.env");

// Retries rate limits, server errors, and network failures.
async function fetchJson(url, what) {
  for (let attempt = 1; ; attempt++) {
    let failure;
    try {
      const response = await fetch(url, { headers: { "x-api-key": adminKey, "anthropic-version": "2023-06-01" } });
      const body = await response.json();
      if (response.ok) return body;
      failure = new Error(`${response.status} ${what}: ${body.error?.message}`);
      if (response.status !== 429 && response.status < 500) throw Object.assign(failure, { final: true });
    } catch (error) {
      if (error.final) throw error;
      failure = error;
    }
    if (attempt === 3) throw failure;
    await new Promise((r) => setTimeout(r, attempt * 2000));
  }
}

// The cost report has no days to give for a range that starts today.
function costReport(since) {
  const today = `${new Date().toISOString().slice(0, 10)}T00:00:00Z`;
  return since >= today ? Promise.resolve([]) : get(`cost_report?starting_at=${since}&limit=31`);
}

async function get(pathAndQuery) {
  const out = [];
  let page = null;
  do {
    const url = `https://api.anthropic.com/v1/organizations/${pathAndQuery}${page ? `&page=${page}` : ""}`;
    const body = await fetchJson(url, pathAndQuery.split("?")[0]);
    if (!body.data) return body;
    out.push(...body.data);
    page = body.has_more ? body.next_page : null;
  } while (page);
  return out;
}

// The bench key's ID, matched on the last four characters the API shows.
async function benchKeyId() {
  const keys = await get("api_keys?limit=100");
  const names = new Map(keys.map((k) => [k.id, k.name]));
  const bench = keys.find((k) => k.status === "active" && k.partial_key_hint?.slice(-4) === benchKey?.slice(-4));
  return { id: bench?.id, names };
}

// Token totals per (key, model) from hourly buckets; daily buckets leave out today.
async function usageSince(since) {
  const buckets = await get(`usage_report/messages?starting_at=${since}&bucket_width=1h&limit=168&group_by[]=api_key_id&group_by[]=model`);
  const totals = new Map();
  for (const bucket of buckets) {
    for (const r of bucket.results) {
      const key = `${r.api_key_id ?? "console"}\t${r.model}`;
      const t = totals.get(key) ?? { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
      t.input += r.uncached_input_tokens;
      t.cacheWrite += r.cache_creation.ephemeral_5m_input_tokens + r.cache_creation.ephemeral_1h_input_tokens;
      t.cacheRead += r.cache_read_input_tokens;
      t.output += r.output_tokens;
      totals.set(key, t);
    }
  }
  return totals;
}

// Base list price; the Haiku long-prompt tier is not visible in usage data.
function listCost(model, t) {
  const p = PRICES[model];
  if (!p) return null;
  return (t.input * p.input + t.cacheWrite * p.cacheWrite + t.cacheRead * p.cacheRead + t.output * p.output) / 1e6;
}

// The org's spend since `cycleStart`: billed days from the cost report, plus
// usage after the last billed day at list price (the priciest model in
// PRICES for a model it lacks, so the estimate errs high).
async function orgSpend(cycleStart) {
  const today = `${new Date().toISOString().slice(0, 10)}T00:00:00Z`;
  const days = (await costReport(cycleStart)).filter((d) => d.results.length && d.ending_at <= today);
  const billed = days.flatMap((d) => d.results).reduce((s, r) => s + Number(r.amount) / 100, 0);
  const pricedFrom = days.at(-1)?.ending_at ?? cycleStart;
  const priciest = Object.keys(PRICES).sort((a, b) => PRICES[b].output - PRICES[a].output)[0];
  let recent = 0;
  for (const [key, t] of await usageSince(pricedFrom)) {
    const model = key.split("\t")[1];
    recent += listCost(model, t) ?? listCost(priciest, t);
  }
  return { billed, recent, pricedFrom };
}

function ledger(files, since) {
  const byModel = new Map();
  for (const file of files) {
    for (const r of readJsonLines(file)) {
      if (r.type === "header" || r.costUsd == null || r.date < since) continue;
      const t = byModel.get(r.model) ?? { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, cost: 0, runs: 0 };
      for (const k of ["input", "cacheWrite", "cacheRead", "output"]) t[k] += r.usage?.[k] ?? 0;
      t.cost += r.costUsd;
      t.runs += 1;
      byModel.set(r.model, t);
    }
  }
  return byModel;
}

const resultFiles = () =>
  fs
    .readdirSync(path.join(benchDir, "results"), { recursive: true })
    .filter((f) => /(^|\/)(raw[^/]*|\d{4}-\d\d-\d\d-[^/]*)\.jsonl$/.test(f) && !f.includes("field/"))
    .map((f) => path.join(benchDir, "results", f));

const usd = (n) => (n == null ? "?" : `$${n.toFixed(2)}`);
const k = (n) => `${(n / 1000).toFixed(0)}k`;

async function report() {
  const now = new Date();
  const since = opts.since ?? `${now.toISOString().slice(0, 8)}01T00:00:00Z`;
  const [{ id, names }, usage, costDays] = await Promise.all([
    benchKeyId(),
    usageSince(since),
    costReport(since),
  ]);

  // cost_report amounts are in cents.
  const billed = costDays.flatMap((d) => d.results).reduce((s, r) => s + Number(r.amount) / 100, 0);
  const lastDay = costDays.filter((d) => d.results.length).at(-1)?.starting_at.slice(0, 10) ?? "none";
  console.log(`Org billed since ${since.slice(0, 10)}: ${usd(billed)} (cost report, days through ${lastDay})`);
  if (opts["cycle-start"]) {
    const org = await orgSpend(`${opts["cycle-start"]}T00:00:00Z`);
    console.log(`Org this cycle: ${usd(org.billed + org.recent)} (${usd(org.billed)} billed, ${usd(org.recent)} since ${org.pricedFrom.slice(0, 10)} at list price)`);
  }

  console.log("\nUsage by key since then, at list price:");
  for (const [key, t] of [...usage].sort()) {
    const [keyId, model] = key.split("\t");
    const name = keyId === id ? `${names.get(keyId)} (bench)` : names.get(keyId) ?? keyId;
    console.log(`  ${name.padEnd(28)} ${model.padEnd(20)} out ${k(t.output).padStart(6)}  ${usd(listCost(model, t))}`);
  }

  const mine = ledger(resultFiles(), since);
  console.log("\nBench key, API usage vs harness records:");
  for (const [model, l] of mine) {
    const a = usage.get(`${id}\t${model}`) ?? { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
    const pct = (x, y) => (y ? `${(((x - y) / y) * 100).toFixed(1)}%` : "n/a");
    console.log(`  ${model}: ${l.runs} runs, harness ${usd(l.cost)}, API ${usd(listCost(model, a))}`);
    for (const f of ["input", "cacheWrite", "cacheRead", "output"]) {
      console.log(`    ${f.padEnd(10)} API ${k(a[f]).padStart(7)}  harness ${k(l[f]).padStart(7)}  diff ${pct(a[f], l[f])}`);
    }
  }
}

function stopRun(why, code) {
  console.log(`${why}; sending SIGINT to ${opts.pid ?? "(no pid)"}.`);
  if (opts.pid) process.kill(Number(opts.pid), "SIGINT");
  process.exit(code);
}

async function check(id) {
  // Only this session: the file's last header, since a resume adds one.
  const header = readJsonLines(opts.file).filter((r) => r.type === "header").at(-1);
  const since = new Date(header?.date ?? Date.now()).toISOString().slice(0, 13) + ":00:00Z";
  const usage = await usageSince(since);
  const mine = ledger([opts.file], since);
  let api = 0;
  let harness = 0;
  for (const [model, l] of mine) {
    harness += l.cost;
    api += listCost(model, usage.get(`${id}\t${model}`) ?? { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 }) ?? 0;
  }
  const stamp = new Date().toISOString().slice(11, 16);
  let line = `${stamp} bench key since ${since.slice(11, 16)}Z: API ${usd(api)}, harness ${usd(harness)}`;
  let stop = null;
  // API data lags the harness, so API ahead by much means the harness undercounts.
  if (api > harness * 1.2 + 0.5) stop = { code: 4, why: "API usage is ahead of the harness records" };
  if (opts["org-cap"]) {
    const cap = Number(opts["org-cap"]);
    const org = await orgSpend(`${opts["cycle-start"]}T00:00:00Z`);
    // Runs the usage data has not caught up with yet count too.
    const total = org.billed + org.recent + Math.max(0, harness - api);
    line += `; org this cycle ${usd(total)} of ${usd(cap)}`;
    if (total >= cap - 1) stop = { code: 3, why: `org spend ${usd(total)} is within $1 of the ${usd(cap)} cap` };
  }
  console.log(line);
  if (stop) stopRun(stop.why, stop.code);
}

async function watch() {
  const minutes = Number(opts.watch);
  if (!opts.file) throw new Error("--watch needs --file <run.jsonl>");
  let id = null;
  let failures = 0;
  for (;;) {
    try {
      id ??= (await benchKeyId()).id;
      await check(id);
      failures = 0;
    } catch (error) {
      // Never let a run go on unwatched: three failed checks in a row stop it.
      console.log(`Usage check failed: ${error.message}`);
      if (++failures === 3) stopRun("Three usage checks failed in a row", 4);
    }
    await new Promise((r) => setTimeout(r, minutes * 60_000));
  }
}

await (opts.watch ? watch() : report());
