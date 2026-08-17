// What a thread's cost says, and what it refuses to claim.
//
// THREE STATES, THREE STRINGS, and the reason is §9's rule rather than formatting taste:
//
//   NOTHING SPENT YET renders as nothing at all. Not "$0", which is a claim — a thread opened a
//   minute ago has not been measured, and a zero next to a real figure one row down reads as "this
//   one was free".
//
//   A COMPLETE TOTAL renders as `$0.04`.
//
//   AN INCOMPLETE ONE renders as `$0.04+`. Something in the thread ran on an unpriced model, so the
//   figure is a floor. The `+` is the whole difference between a number somebody can act on and a
//   number that is confidently wrong, which is the failure mode `pricing.ts` has refused since
//   v0.1.9.
//
// TWO DECIMALS, NOT FOUR. `fmtCost` in lib/format.ts renders four (or five under a cent) because it
// labels ONE step or ONE run, where the difference between $0.0004 and $0.0009 is the whole
// measurement. A thread is a session's cumulative spend and the question it answers is "was this
// expensive" — so it is shown the way the spec writes it, and a sub-cent total says so rather than
// padding two zeros onto a number that has none.

/** Below this, a two-decimal render would be `$0.00` — a zero for money that was really spent. */
const SUB_CENT = 0.01;

/**
 * §4.3's cost cell, or null when there is nothing honest to put in it.
 *
 * Null rather than an empty string, so a row built out of `·` separators can drop the separator too
 * rather than rendering a dot with nothing beside it.
 */
export function fmtThreadCost(usd: number | null | undefined, known = true): string | null {
  if (usd === null || usd === undefined) return null;
  // A real figure that rounds to nothing at two decimals. `<$0.01` rather than `$0.00`: the spend
  // happened, and the row's job is to say it was small rather than to say it was nothing.
  const figure = usd > 0 && usd < SUB_CENT ? "<$0.01" : `$${usd.toFixed(2)}`;
  return known ? figure : `${figure}+`;
}
