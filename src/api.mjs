// The scripting surface: `gb` (alias `cua`) and the App handles it returns.
//
// Every action goes through ctx, which owns output, the abort flag, and the
// audit log. Reads (getAXState, getScreenshot) emit into the result by
// default; pass {emit: false} to only get the return value.
import { diffTrees, formatTree } from "./axformat.mjs";
import { center, toImage, toScreen, viewFor } from "./geometry.mjs";
import { execFile } from "node:child_process";
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

export class App {
  #ctx;
  #view = null;
  #lastTree = null; // {key, lines}
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
        : (this.#view && windows.find((w) => w.index === this.#view.window)) ??
          windows.find((w) => w.focused) ??
          windows.find((w) => w.main) ??
          windows[0];
    if (!pick) throw new Error(`${this.name} has no window ${window}`);
    const next = viewFor(pick, this.#ctx.config.screenshot);
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
    const lines = formatTree(tree.nodes, frames ? { toImage: (f) => toImage(view, f) } : {});
    const key = `${view.window}|${tree.window.title}|${frames}|${menus}`;
    const header = `${this.name} — window ${view.window} "${tree.window.title}" — image ${view.width}x${view.height}`;
    let text;
    if (!disableDiffing && this.#lastTree?.key === key) {
      const diff = diffTrees(this.#lastTree.lines, lines);
      text = diff.length ? `${header} — changes since last read (~ changed, + added):\n${diff.join("\n")}` : `${header} — no change.`;
    } else {
      text = `${header}\n${lines.join("\n")}`;
    }
    if (tree.truncated) text += `\n(truncated at ${lines.length} elements; pass {maxNodes} to see more)`;
    this.#lastTree = { key, lines };
    if (emit) this.#ctx.out.text(text);
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
      this.#ctx.out.text(`Screenshot of ${this.name} window ${view.window}: ${image.width}x${image.height}. Click coordinates are these pixels.`);
      await this.#ctx.out.image(image.data, image.mimeType, `${this.name}-w${view.window}`);
    }
    return result;
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
      // A plain click on a pressable element: press it through accessibility,
      // which works in the background and cannot hit the wrong window.
      if (button === "left" && count === 1 && mods.length === 0 && options.raw !== true) {
        let hit = null;
        if (Number.isInteger(target)) {
          const { actions = [] } = await this.#call("actionNames", { index: target });
          hit = { index: target, actions, role: null };
        } else {
          const [x, y] = await this.#screenPoint(target);
          hit = await this.#call("hitTest", { x, y });
        }
        if (hit?.index != null && hit.actions?.includes("AXPress") && (hit.role == null || PRESSABLE.has(hit.role))) {
          await this.#pointCursor(await this.#screenPoint(target));
          await this.#call("performAction", { index: hit.index, action: "AXPress" });
          this.lastRoute = "accessibility";
          return;
        }
      }
      const [x, y] = await this.#screenPoint(target);
      await this.#pointCursor([x, y]);
      await this.#deliver("click", { x, y, button, count, mods }, options);
    });
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
