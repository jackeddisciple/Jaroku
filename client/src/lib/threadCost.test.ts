// The cost cell, and the three things it must never say.
//
// Every case here is §9's "unknown is not zero" rule in one column: a thread that has spent nothing
// must not read as free, a floor must not read as a total, and a real sub-cent spend must not round
// away to nothing.
//
//   npm run test:thread-cost

import { fmtRunningCost, fmtThreadCost, projectCost } from "./threadCost.ts";

let fail = 0;
const eq = (name: string, got: unknown, want: unknown): void => {
  if (got === want) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`); }
};

// --- nothing spent is not $0 -----------------------------------------------------------------
eq("a thread with no spend renders no cell at all", fmtThreadCost(null), null);
eq("...and undefined is the same answer", fmtThreadCost(undefined), null);

// --- the ordinary case -----------------------------------------------------------------------
eq("a complete total, as the spec writes it", fmtThreadCost(0.04), "$0.04");
eq("...two decimals, not four", fmtThreadCost(0.11), "$0.11");
eq("...and a bigger one", fmtThreadCost(2.9), "$2.90");
eq("rounding is ordinary rounding", fmtThreadCost(0.8249), "$0.82");

// --- a floor says so -------------------------------------------------------------------------
eq("an incomplete total is a floor, and the + is not optional",
  fmtThreadCost(0.04, false), "$0.04+");
eq("...at any size", fmtThreadCost(12.5, false), "$12.50+");

// --- money that is real but small ------------------------------------------------------------
// `$0.00` would be the worst string available here: the thread DID spend, and a zero next to a real
// figure one row down reads as "this provider is free" rather than "this was small".
eq("a real sub-cent spend does not round away to nothing", fmtThreadCost(0.004), "<$0.01");
eq("...and still says when it is a floor", fmtThreadCost(0.004, false), "<$0.01+");
eq("an exact zero is a zero, because nothing was unpriced and nothing was spent",
  fmtThreadCost(0), "$0.00");

// --- the boundary ----------------------------------------------------------------------------
eq("a cent renders as a cent", fmtThreadCost(0.01), "$0.01");
eq("just under a cent does not", fmtThreadCost(0.0099), "<$0.01");

// --- the projection (§4.3.3) -----------------------------------------------------------------
//
// The rule this section is about: a projection is only offered where there is a real denominator, and it
// is never presented with the confidence of a final figure. An eval knows `34/120`; a generation knows
// nothing of the kind, and inventing a number for it would be worse than the still figure it replaces.
eq("an eval part-way through projects a total",
  projectCost(0.82, { done: 34, total: 120 })?.toFixed(2), "2.89");
eq("no denominator, no projection", projectCost(0.82, null), null);
eq("nothing done yet is nothing to extrapolate from", projectCost(0, { done: 0, total: 120 }), null);
eq("a finished denominator is not a projection either", projectCost(2.9, { done: 120, total: 120 }), null);
eq("no spend recorded yet, no projection", projectCost(null, { done: 3, total: 9 }), null);

eq("the running cell shows both halves, and the tilde is not optional",
  fmtRunningCost(0.82, true, { done: 34, total: 120 }), "$0.82 → ~$2.89");
eq("...with no denominator it is just the live figure",
  fmtRunningCost(0.82, true, null), "$0.82");
eq("...and a floor stays a floor on the left half only",
  fmtRunningCost(0.82, false, { done: 34, total: 120 }), "$0.82+ → ~$2.89");
eq("a running thread that has spent nothing yet still has no cell",
  fmtRunningCost(null, true, { done: 0, total: 120 }), null);

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
