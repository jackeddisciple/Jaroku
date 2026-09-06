// The Cockpit's six statuses, in the product's one status vocabulary.
//
// THIS FILE USED TO DRAW SIX MARKS OF ITS OWN — a clock, a spinning loader, a pulsing pause, a
// tick, a cross and a dash, in four colours — and every one of them was correct for this tab and
// unrelated to the six the Threads list drew, the four the deploy panel drew and the four the MCP
// panel drew. Six vocabularies is what a person has to learn six times, and what nobody does learn:
// they hover.
//
// SO THE MARKS ARE GONE AND THE MAPPING STAYS. `WORK_PHASE` says which phase each status is in and
// `StatusGlyph` draws it, which leaves this file holding the one thing that IS local to the
// Cockpit: its own word for each status. "Cancelled" is the Cockpit's word and "stopped" is the
// phase's, and a tooltip on a job somebody cancelled should say the first.
//
// WHAT CHANGED ON SCREEN, said out loud because it is a deliberate reversal of §9's own reasoning:
//
//   `succeeded` IS NO LONGER GREEN. §9 gave it `STATUS.ok`. Under the shared vocabulary a finished
//   job is `done` and `done` is neutral — a run that completed is not an achievement, it is a row
//   with nothing outstanding in it, and a column of green ticks is a column where the two rows that
//   need somebody are the hardest things to find.
//
//   `waiting` IS NO LONGER AMBER. §9's argument was that `running` and `waiting` "are both
//   genuinely in flight — one on the machine, one on a person". That is true and it is a good
//   argument for one tab; it is a bad one for a product, because the Cockpit is not the only place
//   a person is being waited on, and amber that means two things means neither. `waiting` is its
//   own phase with its own shape — ring plus centre dot — and the separation §9 wanted is now
//   geometry rather than motion.
//
//   `running` NO LONGER SPINS. A list of forty running jobs with forty spinners is a seizure risk
//   and a paint-cost problem. The arc pulses instead, in `stream-pulse`, and drops under
//   `prefers-reduced-motion`.
//
// WHAT DID NOT CHANGE is the property §24 asks this file to hold and `test:work-glyphs` still
// asserts: six statuses, six distinct marks, and a suite that fails if two collapse onto one.
//
//   npm run test:work-glyphs

import { STATUS_WORD } from "../lib/cockpitCopy.ts";
import { WORK_PHASE } from "../lib/domainPhase.ts";
import { ICON } from "../lib/tokens.ts";
import type { WorkStatus } from "../types.ts";
import { StatusGlyph } from "./StatusGlyph.tsx";

/**
 * One work status, as the phase it is in.
 *
 * EXHAUSTIVE BY TYPE STILL, and now in `domainPhase.ts` rather than in a switch here: `WORK_PHASE`
 * is a `Record<WorkStatus, Phase>`, so a seventh status is a compile error in the map rather than a
 * blank space where a glyph should be. That is the same guard this file had, moved to where every
 * other domain's is, which is what stops the Cockpit being the tab whose vocabulary drifts.
 */
/**
 * §2.3's dense-row size, and it is a step up from what this tab drew before. `ICON.xs` was right
 * for a dot with an icon inside it; the phase ramp is seven geometries told apart by a dash, a
 * quarter arc and a 2.6-unit centre dot, and at 12px the dashed ring and the hollow one are one
 * mark. The filter strip passes `xs` explicitly, because a chip's glyph rides on a line of text.
 */
export function WorkGlyph({ status, size = ICON.md }: { status: WorkStatus; size?: number }) {
  return <StatusGlyph phase={WORK_PHASE[status]} size={size} title={STATUS_WORD[status]} />;
}
