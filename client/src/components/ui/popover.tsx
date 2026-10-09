// The popover — shadcn/ui's Popover, copied in and restyled to this app's tokens.
//
// shadcn is source you own rather than a package you import: these are its `components/ui/
// popover.tsx` (manual install, over `@radix-ui/react-popover`) with its theme variables swapped for
// ours. Radix brings placement against an anchor with a flip at the window's edge, a press outside
// and Escape that close it as one layer among others, and focus moved in and handed back.
//
// THE COMPOSER'S POPOVERS CAME FIRST (2026-10-09, after the menus): `composer/Popover.tsx` keeps its
// own API for its eleven call sites and is built on this.
//
// `inline` RENDERS IN PLACE INSTEAD OF IN A PORTAL. Radix still positions it with fixed coordinates,
// so a scrolling ancestor does not clip it; what staying in the tree buys is a dialog's focus trap —
// the fullscreen composer keeps Tab inside itself by walking its own subtree, and a portalled panel
// is outside that subtree.

import type { ComponentProps } from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;

export function PopoverContent({
  className = "",
  sideOffset = 6,
  inline = false,
  ...props
}: ComponentProps<typeof PopoverPrimitive.Content> & { inline?: boolean }) {
  const content = <PopoverPrimitive.Content sideOffset={sideOffset} className={`z-50 ${className}`} {...props} />;
  return inline ? content : <PopoverPrimitive.Portal>{content}</PopoverPrimitive.Portal>;
}
