// The platform's own key, lent to a workspace that has none — and the three things that stop it.
//
// BYOK is the enforced default and the platform's spend under it is zero. This is the other
// path: an onboarding tier where somebody can build and run an agent before they have a provider
// account at all. It is the only place in this system where the platform's money is spent by
// somebody else's decision, so it is the only place that needs a switch nobody has to think to
// use.
//
// THREE GATES, CHECKED IN THIS ORDER, AND THE ORDER IS THE POINT:
//
//   1. THE GLOBAL KILL SWITCH. `JAROKU_PLATFORM_KEY=off` stops the platform key being lent to
//      anybody, immediately, without touching a plan, a workspace or a database. This exists for
//      one situation and it is worth naming: somebody is farming the free tier faster than the
//      per-workspace ceilings are catching it, and the correct first move is to stop the
//      bleeding while working out who. A response that requires a migration is not a response.
//
//   2. THE PLAN. `features.platformKey` is what says a plan includes this at all. A workspace on
//      a plan that does not is not being throttled; it is being told to connect a key, which is
//      the arrangement it agreed to.
//
//   3. THE PER-WORKSPACE CEILING ON PLATFORM-PAID SPEND. Separate from `budgetCeilingUsd`, and
//      the separation is load-bearing rather than tidy: the budget ceiling bounds what a
//      workspace STARTS, whoever pays, and exists to protect the user from their own fan-out.
//      This bounds what WE pay on their behalf, and exists to protect the platform. A workspace
//      running entirely on its own key can be nowhere near this one while sitting on its budget
//      ceiling, and vice versa, and collapsing them into one number would make each mean the
//      other's thing half the time.
//
// WHAT IT DOES NOT DO. It does not stop the run — the run is refused only when there is no key
// to run it with. A workspace with its own key configured never reaches this file at all, which
// is why the refusal below says "connect a key" and not "you are over budget": for the
// population this gate can refuse, connecting a key is genuinely the fix.

import type { TenantContext } from "../db/tenant.ts";
import type { BillingRepository } from "../db/repositories/billing.ts";
import type { IdentityRepository } from "../db/repositories/identity.ts";
import { limitsFor } from "./plans.ts";
import { round8 } from "../pricing.ts";

/**
 * Whether this deployment will lend its key to anybody at all.
 *
 * Read per call rather than at import, for the reason queue/jobs.ts reads its overrides per call:
 * a value captured at import is frozen at whatever the environment held the first time anything
 * touched the module, which for a switch whose whole purpose is to be flipped in a hurry is the
 * opposite of what it is for.
 *
 * OFF IS ANY OF `off`, `0`, `false`, `no`. A kill switch that only recognised one spelling is a
 * kill switch somebody sets to `0` at three in the morning and watches do nothing.
 */
export function platformKeyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.JAROKU_PLATFORM_KEY ?? "").trim().toLowerCase();
  return !["off", "0", "false", "no"].includes(raw);
}

export type PlatformKeyVerdict =
  | { allowed: true; spentUsd: number; ceilingUsd: number | null }
  | { allowed: false; reason: "killed" | "plan" | "ceiling"; message: string };

export class PlatformKeyGate {
  constructor(
    private billing: BillingRepository,
    private identity: IdentityRepository,
  ) {}

  /**
   * What the platform has spent on this workspace's behalf, this period.
   *
   * `payer = 'platform'` is the whole of the filter, and it is why migration 024 records a payer
   * at all: counting by KIND would count an `llm.provider` call a workspace paid for with its own
   * key, and throttle somebody for spending their own money.
   *
   * Sandbox seconds and stored bytes are deliberately included. They are ours to pay for whoever
   * the agent's key belonged to, and a free tier farmed for compute rather than for tokens is
   * the abuse case that costs the most and shows up in no token counter.
   */
  async platformSpend(ctx: TenantContext, since: string): Promise<{ usd: number; costKnown: boolean }> {
    const totals = await this.billing.platformSpendSince(ctx, since);
    return { usd: round8(totals.usd), costKnown: totals.costKnown };
  }

  /** May this workspace run on the platform's key right now? */
  async mayUsePlatformKey(ctx: TenantContext, periodStart: string): Promise<PlatformKeyVerdict> {
    if (!platformKeyEnabled()) {
      return {
        allowed: false,
        reason: "killed",
        // Deliberately says the platform's key is unavailable rather than blaming the workspace.
        // Whoever hit this did nothing wrong, and telling them they are over a limit they are
        // not over is how a support queue fills up during an incident.
        message:
          "runs on the platform's provider key are paused on this deployment — " +
          "connect your own Anthropic or OpenAI key to keep going",
      };
    }

    const balance = await this.billing.balance(ctx);
    const workspace = await this.identity.workspaceById(ctx, ctx.workspaceId);
    const limits = limitsFor(workspace?.plan, balance.limit_overrides);

    if (!limits.features.platformKey) {
      return {
        allowed: false,
        reason: "plan",
        message: `the ${limits.label} plan runs on your own provider key — connect one to start a run`,
      };
    }

    const ceiling = limits.platformKeyCeilingUsd;
    const spend = await this.platformSpend(ctx, periodStart);
    if (ceiling !== null && spend.usd >= ceiling) {
      const spent = spend.costKnown ? spend.usd.toFixed(4) : `at least ${spend.usd.toFixed(4)}`;
      return {
        allowed: false,
        reason: "ceiling",
        message:
          `this workspace has used $${spent} of the $${ceiling.toFixed(4)} the ${limits.label} plan ` +
          `covers on our provider key this period. Connect your own key to keep going, or upgrade.`,
      };
    }
    return { allowed: true, spentUsd: spend.usd, ceilingUsd: ceiling };
  }
}
