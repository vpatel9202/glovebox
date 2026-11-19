// Builds and starts Nostrings Fixture.app (native/macos/fixture), the test app
// `nostrings smoke --macos` drives. It is signed ad hoc: it needs no grants.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { paths } from "./config.mjs";

const run = promisify(execFile);
export const FIXTURE_SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "native", "macos", "fixture", "NostringsFixture.swift");
export const FIXTURE_BUNDLE_ID = "io.github.vpatel9202.nostrings.fixture";
export const FIXTURE_NAME = "Nostrings Fixture";

export function fixturePath() {
  return path.join(paths.home, `${FIXTURE_NAME}.app`);
}

export function fixtureLog() {
  return path.join(paths.home, "fixture.log");
}

function sourceHash() {
  return createHash("sha256").update(fs.readFileSync(FIXTURE_SOURCE)).digest("hex");
}

function stamp() {
  // Outside the bundle: a file inside it would break the signature.
  return path.join(paths.home, "fixture.sha256");
}

export function isFixtureBuilt() {
  try {
    return fs.readFileSync(stamp(), "utf8").trim() === sourceHash();
  } catch {
    return false;
  }
}

export async function buildFixture({ log = () => {} } = {}) {
  if (isFixtureBuilt()) return fixturePath();
  const app = fixturePath();
  fs.rmSync(path.join(app, "Contents", "source.sha256"), { force: true });
  const macos = path.join(app, "Contents", "MacOS");
  fs.mkdirSync(macos, { recursive: true });
  fs.writeFileSync(
    path.join(app, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${FIXTURE_BUNDLE_ID}</string>
<key>CFBundleName</key><string>${FIXTURE_NAME}</string>
<key>CFBundleDisplayName</key><string>${FIXTURE_NAME}</string>
<key>CFBundleExecutable</key><string>nostrings-fixture</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSPrincipalClass</key><string>NSApplication</string>
</dict></plist>
`,
  );
  log("Compiling Nostrings Fixture (about a minute)...");
  await run("xcrun", ["swiftc", "-O", "-swift-version", "5", FIXTURE_SOURCE, "-o", path.join(macos, "nostrings-fixture")], { maxBuffer: 16 * 1024 * 1024 });
  await run("codesign", ["--force", "--sign", "-", "--identifier", FIXTURE_BUNDLE_ID, app]);
  fs.writeFileSync(stamp(), `${sourceHash()}\n`);
  // LaunchServices must see the new build before `open -b` can find it.
  await run("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", ["-f", app]).catch(() => {});
  return app;
}

// Starts the fixture without bringing it forward; a fresh log each time.
export async function launchFixture() {
  fs.rmSync(fixtureLog(), { force: true });
  await run("pkill", ["-f", path.join(fixturePath(), "Contents", "MacOS")]).catch(() => {});
  await new Promise((r) => setTimeout(r, 300));
  await run("open", ["-g", "-n", fixturePath()]);
  for (let i = 0; i < 50; i++) {
    if (readFixtureLog().some((e) => e.event === "launched")) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Nostrings Fixture did not start");
}

export function readFixtureLog() {
  try {
    return fs
      .readFileSync(fixtureLog(), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

export async function quitFixture() {
  await run("pkill", ["-f", path.join(fixturePath(), "Contents", "MacOS")]).catch(() => {});
}
