// Shared helpers for task setup and verification. Everything here is the
// harness's own oracle: it never goes through the tool under test.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Session } from "../../src/session.mjs";

const run = promisify(execFile);

export const benchDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const repoDir = path.dirname(benchDir);
export const workDir = path.join(os.homedir(), "glovebox-bench");
export const fixtureApp = path.join(benchDir, ".build", "Bench Fixture.app");
export const FIXTURE_BUNDLE_ID = "dev.glovebox.bench-fixture";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function sh(file, args, options = {}) {
  const { stdout } = await run(file, args, { maxBuffer: 16 << 20, ...options });
  return stdout.trim();
}

export function osascript(script) {
  return sh("osascript", ["-e", script]);
}

export async function quitApp(name) {
  await osascript(`if application "${name}" is running then tell application "${name}" to quit`).catch(() => {});
  for (let i = 0; i < 30; i++) {
    const running = await osascript(`application "${name}" is running`).catch(() => "false");
    if (running !== "true") return;
    await sleep(100);
  }
}

// Closes only the documents the benchmark opened, so the user's own TextEdit
// work is never discarded, and quits TextEdit only if nothing else is open.
export async function closeBenchTextEdit() {
  await osascript(`
    if application "TextEdit" is running then
      tell application "TextEdit"
        repeat with d in (every document)
          try
            if (path of d as text) contains "${workDir}" then close d saving no
          end try
        end repeat
        if (count of documents) is 0 then quit
      end tell
    end if`).catch(() => {});
  await sleep(500);
}

export async function closeFinderWindow(name) {
  await osascript(`tell application "Finder" to close (every window whose name is "${name}")`).catch(() => {});
}

export async function quitFixture() {
  await sh("pkill", ["-f", "Bench Fixture.app/Contents/MacOS/BenchFixture"]).catch(() => {});
  await sleep(300);
}

export async function launchFixture(mode, out) {
  await quitFixture();
  fs.rmSync(out, { force: true });
  fs.writeFileSync(path.join(workDir, "fixture.json"), JSON.stringify({ mode, out }));
  await sh("open", [fixtureApp, "--args", "--mode", mode, "--out", out]);
  await waitFor(async () => (await osascript(`application id "${FIXTURE_BUNDLE_ID}" is running`).catch(() => "false")) === "true");
  await sleep(800);
}

export async function waitFor(check, { timeoutMs = 10_000, everyMs = 200 } = {}) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return true;
    await sleep(everyMs);
  }
  return false;
}

// Builds the fixture app bundle when the Swift source is newer than the binary.
export async function buildFixture() {
  const source = path.join(benchDir, "fixture", "BenchFixture.swift");
  const binary = path.join(fixtureApp, "Contents", "MacOS", "BenchFixture");
  if (fs.existsSync(binary) && fs.statSync(binary).mtimeMs >= fs.statSync(source).mtimeMs) return;
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(
    path.join(fixtureApp, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>${FIXTURE_BUNDLE_ID}</string>
  <key>CFBundleName</key><string>Bench Fixture</string>
  <key>CFBundleExecutable</key><string>BenchFixture</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
</dict></plist>
`,
  );
  await sh("swiftc", ["-O", "-o", binary, source]);
  await sh("codesign", ["--force", "--sign", "-", fixtureApp]);
}

// A glovebox session used only to read state for verification (Calculator's
// display has no scriptable value). Its reads are {emit: false}.
let oracle = null;
export async function oracleRead(appName) {
  oracle ??= new Session({ client: "glovebox bench oracle" });
  const result = await oracle.run(
    `const __app = await gb.getApp(${JSON.stringify(appName)}); await __app.getAXState({emit: false, disableDiffing: true});`,
    { timeoutMs: 20_000 },
  );
  return result.content.map((c) => c.text ?? "").join("\n");
}

// Sends keys through the oracle session, for resets the app can't script.
export async function oracleKeys(appName, keys) {
  oracle ??= new Session({ client: "glovebox bench oracle" });
  const result = await oracle.run(`const __k = await gb.getApp(${JSON.stringify(appName)}); await __k.pressKey(${JSON.stringify(keys)}); undefined;`, {
    timeoutMs: 20_000,
  });
  if (!result.ok) throw new Error(result.content.map((c) => c.text ?? "").join("\n"));
}

export function closeOracle() {
  oracle?.close();
  oracle = null;
}

export function readJsonLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
