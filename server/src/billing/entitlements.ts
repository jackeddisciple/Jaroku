// What a tier entitles a workspace to, resolved in one place and nowhere else.
//
// THE WHOLE POINT IS THAT THERE IS ONE OF THESE. The specification opens by naming the failure it
// is preventing: a limit checked in the client is a limit that holds until somebody uses `curl`,
// and a limit computed in four places is four limits that agree until one of them is edited. So
// `resolveEntitlements` is the only function in this codebase that produces a tier's feature and
// limit values, and `requireEntitlement` is the only thing that refuses on them.
//
// WHY THIS FILE AND `plans.ts` ARE BOTH ALLOWED TO EXIST, given that rule. They are not two
// answers to one question; they are a table and a reader. `plans.ts` holds the NUMBERS, as data,
// nested by spreading, next to the argument for each — the same shape `auth/capabilities.ts` uses
// for roles and `queue/jobs.ts` for job classes. This file holds the RESOLUTION: which plan a
// workspace is on, what its negotiated overrides say, whether the asking session is in admin mode,
// and what the answer looks like at the boundary. Move the numbers here and they stop being
// reviewable as a set; move the resolution there and `plans.ts` has to know about sessions.
//
// `null` GOES IN AND 'unlimited' COMES OUT, deliberately. Inside `plans.ts`, null has meant "no
// limit from the plan" since 020 and is distinguishable from an absent override key. At this
// boundary the value is about to become JSON — in a 402 body, in a billing snapshot, on a screen —
// and `"maxAgents": null` reads as "we do not know" to everyone who did not write it, while
// `"maxAgents": "unlimited"` reads as what it is. The translation happens once, here.

import type { PlanLimits } from "./plans.ts";
import { limitsFor } from "./plans.ts";

/** A limit that may not exist. The word rather than the absence — see the header. */
export type Limit = number | "unlimited";

/**
 * Everything a tier decides, as one object.
 *
 * Flat and complete on purpose: a caller reads the field it needs and never asks which tier it is
 * on. A check written as `if (tier === 'free')` is a check that has to be found and edited when a
 * fourth tier appears, and the one nobody finds is the one that stays wrong.
 */
export interface TierEntitlements {
  maxAgents: Limit;
  maxWorkspaces: Limit;
  /**
   * Members allowed in the workspace. A plain number, and the only limit here that is never
   * 'unlimited' — above twenty a workspace is an Enterprise conversation rather than a bigger
   * number, so the members page surfaces a mailto instead of a twenty-first invite.
   */
  maxMembers: number;
  maxLiveDeployments: Limit;
  runsPerMonth: Limit;
  evalRunsPerMonth: Limit;
  maxMcpServers: Limit;
  traceRetentionDays: number;
  auditRetentionDays: number;
  githubPhase1: boolean;
  githubPhase2: boolean;
  perAgentAccessGrants: boolean;
  approvalBatchApprove: boolean;
  policyEngine: boolean;
  evalCiGate: boolean;
}

/** null is "no limit from the plan"; at this boundary that word is `unlimited`. */
function limit(n: number | null): Limit {
  return n === null ? "unlimited" : n;
}

/**
 * What admin mode grants: everything, with no limit and no gate.
 *
 * A CHECKED-IN CONSTANT, not a row, not an env var, not a plan with every flag set. Each of those
 * would make "what does admin mode allow" a question you answer by looking at a running system
 * rather than at a diff, and the whole argument for deriving admin status from an environment
 * variable is that changing it should be slow and visible. A tier is something you can buy; this
 * is not one, and building it as one is how it acquires a price and then a customer.
 *
 * The retention days are the one place a fully-permissive object cannot say "unlimited": the
 * sweeper reads a number and multiplies it by a day, so this is a century rather than Infinity —
 * `Infinity * 86_400_000` is `Infinity`, and a cutoff of `now - Infinity` is a date-arithmetic bug
 * waiting for whoever writes the next sweeper.
 */
export const ADMIN_ENTITLEMENTS: Readonly<TierEntitlements> = Object.freeze({
  maxAgents: "unlimited",
  maxWorkspaces: "unlimited",
  maxMembers: Number.MAX_SAFE_INTEGER,
  maxLiveDeployments: "unlimited",
  runsPerMonth: "unlimited",
  evalRunsPerMonth: "unlimited",
  maxMcpServers: "unlimited",
  traceRetentionDays: 36_500,
  auditRetentionDays: 36_500,
  githubPhase1: true,
  githubPhase2: true,
  perAgentAccessGrants: true,
  approvalBatchApprove: true,
  policyEngine: true,
  evalCiGate: true,
} as const);

/**
 * What this workspace's plan entitles it to, before any session is considered.
 *
 * Split from `resolveEntitlements` so the retention sweeper and the billing snapshot — neither of
 * which has a session, and neither of which should ever see an admin override — can ask the
 * question they actually have. A sweeper that resolved through admin mode would keep an admin's
 * traces for a century and nobody else's, which is a difference nobody would notice until they
 * went looking for a trace that had been swept.
 */
export function entitlementsForPlan(
  plan: string | null | undefined,
  overrides: Record<string, unknown> = {},
): TierEntitlements {
  return fromLimits(limitsFor(plan, overrides));
}

/** The projection itself, exported so a caller holding limits already need not re-resolve them. */
export function fromLimits(p: PlanLimits): TierEntitlements {
  return {
    maxAgents: limit(p.maxAgents),
    maxWorkspaces: limit(p.maxWorkspaces),
    // Never 'unlimited', even when the plan says null — see the field's own note. A plan with no
    // seat limit is read as the Enterprise handoff's threshold rather than as no threshold.
    maxMembers: p.seats ?? 20,
    maxLiveDeployments: limit(p.maxLiveDeployments),
    runsPerMonth: limit(p.runsPerMonth),
    evalRunsPerMonth: limit(p.evalRunsPerMonth),
    maxMcpServers: limit(p.maxMcpServers),
    traceRetentionDays: p.retentionDays,
    auditRetentionDays: p.auditRetentionDays,
    githubPhase1: p.features.githubPhase1,
    githubPhase2: p.features.githubPhase2,
    perAgentAccessGrants: p.features.perAgentAccessGrants,
    approvalBatchApprove: p.features.approvalBatchApprove,
    policyEngine: p.features.policyEngine,
    evalCiGate: p.features.evalCiGate,
  };
}

/** What a resolution needs to know. Structural, so nothing here imports the session layer. */
export interface EntitlementSubject {
  plan: string | null | undefined;
  limitOverrides?: Record<string, unknown>;
  /** Whether this user MAY turn admin mode on. Derived from the environment at session hydration. */
  isAdmin?: boolean;
  /** Whether it is on right now. In-memory session state, false on every new session. */
  adminMode?: boolean;
}

/**
 * The one resolver.
 *
 * BOTH FLAGS, NOT EITHER. `isAdmin` says the environment lists this user; `adminMode` says they
 * have deliberately turned it on for this session and are looking at the banner that says so.
 * Reading only the second would mean a request body could grant itself the bypass, which is the
 * exact escalation the specification spends a section refusing — and the toggle endpoint refuses
 * a non-admin with a 403 rather than quietly resolving them as an ordinary user, because somebody
 * asking for admin mode who cannot have it is worth a log line.
 */
export function resolveEntitlements(subject: EntitlementSubject): TierEntitlements {
  if (subject.isAdmin && subject.adminMode) return { ...ADMIN_ENTITLEMENTS };
  return entitlementsForPlan(subject.plan, subject.limitOverrides ?? {});
}

/** Whether one more would still be within a limit. `unlimited` is always within itself. */
export function within(used: number, cap: Limit): boolean {
  return cap === "unlimited" || used < cap;
}
