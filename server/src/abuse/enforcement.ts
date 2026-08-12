// The ladder: what happens as a score rises, and what has to be true before each rung.
//
// FIVE RUNGS, AND THE MACHINE MAY ONLY CLIMB THE FIRST THREE. `watch`, `soft_limit` and `verify`
// are reversible inconveniences: they slow a workspace down, they undo themselves when the score
// falls, and the worst case of getting one wrong is somebody annoyed. `suspended` and `blocked`
// stop a person working, and no score is evidence enough for that on its own — so they require a
// human, recorded by name on the row. That is not caution for its own sake: an automatic system
// that can suspend accounts will eventually suspend the wrong one at 3am with nobody watching,
// and the cost of that is somebody's business rather than somebody's afternoon.
//
// EVERY RUNG BOUNDS WHAT IS STARTED, NEVER WHAT IS RUNNING. The same rule the budget ceiling has
// followed since the eval engine landed, and it is the same reasoning: killing a run mid-graph
// spends the money and throws away the result. A workspace suspended while an eval is in flight
// finishes that eval and starts nothing else. Stopping something already running is a separate
// decision with a separate name, and this ladder does not make it.
//
// A RUNG IS NOT A CAPABILITY CHANGE. Enforcement never edits roles or memberships. A suspended
// workspace's owner is still its owner, can still sign in, can still read their traces, can still
// export everything and can still delete the workspace — because the alternative is a platform
// that takes people's data hostage over an automated score. What a rung takes away is the ability
// to CONSUME: to start runs, evals, generations and deploys.
//
// AND AN APPEAL IS PART OF THE MECHANISM, not a support process bolted beside it. Every rung
// carries the sentence that produced it and a column to answer in — see migration 028.

import { limitsFor, type PlanLimits } from "../billing/plans.ts";

export const ENFORCEMENT_LEVELS = ["none", "watch", "soft_limit", "verify", "suspended", "blocked"] as const;
export type EnforcementLevel = (typeof ENFORCEMENT_LEVELS)[number];

export function isEnforcementLevel(v: unknown): v is EnforcementLevel {
  return typeof v === "string" && (ENFORCEMENT_LEVELS as readonly string[]).includes(v);
}

/** How severe a rung is, so two can be compared without knowing the order by heart. */
export function severity(level: EnforcementLevel): number {
  return ENFORCEMENT_LEVELS.indexOf(level);
}

export interface Rung {
  level: EnforcementLevel;
  /** The score at which the ladder reaches this rung, or null for a rung only a human applies. */
  atScore: number | null;
  /** Whether the system may apply this itself. False for the two that stop somebody working. */
  automatic: boolean;
  /**
   * How long an automatic application lasts before it lapses on its own.
   *
   * Null for a human decision, which ends when a human ends it. The automatic ones expire so
   * that a workspace which stops behaving badly stops being limited without filing anything —
   * the score decaying is what SHOULD lift it, and this is the belt to that braces: a gate that
   * somehow never re-evaluates must not leave a limit in place forever.
   */
  expiresAfterMs: number | null;
  /** What it does to the workspace's limits. Empty for the rungs that refuse outright. */
  limitOverrides: Record<string, unknown>;
  /** What a person is told, and what an appeal argues against. */
  explain: string;
}

/**
 * The rungs, in order, in one table.
 *
 * THE SCORES ARE CALIBRATED AGAINST `SIGNALS`, not chosen in the abstract. Reading them beside
 * that table: one miner run is 25, so a single one reaches `watch` and nothing else; three
 * inside a day reach `soft_limit`; a cross-tenant probe is 30 on its own, which is `watch`
 * immediately and `verify` if it happens twice more. Nothing automatic ever passes `verify`.
 */
export const LADDER: readonly Rung[] = [
  {
    level: "watch",
    atScore: 25,
    automatic: true,
    // A day. Long enough to still be in force when the second signal of a pattern arrives, short
    // enough that one bad afternoon is not on the record for a week.
    expiresAfterMs: 24 * 3_600_000,
    limitOverrides: {},
    explain: "recorded, and nothing else — this rung changes nothing about what the workspace may do",
  },
  {
    level: "soft_limit",
    atScore: 60,
    automatic: true,
    expiresAfterMs: 24 * 3_600_000,
    // Concurrency down to one of each, and the platform's money off the table. Deliberately not
    // zero: a workspace at this rung can still work, one run at a time, which is exactly what a
    // false positive should cost and exactly what a farm cannot use.
    //
    // BE CLEAR ABOUT WHICH HALF BITES TODAY. `platformKeyCeilingUsd` is read on every dispatch
    // by billing/platformKey.ts, so it takes effect immediately: the rung costs the platform
    // nothing while leaving a workspace on its own key working, which is the right shape for a
    // rung that may be wrong. The `concurrency` numbers travel the same path a PLAN's do —
    // `planConcurrency`, which Session 5 introduced as the plan-aware layer over the dispatcher's
    // flat defaults and did not wire to the dispatcher. They are stated here so that the day it
    // is wired, the ladder is already correct; until then this rung's teeth are the ceiling.
    limitOverrides: {
      concurrency: { "run.interactive": 1, "run.eval": 1, judge: 1 },
      platformKeyCeilingUsd: 0,
    },
    explain:
      "this workspace is temporarily limited to one run at a time and cannot spend platform credit. " +
      "It lifts itself once the activity that caused it stops.",
  },
  {
    level: "verify",
    atScore: 120,
    automatic: true,
    // A week, because clearing this needs a person on the workspace's side to do something, and
    // a two-day expiry would lapse before somebody back from a weekend had read the message.
    expiresAfterMs: 7 * 86_400_000,
    limitOverrides: {
      concurrency: { "run.interactive": 1, "run.eval": 1, judge: 1 },
      platformKeyCeilingUsd: 0,
    },
    explain:
      "this workspace needs to be verified before it can start new work. Add a payment method or " +
      "contact support — nothing already running is affected, and everything already here stays readable.",
  },
  {
    level: "suspended",
    // NO SCORE. A human applies this, or nothing does. See the header.
    atScore: null,
    automatic: false,
    expiresAfterMs: null,
    limitOverrides: { platformKeyCeilingUsd: 0 },
    explain:
      "this workspace is suspended and cannot start new work. Runs already in flight finish. " +
      "Everything here remains readable and exportable, and the suspension can be appealed.",
  },
  {
    level: "blocked",
    atScore: null,
    automatic: false,
    expiresAfterMs: null,
    limitOverrides: { platformKeyCeilingUsd: 0 },
    explain:
      "this workspace is blocked. Its data remains exportable by its owner; nothing new may be started.",
  },
] as const;

/** The rung a score reaches, or `none`. Only ever returns a rung the machine may apply. */
export function levelForScore(score: number): EnforcementLevel {
  let reached: EnforcementLevel = "none";
  for (const rung of LADDER) {
    if (rung.automatic && rung.atScore !== null && score >= rung.atScore) reached = rung.level;
  }
  return reached;
}

export function rungFor(level: EnforcementLevel): Rung | undefined {
  return LADDER.find((r) => r.level === level);
}

/** Whether this rung refuses new work outright, as opposed to merely narrowing it. */
export function refusesWork(level: EnforcementLevel): boolean {
  return severity(level) >= severity("verify");
}

/**
 * The workspace's limits with the ladder folded in.
 *
 * Composed with `limitsFor` rather than replacing it, so a negotiated override and an enforcement
 * are not two systems fighting over one number — the enforcement is applied LAST, because a
 * workspace with a generous negotiated concurrency that is currently mining should get the
 * enforcement's number and not its contract's.
 */
export function limitsUnderEnforcement(
  plan: string | null | undefined,
  overrides: Record<string, unknown>,
  level: EnforcementLevel,
): PlanLimits {
  const rung = rungFor(level);
  if (!rung || Object.keys(rung.limitOverrides).length === 0) return limitsFor(plan, overrides);
  return limitsFor(plan, { ...overrides, ...rung.limitOverrides });
}

export interface EnforcementState {
  level: EnforcementLevel;
  reason: string;
  appliedAt: string | null;
  expiresAt: string | null;
  /** True when a person decided this, which is what makes it un-liftable by the score falling. */
  byHuman: boolean;
}

export const NO_ENFORCEMENT: EnforcementState = {
  level: "none",
  reason: "",
  appliedAt: null,
  expiresAt: null,
  byHuman: false,
};

/**
 * What the ladder should do, given what is in force and what the score now is.
 *
 * A pure function over two facts, so the decision can be read and argued with in one place
 * rather than inferred from a sequence of database calls. The caller performs whatever this
 * returns; it performs nothing itself.
 *
 * THREE RULES, AND EACH IS THE ANSWER TO A WAY THIS GOES WRONG:
 *
 *   IT NEVER LOWERS A HUMAN'S DECISION. A suspension does not lapse because a suspended
 *   workspace, being unable to run anything, stopped producing signals — which is precisely what
 *   would happen, and it is the most obvious hole in an automatic ladder.
 *
 *   IT NEVER CLIMBS PAST `verify`. See the header.
 *
 *   IT ONLY MOVES ON A CHANGE. Re-applying the rung already in force would write a row per
 *   evaluation, which is a table nobody can read and an audit trail that hides the moment
 *   something actually happened.
 */
export function decide(
  current: EnforcementState,
  score: number,
  now = Date.now(),
): { action: "none" | "apply" | "lift"; level: EnforcementLevel; reason: string } {
  const lapsed =
    current.level !== "none" &&
    !current.byHuman &&
    current.expiresAt !== null &&
    Date.parse(current.expiresAt) <= now;
  const inForce: EnforcementState = lapsed ? NO_ENFORCEMENT : current;
  const wanted = levelForScore(score);

  if (inForce.byHuman) {
    // A human's decision stands until a human ends it. The score may rise underneath it; that
    // is worth recording as a signal and is not worth a second, weaker row.
    return { action: "none", level: inForce.level, reason: "a person decided this one" };
  }

  if (lapsed && wanted === "none") {
    return { action: "lift", level: "none", reason: "the activity that caused it has stopped" };
  }
  if (severity(wanted) > severity(inForce.level)) {
    return { action: "apply", level: wanted, reason: `the abuse score reached ${Math.round(score)}` };
  }
  if (severity(wanted) < severity(inForce.level) && inForce.level !== "none") {
    // Falling is a LIFT, not a step down to a lesser rung. A workspace whose score has dropped
    // below the rung it is on has stopped doing the thing; re-applying something weaker would
    // keep it under a limit it no longer earns, and the next evaluation would re-apply it again
    // if it had not.
    return { action: "lift", level: "none", reason: "the abuse score has fallen back" };
  }
  return { action: "none", level: inForce.level, reason: "unchanged" };
}

/**
 * What a refused request is told.
 *
 * Names the rung, says what still works, and says how to argue — because a refusal a person
 * cannot act on is one they will act on by opening six more accounts, which is the behaviour
 * the ladder exists to discourage.
 */
export function enforcementRefusal(state: EnforcementState): string {
  const rung = rungFor(state.level);
  const why = state.reason ? ` (${state.reason})` : "";
  return `${rung?.explain ?? "this workspace cannot start new work"}${why}`;
}
