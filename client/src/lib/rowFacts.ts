// TWO SLOTS CARRY TWO FACTS, or the second one is not there.
//
// The Usage panel's rows have a label over a sub — an agent name over a short run id, which is
// exactly right when there is an agent name. *Most expensive runs* falls back to the run id when a
// run has none, and the fallback and the sub are the same expression:
//
//   label={r.label ?? r.runId.slice(0, 8)}
//   sub={r.runId.slice(0, 8)}
//
// So half the rows in the panel rendered `1c7c8878` over `1c7c8878`, spending two lines to say one
// thing — and saying nothing at all about which agent the run belonged to, which is the fact the
// two-line shape exists to carry.
//
// THE RULE BELONGS TO THE ROW RATHER THAN TO THE CALL SITE. Every one of these sections composes a
// label from one field and a sub from another, and any of them can be handed the same string twice
// by data rather than by a mistake in the JSX — an agent whose display name IS its slug, a kind
// whose payer is its own name. Suppressing at the row means one line renders one line, wherever the
// coincidence comes from.
//
// COMPARED AFTER TRIMMING AND WITHOUT CASE, because `Test_Agent` over `test_agent` is the same fact
// told twice as surely as an exact match is, and a trailing space is not a second fact either.
//
//   npm run test:row-facts

/**
 * The sub to render beneath `label`, or undefined when it would repeat it.
 *
 * Undefined rather than an empty string: the row renders the element conditionally, and an empty
 * one would leave the vertical space a second line occupies under every row that has nothing to put
 * in it — which is the same misalignment the collapse is meant to avoid.
 */
export function distinctSub(label: string, sub: string | null | undefined): string | undefined {
  if (sub == null) return undefined;
  const trimmed = sub.trim();
  if (!trimmed) return undefined;
  return trimmed.toLowerCase() === label.trim().toLowerCase() ? undefined : sub;
}
