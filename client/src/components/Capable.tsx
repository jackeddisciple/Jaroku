// §8's one rule, as a component: an affordance a role cannot use is ABSENT from the DOM.
//
// NOT DISABLED AND NOT HIDDEN, which §8 states three times and §1.3 froze in v0.4.0. The
// difference between them is what somebody can find: a disabled control is an offer being refused,
// which invites a person to work out what would enable it and tells them the feature exists in
// their workspace when the answer is that it exists for somebody else; a control hidden with CSS
// is one devtools panel away from being clicked, and the click reaches the relay. Absent is the
// only one of the three that is true.
//
// WHY A COMPONENT WHEN A `&&` WOULD DO. Most sites use the `&&` — `{canManage && <Button/>}` — and
// should, because a panel whose mutations all share one capability reads better with one boolean
// at the top than with a wrapper around each control. This is for the other case: a single
// affordance in a file that has no other guarded control, where the alternative is a hook call,
// a variable, and a conditional, three lines apart, for one button.
//
// IT RENDERS NOTHING OF ITS OWN — no wrapper element, no fragment with a key. A guard that added a
// `<div>` would change the layout of every flex row it was introduced into, which is exactly the
// kind of cost that makes people reach for `disabled` instead.

import type { ReactNode } from "react";
import { useCanRun, useCanReach, useCapability } from "../lib/useCapability.ts";
import type { ROUTE_CAPABILITY } from "../lib/capabilities.ts";

/**
 * Render `children` only if this account may do the named thing.
 *
 * EXACTLY ONE OF THE THREE PROPS, and they are three because §8.2's checklist covers three kinds
 * of surface: socket commands (`cmd`), the HTTP routes that are not commands (`route`), and the
 * handful of controls that gate on a capability without sending anything themselves (`capability`)
 * — a section heading whose whole contents are privileged, for instance.
 *
 * PREFER `cmd`. It names what the button does rather than a conclusion about it; see
 * `useCanRun`'s own note on the Deploy row §8.2 files under the wrong capability.
 */
export function Capable({
  cmd,
  route,
  capability,
  children,
}: {
  cmd?: string;
  route?: keyof typeof ROUTE_CAPABILITY;
  capability?: string;
  children: ReactNode;
}) {
  // All three hooks run every render regardless of which prop was passed — hooks cannot be
  // conditional, and each is a cheap store read. The empty strings are values `can` and `canRun`
  // answer `false` for, which is the same answer as "not asked".
  const byCommand = useCanRun(cmd ?? "");
  const byRoute = useCanReach((route ?? "") as keyof typeof ROUTE_CAPABILITY);
  const byCapability = useCapability(capability ?? "");
  const allowed = cmd ? byCommand : route ? byRoute : capability ? byCapability : false;
  return allowed ? <>{children}</> : null;
}
