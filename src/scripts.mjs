// Saved scripts: a routine that worked once, kept as a file and run again by
// name, from any session or from the shell (`nostrings script <name>`), with
// no model in the loop. Files live in ~/.nostrings/scripts/<name>.js. The
// first line is a `// ` comment that describes the script. A script never runs
// by itself: only ui.scripts.run or `nostrings script` runs it.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { paths } from "./config.mjs";

const EXAMPLES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "examples");

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function scriptsDir() {
  return path.join(paths.home, "scripts");
}

function fileFor(name) {
  if (typeof name !== "string" || !NAME.test(name)) {
    throw new Error(`Script names use a-z, 0-9, - and _ (up to 64 characters), starting with a letter or digit; got ${JSON.stringify(name)}`);
  }
  return path.join(scriptsDir(), `${name}.js`);
}

export function listScripts() {
  const dir = scriptsDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".js") && NAME.test(f.slice(0, -3)))
    .sort()
    .map((f) => {
      const first = fs.readFileSync(path.join(dir, f), "utf8").split("\n", 1)[0];
      return { name: f.slice(0, -3), description: first.startsWith("// ") ? first.slice(3).trim() : "" };
    });
}

export function readScript(name) {
  const file = fileFor(name);
  if (!fs.existsSync(file)) {
    const known = listScripts().map((s) => s.name);
    throw new Error(`No saved script "${name}".${known.length ? ` Saved: ${known.join(", ")}` : " None saved yet; ui.scripts.save(name, code, description) saves one."}`);
  }
  return fs.readFileSync(file, "utf8");
}

export function saveScript(name, code, description = "") {
  if (typeof code !== "string" || !code.trim()) throw new Error("ui.scripts.save(name, code, description): code is the script's source as a string");
  const file = fileFor(name);
  const oneLine = String(description).replace(/\s+/g, " ").trim();
  const body = code.replace(/^\/\/ .*\n/, ""); // a saved script read back keeps one description line
  fs.mkdirSync(scriptsDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `// ${oneLine || name}\n${body.endsWith("\n") ? body : `${body}\n`}`, { mode: 0o600 });
  return file;
}

// Wraps a script's source as an async function of `args`, so its own
// declarations stay local and `return` hands back a value.
export function wrapScript(source) {
  return `(async (args) => {\n${source}\n})`;
}

// "a=1 b=x" style command-line pairs into an args object; numbers and
// true/false are converted, everything else stays a string.
export function parseArgPairs(pairs) {
  const args = {};
  for (const pair of pairs) {
    const at = pair.indexOf("=");
    if (at < 1) throw new Error(`Script arguments look like key=value; got ${JSON.stringify(pair)}`);
    const key = pair.slice(0, at);
    const raw = pair.slice(at + 1);
    args[key] = raw === "true" ? true : raw === "false" ? false : raw !== "" && !Number.isNaN(Number(raw)) ? Number(raw) : raw;
  }
  return args;
}

// Copies the example scripts that ship with nostrings into the user's scripts,
// leaving any script with the same name alone. Returns the names added.
export function installExamples() {
  fs.mkdirSync(scriptsDir(), { recursive: true, mode: 0o700 });
  const added = [];
  for (const f of fs.readdirSync(EXAMPLES).filter((f) => f.endsWith(".js")).sort()) {
    const dest = path.join(scriptsDir(), f);
    if (fs.existsSync(dest)) continue;
    fs.copyFileSync(path.join(EXAMPLES, f), dest);
    added.push(f.slice(0, -3));
  }
  return added;
}
