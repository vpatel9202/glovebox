// Unit tests for the harness parts that decide spend and scoring. No model
// calls and no apps: `node --test bench/test/`.
import assert from "node:assert/strict";
import test from "node:test";
import { costOf, turnCost } from "../lib/agent.mjs";
import { quantile, sideDoors } from "../lib/metrics.mjs";
import { LIMITS, mcpContentToApi } from "../lib/setups.mjs";

const turn = (input, cacheRead, output) => ({ input, cacheWrite: 0, cacheRead, output });

test("Haiku requests over 100K prompt tokens use the long rate card", () => {
  const short = turnCost("claude-haiku-5-5", turn(1000, 90_000, 1000));
  const long = turnCost("claude-haiku-5-5", turn(1000, 110_000, 1000));
  assert.ok(Math.abs(short - (1000 * 0.1 + 90_000 * 0.01 + 1000 * 0.5) / 1e6) < 1e-12);
  assert.ok(Math.abs(long - (1000 * 0.5 + 110_000 * 0.05 + 1000 * 2.5) / 1e6) < 1e-12);
  // Sonnet has one rate card at any length.
  assert.equal(costOf("claude-sonnet-5-5", [turn(0, 200_000, 0)]), 0.04);
});

test("tool inputs that reach around the UI are flagged", () => {
  const calls = (...inputs) => [{ calls: inputs.map((input) => ({ input })) }];
  assert.deepEqual(sideDoors(calls({ code: "await app.click(3); await app.typeText('x')" })), []);
  assert.deepEqual(sideDoors(calls({ code: "executeStep(); const fsx = 1" })), []);
  assert.equal(sideDoors(calls({ code: "fs.renameSync('a', 'b')" })).length, 1);
  assert.equal(sideDoors(calls({ code: "const cp = require('child_process')" })).length, 2);
  assert.equal(sideDoors(calls({ text: "defaults write com.apple.TextEdit RichText 0" })).length, 1);
});

test("quantiles skip missing values", () => {
  assert.equal(quantile([], 0.9), null);
  assert.equal(quantile([null, 0.02, 0.01, 0.1], 0.9), 0.1);
  assert.equal(quantile([3, 1, 2], 0.5), 2);
});

test("tool results are capped the same way for every setup", () => {
  const [block] = mcpContentToApi([{ type: "text", text: "x".repeat(LIMITS.textChars + 50) }]);
  assert.ok(block.text.length < LIMITS.textChars + 80);
  assert.match(block.text, /truncated by the benchmark/);
  assert.deepEqual(mcpContentToApi([]), [{ type: "text", text: "(no output)" }]);
});
