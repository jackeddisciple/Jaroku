// A group of independent actions, drawn as one control.
//
// WHAT A CLUSTER IS: refresh, filter, search — three things that each do something and spring back.
// Nothing in it is selected, nothing in it stays down, and pressing one tells you nothing about the
// state of the other two. `Segmented.tsx` is the other kind and they must not look identical: a
// grid/table toggle that looks like a refresh button teaches people that pressing refresh will
// change a mode, which is a lesson they only unlearn by losing their place.
//
// ── THE CONSTRUCTION, WHICH IS THE WHOLE FILE ───────────────────────────────────────────────────
//
// ONE HAIRLINE BETWEEN NEIGHBOURS, never two. Two abutting bordered buttons read as a 2px seam
// against every other hairline in the app, and at this app's contrast that is the difference between
// "a control" and "a control with a crack in it". `divide-x` is exactly this rule: a border on every
// child but the first.
//
// THE RADIUS IS THE CLUSTER'S, NOT THE MEMBERS'. §5.2: outer corners only, interior square. That is
// `overflow-hidden` on a rounded wrapper — which also clips each member's own hover fill to the cell
// it belongs in, so a rounded hover state cannot peek out of a square interior corner.
//
// A CLUSTER OF ONE IS NOT A CLUSTER. Four of the sites in §5.3 have a single member — Cockpit's
// refresh, the Inbox's, Usage's export, GitHub's sync — and a lone button inside a border is a
// group with one thing in it, which reads as a control that has lost its siblings. So one member
// renders as a bare `IconButton` and the wrapper is not drawn at all.
//
// EVERY MEMBER IS STILL AN `IconButton`, which is where the 32×32 hit target, the required label and
// the one-string-two-jobs rule live. This file adds a shape and takes nothing away.
//
// A DATA API RATHER THAN CHILDREN, deliberately. A cluster has to know how many members it has to
// obey the rule above, and it has to be able to guarantee that every member is an `IconButton` — and
// neither is knowable from a `children` prop without cloning elements and hoping. Passing the
// members as data is what makes "a cluster cannot contain something that is not a member" a
// property of the type rather than of a review.
//
//   npm run test:toolbar-cluster

import { ICON } from "../lib/tokens.ts";
import type { IconComponent } from "../lib/icons/registry.ts";
import { IconButton } from "./IconButton.tsx";

export interface ClusterMember {
  /** The mark, from the registry. */
  icon: IconComponent;
  /** What pressing it does. Becomes `aria-label` AND the tooltip — `IconButton`'s one string. */
  label: string;
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  /** Why it cannot be pressed. Non-null disables it and replaces the tooltip with the reason. */
  disabledReason?: string | null;
  /** A toggle inside an action cluster — a filter popover's own button, which stays open. */
  active?: boolean;
  /** Destructive treatment. Rare in a toolbar and never amber. */
  danger?: boolean;
}

export function ToolbarCluster({
  members,
  size = ICON.sm,
  className = "",
}: {
  members: ClusterMember[];
  size?: number;
  className?: string;
}) {
  if (members.length === 0) return null;
  // §5.2's rule, and the reason this component takes data: a lone member is a bare button.
  if (members.length === 1) {
    const only = members[0]!;
    return <IconButton {...only} size={size} className={className} />;
  }
  return (
    <div
      // NO `role="group"` AND EMPHATICALLY NO `radiogroup`. §5.2: an action cluster is a visual
      // grouping of controls that have nothing to do with each other's state, and announcing it as a
      // group would tell a screen-reader user there is a relationship to work out. The segmented
      // control is the one that has one.
      className={`inline-flex items-center divide-x divide-edge overflow-hidden rounded-control border border-edge ${className}`}
    >
      {members.map((m) => (
        <IconButton key={m.label} {...m} size={size} className="rounded-none" />
      ))}
    </div>
  );
}
