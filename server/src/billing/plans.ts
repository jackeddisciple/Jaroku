// What each plan actually limits, as data.
//
// The third table of this shape in the codebase, and the reasoning has not changed since the
// first. `auth/capabilities.ts` puts every role's powers in one place so deciding a new one
// means looking at all of them at once; `queue/jobs.ts` puts every job class's concurrency and
// timeout in one place so two copies of the same number cannot drift. A plan is the same kind
// of object: a bundle of numbers that four separate subsystems each need, and which — scattered
// — become four answers to "how many eval jobs may a free workspace run".
//
// SO THE LIMITS ARE HERE AND NOT IN THE `plans` TABLE. The table holds what genuinely varies
// per deployment: which payment-provider price a plan maps to, and whether it can be bought
// today. Everything below is a decision, and decisions belong in a file somebody has to open a
// pull request to change. See migration 020's header.
//
// PLANS ARE NESTED, expressed by spreading rather than by copying. `pro` starts from `free` and
// `team` from `pro`, so a limit added to the base is a limit every plan has, and the day
// somebody adds a feature flag and forgets two of the three tables is a day that cannot happen.
// The same reason `ADMIN` is `[...MEMBER, …]` rather than its own list.
//
// A PLAN'S LIMITS ARE NOT A CEILING ON CORRECTNESS. Nothing here is a security boundary: a
// workspace on the free plan is capped, not sandboxed differently, and the isolation between
// tenants is identical on every plan. What a plan bounds is consumption of shared capacity and
// of platform money — which is why `budgetCeilingUsd` bounds what is STARTED rather than what
// is spent, exactly as the eval budget already does. See billing/balances.ts.

import type { JobClass } from "../queue/jobs.ts";

export const PLAN_IDS = ["free", "pro", "team"] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export function isPlanId(v: unknown): v is PlanId {
  return typeof v === "string" && (PLAN_IDS as readonly string[]).includes(v);
}

/** What a plan unlocks. Booleans only — anything with a number is a limit, not a feature. */
export interface PlanFeatures {
  /**
   * Whether this workspace may run on the PLATFORM's provider key at all.
   *
   * The free tier's onboarding path, and the one that costs us money — which is why it is
   * gated by a hard per-workspace ceiling and a global kill switch rather than by trust.
   */
  platformKey: boolean;
  /** Whether it may store its own provider key and run on that. The enforced default (D1a). */
  byok: boolean;
  /** Whether it may put an agent on a public URL in its own hosting account. */
  deploy: boolean;
  /** Whether it may connect third-party MCP servers. */
  mcp: boolean;
  /**
   * Pushing an agent's code to a repository the workspace owns.
   *
   * PHASE ONE AND PHASE TWO ARE TWO FLAGS, not one with a number. Pushing is a write this
   * workspace initiates and can undo; reading a repository back — branches, pull requests,
   * webhooks landing on our side — is a standing grant against somebody's account that keeps
   * acting while nobody is watching. A single flag would mean the tier that wanted the first
   * had to be given the second.
   */
  githubPhase1: boolean;
  githubPhase2: boolean;
  /**
   * Per-agent Access grants, as opposed to the workspace role alone.
   *
   * Off below Team for a reason that is not price: Free and Pro are single-member, so there is
   * nobody in the workspace to grant anything TO. Gating it is describing the tier rather than
   * withholding a feature.
   */
  perAgentAccessGrants: boolean;
  /** Approving a batch of pending approvals at once rather than one at a time. */
  approvalBatchApprove: boolean;
  /** The policy engine — rules evaluated against every run rather than per agent. */
  policyEngine: boolean;
  /** An eval that can fail a pull request. Needs GitHub phase two to have anything to fail. */
  evalCiGate: boolean;
}

export interface PlanLimits {
  id: PlanId;
  label: string;
  /**
   * Platform credit granted at the start of each billing period, in USD.
   *
   * Granted, not carried: a period's grant replaces what is left of the previous one rather
   * than accumulating, because an unused monthly allowance that compounds is a liability
   * nobody priced. Purchased credit is a different column and does carry — see
   * `workspace_balances.balance_usd`.
   */
  monthlyCreditsUsd: number;
  /**
   * The most a workspace may have STARTED in one period, or null for no ceiling.
   *
   * Bounds what is started, never what is spent. A run already in flight completes: stopping
   * it mid-graph would spend the money and throw away the result, which is the same rule the
   * eval budget has followed since the eval engine landed, and it is not an oversight to be
   * tightened later.
   */
  budgetCeilingUsd: number | null;
  /**
   * The most the PLATFORM will spend on this workspace's behalf in one period, or null for no
   * limit of its own.
   *
   * NOT the same number as `budgetCeilingUsd`, and the separation is load-bearing rather than
   * tidy. The budget ceiling bounds what a workspace STARTS, whoever pays, and exists to protect
   * the user from their own fan-out. This bounds what WE pay when a workspace runs on the
   * platform's key, and exists to protect the platform. A workspace on its own key can be
   * nowhere near this one while sitting on its budget ceiling, and collapsing them into a single
   * number would make each mean the other's thing half the time.
   *
   * Smaller than the budget ceiling on every plan, deliberately: our money is the tighter
   * constraint, and a plan where they were equal would be a plan where the distinction never
   * mattered and would quietly rot.
   */
  platformKeyCeilingUsd: number | null;
  /**
   * Per-workspace concurrency by job class, overriding `jobClassConfig`'s flat default.
   *
   * Partial on purpose: a class absent here is one whose limit is not a plan decision, and
   * falls through to the class's own number. Session 5 wrote those numbers as flat and
   * env-overridable and said so — this is the plan-aware layer it named.
   */
  concurrency: Partial<Record<JobClass, number>>;
  /**
   * How long a trace is kept before the sweeper takes it, in days.
   *
   * Decided here even though Session 8 is what enforces it, because retention is a plan
   * promise and a plan promise made in one file and kept in another is how the two disagree.
   */
  retentionDays: number;
  /** Members allowed in the workspace, or null for unlimited. */
  seats: number | null;
  /**
   * How long the AUDIT log is kept, in days, as distinct from how long a trace is.
   *
   * Two numbers that happen to be equal on all three tiers today, and kept apart anyway. They
   * answer to different people: a trace window is a product decision about how far back somebody
   * can debug, and an audit window is a compliance answer somebody gives their own security team.
   * The day one of them has to move, the other must not move with it by accident.
   */
  auditRetentionDays: number;
  /**
   * The counted limits, where null means no limit from the plan.
   *
   * NULL RATHER THAN A SENTINEL NUMBER, and rather than the string the entitlement contract uses
   * at its boundary. Inside this file null is already the word for "no ceiling from the plan" —
   * `budgetCeilingUsd` and `seats` have both meant it since 020 — and `limitsFor` below
   * distinguishes an override of null from an absent key by `hasOwnProperty` precisely so that
   * it stays a real answer somebody can negotiate. `resolveEntitlements` translates it to
   * 'unlimited' on the way out, where the value is about to become JSON and null would read as
   * "we do not know" rather than as "there is no limit".
   */
  maxAgents: number | null;
  maxWorkspaces: number | null;
  maxLiveDeployments: number | null;
  /**
   * Runs and eval runs allowed per CALENDAR MONTH, counted in `workspace_usage_periods`.
   *
   * Per calendar month rather than per rolling thirty days, and that is a decision rather than an
   * approximation: people think in months, and a rolling window means the answer to "how many do
   * I have left" changes every night without anybody doing anything. `billingPeriod()` in
   * gate.ts is the one function that decides where a month starts.
   */
  runsPerMonth: number | null;
  evalRunsPerMonth: number | null;
  maxMcpServers: number | null;
  features: PlanFeatures;
}

const FREE: PlanLimits = {
  id: "free",
  label: "Free",
  // Enough to build an agent, run it a few times, and see one small eval through. Deliberately
  // not enough to be worth farming: the abuse economics of a free tier that runs arbitrary
  // Python are the reason this number is small rather than generous.
  monthlyCreditsUsd: 5,
  budgetCeilingUsd: 5,
  // The whole of the free tier's exposure. Small on purpose: this is the number a farmer would
  // be trying to maximise, and it is the one thing here that costs real money to get wrong.
  platformKeyCeilingUsd: 2,
  // The shape Session 5 already assumed for a free workspace: one interactive run, two eval
  // jobs. Stated here rather than left as jobs.ts's default so that raising the default for
  // everybody and raising it for paying workspaces stay two different edits.
  concurrency: { "run.interactive": 1, "run.eval": 2, judge: 2 },
  // SEVEN DAYS, DOWN FROM FOURTEEN, and this one deletes data the first night it runs. The
  // pricing says seven and the sweeper reads this number, so a free workspace's traces from days
  // 8-14 go on the next nightly pass. Stated here rather than discovered there.
  retentionDays: 7,
  auditRetentionDays: 7,
  // ONE, DOWN FROM THREE. Free is solo: there is no invite, and `perAgentAccessGrants` is off
  // below Team for the same reason rather than as a second decision.
  seats: 1,
  maxAgents: 3,
  maxWorkspaces: 1,
  maxLiveDeployments: 1,
  runsPerMonth: 500,
  evalRunsPerMonth: 20,
  maxMcpServers: 3,
  // `deploy` IS TRUE ON FREE NOW, which reads like a giveaway and is not. The tier table grants
  // one concurrent live deployment, and a boolean that said no would make that number
  // unreachable — the flag asks whether this workspace may put an agent on a URL at all, and the
  // count is what bounds it. Deploying is into the USER's own hosting account (ADR-027), so the
  // one thing it costs us is nothing.
  features: {
    platformKey: true, byok: true, deploy: true, mcp: true,
    githubPhase1: false, githubPhase2: false, perAgentAccessGrants: false,
    approvalBatchApprove: false, policyEngine: false, evalCiGate: false,
  },
};

const PRO: PlanLimits = {
  ...FREE,
  id: "pro",
  label: "Pro",
  monthlyCreditsUsd: 50,
  budgetCeilingUsd: 200,
  platformKeyCeilingUsd: 50,
  concurrency: { "run.interactive": 3, "run.eval": 8, judge: 8 },
  retentionDays: 90,
  auditRetentionDays: 90,
  // ONE SEAT, THE SAME AS FREE, and the only place in this file where a paid plan does not beat
  // the one below it on an axis. It is the pricing's own shape rather than an oversight: Pro is
  // the single-operator tier at $20 and Team is what collaboration costs, so a Pro workspace has
  // nobody to invite by construction. `plans.test.ts` asserts >= rather than > for this axis
  // and says why there too, because an assertion weakened without a reason is how the next one
  // gets weakened without one.
  seats: 1,
  maxAgents: null,
  maxWorkspaces: 3,
  maxLiveDeployments: 5,
  runsPerMonth: 10_000,
  evalRunsPerMonth: 500,
  maxMcpServers: null,
  // Nested rather than restated: a flag added to FREE.features is automatically PRO's too.
  // `evalCiGate` stays off here because it has nothing to gate — it fails a pull request, and
  // reading pull requests is phase two.
  features: { ...FREE.features, githubPhase1: true, approvalBatchApprove: true },
};

const TEAM: PlanLimits = {
  ...PRO,
  id: "team",
  label: "Team",
  monthlyCreditsUsd: 250,
  // Still a ceiling, even on the plan whose budget has none. `budgetCeilingUsd: null` is us
  // declining to guess on the customer's behalf about their own money; this is our money, and
  // there is no version of "unlimited" for that which is not an incident waiting to happen.
  platformKeyCeilingUsd: 250,
  // No ceiling from the plan. That is not "unlimited spend": `workspace_balances.ceiling_usd`
  // is still checked, and an account that has not set one is bounded by its balance. A plan
  // whose ceiling is null is a plan that stops guessing on the customer's behalf.
  budgetCeilingUsd: null,
  concurrency: { "run.interactive": 10, "run.eval": 32, judge: 32 },
  retentionDays: 365,
  auditRetentionDays: 365,
  // TWENTY, NOT NULL, and the cap is a handoff rather than a wall. The twenty-first invite is
  // where self-service stops and a conversation starts, so the members page surfaces a mailto
  // instead of refusing — a limit that just says no at 20 is a limit somebody works around by
  // opening a second workspace, which is worse for them and worse for us.
  seats: 20,
  maxAgents: null,
  maxWorkspaces: null,
  maxLiveDeployments: null,
  // POOLED ACROSS THE WORKSPACE, not per member, which is why this is one number rather than a
  // per-seat one multiplied by `seat_count`. A team of three where one person runs everything
  // is the ordinary case, and a per-seat quota would refuse that team while its allowance sat
  // unused on two accounts.
  runsPerMonth: 50_000,
  evalRunsPerMonth: 2_500,
  maxMcpServers: null,
  features: {
    ...PRO.features,
    githubPhase2: true, perAgentAccessGrants: true, policyEngine: true, evalCiGate: true,
  },
};

export const PLANS: Record<PlanId, PlanLimits> = { free: FREE, pro: PRO, team: TEAM };

/**
 * The flags a person reads, and what each is called where they read it.
 *
 * ONLY THE ONES THAT GATE SOMETHING. `approvalBatchApprove`, `policyEngine` and `evalCiGate` are
 * declared on `PlanFeatures` ahead of the surfaces they will gate — which is the right order, and
 * `entitlementGate.ts` argues it — and they are absent here for exactly that reason. A billing
 * panel that listed them would be selling three capabilities the product does not have, which is
 * the mistake the public pricing page made and this list does not repeat.
 *
 * `platformKey`, `byok` and `mcp` are absent too, for the opposite reason: every plan has them, so
 * a list including them describes nothing about the choice somebody is making. A row here earns
 * its place by DIFFERING between plans.
 *
 * In ladder order, so the list reads as what each step adds rather than as a set.
 */
export const FEATURE_LABELS: readonly (readonly [keyof PlanFeatures, string])[] = [
  ["deploy", "deploys"],
  ["githubPhase1", "GitHub push"],
  ["githubPhase2", "GitHub sync"],
  ["perAgentAccessGrants", "per-agent access"],
] as const;

/** The plan a workspace is on, falling back to `free` for a value nothing recognises. */
export function planFor(plan: string | null | undefined): PlanLimits {
  return isPlanId(plan) ? PLANS[plan] : PLANS.free;
}

/**
 * The keys a workspace's `limit_overrides` may name.
 *
 * A closed list, and an unknown key is IGNORED rather than refused. Refusing would mean a
 * workspace whose overrides were written by an older version of this file cannot be read at
 * all — its runs would fail rather than fall back to its plan, which is the wrong direction for
 * a negotiated exception. Ignoring is the same judgement `pricing.ts` makes about a malformed
 * row: one bad entry must not void the table.
 */
const OVERRIDABLE = [
  "monthlyCreditsUsd",
  "budgetCeilingUsd",
  "platformKeyCeilingUsd",
  "retentionDays",
  "auditRetentionDays",
  "seats",
  // The counted limits, overridable for the same two reasons the ceilings are: a negotiated
  // exception somebody agreed to, and an abuse response clamping a workspace down without
  // moving it off the plan it paid for. Zero is a real value here — it is what "start nothing"
  // means — which is why they share the null-or-non-negative case below rather than
  // `retentionDays`'s strictly-positive one.
  "maxAgents",
  "maxWorkspaces",
  "maxLiveDeployments",
  "runsPerMonth",
  "evalRunsPerMonth",
  "maxMcpServers",
  "concurrency",
  "features",
] as const;

/**
 * This workspace's effective limits: its plan, with its own negotiated exceptions folded in.
 *
 * The two are kept apart everywhere else in the system precisely so this function is the only
 * place they meet. `budgetCeilingUsd` is the one worth reading twice: `null` in an override
 * means "no ceiling from the plan", which is a real answer somebody may have negotiated, and
 * it is distinguishable from the key being absent — so `hasOwnProperty` decides, not
 * truthiness. An override of 0 means the workspace may start nothing, which is what an abuse
 * response sets.
 */
export function limitsFor(
  plan: string | null | undefined,
  overrides: Record<string, unknown> = {},
): PlanLimits {
  const base = planFor(plan);
  if (!overrides || typeof overrides !== "object") return base;

  const out: PlanLimits = { ...base, concurrency: { ...base.concurrency }, features: { ...base.features } };
  for (const key of OVERRIDABLE) {
    if (!Object.prototype.hasOwnProperty.call(overrides, key)) continue;
    const v = overrides[key];
    switch (key) {
      case "monthlyCreditsUsd":
        // Zero is meaningful here: a workspace with no monthly credit is an ordinary arrangement.
        if (typeof v === "number" && Number.isFinite(v) && v >= 0) out[key] = v;
        break;
      case "auditRetentionDays":
      case "retentionDays":
        // STRICTLY POSITIVE, and this is the one bound in this function whose absence destroys
        // data rather than blocking work.
        //
        // The sweeper reads this number as `now - retentionDays * a day` and deletes every run,
        // step, checkpoint and export older than the result. At zero the cutoff is NOW: the next
        // nightly pass takes the workspace's entire trace history, including the run that
        // finished a second ago, and a trace is the product. There is no undo and no backup that
        // distinguishes it from an intended deletion.
        //
        // A negative value was already ignored, and zero is far likelier than minus three: it is
        // what an empty form field, a parsed empty string and a misplaced default all produce.
        // Refusing both means the only way to reach it is a plan, and `plans.test.ts` asserts
        // every plan's retention is positive.
        //
        // "Keep nothing" is therefore not expressible as an override, deliberately. It is
        // indistinguishable from a typo at the point it is written and unrecoverable at the point
        // it takes effect, so if it is ever wanted it should arrive as a named policy somebody
        // has to spell out — the same argument concurrency makes two cases below about zero.
        if (typeof v === "number" && Number.isFinite(v) && v > 0) out[key] = v;
        break;
      case "budgetCeilingUsd":
      case "platformKeyCeilingUsd":
      case "seats":
      case "maxAgents":
      case "maxWorkspaces":
      case "maxLiveDeployments":
      case "runsPerMonth":
      case "evalRunsPerMonth":
      case "maxMcpServers":
        // null is meaningful — "no ceiling", "no seat limit" — so it is accepted alongside a
        // number rather than falling through to the plan's value.
        if (v === null) out[key] = null;
        else if (typeof v === "number" && Number.isFinite(v) && v >= 0) out[key] = v;
        break;
      case "concurrency":
        if (v && typeof v === "object") {
          for (const [jobClass, n] of Object.entries(v as Record<string, unknown>)) {
            if (typeof n === "number" && Number.isFinite(n) && n > 0) {
              // A concurrency of zero would admit nothing ever — the same trap jobs.ts's env
              // reader refuses for the same reason. An abuse response suspends a workspace;
              // it does not leave it able to enqueue work that can never be admitted.
              out.concurrency[jobClass as JobClass] = n;
            }
          }
        }
        break;
      case "features":
        if (v && typeof v === "object") {
          for (const [flag, on] of Object.entries(v as Record<string, unknown>)) {
            if (typeof on === "boolean" && flag in out.features) {
              out.features[flag as keyof PlanFeatures] = on;
            }
          }
        }
        break;
    }
  }
  return out;
}

/**
 * How many of `jobClass` this workspace may run at once, or null when the plan has no opinion.
 *
 * Null rather than a number, so the caller falls through to `jobClassConfig(jobClass)` instead
 * of this file quietly inventing a limit for a class no plan mentions. The two layers compose;
 * neither replaces the other.
 */
export function planConcurrency(limits: PlanLimits, jobClass: JobClass): number | null {
  return limits.concurrency[jobClass] ?? null;
}

/**
 * Fail at boot when the `plans` table and this file disagree.
 *
 * The registry exists so a subscription can reference a plan and so a price id has a home. A
 * row here with no definition above would resolve through `planFor` to the FREE limits, which
 * means a workspace that paid for Team silently gets a free workspace's concurrency and
 * ceiling — a failure with no symptom except somebody's throughput. And a definition with no
 * row cannot be subscribed to at all.
 *
 * Checked at startup, where somebody is watching, for the same reason the migrations are
 * applied there: a mismatch is a deployment mistake, and the useful moment to learn about a
 * deployment mistake is during the deployment.
 */
export function assertPlanRegistry(rows: readonly { id: string }[]): void {
  const inTable = new Set(rows.map((r) => r.id));
  const undefinedInCode = [...inTable].filter((id) => !isPlanId(id));
  const missingFromTable = PLAN_IDS.filter((id) => !inTable.has(id));
  const problems: string[] = [];
  if (undefinedInCode.length) {
    problems.push(`the plans table offers ${undefinedInCode.join(", ")}, which billing/plans.ts does not define`);
  }
  if (missingFromTable.length) {
    problems.push(`billing/plans.ts defines ${missingFromTable.join(", ")}, which the plans table has no row for`);
  }
  if (problems.length) throw new Error(`plan registry mismatch — ${problems.join("; ")}`);
}
