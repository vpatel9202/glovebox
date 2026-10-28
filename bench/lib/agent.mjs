// A minimal agent loop over the Messages API, identical for every setup. It
// records usage per round trip and the size of every tool result, and keeps
// the transcript append-only (no pruning) so prompt caching and preserved
// thinking behave as they would in a real agent.
import Anthropic from "@anthropic-ai/sdk";

// $ per million tokens. Cache writes use the 5-minute TTL (1.25x input).
export const PRICES = {
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};

export class BudgetError extends Error {}

export function costOf(model, usage) {
  const p = PRICES[model];
  if (!p) throw new Error(`No price for ${model}; add it to PRICES in bench/lib/agent.mjs`);
  return (
    (usage.input * p.input + usage.cacheWrite * p.cacheWrite + usage.cacheRead * p.cacheRead + usage.output * p.output) / 1e6
  );
}

const SYSTEM = `You operate apps on the user's Mac through the tools provided. Complete the task yourself without asking questions. When the task is done, reply with one line starting with DONE. If you cannot finish, reply with one line starting with FAILED and the reason.`;

// Dimensions from a PNG or JPEG header, for image accounting.
function imageSize(base64) {
  const b = Buffer.from(base64.slice(0, 200_000), "base64");
  if (b[0] === 0x89 && b[1] === 0x50) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  for (let i = 2; i < b.length - 9; ) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    const len = b.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc3) return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
    i += 2 + len;
  }
  return null;
}

// Visual tokens the API bills for an image after fitting it to the current
// models' limits (2576 px long edge, 4784 visual tokens of 28x28 px).
export function visualTokens({ width, height }) {
  let s = Math.min(1, 2576 / Math.max(width, height));
  const tokens = (k) => Math.ceil((width * k) / 28) * Math.ceil((height * k) / 28);
  while (tokens(s) > 4784) s *= 0.98;
  return tokens(s);
}

function resultStats(results) {
  let chars = 0;
  const images = [];
  for (const r of results) {
    for (const c of r.content ?? []) {
      if (c.type === "text") chars += c.text.length;
      if (c.type === "image") {
        const size = imageSize(c.source.data) ?? { width: 0, height: 0 };
        images.push({ ...size, tokens: size.width ? visualTokens(size) : 0 });
      }
    }
  }
  return { chars, images };
}

export async function runAgent({ model, effort, setup, prompt, followUps = [], maxTurns = 40, budget }) {
  const client = new Anthropic();
  const system = setup.instructions ? `${SYSTEM}\n\nNotes from the tool server:\n${setup.instructions}` : SYSTEM;
  const messages = [];
  const turns = [];
  const segments = [];
  const usage = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  let finalText = "";
  let stopReason = null;

  for (const userText of [prompt, ...followUps]) {
    messages.push({ role: "user", content: userText });
    const segmentStart = turns.length;
    for (;;) {
      if (turns.length >= maxTurns) {
        stopReason = "max_turns";
        break;
      }
      const started = Date.now();
      const response = await client.messages.create({
        model,
        max_tokens: 16000,
        thinking: { type: "adaptive" },
        output_config: { effort },
        cache_control: { type: "ephemeral" },
        system,
        tools: setup.tools,
        messages,
      });
      const u = response.usage;
      const turn = {
        input: u.input_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        modelMs: Date.now() - started,
        stop: response.stop_reason,
        calls: [],
      };
      for (const k of Object.keys(usage)) usage[k] += turn[k];
      turns.push(turn);
      messages.push({ role: "assistant", content: response.content });
      stopReason = response.stop_reason;

      const spent = costOf(model, usage);
      if (budget && budget.spent + spent > budget.cap) throw Object.assign(new BudgetError(`Budget of $${budget.cap} reached`), { usage, turns });

      const toolUses = response.content.filter((b) => b.type === "tool_use");
      if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
        finalText = response.content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
        break;
      }
      const toolStarted = Date.now();
      const results = await setup.execute(toolUses);
      turn.toolMs = Date.now() - toolStarted;
      const stats = resultStats(results);
      turn.resultChars = stats.chars;
      turn.images = stats.images;
      turn.calls = toolUses.map((b, i) => ({
        name: b.name,
        input: b.input,
        error: results[i]?.is_error === true,
        text: (results[i]?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n"),
      }));
      messages.push({ role: "user", content: results });
    }
    segments.push({ turns: turns.length - segmentStart });
    if (stopReason === "max_turns" || stopReason === "refusal") break;
  }

  return { usage, turns, segments, finalText, stopReason, cost: costOf(model, usage) };
}
