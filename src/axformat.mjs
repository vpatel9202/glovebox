// Turns a backend's accessibility node list into compact text, and diffs it
// against the previous read so repeat reads cost a few lines, not a tree.
//
// Node shape from a backend: {i, d, role, subrole?, title?, value?, desc?,
// help?, placeholder?, id?, frame?: [x,y,w,h] screen points, actions?,
// focused?, selected?, disabled?, settable?}

const ROLE_NAMES = {
  AXStaticText: "text",
  AXTextField: "text field",
  AXTextArea: "text area",
  AXSecureTextField: "secure text field",
  AXButton: "button",
  AXCheckBox: "checkbox",
  AXRadioButton: "radio button",
  AXPopUpButton: "pop up button",
  AXMenuButton: "menu button",
  AXComboBox: "combo box",
  AXScrollArea: "scroll area",
  AXScrollBar: "scroll bar",
  AXSplitGroup: "split group",
  AXSplitter: "splitter",
  AXGroup: "group",
  AXWindow: "window",
  AXSheet: "sheet",
  AXToolbar: "toolbar",
  AXTabGroup: "tab group",
  AXTable: "table",
  AXOutline: "outline",
  AXRow: "row",
  AXColumn: "column",
  AXCell: "cell",
  AXList: "list",
  AXImage: "image",
  AXLink: "link",
  AXSlider: "slider",
  AXMenuBar: "menu bar",
  AXMenuBarItem: "menu bar item",
  AXMenu: "menu",
  AXMenuItem: "menu item",
  AXWebArea: "web area",
  AXHeading: "heading",
  AXProgressIndicator: "progress indicator",
  AXValueIndicator: "value indicator",
  AXDisclosureTriangle: "disclosure triangle",
  AXIncrementor: "stepper",
  AXLayoutArea: "layout area",
  AXUnknown: "element",
};

const SUBROLE_NAMES = {
  AXCloseButton: "close button",
  AXMinimizeButton: "minimize button",
  AXZoomButton: "zoom button",
  AXFullScreenButton: "full screen button",
  AXSearchField: "search field",
  AXStandardWindow: "window",
  AXDialog: "dialog",
  AXToggle: "toggle",
  AXSwitch: "switch",
  AXTabButton: "tab",
};

function roleName(node) {
  if (node.subrole && SUBROLE_NAMES[node.subrole]) return SUBROLE_NAMES[node.subrole];
  if (ROLE_NAMES[node.role]) return ROLE_NAMES[node.role];
  return node.role
    .replace(/^AX/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase();
}

function quote(text) {
  // Scroll positions and sliders report floats like 0.1851851791143417.
  if (/^-?\d+\.\d{4,}$/.test(text)) text = String(Number(Number(text).toFixed(3)));
  return JSON.stringify(text.replace(/\s+/g, " ").trim());
}

// Actions that are implied by the role or covered by click()/scroll().
const QUIET_ACTIONS = new Set([
  "AXPress",
  "AXRaise",
  "AXCancel",
  "AXConfirm",
  "AXScrollLeftByPage",
  "AXScrollRightByPage",
  "AXScrollUpByPage",
  "AXScrollDownByPage",
]);

function actionName(action) {
  return action.replace(/^AX/, "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

// One node as one line, without indentation. `toImage` maps a screen-point
// frame to image pixels when frames are requested.
export function nodeLine(node, { toImage } = {}) {
  const parts = [String(node.i), roleName(node)];
  const label = node.title ?? node.desc;
  if (label) parts.push(quote(label));
  if (node.title && node.desc && node.desc !== node.title) parts.push(`desc=${quote(node.desc)}`);
  if (node.value != null && node.value !== label) parts.push(`value=${quote(node.value)}`);
  if (node.placeholder) parts.push(`placeholder=${quote(node.placeholder)}`);
  if (node.id) parts.push(`id=${node.id}`);
  if (node.help && node.help !== label) parts.push(`help=${quote(node.help)}`);
  const flags = [];
  if (node.focused) flags.push("focused");
  if (node.selected) flags.push("selected");
  if (node.disabled) flags.push("disabled");
  if (node.settable && /text|combo|slider|search/.test(roleName(node))) flags.push("settable");
  if (flags.length) parts.push(`(${flags.join(", ")})`);
  const extra = (node.actions ?? []).filter((a) => !QUIET_ACTIONS.has(a) && !a.startsWith("Name:"));
  if (extra.length) parts.push(`actions: ${extra.map(actionName).join(", ")}`);
  if (toImage && node.frame) {
    const [x, y, w, h] = toImage(node.frame).map((v) => Math.round(v));
    parts.push(`@${x},${y} ${w}x${h}`);
  }
  return parts.join(" ");
}

export function formatTree(nodes, options = {}) {
  return nodes.map((node) => `${"\t".repeat(node.d)}${nodeLine(node, options)}`);
}

// Diffs two formatted trees keyed by element index. Lines are compared
// whole, so a change to any attribute (or depth) shows as "~".
export function diffTrees(previous, next) {
  const key = (line) => line.trimStart().split(" ", 1)[0];
  const before = new Map(previous.map((line) => [key(line), line]));
  const nextKeys = new Set();
  const out = [];
  for (const line of next) {
    const k = key(line);
    nextKeys.add(k);
    const old = before.get(k);
    if (old === undefined) out.push(`+${line}`);
    else if (old !== line) out.push(`~${line}`);
  }
  const removed = [...before.keys()].filter((k) => !nextKeys.has(k)).map(Number).sort((a, b) => a - b);
  if (removed.length) out.push(`- removed: ${ranges(removed)}`);
  return out;
}

function ranges(numbers) {
  const parts = [];
  let start = numbers[0];
  let prev = start;
  for (const n of numbers.slice(1).concat([NaN])) {
    if (n === prev + 1) {
      prev = n;
      continue;
    }
    parts.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = prev = n;
  }
  return parts.join(", ");
}
