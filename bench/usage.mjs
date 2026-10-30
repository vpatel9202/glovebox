#!/usr/bin/env node
// Checks the harness's own cost records against Anthropic's usage data.
// Needs ANTHROPIC_ADMIN_KEY in bench/.env (gitignored); the key is never printed.
//
//   node bench/usage.mjs                      month to date: org billing, bench key vs harness records
//   node bench/usage.mjs --watch 10 --file <run.jsonl> --pid <run.mjs pid>
//       every 10 minutes, compare the bench key's usage since the file began
//       with the file's records, and send SIGINT to the run if the API side
//       is well ahead of what the harness counted.
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
  },
});

const env = fs.readFileSync(path.join(benchDir, ".env"), "utf8");
const secret = (name) => process.env[name] ?? env.match(new RegExp(`^${name}=(.+)$`, "m"))?.[1].trim();
const adminKey = secret("ANTHROPIC_ADMIN_KEY");
const benchKey = secret("ANTHROPIC_API_KEY");
if (!adminKey) throw new Error("ANTHROPIC_ADMIN_KEY is not set in bench/.env");

async function get(pathAndQuery) {
  const out = [];
  let page = null;
  do {
    const url = `https://api.anthropic.com/v1/organizations/${pathAndQuery}${page ? `&page=${page}` : ""}`;
    const response = await fetch(url, { headers: { "x-api-key": adminKey, "anthropic-version": "2023-06-01" } });
    const body = await response.json();
    if (!response.ok) throw new Error(`${response.status} ${pathAndQuery.split("?")[0]}: ${body.error?.message}`);
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
    get(`cost_report?starting_at=${since}&limit=31`),
  ]);

  // cost_report amounts are in cents.
  const billed = costDays.flatMap((d) => d.results).reduce((s, r) => s + Number(r.amount) / 100, 0);
  const lastDay = costDays.filter((d) => d.results.length).at(-1)?.starting_at.slice(0, 10) ?? "none";
  console.log(`Org billed since ${since.slice(0, 10)}: ${usd(billed)} (cost report, days through ${lastDay})`);

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

async function watch() {
  const minutes = Number(opts.watch);
  if (!opts.file) throw new Error("--watch needs --file <run.jsonl>");
  const header = readJsonLines(opts.file).find((r) => r.type === "header");
  const since = new Date(new Date(header?.date ?? Date.now()).getTime() - 3600_000).toISOString().slice(0, 13) + ":00:00Z";
  const { id } = await benchKeyId();
  for (;;) {
    const usage = await usageSince(since);
    const mine = ledger([opts.file], "");
    let api = 0;
    let harness = 0;
    for (const [model, l] of mine) {
      harness += l.cost;
      api += listCost(model, usage.get(`${id}\t${model}`) ?? { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 }) ?? 0;
    }
    const stamp = new Date().toISOString().slice(11, 16);
    console.log(`${stamp} bench key since ${since.slice(11, 16)}Z: API ${usd(api)}, harness ${usd(harness)}`);
    // API data lags the harness, so API ahead by much means the harness undercounts.
    if (opts.pid && api > harness * 1.2 + 0.5) {
      console.log(`API usage is ahead of the harness records; sending SIGINT to ${opts.pid}.`);
      process.kill(Number(opts.pid), "SIGINT");
      return;
    }
    await new Promise((r) => setTimeout(r, minutes * 60_000));
  }
}

await (opts.watch ? watch() : report());
