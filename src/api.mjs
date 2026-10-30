// The scripting surface: `gb` (alias `cua`) and the App handles it returns.
//
// Every action goes through ctx, which owns output, the abort flag, and the
// audit log. Reads (getAXState, getScreenshot) emit into the result by
// default; pass {emit: false} to only get the return value.
import { diffTrees, formatTree } from "./axformat.mjs";
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
  #view = null;
  #explicitWindow = false;
  #lastTrees = new Map(); // window id -> {lines, base, frames}: what the model last saw
  // What waitForChange compares against: the last printed read (or the state a
  // previous wait settled on), as {pixels, value, format, quality}.
  #waitBase = null;
  #activatedCell = -1;

  constructor(ctx, info) {
    this.#ctx = ctx;
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

  async #call(method, params = {}) {
    this.#ctx.checkAbort();
    return this.#ctx.backend.request(method, { pid: this.pid, ...params });
  }

  async #act(action, detail, fn) {
    this.#ctx.checkAbort();
    this.#ctx.log({ app: this.bundleId ?? this.name, action, ...detail });
    const result = await fn();
    await this.#ctx.settle();
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
      const { accessibility } = await this.#ctx.backend.request("permissions", {});
      if (!accessibility) throw new Error("Accessibility permission is missing for the glovebox helper. Run: glovebox doctor");
      throw new Error(`${this.name} has no open windows`);
    }
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
    });
    // `base` has no frames, so a plain read after a {frames: true} read still
    // diffs. Element indices are stable ids, so the baseline is kept per window
    // (not per list position or title) and diffs across title changes.
    const base = formatTree(tree.nodes);
    const lines = frames ? formatTree(tree.nodes, { toImage: (f) => toImage(view, f) }) : base;
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
    if (tree.truncated) text += `\n(truncated at ${lines.length} elements; pass {maxNodes} to see more)`;
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
      await new Promise((r) => setTimeout(r, interval));
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
      if (error.code !== "activate_failed" || !this.bundleId || process.platform !== "darwin") throw error;
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
        await this.#call("performAction", { index: press.index, action: "AXPress" });
        this.lastRoute = "accessibility";
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
    await this.#call(method, params);
    this.lastRoute = "foreground";
  }

  // Moves the drawn agent cursor to a screen point above the app's window.
  async #pointCursor([x, y]) {
    if (this.#ctx.config.cursor === false) return;
    try {
      await this.#ctx.backend.request("cursor", { x, y, windowId: this.#view?.windowId });
    } catch {
      // The cursor is decoration; never fail an action over it.
    }
  }

  async pressKey(keys, options = {}) {
    const chords = parseKeys(keys);
    const repeat = Math.max(1, options.repeat ?? 1);
    return this.#act("pressKey", { keys: String(keys), repeat }, async () => {
      const all = Array.from({ length: repeat }, () => chords).flat();
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

  async drag(from, to, options = {}) {
    const points = to === undefined && Array.isArray(from) && Array.isArray(from[0]) ? from : [from, to];
    return this.#act("drag", { path: points.map(describeTarget).join(" -> ") }, async () => {
      const path = [];
      for (const point of points) path.push(await this.#screenPoint(point));
      await this.#pointCursor(path[0]);
      await this.#deliver("drag", { path, button: options.button ?? "left" }, options);
      await this.#pointCursor(path.at(-1));
    });
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

export function createApi(ctx) {
  const apps = new Map();

  const gb = {
    async listApps(options = {}) {
      ctx.checkAbort();
      const all = await ctx.backend.request("listApps");
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
      let info = await ctx.backend.request("resolveApp", { query: String(query) });
      if (!info.running) {
        ctx.log({ app: info.bundleId, action: "launch" });
        info = await ctx.backend.request("launch", {
          bundleId: info.bundleId,
          path: info.path,
          name: info.name,
          activate: options.activate ?? false,
        });
      }
      const existing = apps.get(info.pid);
      if (existing) return existing;
      const app = new App(ctx, info);
      apps.set(info.pid, app);
      if (options.foreground) app.foreground = true;
      if (options.activate) await app.activate();
      return app;
    },

    sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    },

    async permissions() {
      return ctx.backend.request("permissions", {});
    },

    help(topic) {
      const text = ctx.help(topic);
      ctx.out.text(text);
      return undefined;
    },
  };
  return gb;
}
