// Where each composer control sits, at every width.
//
// §3.1's layout is one sentence with a lot of consequences: "all seven controls in a single row,
// in this fixed order, left to right", with a flex spacer between the fifth and the sixth. The
// consequences are the reason this is a module rather than a class string.
//
// THE SPEC FORBIDS `justify-content: space-between` ACROSS THE ROW, and names why: controls appear
// and disappear — the connector deck is absent with zero connectors, the effort control is hidden
// on a model with no reasoning — and space-between redistributes the gap between every remaining
// item, so hiding one control moves all of them. A user who learned that the shield is the fourth
// thing from the left finds it in a different place on a different model. Left group packs left,
// right group packs right, one spacer absorbs the difference, and every position a user learned
// stays where they learned it. That is the whole argument, and it is why `sideOf` is a table
// rather than a guess.
//
// THE BAR NEVER WRAPS. Below ~560px there is not room for eight controls, and the two ways out are
// a second row or an overflow menu. A second row would move the send button — the most-used
// control in the product — to a position that depends on the window width, and would push the
// textarea up as the window narrowed. So: an overflow menu, at a FIXED position (3), holding
// exactly the three controls that are settings rather than actions.
//
// AND THREE CONTROLS NEVER COLLAPSE. ⊕, mic and send are the highest-frequency actions in the
// composer, and a high-frequency action behind a `⋯` is a control that costs two clicks forever.
// `PINNED` is that rule, and `layoutBar` refuses to put a pinned control in the overflow no matter
// what it is asked.
//
// This module is pure on purpose. Everything above is an acceptance criterion (§12.1c, §12.1d) and
// a criterion that can only be checked by resizing a window is one nobody checks.
//
//   npm run test:composer-bar

/**
 * Every control the bar can hold, in the fixed left-to-right order of §3.1's table.
 *
 * `model` is the spec's control 6. It sits at the head of the right group because the left/right
 * split is meaningful rather than decorative: left controls change WHAT THE MODEL GETS, right
 * controls change WHO RUNS IT AND WHEN. Anything added later has to answer that question before it
 * gets a position here.
 */
export const CONTROL_ORDER = [
  "add",
  "fullscreen",
  "effort",
  "shield",
  "connectors",
  "promote",
  "model",
  "mode",
  "mic",
  "send",
] as const;

export type ControlId = (typeof CONTROL_ORDER)[number];

/**
 * Which side of the spacer a control lives on.
 *
 * `mode` — Jaroku's existing Chat/Test toggle — is not in the spec's table, because the spec
 * describes a composer that has one send mode. This one does not: Chat plans and edits, Test runs
 * the agent on the input. It goes in the EXECUTION group, and that is the left/right rule applied
 * rather than an exception to it — choosing Test does not change what the model is told, it
 * changes who receives the message and what running it means. Putting it in the input group would
 * have made the split decorative on its very first new member.
 */
const SIDE: Record<ControlId, "input" | "execution"> = {
  add: "input",
  fullscreen: "input",
  effort: "input",
  shield: "input",
  connectors: "input",
  promote: "input",
  model: "execution",
  mode: "execution",
  mic: "execution",
  send: "execution",
};

/** §3.1: "⊕, mic, and send never collapse and never move into overflow." */
const PINNED: ReadonlySet<ControlId> = new Set<ControlId>(["add", "mic", "send"]);

/**
 * The three that do collapse, and they are the three that are settings rather than actions.
 *
 * Order matters here and is the bar's own: an overflow menu that listed them in some other order
 * would be a third arrangement of the same controls for a user to learn.
 *
 * `promote` — save this test input to the eval dataset — is the fourth, and it is here rather than
 * pinned for the same reason the other three are: it is a low-frequency action on a control bar
 * where ⊕, mic and send are pressed constantly. It also only exists in Test mode, so on most
 * composers it is absent entirely and `layoutBar` never sees it.
 */
const COLLAPSIBLE: readonly ControlId[] = ["effort", "shield", "connectors", "promote"];

/**
 * Where the `⋯` trigger goes when there is one: position 3, after ⊕ and fullscreen.
 *
 * A FIXED POSITION RATHER THAN THE END OF THE GROUP. The three controls it replaces occupied
 * positions 3, 4 and 5, so putting their menu anywhere else would move them twice — once into the
 * menu and once across the bar.
 */
export const OVERFLOW_INDEX = 2;

/**
 * The two widths at which the bar changes, in px, measured on the COMPOSER rather than the window.
 *
 * On the composer because that is the box the controls have to fit in, and it is not the window: a
 * 1400px window with both side panels open leaves the middle panel around 600px, and a bar that
 * consulted the window would render its full-width layout into a box too narrow to hold it. This
 * was the actual bug the first pass had.
 */
export const BREAKPOINT = {
  /** Below this, labelled controls drop their text and render icon-only. */
  labels: 720,
  /** Below this, the three collapsible controls move into the overflow menu. */
  overflow: 560,
} as const;

export type Density = "full" | "dense" | "overflow";

/** Which of the three layouts a composer of this width gets. */
export function densityFor(width: number): Density {
  if (width < BREAKPOINT.overflow) return "overflow";
  if (width < BREAKPOINT.labels) return "dense";
  return "full";
}

/** Whether a control shows its text label ("High", "Smart") or renders as a bare glyph. */
export function showsLabel(density: Density): boolean {
  return density === "full";
}

export interface BarLayout {
  /** The input-shaping group, left-packed, in order. */
  left: ControlId[];
  /** What the `⋯` menu holds, in bar order. Empty when there is no overflow. */
  overflow: ControlId[];
  /** The execution group, right-packed, in order. */
  right: ControlId[];
}

/**
 * Place the controls that are present at this density.
 *
 * `present` is the set that EXISTS right now — a non-reasoning model drops `effort`, a workspace
 * with no connectors drops `connectors`. Absence collapses the control out and moves nothing else,
 * which is §12.1c, and it falls out of the fact that both groups are packed rather than spread.
 *
 * Note what this deliberately does NOT do: it never reorders. `CONTROL_ORDER` is applied as a
 * filter, so a caller cannot produce a bar with send before mic by passing them in that order.
 */
export function layoutBar(present: Iterable<ControlId>, density: Density): BarLayout {
  const have = new Set(present);
  const collapsing = density === "overflow";

  const overflow = collapsing
    ? COLLAPSIBLE.filter((id) => have.has(id) && !PINNED.has(id))
    : [];
  const inOverflow = new Set(overflow);

  const left: ControlId[] = [];
  const right: ControlId[] = [];
  for (const id of CONTROL_ORDER) {
    if (!have.has(id) || inOverflow.has(id)) continue;
    (SIDE[id] === "input" ? left : right).push(id);
  }
  return { left, overflow, right };
}

/**
 * Where the `⋯` trigger renders inside the left group, or -1 when there is nothing behind it.
 *
 * Clamped to the group's length rather than assumed: with `fullscreen` hidden the left group is
 * one item long, and splicing at index 2 into a one-item array would silently put the menu at the
 * end — the same "position depends on what else is visible" failure the fixed index exists to
 * prevent.
 */
export function overflowSlot(layout: BarLayout): number {
  if (layout.overflow.length === 0) return -1;
  return Math.min(OVERFLOW_INDEX, layout.left.length);
}
