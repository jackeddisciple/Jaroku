// The tooltip — shadcn/ui's Tooltip, copied in and restyled to this app's tokens.
//
// shadcn is source you own rather than a package you import: the four exports below are its
// `components/ui/tooltip.tsx` (manual install, over `@radix-ui/react-tooltip`), with its theme
// variables swapped for ours — `bg-ink text-bg` is the app's filled charcoal, the pairing every
// filled button already uses — and no entry animation, because a tooltip that slides in after a
// delay is a delay twice.
//
// IT REPLACES THE NATIVE `title` TOOLTIP ONE WHOLE ROW AT A TIME (2026-10-09, the product owner's
// call). The right-hand rail and the composer's bottom row came first. A row never mixes the two:
// half its controls answering a hover in a charcoal bubble and half in the system's grey box is
// worse than either. Everything not yet moved still says `title=`.
//
// `Tip` is the one-liner the call sites use. The label is the same string the control's
// `aria-label` carries wherever there is nothing more to say — the name is for a screen reader,
// the tooltip for a pointer, and they still must not disagree.

import { Children, isValidElement, type ComponentProps, type ReactElement, type ReactNode } from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";

/**
 * Once, at the root. 300ms before the first tooltip in a row opens, then none while the pointer
 * moves along the row — the second icon you hover is one you are already reading the bar for.
 *
 * NOT HOVERABLE. Radix keeps a tooltip open while the pointer travels toward it, so it can be
 * moused into; these hold a sentence and nothing to press, and a wide one ("Attach a file, run,
 * dataset case…") reached over its neighbours, so sliding along the composer's row kept the first
 * tooltip up above the second button. Off, one closes the moment its control is left.
 */
export function TooltipProvider({
  delayDuration = 300,
  skipDelayDuration = 300,
  disableHoverableContent = true,
  ...props
}: ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      delayDuration={delayDuration}
      skipDelayDuration={skipDelayDuration}
      disableHoverableContent={disableHoverableContent}
      {...props}
    />
  );
}

export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export function TooltipContent({ className = "", sideOffset = 6, ...props }: ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    // IN A PORTAL, so a rail or a composer bar with `overflow: hidden` cannot clip it, and above
    // every popover (z-50 is the highest the app uses) because a tooltip is about the control
    // under the pointer, whatever is open around it.
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        sideOffset={sideOffset}
        className={`z-[60] max-w-[280px] rounded-control bg-ink px-2 py-1 text-caption text-bg shadow-floating ${className}`}
        {...props}
      />
    </TooltipPrimitive.Portal>
  );
}

/**
 * A control with a tooltip. `label` is what it says; `hide` keeps it quiet, for a trigger whose own
 * popover is open — the popover is the answer to the question the tooltip would be asking.
 */
export function Tip({
  label,
  side = "top",
  hide = false,
  children,
}: {
  label: string;
  side?: "top" | "right" | "bottom" | "left";
  hide?: boolean;
  children: ReactElement;
}) {
  if (hide || !label) return children;
  // A DISABLED BUTTON FIRES NO POINTER EVENTS, so a tooltip on one never opens — and a disabled
  // control's tooltip is the one place it says WHY it is off. A wrapper the pointer can reach takes
  // the hover instead.
  const child = Children.only(children);
  const off = isValidElement<{ disabled?: boolean }>(child) && child.props.disabled === true;
  const trigger: ReactNode = off ? <span className="inline-flex">{child}</span> : child;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{trigger}</TooltipTrigger>
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  );
}
