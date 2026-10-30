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

// Tool inputs that reach around the UI: a Node REPL tool (Codex's cua_repl)
// could rename the file or write the setting directly. A run that does this
// is counted as failed, and the patterns are listed in bench/README.md.
const SIDE_DOORS = [/\brequire\s*\(/, /\bimport\s*\(/, /\bfs\.\w+/, /child_process/, /\bexecSync\b|\bexec(File)?\s*\(/, /\bspawn\s*\(/, /\bosascript\b/, /\bdefaults\s+write\b/];

export function sideDoors(turns) {
  const hits = new Set();
  for (const call of turns.flatMap((t) => t.calls)) {
    const text = JSON.stringify(call.input ?? {});
    for (const re of SIDE_DOORS) if (re.test(text)) hits.add(re.source);
  }
  return [...hits];
}

export function quantile(values, q) {
  const v = values.filter((x) => x != null).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.floor(q * v.length))];
}

// Prompt growth from one request to the next: what each tool call added.
function contextDeltas(turns) {
  const prompt = (t) => t.input + t.cacheWrite + t.cacheRead;
  return turns.slice(1).map((t, i) => prompt(t) - prompt(turns[i]));
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
    contextPerCall: { median: quantile(contextDeltas(agent.turns), 0.5), p90: quantile(contextDeltas(agent.turns), 0.9) },
    longPromptTurns: agent.turns.filter((t) => t.longPrompt).length,
    sideDoors: sideDoors(agent.turns),
    // glovebox says so in a read's header when it lands on a tooltip-sized window.
    smallWindowReads: agent.turns.flatMap((t) => t.calls).filter((c) => /a small or uncapturable window/.test(c.text)).length,
  };
  if (setupName === "glovebox") summary.reads = gloveboxReads(agent.turns);
  return summary;
}
