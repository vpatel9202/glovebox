// The scripting surface: `gb` (alias `cua`) and the App handles it returns.
//
// Every action goes through ctx, which owns output, the abort flag, and the
// audit log. Reads (getAXState, getScreenshot) emit into the result by
// default; pass {emit: false} to only get the return value.
import { diffTrees, formatTree, nodeRecord, outlineTree } from "./axformat.mjs";
import { center, toImage, toScreen, viewFor } from "./geometry.mjs";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { parseKeys } from "./keys.mjs";

const execFileAsync = promisify(execFile);

// Roles where pressing through accessibility is the same as a click and
// works without bringing the app to the front.
const PRESSABLE = new Set([
  "AXButton",
  "AXCheckBox",
  "AXRadioButton",
  "AXMenuItem",
  "AXMenuBarItem",
  "AXLink",
  "AXDisclosureTriangle",
  "AXPopUpButton",
  "AXMenuButton",
]);

function isPoint(value) {
  return Array.isArray(value) && value.length === 2 && value.every(Number.isFinite);
}

function describeTarget(target) {
  return isPoint(target) ? `[${target.map((v) => Math.round(v)).join(", ")}]` : `#${target}`;
}

// A window an agent means to work in: capturable and bigger than a tooltip,
// a popover, or Finder's rename field editor.
function isNormalWindow(w) {
  return w.windowId != null && !w.minimized && w.frame[2] >= 160 && w.frame[3] >= 100;
}

function area(w) {
  return w.frame[2] * w.frame[3];
}

// Default read and click target: the focused window if it is a normal one (a
// new document or settings window), else the window last used, else the main
// window, else the largest normal one. Small focused windows never win, so a
// tooltip or field editor can't take over the reads.
export function pickWindow(windows, last) {
  const sticky = last?.windowId != null ? windows.find((w) => w.windowId === last.windowId) : undefined;
  if (last?.explicit && sticky) return sticky;
  const largest = [...windows].sort((a, b) => area(b) - area(a));
  return (
    windows.find((w) => w.focused && isNormalWindow(w)) ??
    sticky ??
    windows.find((w) => w.main && isNormalWindow(w)) ??
    largest.find(isNormalWindow) ??
    largest.find((w) => w.windowId != null) ??
    largest[0]
  );
}

function hashImage(data) {
  return createHash("sha1").update(data).digest("hex");
}

export class App {
  #ctx;
  #backend;
  #view = null;
  #explicitWindow = false;
  #lastTrees = new Map(); // window id -> {lines, base, frames}: what the model last saw
  // What waitForChange compares against: the last printed read (or the state a
  // previous wait settled on), as {pixels, value, format, quality}.
  #waitBase = null;
  #activatedCell = -1;
  #opened = false; // Android: opened on its screen at least once this session
  #knownWindows = null; // macOS: window ids at the last read, for open/close notices
  #notice = "";

  // `backend` is the host's (ctx.backend) or a device's; `pid` is whatever
  // handle that backend gave the app (a number on macOS, a package on Android).
  constructor(ctx, info, backend = ctx.backend) {
    this.#ctx = ctx;
    this.#backend = backend;
    this.platform = backend.platform ?? null;
    this.name = info.name;
    this.bundleId = info.bundleId;
    this.pid = info.pid;
    // true: always bring this app forward for input (see #useBackground).
    this.foreground = false;
    // How the last input reached the app: accessibility, background, or foreground.
    this.lastRoute = null;
  }

  toString() {
    return `App(${this.name}, pid ${this.pid})`;
  }

  [Symbol.for("nodejs.util.inspect.custom")]() {
    return this.toString();
  }

  get view() {
    return this.#view;
  }

  // Android: which screen this handle works on. "hidden" is a private
  // display only glovebox sees (Android 14+); "phone" is the phone's own
  // screen, chosen with getApp(name, {foreground: true}) or the
  // `androidScreen: "phone"` setting.
  get screen() {
    if (this.platform !== "android") return null;
    if (this.foreground || this.#ctx.config.androidScreen === "phone" || !this.#backend.info?.hiddenScreen) return "phone";
    return "hidden";
  }

  async #call(method, params = {}) {
    this.#ctx.checkAbort();
    const screen = this.platform === "android" ? { screen: this.screen } : {};
    try {
      const result = await this.#backend.request(method, { pid: this.pid, ...screen, ...params });
      if (method === "activate") this.#opened = true;
      return result;
    } catch (error) {
      // A hidden screen is the agent's own: the first read or action of a
      // handle opens the app there, rather than failing with not_visible.
      // An app that closed after that still fails, so the change is noticed.
      if (error.code !== "not_visible" || method === "activate" || this.#opened || this.screen !== "hidden") throw error;
      this.#opened = true;
      this.#ctx.log({ app: this.bundleId ?? this.name, action: "open", screen: "hidden" });
      await this.#backend.request("activate", { pid: this.pid, ...screen });
      return this.#backend.request(method, { pid: this.pid, ...screen, ...params });
    }
  }

  async #act(action, detail, fn) {
    this.#ctx.checkAbort();
    const device = this.platform === "android" ? { device: this.#backend.label } : {};
    this.#ctx.log({ app: this.bundleId ?? this.name, action, ...device, ...detail });
    const result = await fn();
    await this.#ctx.settle();
    // Android UI animates most changes; a read right after an action would
    // catch it halfway. Wait until the app has been quiet (no accessibility
    // events) for a moment, up to 1.5 s; a fixed androidSettleMs overrides.
    if (this.platform === "android") {
      const fixed = this.#ctx.config.androidSettleMs;
      if (fixed != null) await new Promise((r) => setTimeout(r, fixed));
      else await this.#call("waitQuiet", { quiet: 150, max: 1500 }).catch(() => new Promise((r) => setTimeout(r, 300)));
    }
    return result;
  }

  async windows() {
    const list = await this.#call("windows");
    return list.map((w) => ({ ...w, view: viewFor(w, this.#ctx.config.screenshot) }));
  }

  // Refreshes the view for the target window. Keeps the scale from the last
  // read when the window size has not changed, so earlier coordinates stay valid.
  async #refreshView(window) {
    const windows = await this.#call("windows");
    if (windows.length === 0) {
      // Without Accessibility every app looks windowless; say which it is.
      const { accessibility } = await this.#backend.request("permissions", {});
      if (!accessibility) throw new Error("Accessibility permission is missing for the glovebox helper. Run: glovebox doctor");
      if (this.platform !== "macos") throw new Error(`${this.name} has no open windows`);
      // A windowless app (the Dock, a menu bar app, an app whose last window
      // closed): reads show what it has outside windows, in the main
      // display's space.
      const [display] = await this.#backend.request("displays");
      const next = viewFor({ index: -1, title: "(no window)", frame: display.frame, scale: display.scale }, this.#ctx.config.screenshot);
      next.note = " (the app has no windows; this is what it shows outside them, in screen space)";
      next.windowless = true;
      this.#view = next;
      this.#knownWindows = new Map();
      return next;
    }
    this.#noteWindows(windows);
    const pick =
      window != null
        ? windows.find((w) => w.index === window)
        : pickWindow(windows, this.#view && { windowId: this.#view.windowId, explicit: this.#explicitWindow });
    if (!pick) throw new Error(`${this.name} has no window ${window}`);
    if (window != null) this.#explicitWindow = true;
    else if (pick.windowId !== this.#view?.windowId) this.#explicitWindow = false;
    const next = viewFor(pick, this.#ctx.config.screenshot);
    // Said once in a header when the target is a tooltip-sized or uncapturable window.
    next.note =
      !isNormalWindow(pick) && windows.some(isNormalWindow)
        ? ` (a small or uncapturable window; pass {window: ${windows.find(isNormalWindow).index}} for the main one)`
        : "";
    this.#view = next;
    return next;
  }

  async #ensureView() {
    return this.#refreshView(undefined);
  }

  // One line, shown on the next read, when windows opened or closed since the
  // last one: a dialog or a new document window is easy to miss in a diff.
  #noteWindows(windows) {
    if (this.platform !== "macos") return;
    const now = new Map(windows.filter((w) => w.windowId != null).map((w) => [w.windowId, w]));
    if (this.#knownWindows) {
      const opened = [...now.values()].filter((w) => !this.#knownWindows.has(w.windowId));
      const closed = [...this.#knownWindows.values()].filter((w) => !now.has(w.windowId));
      const parts = [
        ...opened.map((w) => `window ${w.index} "${w.title}" opened${w.subrole && w.subrole !== "AXStandardWindow" ? ` (${w.subrole.replace(/^AX/, "")})` : ""}`),
        ...closed.map((w) => `"${w.title}" closed`),
      ];
      if (parts.length) this.#notice += `\n(windows: ${parts.join("; ")})`;
    }
    this.#knownWindows = now;
  }

  async getAXState(options = {}) {
    const { disableDiffing = false, frames = false, menus = false, window, emit = true } = options;
    const ax = this.#ctx.config.ax;
    const view = await this.#refreshView(window);
    const tree = await this.#call("axTree", {
      window: view.window,
      maxNodes: options.maxNodes ?? ax.maxNodes,
      maxDepth: options.maxDepth ?? ax.maxDepth,
      maxText: ax.maxTextLength,
      menus,
      keyboard: options.keyboard === true,
    });
    // `base` has no frames, so a plain read after a {frames: true} read still
    // diffs. Element indices are stable ids, so the baseline is kept per window
    // (not per list position or title) and diffs across title changes.
    // Large trees print as an outline (offscreen elements dropped, deep
    // levels folded); find() and nodes() still see everything.
    const outline = options.full ? { nodes: tree.nodes, folded: new Map(), offscreen: 0, deeper: 0 } : outlineTree(tree.nodes, { limit: ax.outlineAbove ?? 250, bounds: [...view.origin, ...view.size] });
    const fold = (list) => list.map((line, k) => (outline.folded.has(outline.nodes[k].i) ? `${line} (+${outline.folded.get(outline.nodes[k].i)} inside)` : line));
    const base = fold(formatTree(outline.nodes));
    const lines = frames ? fold(formatTree(outline.nodes, { toImage: (f) => toImage(view, f) })) : base;
    const key = tree.window.windowId ?? view.windowId ?? `#${view.window}`;
    const header = `${this.name} — window ${view.window} "${tree.window.title}" — image ${view.width}x${view.height}${view.note ?? ""}`;
    const last = disableDiffing ? undefined : this.#lastTrees.get(key);
    let text;
    // A first {frames: true} read prints in full: the frames are what was asked for.
    if (last && (!frames || last.frames)) {
      const diff = frames ? diffTrees(last.lines, lines) : diffTrees(last.base, base);
      text = diff.length ? `${header} — changes since last read (~ changed, + added):\n${diff.join("\n")}` : `${header} — no change.`;
    } else {
      text = `${header}\n${lines.join("\n")}`;
    }
    if (tree.truncated) text += `\n(truncated at ${tree.nodes.length} elements; pass {maxNodes} to see more)`;
    if (emit && this.#notice) {
      text += this.#notice;
      this.#notice = "";
    }
    // Once, on a full read: a diff of a near-empty tree needs no reminder.
    if (tree.nodes.length <= 2 && !text.includes(" — changes since last read") && !text.endsWith(" — no change.")) {
      text += "\n(few elements: this screen may be drawn, not described; app.ocr() reads its text with positions, or take a screenshot)";
    }
    if (outline.offscreen || outline.deeper) {
      const left = [outline.offscreen && `${outline.offscreen} outside the window`, outline.deeper && `${outline.deeper} in folded levels`].filter(Boolean).join(", ");
      text += `\n(outline: ${outline.nodes.length} of ${tree.nodes.length} elements; not shown: ${left}. find() and nodes() reach all of them; {full: true} prints everything)`;
    }
    // The baseline is what the model last saw, so silent reads leave it alone.
    if (emit) {
      this.#lastTrees.set(key, { lines, base, frames });
      this.#waitBase = { pixels: false, value: base.join("\n") };
      this.#ctx.out.text(text);
    }
    return text;
  }

  async getScreenshot(options = {}) {
    const { window, emit = true } = options;
    const shot = this.#ctx.config.screenshot;
    const view = await this.#refreshView(window);
    if (view.windowless) throw new Error(`${this.name} has no window to capture; gb.screenshot() captures the whole screen`);
    if (view.windowId == null) throw new Error(`Cannot find a capturable window id for ${this.name}`);
    const image = await this.#call("screenshot", {
      windowId: view.windowId,
      width: view.width,
      height: view.height,
      format: options.format ?? shot.format,
      quality: (options.quality ?? shot.quality) / 100,
    });
    const result = { width: image.width, height: image.height, mimeType: image.mimeType, view: { width: view.width, height: view.height, scale: view.scale } };
    // Keep base64 out of printed results; it is still there for code that wants it.
    Object.defineProperty(result, "data", { value: image.data, enumerable: false });
    if (emit) {
      this.#waitBase = { pixels: true, value: hashImage(image.data), format: options.format ?? shot.format, quality: options.quality };
      this.#ctx.out.text(`Screenshot of ${this.name} window ${view.window}${view.note}: ${image.width}x${image.height}. Click coordinates are these pixels.`);
      await this.#ctx.out.image(image.data, image.mimeType, `${this.name}-w${view.window}`);
    }
    return result;
  }

  // Polls silently until the window stops changing, then returns. For apps
  // that repaint late (remote desktops, reports, async loads). A frame that
  // matches any of the last few counts as stable, so a blinking caret settles.
  async settle(options = {}) {
    const { stable, ms, frames } = await this.#settle(options);
    return { stable, ms, frames };
  }

  async #settle(options = {}, like = {}) {
    const { timeout = 10_000, interval = 400, min = 300, stableFor = 2, window } = options;
    const started = Date.now();
    await new Promise((r) => setTimeout(r, min));
    const recent = [];
    let same = 0;
    let frames = 0;
    let hash;
    while (Date.now() - started < timeout) {
      hash = await this.#frameHash(window, like);
      frames += 1;
      same = recent.includes(hash) ? same + 1 : 0;
      if (same >= stableFor - 1 && frames > 1) return { stable: true, ms: Date.now() - started, frames, hash };
      recent.push(hash);
      if (recent.length > 3) recent.shift();
      await new Promise((r) => setTimeout(r, interval));
    }
    return { stable: false, ms: Date.now() - started, frames, hash };
  }

  // Waits until the window differs from the last printed read (or from where
  // the previous wait settled), then settles. Returns {changed: false} at the
  // timeout instead of throwing.
  async waitForChange(options = {}) {
    const { timeout = 10_000, interval = 300, window } = options;
    const started = Date.now();
    const base = this.#waitBase;
    if (!base) throw new Error("waitForChange needs an earlier printed read; call getAXState() or getScreenshot() first");
    const current = async () => (base.pixels ? this.#frameHash(window, base) : (await this.#treeBase(window)).join("\n"));
    while (Date.now() - started < timeout) {
      if ((await current()) !== base.value) {
        const settled = await this.#settle({ ...options, timeout: Math.max(1, timeout - (Date.now() - started)), min: 0 }, base);
        this.#waitBase = { ...base, value: base.pixels ? settled.hash : await current() };
        return { changed: true, ms: Date.now() - started, stable: settled.stable };
      }
      // Android: sleep until the app reports a change, not a fixed interval.
      if (this.platform === "android" && !base.pixels) {
        await this.#call("waitEvent", { timeout: Math.min(2_000, Math.max(1, timeout - (Date.now() - started))) });
      } else {
        await new Promise((r) => setTimeout(r, interval));
      }
    }
    return { changed: false, ms: Date.now() - started };
  }

  // Hashed in the same format as `like`, so it can match a printed screenshot.
  async #frameHash(window, like = {}) {
    const shot = await this.getScreenshot({ window, emit: false, format: like.format ?? "png", quality: like.quality });
    return hashImage(shot.data);
  }

  async #treeBase(window) {
    const view = await this.#refreshView(window);
    const ax = this.#ctx.config.ax;
    const tree = await this.#call("axTree", { window: view.window, maxNodes: ax.maxNodes, maxDepth: ax.maxDepth, maxText: ax.maxTextLength });
    return formatTree(tree.nodes);
  }

  // The tree as data, without printing it or touching the diff baseline:
  // [{index, role, label, value, id, placeholder, focused, ..., actions,
  // frame: [x, y, w, h] in image pixels}]. `maxText` (default 10000) bounds
  // each text; reads cut text much shorter.
  async nodes(options = {}) {
    const ax = this.#ctx.config.ax;
    const view = await this.#refreshView(options.window);
    const tree = await this.#call("axTree", {
      window: view.window,
      maxNodes: options.maxNodes ?? ax.maxNodes,
      maxDepth: options.maxDepth ?? ax.maxDepth,
      maxText: options.maxText ?? 10_000,
      menus: options.menus ?? false,
      keyboard: options.keyboard === true,
    });
    return tree.nodes.map((node) => nodeRecord(node, { toImage: (f) => toImage(view, f) }));
  }

  // The first element matching `query`, or null; `{all: true}` returns every
  // match. `query` fields: role ("button"), label, id, value, text (label,
  // value, placeholder or id), each a string (case-insensitive substring) or a
  // RegExp, and any flag (focused, selected, disabled, settable) as a boolean.
  // A string query matches `text`. Prints nothing.
  async find(query, options = {}) {
    const all = (await this.nodes(options)).filter(matcher(query));
    return options.all ? all : (all[0] ?? null);
  }

  // A check inside a script: waits up to `timeout` ms (default 3000) for an
  // element matching `query` (as find), or with {gone: true} for none to
  // match, and returns it (true for gone). If the check fails it prints a
  // read of the window and throws, so the call stops at the first failed
  // step with the state in front of the agent.
  async expect(query, options = {}) {
    const { timeout = 3000, gone = false, message, window } = options;
    const match = matcher(query);
    const started = Date.now();
    while (true) {
      const hit = (await this.nodes({ window })).find(match);
      if (gone ? !hit : hit) return gone ? true : hit;
      const left = timeout - (Date.now() - started);
      if (left <= 0) break;
      if (this.platform === "android") await this.#call("waitEvent", { timeout: Math.min(left, 1000) });
      else await new Promise((r) => setTimeout(r, Math.min(left, 250)));
    }
    const what = message ?? `${gone ? "no element" : "an element"} matching ${describeQuery(query)}`;
    await this.getAXState({ window });
    throw new Error(`expect failed in ${this.name}: ${what} ${gone ? "still there" : "not found"} after ${timeout} ms (the read above is the window now)`);
  }

  // Scrolls until an element matching `query` (as find) is fully in view and
  // returns it, or null at the end of the content. Scrolls the largest list
  // or scroll area unless `container` (an index) names one. Each step moves
  // about a page on Android, or `dy` lines elsewhere (default 5); a negative
  // `dy` scrolls back. At most `max` steps (30).
  async scrollTo(query, options = {}) {
    const { container, dy = 5, max = 30, window } = options;
    const match = matcher(query);
    const visible = (n) => n.frame && n.frame[3] > 0 && n.frame[1] >= 0 && n.frame[1] + n.frame[3] <= this.#view.height && n.frame[0] >= 0 && n.frame[0] < this.#view.width;
    let last = null;
    for (let step = 0; step <= max; step++) {
      const all = await this.nodes({ window });
      const hit = all.find(match);
      if (hit && visible(hit)) return hit;
      const area = (n) => (n.frame ? n.frame[2] * n.frame[3] : 0);
      const box = container != null ? all.find((n) => n.index === container) : all.filter((n) => /^(list|scroll area|table|outline|web area)$/.test(n.role)).sort((a, b) => area(b) - area(a))[0];
      if (!box?.frame) throw new Error(`scrollTo: nothing to scroll in ${this.name}'s window; pass {container: index}`);
      // The same elements as last time: the content stopped moving.
      const now = all.map((n) => `${n.index}:${n.label ?? ""}:${n.frame?.[1] ?? ""}`).join("|");
      if (now === last) return null;
      last = now;
      // An element found but cut off by the edge needs a nudge toward it.
      const back = hit ? hit.frame[1] < 0 : dy < 0;
      const [bx, by, bw, bh] = box.frame;
      if (this.platform === "android") {
        // A finger swipe over most of the list: a page per step, no fling.
        const share = hit ? 0.25 : 0.6;
        const [from, to] = [by + bh * (0.5 + share / 2), by + bh * (0.5 - share / 2)];
        await this.swipe([bx + bw / 2, back ? to : from], [bx + bw / 2, back ? from : to], { ms: 300 });
      } else {
        await this.scroll([bx + bw / 2, by + bh / 2], hit ? (back ? -2 : 2) : dy);
      }
    }
    return null;
  }

  // The full text of element `index` (its value, else its label): reads cut
  // long text short.
  async text(index, options = {}) {
    const node = (await this.nodes({ ...options, maxText: options.maxText ?? 100_000 })).find((n) => n.index === index);
    if (!node) throw new RangeError(`No element ${index} in ${this.name}'s window; read again`);
    return node.value ?? node.label ?? "";
  }

  // Text in the window's screenshot, by OCR on the host (macOS Vision), for
  // screens the tree cannot describe: canvases, games, remote desktops.
  // Returns [{text, confidence, frame: [x, y, w, h]}] in image pixels (the
  // click space) and prints one line per text unless {emit: false}.
  // `languages` (e.g. ["de-DE"]) helps text that is not English.
  async ocr(options = {}) {
    const { recognizeText } = await import("./ocr.mjs");
    const shot = await this.getScreenshot({ window: options.window, format: "png", emit: false });
    const found = await recognizeText(Buffer.from(shot.data, "base64"), { languages: options.languages });
    // A screenshot can come back larger than the view; map to the view's pixels.
    const sx = this.#view.width / shot.width, sy = this.#view.height / shot.height;
    const items = found.map((t) => ({ text: t.text, confidence: Math.round(t.confidence * 100) / 100, frame: [t.frame[0] * sx, t.frame[1] * sy, t.frame[2] * sx, t.frame[3] * sy].map(Math.round) }));
    if (options.emit !== false) {
      const lines = items.map((t) => `${JSON.stringify(t.text)} @${t.frame[0]},${t.frame[1]} ${t.frame[2]}x${t.frame[3]}`);
      this.#ctx.out.text(`${this.name} — text in the screenshot (OCR) — image ${this.#view.width}x${this.#view.height}\n${lines.join("\n") || "(no text found)"}`);
    }
    return items;
  }

  async getAXStateAndScreenshot(options = {}) {
    const text = await this.getAXState(options);
    const image = await this.getScreenshot(options);
    return { text, image };
  }

  // Image-space frame of an element from the last tree.
  async frame(index) {
    const view = this.#view ?? (await this.#ensureView());
    const { frame } = await this.#call("elementFrame", { index });
    return toImage(view, frame).map((v) => Math.round(v));
  }

  async center(index) {
    return center(await this.frame(index)).map((v) => Math.round(v));
  }

  async activate() {
    await this.#activate();
  }

  // Android: opens a link or a specific screen of this app, on its screen
  // (hidden by default): {action ("android.intent.action.VIEW"), data (a
  // URL or URI), type, component ("pkg/.Activity"), categories, extras}.
  async open(intent) {
    if (this.platform === "macos") {
      // A file path or URL, opened in this app without bringing it forward.
      const target = String(intent);
      return this.#act("open", { target }, () => this.#backend.request("open", { target, bundleId: this.bundleId, activate: false }));
    }
    if (this.platform !== "android") throw new Error("app.open() needs a macOS or Android app");
    const spec = typeof intent === "string" ? { data: intent } : intent;
    return this.#act("open", { intent: spec.data ?? spec.component ?? spec.action }, async () => {
      await this.#call("activate", { intent: spec });
    });
  }

  // Brings the app forward at most once per call. If it is no longer in front
  // later in the same call, the user switched away: stop rather than take
  // focus back from them.
  async #activate() {
    if (this.#activatedCell === this.#ctx.cell) {
      if ((await this.#call("isActive")).active) return;
      this.#ctx.stop(`Stopped: the user switched away from ${this.name}. Do not continue GUI actions until the user asks.`);
    }
    await this.#bringForward();
    this.#activatedCell = this.#ctx.cell;
  }

  // macOS may refuse an activation requested by a background app, and a
  // switch to another Space takes a moment. LaunchServices (`open -b`) is
  // honored, so fall back to it and wait longer.
  async #bringForward() {
    try {
      await this.#call("activate");
      return;
    } catch (error) {
      if (error.code !== "activate_failed" || !this.bundleId || this.platform !== "macos" || process.platform !== "darwin") throw error;
    }
    await execFileAsync("open", ["-b", this.bundleId]);
    for (let i = 0; i < 40; i++) {
      if ((await this.#call("isActive")).active) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`Could not bring ${this.name} to the front`);
  }

  async #screenPoint(target) {
    if (isPoint(target)) {
      const view = await this.#ensureView();
      const [x, y] = target;
      // A point outside the window would land in whatever app is underneath.
      if (x < 0 || y < 0 || x >= view.width || y >= view.height) {
        throw new RangeError(`[${x}, ${y}] is outside ${this.name}'s window image (${view.width}x${view.height})`);
      }
      return toScreen(view, target);
    }
    if (Number.isInteger(target)) {
      const { frame } = await this.#call("elementFrame", { index: target });
      return center(frame);
    }
    throw new TypeError("Target must be [x, y] image pixels or an element index");
  }

  async click(target, options = {}) {
    const { button = "left", count = 1, modifiers = [] } = options;
    const modList = [].concat(modifiers);
    const mods = modList.length ? parseKeys(`${modList.join("+")}+a`)[0].mods : [];
    return this.#act("click", { target: describeTarget(target), button, count }, async () => {
      const [x, y] = await this.#screenPoint(target);
      const hit = await this.#call("hitTest", { x, y }).catch(() => null);
      const onMenu = hit?.role === "AXMenuItem";
      // A plain click on a pressable element: press it through accessibility,
      // which works in the background and cannot hit the wrong window. An open
      // menu is its own window that background pixel clicks never reach, so a
      // menu item is pressed this way even for a raw click.
      let press = null;
      if (button === "left" && count === 1 && mods.length === 0 && (options.raw !== true || (onMenu && this.#useBackground(options)))) {
        if (Number.isInteger(target)) {
          const { actions = [] } = await this.#call("actionNames", { index: target });
          press = { index: target, actions, role: null };
        } else {
          press = hit;
        }
      }
      await this.#pointCursor([x, y]);
      if (press?.index != null && press.actions?.includes("AXPress") && (press.role == null || PRESSABLE.has(press.role))) {
        const result = await this.#call("performAction", { index: press.index, action: "AXPress" });
        // Android taps web content instead, and says so.
        this.lastRoute = result?.route === "touch" ? `${this.screen === "hidden" ? "hidden screen" : "foreground"} (touch)` : "accessibility";
      } else {
        await this.#deliver("click", { x, y, button, count, mods }, options);
      }
      if (onMenu) await this.#waitForMenuClose(x, y);
    });
  }

  // A menu pick lands as the menu closes. Until then the next click hits the
  // closing menu and is dropped, and a pop-up button still has its old value.
  async #waitForMenuClose(x, y) {
    for (let i = 0; i < 20; i++) {
      const now = await this.#call("hitTest", { x, y }).catch(() => null);
      if (now?.role !== "AXMenuItem") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  doubleClick(target, options = {}) {
    return this.click(target, { ...options, count: 2 });
  }

  rightClick(target, options = {}) {
    return this.click(target, { ...options, button: "right" });
  }

  // Whether this action should stay in the background. Off when the caller,
  // this handle, the config, or the app's entry in foregroundApps says so.
  #useBackground(options) {
    if (options.foreground === true || options.background === false || this.foreground) return false;
    // Android input goes to the phone's screen until the virtual-display route lands.
    if (this.platform === "android") return false;
    const config = this.#ctx.config;
    if (config.input === "foreground") return false;
    const names = [this.bundleId, this.name].filter(Boolean).map((n) => n.toLowerCase());
    return !(config.foregroundApps ?? []).some((entry) => names.includes(String(entry).toLowerCase()));
  }

  // Sends one input request to the app. Background first: the window is made
  // key inside its app and events go to the process, so focus and the real
  // cursor stay with the user. If this macOS or this app can't take that, the
  // app is brought forward instead and `lastRoute` says so.
  async #deliver(method, params, options = {}) {
    if (this.#useBackground(options)) {
      const view = await this.#ensureView();
      if (view.windowId != null) {
        try {
          const result = await this.#call(method, { ...params, mode: "background", windowId: view.windowId });
          this.lastRoute = result?.focusRestored ? `${result.route} (focus restored)` : (result?.route ?? "background");
          return;
        } catch (error) {
          if (!["background_unavailable", "background_unconfirmed"].includes(error.code)) throw error;
          this.#ctx.log({ app: this.bundleId ?? this.name, action: "fallback", reason: error.message });
        }
      }
    }
    await this.#activate();
    const result = await this.#call(method, params);
    // Android says how it got there (touch, keys, set-text).
    const where = this.screen === "hidden" ? "hidden screen" : "foreground";
    this.lastRoute = result?.route ? `${where} (${result.route})` : where;
  }

  // Moves the drawn agent cursor to a screen point above the app's window.
  async #pointCursor([x, y]) {
    if (this.#ctx.config.cursor === false) return;
    try {
      await this.#backend.request("cursor", { x, y, windowId: this.#view?.windowId });
    } catch {
      // The cursor is decoration; never fail an action over it.
    }
  }

  async pressKey(keys, options = {}) {
    const chords = parseKeys(keys);
    const repeat = Math.max(1, options.repeat ?? 1);
    return this.#act("pressKey", { keys: String(keys), repeat }, async () => {
      const all = Array.from({ length: repeat }, () => chords).flat();
      // A menu shortcut (Cmd+S) sent as a key never reaches a background
      // app's menus, so it presses the menu item instead. Other keys go as keys.
      if (this.platform === "macos" && this.#useBackground(options) && all.some((c) => c.mods.includes("super"))) {
        let batch = [];
        const flush = async () => {
          if (batch.length) await this.#deliver("keys", { chords: batch }, options);
          batch = [];
        };
        const routes = [];
        for (const chord of all) {
          if (chord.mods.includes("super")) {
            const hit = await this.#call("menuShortcut", { key: chord.key, mods: chord.mods }).catch(() => ({ found: false }));
            if (hit.found && hit.pressed) {
              await flush();
              routes.push(`menu "${hit.title}"`);
              await new Promise((r) => setTimeout(r, 120));
              continue;
            }
          }
          batch.push(chord);
        }
        await flush();
        if (routes.length) this.lastRoute = batch.length || all.length > routes.length ? `${this.lastRoute ?? "background"} + ${routes.join(", ")}` : routes.join(", ");
        return;
      }
      await this.#deliver("keys", { chords: all }, options);
    });
  }

  async typeText(text, options = {}) {
    if (typeof text !== "string") throw new TypeError("typeText expects a string");
    const detail = this.#ctx.config.log.text ? { text } : { length: text.length };
    return this.#act("typeText", detail, () => this.#deliver("type", { text }, options));
  }

  async scroll(target, amount = 3, options = {}) {
    const { dy, dx } = typeof amount === "number" ? { dy: amount, dx: options.dx ?? 0 } : { dy: 0, dx: 0, ...amount };
    return this.#act("scroll", { target: describeTarget(target), dy, dx }, async () => {
      const [x, y] = await this.#screenPoint(target);
      await this.#pointCursor([x, y]);
      await this.#deliver("scroll", { x, y, dy, dx }, options);
    });
  }

  // Two fingers around `target` (index or [x, y]) moving apart (`scale` > 1
  // zooms in) or together (< 1), over `ms`. `distance` is the fingers'
  // starting gap in image pixels (default a third of the window's short
  // side), `angle` their direction in degrees. Android only.
  async pinch(target, options = {}) {
    const { scale = 2, ms = 500, angle = 0 } = options;
    return this.#twoFingers("pinch", target, options, (r0, view, room) => {
      const r1 = Math.min(r0 * scale, room);
      const steps = 8;
      return Array.from({ length: steps + 1 }, (_, k) => r0 + ((r1 - r0) * k) / steps).map((r) => [r, angle]);
    }, ms, { scale });
  }

  // Two fingers around `target` turning by `degrees` (clockwise on screen
  // for positive) over `ms`, as to rotate a map or photo. Android only.
  async rotate(target, options = {}) {
    const { degrees = 45, ms = 600, angle = 0 } = options;
    return this.#twoFingers("rotate", target, options, (r0) => {
      const steps = 12;
      return Array.from({ length: steps + 1 }, (_, k) => [r0, angle + (degrees * k) / steps]);
    }, ms, { degrees });
  }

  // Builds two finger paths from [radius, angle] samples (radius in screen
  // points from the center) and sends them as one multi-touch gesture.
  async #twoFingers(action, target, options, samples, ms, detail) {
    if (this.platform === "macos") {
      // Trackpad gesture events: magnify by scale - 1, rotate (clockwise
      // positive here, counterclockwise in AppKit).
      return this.#act(action, { target: describeTarget(target), ...detail }, async () => {
        const [x, y] = await this.#screenPoint(target);
        await this.#pointCursor([x, y]);
        const amount = action === "pinch" ? (detail.scale ?? 2) - 1 : -(detail.degrees ?? 45);
        await this.#deliver("gesture", { x, y, kind: action === "pinch" ? "magnify" : "rotate", amount, ms }, options);
      });
    }
    if (this.platform !== "android") throw new Error(`app.${action}() needs a touch screen or trackpad`);
    return this.#act(action, { target: describeTarget(target), ...detail }, async () => {
      const view = await this.#ensureView();
      const [cx, cy] = await this.#screenPoint(target);
      const [ox, oy] = view.origin, [w, h] = view.size;
      // How far a finger can go from the center and stay on the window.
      const room = Math.max(1, Math.min(cx - ox, ox + w - cx, cy - oy, oy + h - cy) - 2);
      const r0 = Math.min(room, (options.distance ?? Math.min(view.width, view.height) / 3) / view.scale / 2);
      const pts = samples(r0, view, room);
      const finger = (sign) => pts.map(([r, deg]) => {
        const t = (deg * Math.PI) / 180;
        return [cx + sign * r * Math.cos(t), cy + sign * r * Math.sin(t)];
      });
      await this.#deliver("touches", { paths: [finger(1), finger(-1)], ms }, options);
    });
  }

  async drag(from, to, options = {}) {
    const points = to === undefined && Array.isArray(from) && Array.isArray(from[0]) ? from : [from, to];
    return this.#act("drag", { path: points.map(describeTarget).join(" -> ") }, async () => {
      const path = [];
      for (const point of points) path.push(await this.#screenPoint(point));
      await this.#pointCursor(path[0]);
      const touch = this.platform === "android" ? { hold: options.hold ?? true, ms: options.ms } : {};
      await this.#deliver("drag", { path, button: options.button ?? "left", ...touch }, options);
      await this.#pointCursor(path.at(-1));
    });
  }

  // Touch screens (Android): a finger swipe with no long press first, for
  // pagers, sheets and lists. `ms` is how long the finger moves.
  async swipe(from, to, options = {}) {
    return this.#act("swipe", { path: `${describeTarget(from)} -> ${describeTarget(to)}` }, async () => {
      const path = [await this.#screenPoint(from), await this.#screenPoint(to)];
      await this.#deliver("drag", { path, hold: false, ms: options.ms ?? 300 }, options);
    });
  }

  // Touch screens (Android): press and hold. rightClick does the same.
  async longPress(target, options = {}) {
    return this.#act("longPress", { target: describeTarget(target) }, async () => {
      const [x, y] = await this.#screenPoint(target);
      await this.#deliver("longPress", { x, y, ms: options.ms ?? 0 }, options);
    });
  }

  // macOS: moves the pointer onto a target without clicking, for tooltips and
  // hover menus. In the background only the app sees it; the real pointer
  // stays put.
  // AppKit tracks the pointer from the real cursor, so hover uses the
  // foreground route by default: it brings the app forward and moves the real
  // pointer. {background: true} tries without (web content in Chromium apps
  // reacts to it).
  async hover(target, options = {}) {
    return this.#act("hover", { target: describeTarget(target) }, async () => {
      const [x, y] = await this.#screenPoint(target);
      await this.#pointCursor([x, y]);
      const route = options.background === true ? options : { ...options, foreground: options.foreground ?? true };
      await this.#deliver("hover", { x, y }, route);
    });
  }

  // Holds the mouse button down on a target for `ms` (default 800): press
  // and hold, long press. A mouse event, never an accessibility press.
  async press(target, options = {}) {
    if (this.platform === "android") return this.longPress(target, options);
    const ms = options.ms ?? 800;
    return this.#act("press", { target: describeTarget(target), ms }, async () => {
      const [x, y] = await this.#screenPoint(target);
      await this.#pointCursor([x, y]);
      await this.#deliver("click", { x, y, button: options.button ?? "left", count: 1, mods: [], holdMs: ms }, options);
    });
  }

  // macOS menus. menus() lists the menu bar (or one menu: menus(["File"]))
  // with each item's shortcut; menu(["File", "Export…"]) presses an item
  // through accessibility, which works in the background. "File > Export"
  // works as a path too. Titles match without case or a trailing "…".
  async menus(path = [], options = {}) {
    this.#requireMac("menus");
    const list = typeof path === "string" ? path.split(/\s*>\s*/).filter(Boolean) : [].concat(path);
    const result = await this.#call("menus", { path: list, depth: options.depth });
    const lines = [];
    const walk = (items, indent) => {
      for (const it of items) {
        const flags = [it.shortcut, it.disabled && "disabled", it.checked && "checked"].filter(Boolean).join(", ");
        const sub = typeof it.submenu === "number" ? ` (${it.submenu} items)` : Array.isArray(it.submenu) ? " >" : "";
        if (it.title || it.shortcut) lines.push(`${"  ".repeat(indent)}${it.title || "(untitled)"}${flags ? ` [${flags}]` : ""}${sub}`);
        if (Array.isArray(it.submenu)) walk(it.submenu, indent + 1);
      }
    };
    walk(result.items, 0);
    if (options.emit !== false) this.#ctx.out.text(`${this.name} — menu${list.length ? ` ${list.join(" > ")}` : " bar"}:\n${lines.join("\n") || "(empty)"}`);
    return result.items;
  }

  async menu(path) {
    this.#requireMac("menu");
    const list = typeof path === "string" ? path.split(/\s*>\s*/).filter(Boolean) : [].concat(path);
    return this.#act("menu", { path: list.join(" > ") }, async () => {
      await this.#call("menuPress", { path: list });
      this.lastRoute = "menu";
    });
  }

  // Opens a pop-up button's (or menu button's) menu and picks `item` in one
  // step; `item` may be a path into a submenu. The menu is open only for that
  // moment, so the user's typing never lands in it. Returns the title picked.
  async select(target, item) {
    this.#requireMac("select");
    return this.#pick("select", target, item, false);
  }

  // Opens an element's context menu (what a right-click shows) and picks
  // `item`, in one step.
  async contextMenu(target, item) {
    this.#requireMac("contextMenu");
    return this.#pick("contextMenu", target, item, true);
  }

  async #pick(action, target, item, context) {
    const path = [].concat(item).map(String);
    return this.#act(action, { target: describeTarget(target), item: path.join(" > ") }, async () => {
      let index = target;
      if (isPoint(target)) {
        const [x, y] = await this.#screenPoint(target);
        const hit = await this.#call("hitTest", { x, y });
        if (hit.foreign) throw new Error(`${describeTarget(target)} is covered by ${hit.app ?? "another app"} (pid ${hit.pid})`);
        if (hit.index == null) throw new Error(`No element at ${describeTarget(target)}`);
        index = hit.index;
      } else if (!Number.isInteger(target)) {
        const found = await this.find(target);
        if (!found) throw new Error(`No element matches ${describeQuery(target)}`);
        index = found.index;
      }
      const result = await this.#call("selectMenuItem", { index, path, context });
      this.lastRoute = "accessibility";
      return result.title;
    });
  }

  // macOS window controls, without bringing the app forward: app.window(i)
  // (default: the window reads use) has move(x, y) and resize(w, h) in screen
  // points, minimize(), restore(), raise(), zoom(), fullScreen(on), close().
  window(index) {
    this.#requireMac("window");
    const run = (op, extra = {}) =>
      this.#act("window", { op, window: index ?? "default", ...extra }, async () => {
        const view = index == null ? await this.#ensureView() : null;
        await this.#call("windowAction", { op, window: index ?? view.window, ...extra });
      });
    return {
      move: (x, y) => run("move", { x, y }),
      resize: (width, height) => run("resize", { width, height }),
      minimize: () => run("minimize"),
      restore: () => run("restore"),
      raise: () => run("raise"),
      zoom: () => run("zoom"),
      fullScreen: (on = true) => run("fullScreen", { on }),
      close: () => run("close"),
    };
  }

  // Quits the app (it may ask to save first; then `terminated` is false and
  // its dialog shows in the next read). {force: true} force-quits.
  async quit(options = {}) {
    this.#requireMac("quit");
    return this.#act("quit", { force: options.force === true }, () => this.#call("appAction", { op: options.force ? "forceQuit" : "quit" }));
  }

  async hide() {
    this.#requireMac("hide");
    return this.#act("hide", {}, () => this.#call("appAction", { op: "hide" }));
  }

  async unhide() {
    this.#requireMac("unhide");
    return this.#act("unhide", {}, () => this.#call("appAction", { op: "unhide" }));
  }

  // Pastes text (any characters, any length) through the clipboard, then
  // puts the user's clipboard back. Faster than typeText for long text.
  async paste(text) {
    this.#requireMac("paste");
    if (typeof text !== "string") throw new TypeError("paste expects a string");
    const detail = this.#ctx.config.log.text ? { text } : { length: text.length };
    return this.#act("paste", detail, async () => {
      await this.#call("pasteStash", { op: "stash", text });
      try {
        await this.pressKey("super+v");
        await new Promise((r) => setTimeout(r, 250));
      } finally {
        await this.#call("pasteStash", { op: "restore" });
      }
    });
  }

  // Drags files from this Mac onto a target in the app (a drop zone, a mail
  // body, a Finder window), as a person would. Uses the real pointer, then
  // puts it back. Asks first (macos:files).
  async dropFiles(target, paths) {
    this.#requireMac("dropFiles");
    const list = [].concat(paths).map(String);
    return this.#act("dropFiles", { target: describeTarget(target), files: list.length }, async () => {
      // The drop lands on whatever window is on top at that point.
      await this.#activate();
      const [x, y] = await this.#screenPoint(target);
      const result = await this.#call("dropFiles", { x, y, paths: list });
      this.lastRoute = result.route;
    });
  }

  // In an open or save panel that is showing, goes to `path` and confirms
  // (Open or Save) unless {confirm: false}. In a save panel the last part of
  // the path is the file name. Panels run in a separate macOS process that
  // takes no background keys, so this brings the app forward.
  async choosePath(path, options = {}) {
    this.#requireMac("choosePath");
    const target = String(path);
    return this.#act("choosePath", { path: target }, async () => {
      const nodes = await this.nodes();
      const sheet = nodes.find((n) => n.role === "sheet") ?? nodes.find((n) => n.depth === 0);
      const inSheet = nodes.filter((n) => n.index === sheet.index || (n.depth > sheet.depth && nodes.indexOf(n) > nodes.indexOf(sheet)));
      const nameField = inSheet.find((n) => n.role === "text field" && /save as|name/i.test(`${n.label ?? ""} ${n.desc ?? ""}`));
      let go = target;
      if (nameField) {
        const slash = target.lastIndexOf("/");
        go = slash > 0 ? target.slice(0, slash) : target;
        await this.#call("setValue", { index: nameField.index, value: target.slice(slash + 1) });
      }
      const fg = { ...options, foreground: true };
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      await this.#activate();
      await wait(300);
      await this.#deliver("keys", { chords: parseKeys("super+shift+g") }, fg);
      await wait(900);
      // The Go To field keeps the last path, selected; replace it.
      await this.#deliver("keys", { chords: parseKeys("super+a BackSpace") }, fg);
      await this.#deliver("type", { text: go }, fg);
      // Return picks the highlighted suggestion; let the list catch up.
      await wait(1300);
      await this.#deliver("keys", { chords: parseKeys("Return") }, fg);
      await wait(1000);
      if (options.confirm !== false) await this.#deliver("keys", { chords: parseKeys("Return") }, fg);
    });
  }

  #requireMac(name) {
    if (this.platform !== "macos") throw new Error(`app.${name}() is for macOS apps`);
  }

  async setValue(index, value) {
    return this.#act("setValue", { target: `#${index}` }, () => this.#call("setValue", { index, value }));
  }

  async focus(index) {
    return this.#act("focus", { target: `#${index}` }, () => this.#call("focusElement", { index }));
  }

  async selectText(index, options = {}) {
    return this.#act("selectText", { target: `#${index}` }, () =>
      this.#call("selectText", { index, start: options.start, length: options.length }),
    );
  }

  async listActions(index) {
    const { actions } = await this.#call("actionNames", { index });
    return actions;
  }

  async performSecondaryAction(index, action) {
    const actions = await this.listActions(index);
    const wanted = String(action).toLowerCase().replace(/\s+/g, "");
    const match = actions.find((a) => a.toLowerCase().replace(/^ax/, "").replace(/\s+/g, "") === wanted.replace(/^ax/, ""));
    if (!match) throw new Error(`Element ${index} has no action "${action}". It has: ${actions.join(", ") || "none"}`);
    return this.#act("performAction", { target: `#${index}`, action: match }, () =>
      this.#call("performAction", { index, action: match }),
    );
  }
}

// listApps / getApp / permissions bound to one backend: the host's for `gb`,
// a device's for gb.device(). Handles are cached per backend, so a Mac pid and
// a phone's package can never collide.
function appSurface(ctx, backend) {
  const apps = (backend.apps ??= new Map());
  return {
    async listApps(options = {}) {
      ctx.checkAbort();
      const all = await backend.request("listApps");
      const running = all.filter((a) => a.running);
      const list = options.installed ? all : running;
      if (options.emit !== false) {
        const lines = list.map((a) => `${a.name} (${a.bundleId ?? "?"})${a.running ? ` pid ${a.pid}` : ""}${a.active ? " [front]" : ""}`);
        ctx.out.text(`${options.installed ? "Apps" : "Running apps"}:\n${lines.join("\n")}${options.installed ? "" : "\n(pass {installed: true} for installed apps)"}`);
      }
      return list;
    },

    // Launches the app if needed and returns a handle. Does not take focus.
    async getApp(query, options = {}) {
      ctx.checkAbort();
      let info = await backend.request("resolveApp", { query: String(query) });
      if (!info.running) {
        ctx.log({ app: info.bundleId, action: "launch" });
        info = await backend.request("launch", {
          bundleId: info.bundleId,
          path: info.path,
          name: info.name,
          activate: options.activate ?? false,
        });
        (backend.launched ??= new Set()).add(info.pid);
      }
      const existing = apps.get(info.pid);
      if (existing) {
        // On Android `foreground` picks the screen, so it can change later.
        if (backend.platform === "android" && typeof options.foreground === "boolean") existing.foreground = options.foreground;
        return existing;
      }
      const app = new App(ctx, info, backend);
      apps.set(info.pid, app);
      if (options.foreground) app.foreground = true;
      if (options.activate) await app.activate();
      return app;
    },

    async permissions() {
      return backend.request("permissions", {});
    },

    // Quits the apps this session launched (not ones the user had open).
    // An app that asks to save first stays open; its name is in `left`.
    async quitLaunched(options = {}) {
      ctx.checkAbort();
      const quit = [], left = [];
      for (const pid of [...(backend.launched ?? [])]) {
        const app = apps.get(pid);
        if (!app || typeof app.quit !== "function" || backend.platform !== "macos") continue;
        const result = await app.quit({ force: options.force === true }).catch(() => ({ terminated: false }));
        (result?.terminated ? quit : left).push(app.name);
        if (result?.terminated) {
          backend.launched.delete(pid);
          apps.delete(pid);
        }
      }
      if (options.emit !== false) ctx.out.text(`Quit: ${quit.join(", ") || "none"}${left.length ? `; still open (may be asking to save): ${left.join(", ")}` : ""}`);
      return { quit, left };
    },
  };
}

// Things on the Mac that are not one app: the whole screen, every window,
// the menu bar's extras, system-wide keys, the clipboard, opening files.
// Each asks first under its own key (macos:screen, macos:system,
// macos:clipboard, macos:files).
function macSystem(ctx, gbRef) {
  const backend = ctx.backend;
  const mac = () => {
    if (backend.platform !== "macos") throw new Error("This is for the Mac; use gb.device() for a phone");
  };
  const displayView = async (index = 0) => {
    const displays = await backend.request("displays");
    const d = displays[index];
    if (!d) throw new Error(`No display ${index}; there are ${displays.length}`);
    return { display: d, view: viewFor({ index, title: d.name, frame: d.frame, scale: d.scale }, ctx.config.screenshot) };
  };
  return {
    // [{index, frame, scale, main, name}] in global screen points.
    async displays() {
      mac();
      return backend.request("displays");
    },

    // Every window on screen, front to back, with its owner, so an agent can
    // find a dialog it did not expect and getApp(`pid:${w.pid}`) its owner.
    // {all: true} includes windows that are not on screen.
    async windows(options = {}) {
      mac();
      ctx.checkAbort();
      const list = await backend.request("allWindows", { all: options.all === true });
      if (options.emit !== false) {
        const lines = list.filter((w) => options.all || w.layer < 1000).map((w) => `${w.app} (pid ${w.pid}${w.bundleId ? `, ${w.bundleId}` : ""}) ${w.title ? `"${w.title}" ` : ""}@${w.frame.map(Math.round).join(",")}${w.layer ? ` layer ${w.layer}` : ""}`);
        ctx.out.text(`Windows, front to back:\n${lines.join("\n")}`);
      }
      return list;
    },

    // A screenshot of a whole display (default the main one). The image
    // space is the display's, scaled like a window's.
    async screenshot(options = {}) {
      mac();
      ctx.checkAbort();
      const { view } = await displayView(options.display ?? 0);
      const shot = ctx.config.screenshot;
      const image = await backend.request("screenCapture", { display: options.display ?? 0, width: view.width, height: view.height, format: options.format ?? shot.format, quality: (options.quality ?? shot.quality) / 100 });
      ctx.log({ app: "macos:screen", action: "screenshot", display: options.display ?? 0 });
      const result = { width: image.width, height: image.height, mimeType: image.mimeType, view };
      Object.defineProperty(result, "data", { value: image.data, enumerable: false });
      if (options.emit !== false) {
        ctx.out.text(`Screenshot of display ${options.display ?? 0}: ${image.width}x${image.height} (${view.scale.toFixed(3)} image pixels per screen point, origin ${view.origin.join(",")}).`);
        await ctx.out.image(image.data, image.mimeType, `display${options.display ?? 0}`);
      }
      return result;
    },

    // OCR of a whole display: [{text, confidence, frame}] in that display's
    // image pixels, plus `screen` [x, y] in global points for each.
    async ocr(options = {}) {
      mac();
      const { recognizeText } = await import("./ocr.mjs");
      const shot = await gbRef().screenshot({ ...options, format: "png", emit: false });
      const found = await recognizeText(Buffer.from(shot.data, "base64"), { languages: options.languages });
      const v = shot.view;
      const items = found.map((t) => {
        const frame = t.frame.map(Math.round);
        return { text: t.text, confidence: Math.round(t.confidence * 100) / 100, frame, screen: toScreen(v, center(frame)).map(Math.round) };
      });
      if (options.emit !== false) {
        ctx.out.text(`Display ${options.display ?? 0} — text (OCR) — image ${v.width}x${v.height}\n${items.map((t) => `${JSON.stringify(t.text)} @${t.frame[0]},${t.frame[1]} ${t.frame[2]}x${t.frame[3]}`).join("\n") || "(no text found)"}`);
      }
      return items;
    },

    // The menu bar's extras (Wi-Fi, battery, Control Center, the clock, and
    // third-party status icons), left to right: [{app, pid, index, title, help}].
    async menuExtras(options = {}) {
      mac();
      ctx.checkAbort();
      const list = await backend.request("menuExtras");
      if (options.emit !== false) {
        ctx.out.text(`Menu bar extras, left to right:\n${list.map((e) => `${e.app} (pid ${e.pid}) #${e.index} ${JSON.stringify(e.title ?? e.help ?? e.id ?? "")}${e.help && e.title ? ` help=${JSON.stringify(e.help)}` : ""}`).join("\n")}`);
      }
      return list;
    },

    // Opens a menu bar extra (by title, help, id or app name, substring or
    // RegExp) and returns its app's handle: read it to see the menu or panel.
    async menuExtra(query) {
      mac();
      const list = await gbRef().menuExtras({ emit: false });
      const test = matcher(typeof query === "object" && Object.prototype.toString.call(query) !== "[object RegExp]" ? query : { text: query });
      const hit = list.find((e) => test({ label: e.title, value: e.help, id: e.id, desc: e.app, role: "menu extra" }));
      if (!hit) throw new Error(`No menu bar extra matches ${describeQuery(query)}. There are: ${list.map((e) => e.title ?? e.help ?? e.app).join(", ")}`);
      const before = new Set((await backend.request("allWindows", {})).map((w) => w.windowId));
      const owner = await gbRef().getApp(`pid:${hit.pid}`);
      await owner.performSecondaryAction(hit.index, "AXPress");
      // The menu or panel it opens is often another process's window
      // (Control Center's, Notification Center's): return that app.
      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 100));
        const fresh = (await backend.request("allWindows", {})).find((w) => !before.has(w.windowId) && w.layer < 1000 && w.frame[3] > 40 && w.bundleId && w.pid !== hit.pid);
        if (fresh) return gbRef().getApp(`pid:${fresh.pid}`);
      }
      return owner;
    },

    // The notifications in Notification Center, newest first:
    // [{app, title, body, when, stacked, index}]. Opens Notification Center
    // (the clock in the menu bar), reads it, and closes it again unless
    // {keepOpen: true}; the returned `center` handle acts on it. Asks first
    // (macos:notifications): they can hold messages and codes.
    async notifications(options = {}) {
      mac();
      ctx.checkAbort();
      await backend.request("approveSurface", { key: "macos:notifications", name: "your notifications", reason: "Notifications can show messages and one-time codes." });
      let center = await gbRef().getApp("com.apple.notificationcenterui");
      let open = (await center.windows()).some((w) => /notification center/i.test(w.title ?? ""));
      if (!open) {
        center = await gbRef().menuExtra({ id: "com.apple.menuextra.clock" });
        await new Promise((r) => setTimeout(r, 400));
      }
      const nodes = await center.nodes();
      const list = nodes.find((n) => n.id === "AXNotificationListItems");
      const items = [];
      if (list) {
        const after = nodes.slice(nodes.indexOf(list) + 1);
        for (let k = 0; k < after.length && after[k].depth > list.depth; k++) {
          const n = after[k];
          if (n.depth !== list.depth + 1) continue;
          const kids = [];
          for (let j = k + 1; j < after.length && after[j].depth > n.depth; j++) kids.push(after[j]);
          const title = kids.find((c) => c.id === "title")?.value ?? null;
          const body = kids.find((c) => c.id === "body")?.value ?? null;
          const when = kids.find((c) => c.role === "text" && c.id == null)?.value ?? null;
          const app = (n.label ?? "").split(",")[0].trim() || null;
          if (title == null && body == null) continue; // headers and "Clear All"
          items.push({ app, title, body, when, stacked: /,\s*stacked$/.test(n.label ?? ""), index: n.index });
        }
      }
      ctx.log({ app: "macos:notifications", action: "read notifications", count: items.length });
      if (!options.keepOpen && !open) await gbRef().pressKey("Escape");
      if (options.emit !== false) {
        ctx.out.text(`Notifications:\n${items.map((n) => `#${n.index} ${n.app}: ${[n.title, n.body].filter(Boolean).join(" — ")}${n.when ? ` (${n.when})` : ""}${n.stacked ? " [stacked]" : ""}`).join("\n") || "(none)"}`);
      }
      Object.defineProperty(items, "center", { value: center, enumerable: false });
      return items;
    },

    // Keys and text sent system-wide to whatever is in front: Spotlight
    // (super+space), Mission Control (ctrl+Up), screenshots, app switching.
    async pressKey(keys) {
      mac();
      ctx.checkAbort();
      ctx.log({ app: "macos:system", action: "pressKey", keys: String(keys) });
      await backend.request("systemKeys", { chords: parseKeys(keys) });
      await ctx.settle();
    },

    async typeText(text) {
      mac();
      ctx.checkAbort();
      ctx.log({ app: "macos:system", action: "typeText", length: String(text).length });
      await backend.request("systemKeys", { text: String(text) });
      await ctx.settle();
    },

    // Opens an app, file or setting through Spotlight, as a person would.
    async spotlight(query, options = {}) {
      mac();
      await gbRef().pressKey("super+space");
      await new Promise((r) => setTimeout(r, 500));
      await gbRef().typeText(String(query));
      await new Promise((r) => setTimeout(r, options.wait ?? 900));
      if (options.open !== false) await gbRef().pressKey("Return");
    },

    clipboard: {
      // {text, files, image, types}. Asks first (macos:clipboard).
      async read() {
        mac();
        ctx.checkAbort();
        const result = await backend.request("clipboard", { op: "read" });
        ctx.log({ app: "macos:clipboard", action: "read", length: result.text?.length ?? 0 });
        return result;
      },
      // A string, or {files: [paths]} to copy files.
      async write(value) {
        mac();
        ctx.checkAbort();
        const params = typeof value === "string" ? { text: value } : { files: [].concat(value.files ?? []) };
        ctx.log({ app: "macos:clipboard", action: "write", length: params.text?.length ?? params.files.length });
        await backend.request("clipboard", { op: "write", ...params });
      },
    },

    // Opens a file path or URL in the app that handles it (or {app}), in the
    // background unless {activate: true}, and returns that app's handle.
    async open(target, options = {}) {
      mac();
      ctx.checkAbort();
      let bundleId;
      if (options.app) bundleId = (await backend.request("resolveApp", { query: String(options.app) })).bundleId;
      ctx.log({ app: bundleId ?? "default", action: "open", target: String(target) });
      const runningBefore = new Set((await backend.request("listApps")).filter((a) => a.running).map((a) => a.pid));
      const info = await backend.request("open", { target: String(target), bundleId, activate: options.activate === true });
      // An app this opened counts as launched, so quitLaunched() closes it.
      if (!runningBefore.has(info.pid)) (backend.launched ??= new Set()).add(info.pid);
      await new Promise((r) => setTimeout(r, 400));
      return gbRef().getApp(`pid:${info.pid}`);
    },
  };
}

function describeQuery(query) {
  const show = (v) => (Object.prototype.toString.call(v) === "[object RegExp]" ? String(v) : JSON.stringify(v));
  if (typeof query !== "object" || query === null || Object.prototype.toString.call(query) === "[object RegExp]") return show(query);
  return `{${Object.entries(query).map(([k, v]) => `${k}: ${show(v)}`).join(", ")}}`;
}

// A find() query as a predicate over nodes() records. Scripts run in their
// own realm, so their RegExps fail `instanceof`.
function matcher(query) {
  const isRegExp = (v) => Object.prototype.toString.call(v) === "[object RegExp]";
  const q = typeof query === "string" || isRegExp(query) ? { text: query } : (query ?? {});
  const test = (want, have) => {
    if (want == null) return true;
    if (have == null) return false;
    return isRegExp(want) ? want.test(String(have)) : String(have).toLowerCase().includes(String(want).toLowerCase());
  };
  return (n) =>
    (q.role == null || (isRegExp(q.role) ? q.role.test(n.role) : n.role === String(q.role).toLowerCase())) &&
    test(q.label, n.label) &&
    test(q.id, n.id) &&
    test(q.value, n.value) &&
    (q.text == null || [n.label, n.value, n.placeholder, n.id, n.desc].some((v) => test(q.text, v))) &&
    ["focused", "selected", "disabled", "settable"].every((f) => q[f] == null || Boolean(n[f]) === q[f]);
}

export function createApi(ctx) {
  const gb = {
    ...appSurface(ctx, ctx.backend),

    // An Android device by ADB serial (USB or wireless; either names the same
    // phone), or the only connected one. Same listApps/getApp/permissions.
    device(serial) {
      if (!ctx.device) throw new Error("This glovebox session has no device support");
      const backend = ctx.device(serial == null ? null : String(serial));
      const surface = appSurface(ctx, backend);
      return Object.assign(surface, {
        // Opens a link (a URL string) or an intent spec in the app that
        // handles it (the user's default, else the first), on that app's
        // screen, and returns its handle. {foreground: true} uses the
        // phone's own screen.
        async open(target, options = {}) {
          ctx.checkAbort();
          const spec = typeof target === "string" ? { data: target } : target;
          const info = await backend.request("resolveIntent", { intent: spec });
          const app = await surface.getApp(info.bundleId, { foreground: options.foreground });
          await app.open(spec);
          if (info.alternatives?.length) ctx.out.text(`(opened in ${info.name}; also handled by ${info.alternatives.join(", ")})`);
          return app;
        },
        // The notifications in the shade now, newest first:
        // [{app, package, title, text, subtext, when, ongoing, actions}].
        // Always asks first (they can hold messages and codes). Prints them
        // unless {emit: false}.
        async notifications(options = {}) {
          ctx.checkAbort();
          const list = (await backend.request("notifications", { max: options.max ?? 50 })).map(({ key, ...n }) => n);
          ctx.log({ app: "android:notifications", action: "read notifications", device: backend.label, count: list.length });
          if (options.emit !== false) {
            const lines = list.map((n) => `${n.app}: ${[n.title, n.text].filter(Boolean).join(" — ")}${n.actions?.length ? ` [${n.actions.join(", ")}]` : ""}`);
            ctx.out.text(`Notifications on ${backend.label}:\n${lines.join("\n") || "(none)"}`);
          }
          return list;
        },
        // Copies a file from this computer to the phone (default the
        // Download folder) where apps can pick it, and returns {path, bytes}.
        // Each file asks first.
        async push(localPath, options = {}) {
          ctx.checkAbort();
          const result = await backend.push(localPath, options);
          ctx.log({ app: "android:files", action: "push", device: backend.label, path: result.path, bytes: result.bytes });
          return result;
        },
        platform: backend.platform,
        serial: serial ?? null,
        toString: () => `Device(${backend.label})`,
        [Symbol.for("nodejs.util.inspect.custom")]: () => `Device(${backend.label})`,
      });
    },

    sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    },

    ...macSystem(ctx, () => gb),

    help(topic) {
      const text = ctx.help(topic);
      ctx.out.text(text);
      return undefined;
    },
  };
  return gb;
}
