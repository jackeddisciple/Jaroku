// The two display helpers the Agents tab needs and `lib/format.ts` did not already have.
//
// HERE RATHER THAN IN `format.ts`, because both are about an AGENT rather than about a run: a size in
// the version history and a latency percentile on the Health tab. `format.ts` is the trace's
// vocabulary — durations, costs, tokens, relative times — and it is imported by nearly every panel
// in the app, so adding to it is adding to everybody's surface area.
//
// THEY FOLLOW THE SAME RULE EVERYTHING ELSE IN THAT FILE DOES: null is UNKNOWN and renders as an em
// dash, never as zero. `fmtCost` and `fmtLatency` already draw that line and §6 restates it for
// `creation_cost` specifically — a missing figure is not a zero.

import { ZERO_COST } from "./format.ts";

/**
 * A byte count, at the precision a person reads rather than the one a machine stores.
 *
 * BINARY UNITS AND ONE DECIMAL. An agent project is a few kilobytes and a version's manifest sums to
 * tens of them, so the useful distinction is between `4.2 KB` and `41 KB` — not between 4,301 and
 * 4,302 bytes, which is what `toLocaleString()` gives and which the file list already uses where a
 * single file's exact size genuinely is the fact.
 *
 * `0 B` IS A REAL ANSWER HERE and is not the unknown case: a version with no files is empty, which
 * is different from a version nobody measured. Nothing in this schema produces the second — 014's
 * `total_bytes` is NOT NULL with a default — so there is no null branch to write.
 */
export function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/**
 * A cost per run, which is a small number and needs more places than a total does.
 *
 * `fmtCost` FLOORS AT FIVE DECIMALS AND THAT IS NOT ENOUGH HERE. A workspace that spent four cents
 * across two hundred runs has a per-run cost of $0.0002, and the existing formatter renders that as
 * `$0.00020` — which is right — but one that spent it across two thousand renders `$0.00002`, and
 * the next order of magnitude down becomes `$0.00000`, a figure that reads as free. So this switches
 * to a per-thousand-runs form rather than adding decimals nobody can compare at a glance.
 *
 * NULL IS UNKNOWN, and §6 is explicit about the case it covers: "A model with no pricing entry shows
 * cost unknown and is excluded from any ranking." An agent that has not run in the window has no
 * denominator, which is the same absence for a different reason and gets the same answer.
 */
export function fmtCostPerRun(usd: number | null): string {
  if (usd === null) return "—";
  // THE SHARED ZERO, for the reason the other two share it: this is a third money formatter over
  // the same currency, and three spellings of nothing spent is the same defect as two.
  if (usd === 0) return ZERO_COST;
  if (usd >= 0.0001) return `$${usd.toFixed(4)}`;
  // Below a hundredth of a cent per run, the honest comparable unit is a thousand runs.
  return `$${(usd * 1000).toFixed(3)} / 1k runs`;
}
