#!/usr/bin/env node
// The version lives in five places. This keeps them together.
//
//   node scripts/release-version.mjs bump 0.4.0   set every place, date the changelog
//   node scripts/release-version.mjs check [v0.4.0]  fail unless all agree (and match the tag)
//   node scripts/release-version.mjs notes 0.4.0   print that version's changelog section
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = (p) => path.join(root, p);
const read = (p) => fs.readFileSync(file(p), "utf8");
const write = (p, s) => fs.writeFileSync(file(p), s);

const places = {
  "package.json": {
    get: (s) => JSON.parse(s).version,
    set: (s, v) => s.replace(/("version":\s*")[^"]+(")/, `$1${v}$2`),
  },
  "package-lock.json": {
    // The top-level version and the root package entry.
    get: (s) => {
      const j = JSON.parse(s);
      return j.version === j.packages?.[""]?.version ? j.version : `${j.version} / ${j.packages?.[""]?.version}`;
    },
    set: (s, v) => {
      const j = JSON.parse(s);
      j.version = v;
      if (j.packages?.[""]) j.packages[""].version = v;
      return `${JSON.stringify(j, null, 2)}\n`;
    },
  },
  "server.json": {
    get: (s) => {
      const j = JSON.parse(s);
      const pkg = j.packages?.[0]?.version;
      return j.version === pkg ? j.version : `${j.version} / ${pkg}`;
    },
    set: (s, v) => {
      const j = JSON.parse(s);
      j.version = v;
      for (const p of j.packages ?? []) p.version = v;
      return `${JSON.stringify(j, null, 2)}\n`;
    },
  },
  "src/config.mjs": {
    get: (s) => s.match(/export const VERSION = "([^"]+)"/)?.[1],
    set: (s, v) => s.replace(/(export const VERSION = ")[^"]+(")/, `$1${v}$2`),
  },
  "native/macos/GloveboxHelper.swift": {
    get: (s) => s.match(/let helperVersion = "([^"]+)"/)?.[1],
    set: (s, v) => s.replace(/(let helperVersion = ")[^"]+(")/, `$1${v}$2`),
  },
};

function changelogSection(version) {
  const lines = read("CHANGELOG.md").split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## ${version} `) || l === `## ${version}`);
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n").trim();
}

const [command, arg] = process.argv.slice(2);
const semver = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

if (command === "bump") {
  if (!semver.test(arg ?? "")) throw new Error("usage: bump X.Y.Z");
  for (const [p, place] of Object.entries(places)) write(p, place.set(read(p), arg));
  const today = new Date().toISOString().slice(0, 10);
  const log = read("CHANGELOG.md");
  if (!changelogSection(arg)) {
    if (!log.includes("## Unreleased")) throw new Error("CHANGELOG.md has no '## Unreleased' section to release");
    write("CHANGELOG.md", log.replace("## Unreleased", `## ${arg} (${today})`));
  }
  console.log(`Set ${arg} in ${Object.keys(places).join(", ")} and CHANGELOG.md.`);
  console.log(`Next: git commit -am "Release ${arg}: ..." && git tag v${arg} && git push origin main v${arg}`);
} else if (command === "check") {
  const found = Object.fromEntries(Object.entries(places).map(([p, place]) => [p, place.get(read(p))]));
  const versions = new Set(Object.values(found));
  const want = arg ? arg.replace(/^v/, "") : [...versions][0];
  const problems = Object.entries(found).filter(([, v]) => v !== want).map(([p, v]) => `${p} has ${v}, expected ${want}`);
  if (!changelogSection(want)) problems.push(`CHANGELOG.md has no "## ${want}" section`);
  if (problems.length) {
    console.error(`Version check failed:\n- ${problems.join("\n- ")}\nFix with: node scripts/release-version.mjs bump ${want}`);
    process.exit(1);
  }
  console.log(`All versions are ${want}.`);
} else if (command === "notes") {
  const notes = changelogSection(String(arg ?? "").replace(/^v/, ""));
  if (notes == null) throw new Error(`No changelog section for ${arg}`);
  console.log(notes);
} else {
  console.error("usage: release-version.mjs bump X.Y.Z | check [vX.Y.Z] | notes X.Y.Z");
  process.exit(2);
}
