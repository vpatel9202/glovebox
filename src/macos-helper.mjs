// Builds and launches "Glovebox Helper.app", the macOS backend.
//
// The helper is its own app bundle (not a child of the agent) so that macOS
// attributes Accessibility and Screen Recording to it. One grant then covers
// every agent and terminal on the machine.
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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

// macOS ties privacy grants to the helper's designated requirement. An ad-hoc
// signature's requirement is the binary's hash, so every rebuild loses the
// grants. Signing with a local certificate makes the requirement
// "identifier + certificate", which survives rebuilds. The certificate does not
// need to be trusted for this; it only needs to be the same one each time.
export const SIGNING_NAME = "glovebox local signing";

// SHA-1 of the local signing identity, or null. Untrusted identities count.
export async function signingIdentity() {
  try {
    const { stdout } = await run("security", ["find-identity", "-p", "codesigning"]);
    const line = stdout.split("\n").find((l) => l.includes(`"${SIGNING_NAME}"`));
    return line?.match(/\b([0-9A-F]{40})\b/)?.[1] ?? null;
  } catch {
    return null;
  }
}

// Creates the signing identity in the login keychain. Run only on the user's
// request (`glovebox signing --create`); it adds a key to their keychain.
export async function createSigningIdentity({ log = () => {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glovebox-signing-"));
  try {
    const key = path.join(dir, "key.pem");
    const cert = path.join(dir, "cert.pem");
    const p12 = path.join(dir, "identity.p12");
    const pass = randomBytes(16).toString("hex");
    await run("/usr/bin/openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-keyout", key, "-out", cert, "-days", "3650", "-nodes",
      "-subj", `/CN=${SIGNING_NAME}`,
      "-addext", "extendedKeyUsage=critical,codeSigning",
      "-addext", "keyUsage=critical,digitalSignature",
      "-addext", "basicConstraints=critical,CA:false",
    ]);
    await run("/usr/bin/openssl", ["pkcs12", "-export", "-inkey", key, "-in", cert, "-out", p12, "-passout", `pass:${pass}`, "-name", SIGNING_NAME]);
    // -T lets codesign use the key without a keychain prompt on every build.
    await run("security", ["import", p12, "-k", path.join(os.homedir(), "Library", "Keychains", "login.keychain-db"), "-P", pass, "-T", "/usr/bin/codesign"]);
    log(`Created "${SIGNING_NAME}" in your login keychain.`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Compiles the helper with the Xcode command line tools and signs it with the
// local signing identity when there is one, else ad hoc.
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
  const identity = await signingIdentity();
  await run("codesign", ["--force", "--sign", identity ?? "-", "--identifier", BUNDLE_ID, app]);
  log(identity ? `Signed with "${SIGNING_NAME}"; permission grants survive rebuilds.` : "Signed ad hoc; a rebuild will need permissions granted again (see: glovebox signing).");
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

// Stops the helper and waits for it to exit, so the next client does not
// connect to a process that is shutting down.
export async function quit() {
  const pattern = path.join(appPath(), "Contents", "MacOS", "glovebox-helper");
  try {
    await run("pkill", ["-f", pattern]);
  } catch {
    return; // Not running.
  }
  for (let i = 0; i < 50; i++) {
    try {
      await run("pgrep", ["-f", pattern]);
    } catch {
      break; // Gone.
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  fs.rmSync(socketPath(), { force: true });
}
