// Money held before it is spent.
//
// WHY A HOLD AND NOT A CHECK. "Read the balance, decide, then spend" is not a check under
// concurrency — it is ten runs each reading the same balance, each concluding there is room, and
// all ten starting. The gap between the read and the spend is where the overdraft lives, and no
// amount of care at the call site closes it, because the call sites are on different machines.
//
// So the check and the claim are ONE STATEMENT:
//
//   UPDATE workspace_balances
//      SET reserved_usd = reserved_usd + $2
//    WHERE workspace_id = $1 AND (balance_usd - reserved_usd) >= $2
//
// Zero rows means refused. The database is the only thing that can arbitrate between two
// requests that arrive together, and this is it doing so — the same shape as the queue's Lua
// admit script, for the same reason: rotate-check-pop is one step there because two workers
// must not both see room, and read-decide-spend is one step here because two runs must not
// both see credit.
//
// AND A HOLD IS A ROW, NOT JUST A NUMBER. The UPDATE above moves a counter; something has to
// move it back by exactly the same amount when the run ends, including when the process that
// took it is gone. Session 5 learned this in the small — a per-workspace interactive
// reservation taken for a run that never started held for the lease's full hour — and money is
// the worse version of it: a leaked slot costs a workspace an hour, a leaked hold costs it the
// balance. The row carries an amount and an expiry, so a sweeper can find what nobody released.
//
// WHAT THIS FILE DOES NOT DECIDE. Whether a workspace should be asked to reserve at all is not
// here. Under BYOK the balance is zero forever and nothing may consult it; under the platform
// key it is the gate. That decision belongs where the plan and the provider key are known — see
// the pre-dispatch gate — and keeping it out of this module is what lets the mechanism be
// unconditional while the policy is not.

import { randomUUID } from "node:crypto";
import type { Db, Queryable } from "../db/db.ts";
import type { TenantContext } from "../db/tenant.ts";
import type { BillingRepository } from "../db/repositories/billing.ts";
import { round8 } from "../pricing.ts";

/** How long a hold stands before a sweeper may reclaim it. Generous on purpose: this is a
 *  crash safety net, not the release path, and a TTL short enough to fire during a legitimately
 *  long run would return money that is about to be spent. */
export const DEFAULT_HOLD_TTL_MS = 60 * 60 * 1000;

export interface ReserveRequest {
  /** What to hold, in USD. Rounded to the module's precision before anything is written. */
  amountUsd: number;
  /** `run` or `eval` — what the hold is for, so a sweeper's log names a thing and not a uuid. */
  purpose: "run" | "eval";
  subjectId?: string | null;
  ttlMs?: number;
}

export type ReserveResult =
  | { ok: true; holdId: string; available: number }
  | { ok: false; reason: "insufficient"; available: number; requested: number };

export class Balances {
  constructor(
    private db: Db,
    private billing: BillingRepository,
  ) {}

  /** Credit not already spoken for. A read, and therefore never the basis of a decision — see
   *  the file header. For showing somebody a number, and for explaining a refusal after it. */
  async available(ctx: TenantContext): Promise<number> {
    const b = await this.billing.balance(ctx);
    return round8(Math.max(0, b.balance_usd - b.reserved_usd));
  }

  /**
   * Claim `amountUsd` against this workspace's balance, or refuse.
   *
   * THE UPDATE AND THE HOLD ROW ARE ONE TRANSACTION. A counter moved without a row is money
   * held with nothing to release it — indistinguishable, afterwards, from a workspace that
   * genuinely has less credit. A row written without the counter moving is a hold that protects
   * nothing and gives money back on release that was never taken.
   *
   * A REQUEST FOR NOTHING IS NOT A REFUSAL. Reserving zero — a free-provider run, a dry run,
   * anything the estimator prices at nothing — succeeds and writes a hold of 0, so the caller's
   * release path is the same shape either way. A caller that had to branch on "did I actually
   * take a hold" is a caller that will forget to release one.
   */
  async reserve(ctx: TenantContext, req: ReserveRequest): Promise<ReserveResult> {
    const amount = round8(Math.max(0, req.amountUsd));
    // Materialise the row first, outside the transaction that claims against it. `balance` is
    // an INSERT ... ON CONFLICT DO NOTHING plus a read, and doing it inside would mean the
    // claiming UPDATE and the row's creation race each other on Postgres for no benefit.
    await this.billing.balance(ctx);

    return this.db.scoped<ReserveResult>(ctx.workspaceId, async (tx: Queryable) => {
      const now = new Date().toISOString();
      // The whole of the concurrency control. Two of these against the same row serialise on
      // Postgres (the UPDATE takes a row lock) and on SQLite (one writer), so the second sees
      // the first's `reserved_usd` and its WHERE either still holds or does not.
      const claimed = await tx.run(
        `UPDATE workspace_balances
            SET reserved_usd = reserved_usd + ?, updated_at = ?
          WHERE workspace_id = ? AND (balance_usd - reserved_usd) >= ?`,
        [amount, now, ctx.workspaceId, amount],
      );
      if (claimed.changes === 0) {
        const row = await tx.get<{ balance_usd: unknown; reserved_usd: unknown }>(
          `SELECT balance_usd, reserved_usd FROM workspace_balances WHERE workspace_id = ?`,
          [ctx.workspaceId],
        );
        const available = round8(
          Math.max(0, Number(row?.balance_usd ?? 0) - Number(row?.reserved_usd ?? 0)),
        );
        // The figures travel with the refusal so the caller can say what would clear it. A
        // refusal that only says "no" sends somebody to a dashboard to work out why.
        return { ok: false, reason: "insufficient", available, requested: amount };
      }

      const holdId = randomUUID();
      await tx.run(
        `INSERT INTO billing_holds (id, workspace_id, amount_usd, purpose, subject_id,
           created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          holdId,
          ctx.workspaceId,
          amount,
          req.purpose,
          req.subjectId ?? null,
          now,
          new Date(Date.now() + (req.ttlMs ?? DEFAULT_HOLD_TTL_MS)).toISOString(),
        ],
      );
      const after = await tx.get<{ balance_usd: unknown; reserved_usd: unknown }>(
        `SELECT balance_usd, reserved_usd FROM workspace_balances WHERE workspace_id = ?`,
        [ctx.workspaceId],
      );
      return {
        ok: true,
        holdId,
        available: round8(Math.max(0, Number(after?.balance_usd ?? 0) - Number(after?.reserved_usd ?? 0))),
      };
    });
  }

  /**
   * Give a hold back, and take what was actually spent out of the balance.
   *
   * TWO SEPARATE MOVEMENTS, and conflating them is the bug. Releasing frees what was held;
   * settling deducts what was used. They are almost never the same number — a hold is an
   * estimate — and a version that just deducted the hold would charge every run its estimate
   * rather than its cost.
   *
   * `settleUsd` MAY EXCEED THE HOLD, and is deducted in full when it does. The ceiling bounds
   * what is STARTED, not what is spent: a run already in flight runs to completion, so its
   * final cost can exceed what was reserved for it. Clamping the deduction to the hold would
   * mean the platform ate the difference every time an estimate ran low, which is precisely the
   * direction estimates run.
   *
   * IDEMPOTENT, AND THAT GUARD IS LOAD-BEARING. `released_at IS NULL` in the WHERE is what
   * makes a second release a no-op instead of a second credit — and a second release is not
   * hypothetical: a run that ends normally releases its own hold while a sweeper may already
   * have decided the lease lapsed. Whichever gets there first is the one that moves money.
   */
  async release(
    ctx: TenantContext,
    holdId: string,
    opts: { settleUsd?: number } = {},
  ): Promise<{ released: boolean; settledUsd: number }> {
    const settle = round8(Math.max(0, opts.settleUsd ?? 0));
    return this.db.scoped(ctx.workspaceId, async (tx: Queryable) => {
      const hold = await tx.get<{ amount_usd: unknown }>(
        `SELECT amount_usd FROM billing_holds
          WHERE id = ? AND workspace_id = ? AND released_at IS NULL`,
        [holdId, ctx.workspaceId],
      );
      if (!hold) return { released: false, settledUsd: 0 };

      const claimed = await tx.run(
        `UPDATE billing_holds SET released_at = ?
          WHERE id = ? AND workspace_id = ? AND released_at IS NULL`,
        [new Date().toISOString(), holdId, ctx.workspaceId],
      );
      // Somebody else released it between the read and here. Their release moved the money;
      // ours must not move it again.
      if (claimed.changes === 0) return { released: false, settledUsd: 0 };

      const amount = round8(Number(hold.amount_usd ?? 0));
      // CASE rather than a bare subtraction, on both columns. The CHECK constraint would
      // otherwise refuse the whole statement — and a settle that fails because a balance was
      // adjusted by hand mid-run would leave the hold marked released with the reservation
      // still standing, which is the one state nothing can recover from. Clamping at zero
      // records the money as gone, which it is.
      await tx.run(
        `UPDATE workspace_balances
            SET reserved_usd = CASE WHEN reserved_usd >= ? THEN reserved_usd - ? ELSE 0 END,
                balance_usd  = CASE WHEN balance_usd  >= ? THEN balance_usd  - ? ELSE 0 END,
                updated_at   = ?
          WHERE workspace_id = ?`,
        [amount, amount, settle, settle, new Date().toISOString(), ctx.workspaceId],
      );
      return { released: true, settledUsd: settle };
    });
  }

  /**
   * Reclaim holds nobody released, for ONE workspace. Returns how many were reclaimed.
   *
   * The safety net Session 5's reservation lacked. Scoped, and the caller walks the workspace
   * list, for the reason every other sweep in this codebase does: an unscoped query returns
   * nothing at all as the application role, so a "platform-wide" sweep would silently reclaim
   * nothing in exactly the deployment that needs it.
   *
   * SETTLES NOTHING. An expired hold is one whose owner is gone, and what that owner spent —
   * if anything — was already recorded in `usage_events` by the ingest path, which does not go
   * through here. Deducting the hold's amount as though it were spend would charge an estimate
   * for a run that may never have started. The money is freed; the record of what was really
   * used is where it always was.
   */
  async sweepExpired(ctx: TenantContext): Promise<number> {
    const expired = await this.billing.expiredHolds(ctx);
    let reclaimed = 0;
    for (const hold of expired) {
      const { released } = await this.release(ctx, hold.id);
      if (released) {
        reclaimed++;
        console.warn(
          `[billing] reclaimed a $${hold.amount_usd} hold on ${hold.purpose}` +
            `${hold.subject_id ? ` ${hold.subject_id}` : ""} that nobody released`,
        );
      }
    }
    return reclaimed;
  }
}
