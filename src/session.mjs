// Host side of a session: owns one kernel process and serializes calls to it.
// The kernel (and every binding in it) lives until reset() or the host exits.
// There is no idle teardown here; the CLI daemon applies its own idle limit.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const kernelPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "kernel.mjs");
const ABORT_GRACE_MS = 5000;

export class Session {
  constructor({ client = "An agent", imageMode = "inline" } = {}) {
    this.client = client;
    this.imageMode = imageMode;
    this.kernel = null;
    this.pending = new Map();
    this.nextId = 1;
    this.lastUsed = Date.now();
  }

  #start() {
    const child = spawn(process.execPath, [kernelPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, GLOVEBOX_CLIENT: this.client, GLOVEBOX_IMAGE_MODE: this.imageMode },
    });
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        const waiter = this.pending.get(message.id);
        if (waiter) {
          this.pending.delete(message.id);
          waiter.resolve(message);
        }
      }
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-4000);
      if (process.env.GLOVEBOX_DEBUG) process.stderr.write(chunk);
    });
    child.on("exit", (code, signal) => {
      if (this.kernel === child) this.kernel = null;
      const why = stderr.trim().split("\n").slice(-3).join("\n");
      for (const [id, waiter] of this.pending) {
        if (waiter.child !== child) continue;
        this.pending.delete(id);
        waiter.resolve({
          ok: false,
          content: [{ type: "text", text: `The session process exited (${signal ?? code}); bindings were lost.${why ? `\n${why}` : ""}` }],
        });
      }
    });
    this.kernel = child;
    return child;
  }

  async run(code, { title, timeoutMs = 120_000 } = {}) {
    this.lastUsed = Date.now();
    const child = this.kernel ?? this.#start();
    const id = this.nextId++;
    const reply = new Promise((resolve) => this.pending.set(id, { resolve, child }));
    child.stdin.write(`${JSON.stringify({ id, op: "eval", code, title })}\n`);
    let timer;
    let killer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        // Ask the script to stop at its next action; kill it if it won't.
        child.stdin.write(`${JSON.stringify({ op: "abort", reason: `Stopped: the script ran longer than ${timeoutMs} ms.` })}\n`);
        killer = setTimeout(() => {
          if (this.kernel === child) this.kernel = null;
          child.kill("SIGKILL");
          resolve({
            ok: false,
            content: [{ type: "text", text: `The script ran longer than ${timeoutMs} ms and did not stop, so the session was restarted. Bindings were lost.` }],
          });
        }, ABORT_GRACE_MS);
      }, timeoutMs);
    });
    try {
      return await Promise.race([reply, timeout]);
    } finally {
      clearTimeout(timer);
      clearTimeout(killer);
      this.pending.delete(id);
      this.lastUsed = Date.now();
    }
  }

  reset() {
    const child = this.kernel;
    this.kernel = null;
    if (child) child.kill("SIGTERM");
  }

  close() {
    this.reset();
  }
}
