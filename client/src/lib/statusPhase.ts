// Seven phases, and the one place the whole product agrees what a status IS.
//
// EVERY DOMAIN IN THIS PRODUCT HAS ITS OWN STATE UNION and every one of them was drawing its own
// mark: a run is `running | completed | error | paused`, a work item is six words, a thread is five,
// a deploy is eleven, GitHub sync is seven, an MCP server is four. Seven vocabularies, seven sets of
// shapes, and a person who has learned one of them has learned nothing about the next. This file is
// the vocabulary they all map INTO — see `lib/domainPhase.ts` for the maps themselves.
//
// GEOMETRY CARRIES THE STATE; COLOUR ONLY REINFORCES IT. That is the invariant this whole design
// exists for, and it is the reason a phase is not a colour with a name on it. A coloured dot fails
// for about one man in twelve, fails at 14px, and fails in a greyscale screenshot — so all seven
// phases are variations on one circle and every pair is distinguishable with the colour stripped.
// `StatusGlyph.tsx` draws them; `test:status-glyph` is what proves the claim.
//
// AMBER MEANS RUNNING. STILL. EVERYWHERE. Exactly one phase in this table is amber — `active` — and
// `test:status-amber` enumerates every glyph, every state border and every chip this vocabulary
// produces and fails on a second one. That extends the law `test:agent-tags` already asserts rather
// than inventing a new one: this product has spent forty-eight call sites, a node glow and a stream
// pulse teaching people that amber means work is happening right now, and one exception is all it
// takes to stop the colour answering that question.
//
// THREE FAMILIES OF STATE DELIBERATELY HAVE NO PHASE, and they are not omissions. `ahead`,
// `behind`, `diverged` and `drifted` answer "how does this compare to something else", and agent
// health answers "is this thing well" — neither is "what phase is this in". Forcing a comparison
// into this ramp would make the ramp lie, so they are typed into an explicit exclusion list in
// `domainPhase.ts` rather than quietly left out of a map.
//
//   npm run test:status-glyph
//   npm run test:status-amber

import { STATUS } from "./tokens.ts";

/**
 * The seven, in ramp order — not begun, begun, happening, halted-on-a-human, and the three ways a
 * thing can be finished.
 *
 * THE ORDER IS THE RAMP AND THE RAMP IS READ DOWN A COLUMN. `PHASES` is written out rather than
 * derived from `Object.keys` because object iteration order is a language guarantee about insertion
 * and not about intent — this codebase has been bitten once already by a sort that was implied
 * rather than declared, and the emoji palette two patterns over is written the same way for the
 * same reason.
 */
export type Phase =
  /** Exists, has not begun. */
  | "pending"
  /** Begun, nothing happening now. */
  | "ready"
  /** Work is happening right now. The only phase permitted amber. */
  | "active"
  /** Halted, needs a human. */
  | "waiting"
  /** Finished, succeeded. */
  | "done"
  /** Finished, did not succeed. */
  | "failed"
  /** Stopped deliberately. Not a failure. */
  | "halted";

export const PHASES: readonly Phase[] = [
  "pending",
  "ready",
  "active",
  "waiting",
  "done",
  "failed",
  "halted",
] as const;

/**
 * The word each phase carries, because colour is never the only signal.
 *
 * Every glyph renders this as its `title`, which is what makes the mark readable to a screen reader
 * and to somebody hovering a shape they have not learned yet. It is deliberately the PHASE's word
 * and not the domain's: a run that is `cancelled` and a deploy that is `Cancelled` are both
 * "stopped", and a caller with a better sentence passes its own.
 */
export const PHASE_WORD: Record<Phase, string> = {
  pending: "not started",
  ready: "idle",
  active: "running",
  waiting: "waiting on you",
  done: "finished",
  failed: "failed",
  halted: "stopped",
};

/**
 * The neutral the five quiet phases share. Not a fifth status colour — the absence of one.
 *
 * `STATUS.neutral` is the token whose own comment reads "decided-but-not-notable: recedes rather
 * than signals", which is exactly what four of these five are. `ready` is the odd one and takes it
 * anyway: a thing with nothing happening to it has nothing to say, and saying it in green would
 * make every idle row in the product compete with the running ones.
 */
const NEUTRAL = STATUS.neutral;

/**
 * Two colours and a neutral, and that is the whole palette this vocabulary spends.
 *
 * `done` IS NOT GREEN, and that is the sharpest departure from what this client did before. A run
 * that finished is not an achievement to be congratulated — it is a row with nothing outstanding in
 * it — and a column of green ticks is a column where the two rows that need a person are the
 * hardest things to find. The same argument `ThreadGlyph` already made about its `idle`: "green
 * appears nowhere, because colouring it would make the amber rows compete with something".
 */
export const PHASE_COLOUR: Record<Phase, string> = {
  pending: NEUTRAL,
  ready: NEUTRAL,
  /** The one amber in the product. Guarded by `test:status-amber`. */
  active: STATUS.pending,
  waiting: NEUTRAL,
  done: NEUTRAL,
  /** Rose. The only other colour this vocabulary is allowed. */
  failed: STATUS.error,
  halted: NEUTRAL,
};

/**
 * The single phase permitted amber, as a value rather than as a string in a suite.
 *
 * `test:status-amber` imports this and asserts that every OTHER phase's colour differs from
 * `STATUS.pending`. Writing the exception down here means the rule and the guard cannot drift: a
 * second amber has to be added in this file, in the one place a reader of the invariant looks.
 */
export const AMBER_PHASE: Phase = "active";
