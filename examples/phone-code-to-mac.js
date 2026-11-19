// Wait for a one-time code to arrive on the phone, then type it into a Mac app's focused field. args: app (Mac app name), timeout (seconds, default 60), serial (optional)
const phone = ui.device(args.serial);
const mac = await ui.getApp(args.app ?? "Safari");
const deadline = Date.now() + (args.timeout ?? 60) * 1000;
const seen = new Set((await phone.notifications({ emit: false })).map((n) => `${n.app}|${n.when}`));
let code = null;
while (!code && Date.now() < deadline) {
  await sleep(2000);
  for (const n of await phone.notifications({ emit: false })) {
    if (seen.has(`${n.app}|${n.when}`)) continue;
    const match = `${n.title ?? ""} ${n.text ?? ""}`.match(/\b(\d{4,8})\b/);
    if (match) {
      code = match[1];
      break;
    }
  }
}
if (!code) return `No new code on ${args.serial ?? "the phone"} within ${args.timeout ?? 60} seconds.`;
await mac.typeText(code);
return `Typed a ${code.length}-digit code into ${mac.name}.`;
