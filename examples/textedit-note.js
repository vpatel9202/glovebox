// Start a new TextEdit document and type text into it, in the background. args: text
const editor = await ui.getApp("TextEdit");
await editor.menu(["File", "New"]);
await editor.expect({ role: "text area" });
const area = await editor.find({ role: "text area" });
await editor.click(area.index);
await editor.typeText(args.text ?? "Written by nostrings.\n");
return (await editor.text(area.index)).slice(0, 200);
