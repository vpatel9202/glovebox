// Work out an expression in Calculator and return the display. args: expr (e.g. "12*34")
const calc = await ui.getApp("Calculator");
await calc.pressKey("Escape");
await calc.typeText(`${args.expr ?? "6*7"}=`);
await calc.settle();
const display = await calc.find({ role: "text", label: "Edit field" });
return display?.value;
