// Open a link on the phone in the app that handles it, and print what it shows. args: url, serial (optional)
const phone = ui.device(args.serial);
const app = await phone.open(args.url ?? "https://en.wikipedia.org/wiki/Special:Random");
await app.settle();
await app.getAXState();
return app.name;
