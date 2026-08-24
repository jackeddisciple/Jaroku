// The response metadata row — §6's ordering and formatting rules, as functions rather than as JSX.
//
// §6.5 IS THE RULE THIS FILE EXISTS FOR: "Fixed order: model → effort → build → duration → variant
// switcher. Never reorder based on availability; absent items collapse, the rest hold position.
// Stability matters more than density — people learn the position of the thing they check most."
//
// Reordering on availability is the natural thing to write. You have four optional items, you map
// over the ones that exist, and the row looks perfect on every turn you happen to be looking at.
// What it costs is that the duration is in a different place on a turn that produced code than on
// one that did not — so the number somebody glances at forty times an hour moves depending on what
// the response happened to do.
//
// AND §6.2's OMISSION IS NOT THE SAME AS AN ABSENCE. A model with no reasoning control omits the
// effort chip ENTIRELY rather than showing a meaningless "Low" — but a model that clamped shows the
// applied level with a marker. Those are two different states of the same slot, and collapsing them
// would either invent a level nobody used or hide a downgrade somebody paid for.
//
//   npm run test:turn-metadata

/** §6.5's order, and there is no other. */
export const METADATA_SLOTS = ["model", "effort", "build", "duration", "variants"] as const;

export type MetadataSlot = (typeof METADATA_SLOTS)[number];

/** What one variant of a turn reports about itself. Every field can genuinely be unknown. */
export interface TurnMeta {
  modelId: string | null;
  provider: string | null;
  /** What was asked for, and what was spent. §6.2's clamp marker is the comparison of the two. */
  effortRequested: string | null;
  effortApplied: string | null;
  /** Whether the model exposes a reasoning control at all. False → the chip is omitted. */
  effortSupported: boolean;
  /** Set only when this turn produced agent code — a new `agent_versions` row. */
  versionLabel: string | null;
  versionStaged: boolean;
  diffPlus: number | null;
  diffMinus: number | null;
  durationMs: number | null;
  /** 1-based. `total` above 1 is what renders the `‹ 2/2 ›` switcher. */
  ordinal: number;
  total: number;
}

/**
 * Which slots this turn has anything to put in.
 *
 * A SET RATHER THAN A FILTERED LIST, because the caller must walk `METADATA_SLOTS` and skip — not
 * walk this and render. The difference is exactly §6.5: iterate the fixed order and omit, and
 * positions hold; iterate the present ones, and they do not.
 */
export function presentSlots(meta: TurnMeta): Set<MetadataSlot> {
  const slots = new Set<MetadataSlot>();
  if (meta.modelId) slots.add("model");
  // §6.2: "Model has no reasoning control: omit the chip entirely rather than showing a
  // meaningless 'Low'." An applied level with no support behind it is a level nobody spent.
  if (meta.effortSupported && meta.effortApplied) slots.add("effort");
  // §6.3: "Present only when the turn produced agent code."
  if (meta.versionLabel) slots.add("build");
  // A duration of null is unmeasured; a duration of 0 is a response that took under a millisecond,
  // which does not happen. Only null is absent.
  if (meta.durationMs !== null) slots.add("duration");
  // §5.4's switcher appears once there is something to switch between. One variant is not a choice.
  if (meta.total > 1) slots.add("variants");
  return slots;
}

/** True when the applied level is below what was asked for — §6.2's clamp marker. */
export function isClamped(meta: TurnMeta): boolean {
  if (!meta.effortSupported) return false;
  if (!meta.effortRequested || !meta.effortApplied) return false;
  return meta.effortRequested !== meta.effortApplied;
}

/**
 * §6.4: "12.4s under a minute, 1m 04s above."
 *
 * THE SECONDS ARE ZERO-PADDED ABOVE A MINUTE and are not below it, which looks inconsistent and is
 * not: "1m 4s" reads as a typo next to "1m 14s" in a column, while "4.2s" is simply a number. The
 * spec writes both forms out, and this is why.
 */
export function formatDuration(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return null;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${minutes}m ${String(rest).padStart(2, "0")}s`;
}

/** The switcher's label — the `2/2` in `‹ 2/2 ›`. Null when there is nothing to switch. */
export function variantLabel(meta: TurnMeta): string | null {
  if (meta.total <= 1) return null;
  return `${meta.ordinal}/${meta.total}`;
}

/**
 * §6.3's trailing DiffStat, "when the diff is small enough to summarize".
 *
 * SMALL ENOUGH IS A NUMBER AND IT IS HERE. Past a few dozen lines the figures stop being a summary
 * and start being a statistic — "+412/−390" tells nobody anything the version label did not, and it
 * widens the row enough to wrap it on a narrow composer. Under the threshold the pair genuinely
 * answers "is this a tweak or a rewrite" at a glance.
 */
export const DIFF_SUMMARY_MAX = 100;

export function diffSummary(meta: TurnMeta): { plus: number; minus: number } | null {
  const { diffPlus: plus, diffMinus: minus } = meta;
  if (plus === null || minus === null) return null;
  if (plus + minus > DIFF_SUMMARY_MAX) return null;
  return { plus, minus };
}
