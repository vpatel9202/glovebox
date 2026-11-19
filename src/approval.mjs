// Approval for device apps (Android). The same config as the macOS helper
// (approval mode, allow, deny), with one difference: nothing is blocked
// outright. Apps and screens that hold money, messages, codes or system
// control are "ask first": they prompt even under allow-all, and the user
// decides. The prompt is a native dialog on the host.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadConfig, paths, writeUserConfig, readUserConfig } from "./config.mjs";

const execFileAsync = promisify(execFile);

// Packages that always ask (unless on `allow`). Matched exactly, or by prefix
// for entries ending in "." or ":".
export const ASK_FIRST = [
  // Purchases, installs, permissions, accounts and passkeys
  "com.android.vending",
  "com.android.permissioncontroller",
  "com.google.android.permissioncontroller",
  "com.android.packageinstaller",
  "com.google.android.packageinstaller",
  "com.google.android.gms",
  "com.android.credentialmanager",
  // System control
  "com.android.settings",
  "com.samsung.android.settings",
  "com.android.systemui",
  "moe.shizuku.privileged.api",
  // Messages, calls and codes
  "com.google.android.apps.messaging",
  "com.samsung.android.messaging",
  "com.android.mms",
  "com.google.android.dialer",
  "com.samsung.android.dialer",
  "com.android.phone",
  "com.google.android.apps.authenticator2",
  "com.azure.authenticator",
  "com.authy.authy",
  // Reading the notification shade (messages and one-time codes show there)
  "android:notifications",
  // Copying a file from this computer to the phone ("file:<path>")
  "file:",
  // Wallets and password managers
  "com.google.android.apps.walletnfcrel",
  "com.samsung.android.spay",
  "com.samsung.android.samsungpass",
  "com.onepassword.android",
  "com.x8bit.bitwarden",
  "com.lastpass.lastpass",
  "com.dashlane",
];

export function isAskFirst(pkg) {
  const id = String(pkg).toLowerCase();
  return ASK_FIRST.some((entry) => (entry.endsWith(".") || entry.endsWith(":") ? id.startsWith(entry) : id === entry));
}

function matches(list, pkg, name) {
  const id = String(pkg).toLowerCase();
  const n = String(name ?? "").toLowerCase();
  return (list ?? []).some((entry) => {
    const e = String(entry).toLowerCase();
    return e === id || (n && e === n);
  });
}

function coded(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function escapeAppleScript(text) {
  return String(text).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// "session" | "always" | "deny". On macOS a dialog; on Linux zenity if
// present; otherwise there is no one to ask, and the caller gets
// needs_approval with the command that approves.
export async function defaultPrompt({ client, title, detail }) {
  if (process.platform === "darwin") {
    const script =
      `display dialog "${escapeAppleScript(detail)}" with title "${escapeAppleScript(title)}" ` +
      `buttons {"Deny", "Always Allow", "Allow for This Session"} default button "Allow for This Session" ` +
      `cancel button "Deny" with icon caution giving up after 120`;
    try {
      const { stdout } = await execFileAsync("osascript", ["-e", script], { timeout: 125_000 });
      if (/gave up:true/.test(stdout)) return "deny";
      if (/Always Allow/.test(stdout)) return "always";
      if (/Allow for This Session/.test(stdout)) return "session";
      return "deny";
    } catch {
      return "deny"; // Deny is the cancel button; a failed dialog denies too
    }
  }
  try {
    await execFileAsync("zenity", ["--question", `--title=${title}`, `--text=${detail}`, "--ok-label=Allow for This Session", "--cancel-label=Deny", "--timeout=120"], { timeout: 125_000 });
    return "session";
  } catch (error) {
    if (error.code === "ENOENT") return null;
    return "deny";
  }
}

// Throws a coded error unless `pkg` may be acted on now. `approved` is the
// session's set of approved packages (and "locked:<device>" grants).
export async function authorize({ pkg, name, client, device, approved, reason, prompt = defaultPrompt, config = loadConfig() }) {
  if (approved.has(pkg)) return;
  const label = name && name !== pkg ? `${name} (${pkg})` : pkg;
  if (matches(config.deny, pkg, name)) throw coded(`${label} is on the deny list in ${paths.config}.`, "denied");
  if (matches(config.allow, pkg, name)) {
    approved.add(pkg);
    return;
  }
  const askFirst = isAskFirst(pkg);
  if (!askFirst && config.approval === "allow-all") {
    approved.add(pkg);
    return;
  }
  if (!askFirst && config.approval === "allowlist") {
    throw coded(`${label} is not in the allowlist. Run: glovebox allow ${pkg}`, "not_allowed");
  }
  const why = reason ?? (askFirst ? `${name ?? pkg} can move money, read messages or codes, or change the phone's settings.` : "");
  const answer = await prompt({
    client,
    title: "glovebox",
    detail: `Allow ${client} to control ${label} on ${device}?\n\n${why ? `${why}\n\n` : ""}Every action is logged in ${paths.log}.`,
  });
  if (answer === null) {
    throw coded(`${label} needs approval and there is no dialog on this host. Ask the user, then run: glovebox allow ${pkg}`, "needs_approval");
  }
  if (answer === "deny") throw coded(`The user denied access to ${label}.`, "denied");
  approved.add(pkg);
  if (answer === "always") {
    const allow = readUserConfig().allow ?? [];
    if (!allow.some((e) => String(e).toLowerCase() === pkg.toLowerCase())) writeUserConfig({ allow: [...allow, pkg] });
  }
}

// Acting on a locked phone reaches past its lock screen, so it asks once per
// session, whatever the app.
export async function authorizeLocked({ device, client, approved, prompt = defaultPrompt }) {
  const key = `locked:${device}`;
  if (approved.has(key)) return;
  const answer = await prompt({
    client,
    title: "glovebox",
    detail: `${device} is locked. Allow ${client} to act on it anyway?\n\nThis reaches apps behind the lock screen.`,
  });
  if (answer === null) throw coded(`${device} is locked and there is no dialog on this host. Unlock it, or ask the user.`, "needs_approval");
  if (answer === "deny") throw coded(`The user declined acting on ${device} while it is locked.`, "denied");
  approved.add(key);
}
