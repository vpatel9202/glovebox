// Text from a screenshot, for screens whose accessibility tree says little
// (canvases, games, remote desktops). macOS Vision through glovebox-ocr
// (native/macos/ocr.swift), compiled on first use into ~/.glovebox/bin.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { paths } from "./config.mjs";

const execFileAsync = promisify(execFile);
const SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "native", "macos", "ocr.swift");
const BINARY = path.join(paths.home, "bin", "glovebox-ocr");

async function binary() {
  if (process.platform !== "darwin") throw Object.assign(new Error("OCR needs a macOS host (Vision)"), { code: "unsupported" });
  const fresh = fs.existsSync(BINARY) && fs.statSync(BINARY).mtimeMs >= fs.statSync(SOURCE).mtimeMs;
  if (!fresh) {
    fs.mkdirSync(path.dirname(BINARY), { recursive: true, mode: 0o700 });
    try {
      await execFileAsync("swiftc", ["-O", SOURCE, "-o", BINARY], { timeout: 180_000 });
    } catch (error) {
      throw Object.assign(new Error(`Could not build the OCR tool (swiftc, from the Xcode command line tools): ${(error.stderr || error.message).trim().split("\n")[0]}`), { code: "failed" });
    }
  }
  return BINARY;
}

// [{text, confidence, frame: [x, y, w, h]}] in the image's pixels.
export async function recognizeText(imageBuffer, { languages = [] } = {}) {
  const bin = await binary();
  return new Promise((resolve, reject) => {
    const child = spawn(bin, languages, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(Object.assign(new Error(err.trim() || `glovebox-ocr exited ${code}`), { code: "failed" }));
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(Object.assign(new Error("glovebox-ocr printed something unexpected"), { code: "failed" }));
      }
    });
    child.stdin.end(imageBuffer);
  });
}
