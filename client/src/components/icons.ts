// The composer's size ladder, its hit target, and the one renderer for a mark chosen at runtime.
//
// WHAT THIS FILE USED TO BE, AND WHY IT IS NOT THAT ANY MORE. It was a second icon registry: a
// table of twenty tokens mapping to `@hugeicons/core-free-icons` payloads, drawn by
// `@hugeicons/react` at its own stroke weight of 1.5. It existed for a good reason — one place to
// fix a renamed export — and it was correct about that. It was just the second such place.
//
// `lib/icons/registry.ts` is now the first and only one, and this file's table moved into it
// wholesale: `Icon.Add` is `Icon.composer.attach`, `Icon.ThumbDown` is `Icon.turn.thumbDown`, and
// so on for all twenty. Two registries with two spellings of the same twenty jobs is exactly the
// arrangement icons_integration §0 says this product has already refused twice.
//
// TWO THINGS WENT WITH IT, AND BOTH WERE DELIBERATE DECISIONS REVERSED ON PURPOSE:
//
//   THE RUNTIME DEPENDENCY. `@hugeicons/react` walked an array of path tuples on every render,
//   which made the icon set a runtime dependency of the composer's control bar — the one row that
//   has to be on screen before anything else is. The marks are committed inline SVG now, written
//   by `scripts/gen-icons.mjs` at authoring time, and the package is a devDependency. I2.
//
//   THE SECOND STROKE WEIGHT. `GLYPH.strokeWidth` was 1.5 and this file argued, at length and not
//   unreasonably, that a Hugeicons mark at 1.75 sits heavier than the Lucide chrome around it. The
//   argument was sound and the consequence was not: the composer drew at 1.5 while everything
//   touching it drew at 1.75, so the seven controls in that bar were a different weight from the
//   panel they sit in. One weight, from `ICON.strokeWidth`, applied by the one factory in
//   `panelIcons.tsx`. I1. If that weight is ever wrong it is now wrong everywhere at once, which
//   is the property worth having.
//
// THE SIZE LADDER STAYED. Sizes are not weights: `toolbar` is 20 and `action` is 16 because of what
// those rows are for, and that reasoning survives the families merging. It is here rather than in
// `lib/tokens.ts`'s `ICON` because these five steps describe the composer and the turn rows
// specifically, and `ICON`'s four describe text-adjacent chrome.

import { createElement } from "react";

import type { IconComponent } from "../lib/icons/registry.ts";

/**
 * The size ladder, by context.
 *
 * Sizes only. The stroke weight is `ICON.strokeWidth`, for every mark in the app — see the header.
 */
export const GLYPH = {
  /** The composer's bottom control bar. */
  toolbar: 20,
  /** Under an assistant turn: copy, note, pin, regenerate, feedback. */
  action: 16,
  /** The response metadata row — subordinate to the small muted text it sits in. */
  meta: 14,
  /** Rows inside a dropdown or popover menu. */
  menu: 18,
  /** The glyph of an empty state. */
  empty: 32,
} as const;

/**
 * The minimum hit target for an icon-only control, in px, regardless of the glyph inside it.
 *
 * Thirty-two. A 20px glyph in a 20px button is a control you miss on a trackpad and cannot hit at
 * all on a touch screen, and the composer's bar is seven of them in a row — the place where a
 * near-miss costs the most, because the neighbour you hit instead is a different setting.
 *
 * `IconButton` enforces it for every icon-only control in the product; the composer's own buttons
 * apply it directly because several of them carry a caret or a value beside the mark.
 */
export const HIT_TARGET = 32;

/**
 * Draw a mark the caller picked at runtime.
 *
 * FOR DYNAMIC MARKS ONLY — `ICON_FOR[attachment.kind]`, a pin's kind, a source row's icon. A mark
 * known at authoring time is written as itself: `<Icon.turn.copy size={GLYPH.action} />`, which is
 * a component, because everything in the registry is one. This helper exists because JSX needs a
 * capitalised binding and `<ICON_FOR[a.kind] />` is not valid syntax.
 *
 * It is NOT a second icon path: it renders whatever registry component it is handed and decides
 * nothing. Colour comes from the button's text colour through `currentColor`, which is what makes
 * hover, active and disabled states free — every icon in this app that hardcoded its own colour
 * ended up with a disabled state that stayed bright.
 */
export function Glyph({
  icon,
  size = GLYPH.action,
  className,
}: {
  icon: IconComponent;
  size?: number;
  className?: string;
}) {
  return createElement(icon, { size, className });
}
