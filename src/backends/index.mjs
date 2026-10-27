// Picks the backend for this OS. Each backend exposes request(method, params)
// with the same methods and emits "escape" when the user presses Escape.
// See docs/backend-protocol.md for the contract a new OS backend implements.
import { MacBackend } from "./macos.mjs";

export function createBackend(options) {
  switch (process.platform) {
    case "darwin":
      return new MacBackend(options);
    default:
      return new UnsupportedBackend(process.platform);
  }
}

class UnsupportedBackend {
  constructor(platform) {
    this.platform = platform;
  }
  on() {
    return this;
  }
  async request() {
    throw new Error(
      `glovebox has no ${this.platform} backend yet. macOS is supported today; Windows and Linux are planned (see docs/roadmap.md).`,
    );
  }
}
