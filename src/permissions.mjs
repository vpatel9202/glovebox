// Waiting for the user to grant a macOS permission to the helper.
//
// After a grant, macOS offers to quit and reopen the helper. Either answer
// must work. If the user quits it, the request in flight fails and the next
// one reconnects (relaunching the helper). If the user leaves it running, a
// running process can keep reporting the old answer, so a helper that still
// says no is restarted every `restartMs` and a fresh process asks again.
export async function waitForPermission(backend, check, { minutes = 5, restartMs = 6000, pollMs = 1500, restart } = {}) {
  const deadline = Date.now() + minutes * 60_000;
  let restarted = Date.now();
  while (Date.now() < deadline) {
    try {
      if (check(await backend.request("permissions", {}))) return true;
    } catch {
      // The helper quit (macOS "Quit & Reopen"); the next request reconnects.
      restarted = Date.now();
    }
    if (Date.now() - restarted >= restartMs) {
      backend.close();
      await restart();
      restarted = Date.now();
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return false;
}
