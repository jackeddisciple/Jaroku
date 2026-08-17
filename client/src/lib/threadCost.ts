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

/**
 * §4.3.3's projected total: cost-so-far, extrapolated over a KNOWN denominator.
 *
 * LINEAR, AND ONLY WHERE THERE IS A DENOMINATOR. An eval knows its total step count — `34/120` — so
 * cost-per-completed-step times total is a figure somebody can act on: the difference between "this will
 * be about three dollars" and "no idea" is the difference between letting it run and stopping it now.
 * A running generation or an interactive run has no such number, and this returns null for them rather
 * than inventing one from a guess at how long a graph is.
 *
 * NULL AT ZERO DONE, too. Extrapolating from nothing gives either zero or infinity depending on which
 * way you write the arithmetic, and both are worse than saying nothing yet.
 */
export function projectCost(
  spent: number | null,
  progress: { done: number; total: number } | null,
): number | null {
  if (spent === null || !progress) return null;
  const { done, total } = progress;
  if (done <= 0 || total <= 0 || done >= total) return null;
  return (spent / done) * total;
}

/**
 * The cost cell for a RUNNING thread: what it has spent, and what that extrapolates to.
 *
 * `$0.82 → ~$2.90`, and the `~` is not optional. §9's unknown-is-not-zero discipline extends to
 * "estimated is not exact": the projection must never be presented with the confidence of a completed
 * thread's final figure, and a tilde is the cheapest honest way to say so. A `+` on the left half still
 * appears when something in the thread ran unpriced — the two flags answer different questions, and a
 * projection built on a floor is both incomplete AND an estimate.
 */
export function fmtRunningCost(
  spent: number | null,
  known: boolean,
  progress: { done: number; total: number } | null,
): string | null {
  const now = fmtThreadCost(spent, known);
  if (!now) return null;
  const projected = projectCost(spent, progress);
  if (projected === null) return now;
  // The projection carries no `+`: it is an estimate either way, and two hedges on one figure is one
  // more than a person can read.
  const target = fmtThreadCost(projected, true);
  return target ? `${now} → ~${target}` : now;
}
