// Cross-language parity guard for cost arithmetic.
//
// Cost is computed in two places — runtime/jaroku_interceptor/pricing.py while a run
// executes, and server/src/pricing.ts for pre-run estimates and eval aggregation. They
// read the same runtime/pricing.json, but reading the same numbers is not the same as
// producing the same answer: a different rounding point, a different cache multiplier, or
// a different idea of what "input tokens" means and the estimate stops matching the bill.
//
// This runs the SAME cases through both and demands byte-identical output. It is the one
// test that has to pass before any eval cost number is trustworthy (doc §8: "wrong cost
// numbers destroy trust instantly").
//
//   npm run test:pricing

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { costFor, isPriced, priceFor, PRICING_PATH } from "./pricing.ts";

const RUNTIME_DIR = join(resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."), "runtime");

type Case = {
  name: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

const CASES: Case[] = [
  { name: "haiku 1M in / 1M out", model: "claude-haiku-4-5", inputTokens: 1_000_000, outputTokens: 1_000_000 },
  { name: "opus-5 realistic step", model: "claude-opus-5", inputTokens: 3_471, outputTokens: 812 },
  { name: "sonnet-5 realistic step", model: "claude-sonnet-5", inputTokens: 12_003, outputTokens: 47 },
  // Cache tokens must be billed at their own multipliers, not the full input rate — the
  // single most expensive way for these two to disagree.
  { name: "cache read only", model: "claude-haiku-4-5", inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 },
  { name: "cache write only", model: "claude-haiku-4-5", inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1_000_000 },
  {
    name: "mixed cached + uncached",
    model: "claude-opus-4-8",
    inputTokens: 1_234,
    outputTokens: 567,
    cacheReadTokens: 89_012,
    cacheWriteTokens: 3_456,
  },
  // A genuine zero must survive; the old `a or b` key lookup treated 0 as absent.
  { name: "all zeros", model: "claude-haiku-4-5", inputTokens: 0, outputTokens: 0 },
  // Longest-prefix resolution: a dated/suffixed variant must fall back to its base entry.
  { name: "prefix variant", model: "claude-haiku-4-5-20251001", inputTokens: 1_000, outputTokens: 1_000 },
  { name: "openai priced", model: "gpt-4o-mini", inputTokens: 500_000, outputTokens: 250_000 },
  // The free dry-run path is genuinely $0 — distinct from "unknown".
  { name: "fake dry run is free", model: "fake-dry-run", inputTokens: 9_999, outputTokens: 9_999 },
  // An unpriced model must be null on BOTH sides. Never 0.
  { name: "unpriced model", model: "some-unreleased-model", inputTokens: 1_000, outputTokens: 1_000 },
  { name: "unpriced near-miss", model: "claude", inputTokens: 1_000, outputTokens: 1_000 },
];

/** Render one result the same way on both sides, so comparison is a string compare. */
function fmt(cost: number | null): string {
  return cost === null ? "null" : cost.toFixed(8);
}

// --- python side ---------------------------------------------------------------------
const PY = existsSync(join(RUNTIME_DIR, ".venv/bin/python"))
  ? join(RUNTIME_DIR, ".venv/bin/python")
  : "python3";

const script = `
import json, sys
sys.path.insert(0, ${JSON.stringify(RUNTIME_DIR)})
from jaroku_interceptor.pricing import cost_for
out = []
for c in json.load(sys.stdin):
    v = cost_for(
        c["model"],
        input_tokens=c["inputTokens"],
        output_tokens=c["outputTokens"],
        cache_read_tokens=c.get("cacheReadTokens", 0),
        cache_write_tokens=c.get("cacheWriteTokens", 0),
    )
    out.append("null" if v is None else format(v, ".8f"))
print(json.dumps(out))
`;

const proc = spawnSync(PY, ["-c", script], { input: JSON.stringify(CASES), encoding: "utf8" });
if (proc.status !== 0) {
  console.error(`  FAIL could not run the Python reader (${PY}):\n${proc.stderr || proc.error?.message}`);
  process.exit(1);
}
const pyResults = JSON.parse(proc.stdout.trim()) as string[];

// --- compare -------------------------------------------------------------------------
let fail = 0;
console.log(`  table: ${PRICING_PATH}`);

CASES.forEach((c, i) => {
  const ts = fmt(costFor(c.model, c));
  const py = pyResults[i];
  if (ts !== py) {
    fail++;
    console.log(`  FAIL ${c.name}: ts=${ts} py=${py}`);
  } else {
    console.log(`  ok   ${c.name} = ${ts}`);
  }
});

// --- invariants the parity check alone can't express ---------------------------------

// An unpriced model must be null, not zero. This is the trust-critical one: a $0.00 in a
// provider comparison reads as "free", which is a different (and false) claim than
// "unknown". Assert it explicitly rather than inferring it from the parity rows.
{
  const cost = costFor("definitely-not-a-model", { inputTokens: 10_000, outputTokens: 10_000 });
  const ok = cost === null && !isPriced("definitely-not-a-model");
  if (!ok) { fail++; console.log(`  FAIL unpriced model returned ${cost} (must be null)`); }
  else console.log("  ok   unpriced model is null, not zero");
}

// Longest prefix wins, not first-match. The old substring walk over an unordered dict
// could resolve a suffixed model to whichever similar key came first.
{
  const p = priceFor("claude-opus-4-8-experimental");
  const ok = p?.id === "claude-opus-4-8";
  if (!ok) { fail++; console.log(`  FAIL longest-prefix resolved to ${p?.id}`); }
  else console.log("  ok   longest prefix wins over shorter matches");
}

// Cache reads must be strictly cheaper than the same tokens uncached, and cache writes
// strictly dearer — if a multiplier is dropped these collapse to equal.
{
  const uncached = costFor("claude-haiku-4-5", { inputTokens: 100_000, outputTokens: 0 })!;
  const read = costFor("claude-haiku-4-5", { inputTokens: 0, outputTokens: 0, cacheReadTokens: 100_000 })!;
  const write = costFor("claude-haiku-4-5", { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 100_000 })!;
  const ok = read < uncached && write > uncached;
  if (!ok) { fail++; console.log(`  FAIL cache rates not applied: uncached=${uncached} read=${read} write=${write}`); }
  else console.log(`  ok   cache read (${read}) < uncached (${uncached}) < cache write (${write})`);
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
