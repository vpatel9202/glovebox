// Picks the backend for this OS, and makes backends for attached devices.
// Each backend exposes request(method, params) with the same methods and
// emits "escape" when the user presses Escape (device backends also emit
// "exit" when their server stops). See docs/backend-protocol.md for the
// contract a new backend implements.
import { AndroidBackend } from "./android.mjs";
import { MacBackend } from "./macos.mjs";

export function createBackend(options) {
  switch (process.platform) {
    case "darwin":
      return new MacBackend(options);
    default:
      return new UnsupportedBackend(process.platform);
  }
}

// A backend for one Android device, named by ADB serial (or the only one).
export function createDeviceBackend(options) {
  return new AndroidBackend(options);
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
      `glovebox has no ${this.platform} desktop backend yet. macOS is supported today; Android devices work through gb.device(). Windows and Linux are planned (see docs/roadmap.md).`,
    );
  }
}
