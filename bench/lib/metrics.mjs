// Per-run counters derived from the recorded turns.
//
// The read counters apply to glovebox only, because they are about its diff:
// - fullReads / diffReads / noChangeReads: tree reads by kind.
// - reprints: a full tree printed again for a window already printed in this
//   run, without disableDiffing. The roadmap's baseline-mismatch bugs show up
//   here (a title change, for example, reprints the whole tree).
// - noChangeThenRead: a "no change" result whose next call starts by reading
//   again before acting, which suggests the agent did not trust or understand it.
const HEADER = /^(.+) — window (\d+) "(.*)" — image \d+x\d+( — changes since last read| — no change\.)?/gm;
const READ = /getAXState|getScreenshot|getAXStateAndScreenshot/;
const ACTION = /\.(click|doubleClick|rightClick|pressKey|typeText|scroll|drag|setValue|focus|selectText|performSecondaryAction|activate)\(/;

function gloveboxReads(turns) {
  const counts = { fullReads: 0, diffReads: 0, noChangeReads: 0, reprints: 0, noChangeThenRead: 0 };
  const seen = new Set();
  const calls = turns.flatMap((t) => t.calls);
  calls.forEach((call, i) => {
    if (call.name !== "js") return;
    const code = String(call.input?.code ?? "");
    let sawNoChange = false;
    for (const m of call.text.matchAll(HEADER)) {
      const key = `${m[1]}|${m[2]}`;
      if (m[4]?.includes("no change")) {
        counts.noChangeReads += 1;
        sawNoChange = true;
      } else if (m[4]) counts.diffReads += 1;
      else {
        counts.fullReads += 1;
        if (seen.has(key) && !/disableDiffing\s*:\s*true/.test(code)) counts.reprints += 1;
      }
      seen.add(key);
    }
    if (sawNoChange) {
      const next = String(calls[i + 1]?.input?.code ?? "");
      const read = next.search(READ);
      const action = next.search(ACTION);
      if (read >= 0 && (action < 0 || read < action)) counts.noChangeThenRead += 1;
    }
  });
  return counts;
}

export function summarize(setupName, task, agent) {
  const images = agent.turns.flatMap((t) => t.images ?? []);
  const summary = {
    roundTrips: agent.turns.length,
    roundTripsPerSegment: agent.segments.map((s) => s.turns),
    toolCalls: agent.turns.reduce((n, t) => n + t.calls.length, 0),
    toolErrors: agent.turns.reduce((n, t) => n + t.calls.filter((c) => c.error).length, 0),
    resultChars: agent.turns.reduce((n, t) => n + (t.resultChars ?? 0), 0),
    images: images.length,
    imagePixels: images.reduce((n, i) => n + i.width * i.height, 0),
    imageTokensEst: images.reduce((n, i) => n + i.tokens, 0),
    screenshotsOnTextTask: task.kind === "text" ? images.length : null,
    modelMs: agent.turns.reduce((n, t) => n + t.modelMs, 0),
    toolMs: agent.turns.reduce((n, t) => n + (t.toolMs ?? 0), 0),
  };
  if (setupName === "glovebox") summary.reads = gloveboxReads(agent.turns);
  return summary;
}
