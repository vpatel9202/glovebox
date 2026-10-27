// Builds and launches "Glovebox Helper.app", the macOS backend.
//
// The helper is its own app bundle (not a child of the agent) so that macOS
// attributes Accessibility and Screen Recording to it. One grant then covers
// every agent and terminal on the machine.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { homeDir, VERSION } from "./config.mjs";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
export const HELPER_SOURCE = path.join(here, "..", "native", "macos", "GloveboxHelper.swift");
export const BUNDLE_ID = "io.github.vpatel9202.glovebox.helper";

export function appPath() {
  return path.join(homeDir(), "Glovebox Helper.app");
}

export function socketPath() {
  return process.env.GLOVEBOX_SOCKET || path.join(homeDir(), "helper.sock");
}

// Keyed on the helper source only: macOS ties privacy grants to the build,
// so the helper is rebuilt only when its own code changes.
function sourceHash() {
  return createHash("sha256").update(fs.readFileSync(HELPER_SOURCE)).digest("hex").slice(0, 16);
}

function stampPath() {
  return path.join(appPath(), "Contents", "Resources", "build-stamp");
}

export function isBuilt() {
  try {
    return fs.readFileSync(stampPath(), "utf8").trim() === sourceHash();
  } catch {
    return false;
  }
}

function infoPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleName</key><string>Glovebox Helper</string>
  <key>CFBundleDisplayName</key><string>Glovebox Helper</string>
  <key>CFBundleExecutable</key><string>glovebox-helper</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`;
}

// Compiles the helper with the Xcode command line tools and ad-hoc signs it.
// macOS ties privacy grants to the signature, so a rebuild may need a re-grant.
export async function build({ log = () => {} } = {}) {
  try {
    await run("xcrun", ["--find", "swiftc"]);
  } catch {
    throw new Error("swiftc not found. Install the Xcode command line tools: xcode-select --install");
  }
  const app = appPath();
  const macos = path.join(app, "Contents", "MacOS");
  const resources = path.join(app, "Contents", "Resources");
  fs.mkdirSync(macos, { recursive: true });
  fs.mkdirSync(resources, { recursive: true });
  fs.writeFileSync(path.join(app, "Contents", "Info.plist"), infoPlist());
  log("Compiling Glovebox Helper (about a minute)...");
  const binary = path.join(macos, "glovebox-helper");
  await run("xcrun", ["swiftc", "-O", "-swift-version", "5", HELPER_SOURCE, "-o", binary], {
    maxBuffer: 16 * 1024 * 1024,
  });
  await run("codesign", ["--force", "--sign", "-", "--identifier", BUNDLE_ID, app]);
  fs.writeFileSync(stampPath(), `${sourceHash()}\n`);
  log(`Built ${app}`);
  return app;
}

// Starts the helper through LaunchServices so it is its own responsible process.
export async function launch({ requestPermissions = false } = {}) {
  const args = ["-g", "-j", "-a", appPath()];
  for (const name of ["GLOVEBOX_HOME", "GLOVEBOX_APPROVAL", "GLOVEBOX_SOCKET"]) {
    if (process.env[name]) args.push("--env", `${name}=${process.env[name]}`);
  }
  if (requestPermissions) args.push("--args", "--request-permissions");
  await run("open", args);
}

export async function quit() {
  try {
    await run("pkill", ["-f", path.join(appPath(), "Contents", "MacOS", "glovebox-helper")]);
  } catch {
    // Not running.
  }
}
