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
import { allPrices, costFor, isPriced, priceFor, PRICING_PATH } from "./pricing.ts";
import { PROVIDER_LABEL } from "./providers.ts";

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

// LOADED INTO A STAND-IN PACKAGE rather than imported, and the import is why this suite could
// not run. `from jaroku_interceptor.pricing import cost_for` executes the package's
// __init__.py first, which imports `.callback`, which imports langchain_core — so comparing two
// arithmetic implementations required the entire hosted extra to be installed. It is not
// installed in CI and it is not installed on a machine that has only ever run `npm run dev`,
// which is most of them; the suite reported `could not run the Python reader (python3)` and the
// parity it exists to check went unchecked.
//
// `pricing.py` imports json, dataclasses, pathlib and typing. Nothing else. So the package is
// faked — an empty module carrying a __path__, registered under the real name — and the module
// is loaded into it by path. __init__.py never runs, `__file__` stays where it belongs so the
// price table beside it still resolves, and a relative import would still work if this module
// ever grows one. Same shape as the loader in checkpoints/threads.test.ts, for the same reason.
const script = `
import importlib.util, json, os, sys, types
PKG = os.path.join(${JSON.stringify(RUNTIME_DIR)}, "jaroku_interceptor")
pkg = types.ModuleType("jaroku_interceptor")
pkg.__path__ = [PKG]
sys.modules["jaroku_interceptor"] = pkg
spec = importlib.util.spec_from_file_location("jaroku_interceptor.pricing", os.path.join(PKG, "pricing.py"))
mod = importlib.util.module_from_spec(spec)
sys.modules["jaroku_interceptor.pricing"] = mod
spec.loader.exec_module(mod)
cost_for = mod.cost_for
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

// --- the SELECTABLE CATALOGUE is this file, and cannot drift from it -------------------------
//
// WHAT THIS REPLACES. The client held its own list of selectable models, and it had fallen four
// models behind this table — including `claude-opus-5`, the newest priced entry — so a model the
// product knew how to price, run and meter could not be chosen for a run, added as an eval leg, or
// deployed with. Nothing failed, because nothing compared the two lists: `test:pricing` asserted the
// table parses and prices correctly, and nothing asserted that what the table prices is what the
// product offers. The catalogue is built from `allPrices()` and shipped on the providers snapshot
// now, so the drift is not expressible — and these are the properties that make that safe.
{
  const table = allPrices();
  if (table.length === 0) { fail++; console.log("  FAIL the price sheet is empty, so the catalogue would be too"); }
  else console.log(`  ok   the catalogue has something in it (${table.length} models)`);

  // EVERY MODEL NAMES A PROVIDER. The catalogue groups by this field, and a blank one would produce
  // an unnamed group in every model selector in the product.
  const unnamed = table.filter((p) => !p.provider);
  if (unnamed.length) { fail++; console.log(`  FAIL models with no provider: ${unnamed.map((p) => p.id).join(", ")}`); }
  else console.log("  ok   every priced model names its provider");

  // EVERY PROVIDER HAS A LABEL. It travels with the model so the browser keeps no copy of this
  // mapping; a provider missing here renders as its raw id, which is how one provider came to be
  // called two different things in two surfaces.
  const providers = [...new Set(table.map((p) => p.provider))];
  const unlabelled = providers.filter((id) => !(id in PROVIDER_LABEL));
  if (unlabelled.length) { fail++; console.log(`  FAIL providers with no display name: ${unlabelled.join(", ")}`); }
  else console.log(`  ok   every provider in the price sheet has a display name (${providers.join(", ")})`);

  // THE DRY-RUN PATH IS IN THE TABLE, marked free. It is the default provider and model of every
  // fresh tab, and it is the client's one pre-snapshot fallback — if it left the price sheet, that
  // fallback would name a model the server does not offer.
  const dry = table.find((p) => p.id === "fake-dry-run");
  if (!dry || !dry.free || dry.provider !== "fake") {
    fail++;
    console.log(`  FAIL the free dry-run model is missing or not marked free (${JSON.stringify(dry)})`);
  } else console.log("  ok   the dry-run model is in the table and marked free");

  // AND EVERY MODEL RESOLVES THROUGH THE FUNCTION THAT WILL BE ASKED ABOUT IT. A row this file
  // parsed but `priceFor` cannot resolve would be selectable and would meter as unknown cost.
  const unresolvable = table.filter((p) => !isPriced(p.id));
  if (unresolvable.length) { fail++; console.log(`  FAIL selectable but unpriced: ${unresolvable.map((p) => p.id).join(", ")}`); }
  else console.log("  ok   every model the catalogue offers resolves to a price");
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
