// Read the notifications on the Mac and on the phone, newest first, without acting on any. args: serial (optional), phoneOnly (true to skip the Mac)
const phone = await ui.device(args.serial).notifications({ emit: false });
const mac = args.phoneOnly ? [] : await ui.notifications();
const lines = [
  ...mac.map((n) => `Mac    ${n.app}: ${[n.title, n.body].filter(Boolean).join(" — ")}`),
  ...phone.map((n) => `Phone  ${n.app}: ${[n.title, n.text].filter(Boolean).join(" — ")}`),
];
console.log(lines.join("\n") || "No notifications.");
return { mac: mac.length, phone: phone.length };
