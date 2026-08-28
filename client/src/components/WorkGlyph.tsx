// §9's six marks, in one place, because two surfaces rendering five of them is how two collapse.
//
// SIX WORK STATUSES, SIX MARKS. §9 states the rule and names the file it comes from: "The rule is
// written in `Sidebar.tsx` between `StatusGlyph` and `AgentDot`, and the failure it records — two
// of four live states rendering identically, hoverable only — is exactly what you will reproduce if
// you map six statuses onto three colours." That comment is the specification for this file. What
// it records is that `deploying` and `running` were both a pulsing amber dot and `deployed` and
// `ran` were both a static green one, so half the live states were distinguishable only by hovering
// for a tooltip.
//
// §9's TABLE, WHICH THIS FILE IS:
//
//   queued      STATUS.neutral   a static mark distinct from succeeded's   none
//   running     STATUS.pending   the loader                                spin
//   waiting     STATUS.pending   a distinct mark — not the loader          pulse
//   succeeded   STATUS.ok        the tick                                  none
//   failed      STATUS.error     the cross                                 none
//   cancelled   STATUS.neutral   a distinct mark                           none
//
// AMBER MEANS IN FLIGHT, AND ONLY IN FLIGHT — and this is where this build changed its mind, so it
// is worth writing down which way and why. `waiting` was `STATUS.warn`, the blue, on the argument
// that amber means RUNNING and a waiting job has stopped. §9 answers that directly: "`running` and
// `waiting` share amber because both are genuinely in flight — one on the machine, one on a person
// — and they are separated by mark and by motion, never by inventing a seventh colour." The
// distinction the old reading protected is real and is kept: the loader turns, the pause pulses,
// and the two are a different shape before they are a different anything else.
//
// `tokens.ts` SPENDS A PAGE DEFENDING THAT AMBER AND COUNTS FORTY-EIGHT CALL SITES, A NODE GLOW AND
// A STREAM PULSE ON ONE SIDE OF THE ARGUMENT. A `warn` blue on a job that is genuinely mid-flight
// would be the one place in the product where the in-flight colour is not the in-flight colour.
//
// MOTION MEANS "THIS IS CHANGING RIGHT NOW" AND NOTHING ELSE — §9. Two of six move. `stream-pulse`
// rather than `animate-pulse`, which is what `StatusDot` already reaches for, and everything
// honours `motion-reduce` because `StatusDot` puts `motion-reduce:animate-none` on both.
//
// COLOUR IS NEVER THE ONLY SIGNAL — §9 again, and `StatusDot`'s `title` is what satisfies it. Every
// mark carries the status's own word from `cockpitCopy`, which is also what §12 requires: "Every
// status mark has a `title`, as `StatusGlyph` already does."
//
//   npm run test:work-glyphs

import { STATUS_WORD } from "../lib/cockpitCopy.ts";
import { ICON } from "../lib/tokens.ts";
import type { WorkStatus } from "../types.ts";
import { StatusDot } from "./StatusBadge.tsx";
import { CheckIcon, ClockIcon, LoaderIcon, MinusIcon, PauseIcon, XIcon } from "./panelIcons.tsx";

/**
 * One status, as a mark.
 *
 * EXHAUSTIVE BY TYPE, so a seventh status is a compile error rather than a blank space where a
 * glyph should be. That is the same guard `WorkGlyph` had when it lived inside `WorkList`, and the
 * reason to keep it while moving the function out is that the move is what makes a seventh status
 * cheap to add and therefore likely.
 *
 * THE TWO THAT ARE EASY TO GET WRONG, and each is a decision:
 *
 *   `waiting` IS A PAUSE, NOT A SPINNER. The graph has STOPPED — a person has to answer something —
 *   and a turning arc would say the opposite of what is true. It pulses instead, which says "this
 *   is in flight" without claiming the machine is doing anything.
 *
 *   `cancelled` IS A DASH, NOT A CROSS. Nothing failed; somebody pressed stop. A cross would file
 *   an ordinary operational decision under "something went wrong", which is the same conflation
 *   `stopped_reporting` exists to avoid one field over.
 */
export function WorkGlyph({ status, size = ICON.xs }: { status: WorkStatus; size?: number }) {
  const title = STATUS_WORD[status];
  switch (status) {
    case "queued":
      // NOT AMBER. It is not in flight — nothing has picked it up — and a clock is the mark for a
      // thing that is waiting for its turn. Distinct from `succeeded`'s tick, which is §9's own
      // requirement for this row of the table and the pair most likely to be collapsed.
      return <StatusDot state="neutral" icon={ClockIcon} size={size} title={title} />;
    case "running":
      return <StatusDot state="pending" icon={LoaderIcon} spin size={size} title={title} />;
    case "waiting":
      return <StatusDot state="pending" icon={PauseIcon} pulse size={size} title={title} />;
    case "succeeded":
      return <StatusDot state="ok" icon={CheckIcon} size={size} title={title} />;
    case "failed":
      return <StatusDot state="error" icon={XIcon} size={size} title={title} />;
    case "cancelled":
      return <StatusDot state="neutral" icon={MinusIcon} size={size} title={title} />;
  }
}
