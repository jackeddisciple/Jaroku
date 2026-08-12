// The billing tables, behind the same rule every other repository follows: every method takes
// a TenantContext first and every statement filters on it.
//
// The rule is worth restating here rather than assumed, because the failure mode is different
// in kind. A cross-tenant read of a trace shows somebody data that is not theirs. A
// cross-tenant write HERE moves money: a usage row written into the wrong workspace is an
// invoice line somebody else pays, and a balance read from the wrong workspace is a run that
// should have been refused and was not. `plans` is the one exception in this file — it is the
// platform's own catalogue, has no workspace_id, and takes an AnyContext for that reason.
//
// WHAT THIS FILE DOES NOT DO. There is no `reserve()` here yet. Taking a hold is an atomic
// UPDATE plus a row, and it has to be one transaction with a specific refusal semantics — that
// is its own commit, in billing/balances.ts, on top of these primitives. What is here is the
// storage: rows in, rows out, and the one invariant the storage itself can carry, which is that
// a usage event with a key already recorded is not recorded twice.

import { randomUUID } from "node:crypto";
import { asBool, asInt, jsonFromColumn, type Db, type Queryable } from "../db.ts";
import type { AnyContext, TenantContext } from "../tenant.ts";
import type { UsageKind } from "../../billing/usage.ts";

// --- row shapes ---------------------------------------------------------------------------

export interface PlanRow {
  id: string;
  display_name: string;
  /** The payment provider's price object, or null for a plan nobody can buy. */
  external_price_id: string | null;
  purchasable: boolean;
  created_at: string;
}

export interface BalanceRow {
  workspace_id: string;
  balance_usd: number;
  /** The part of `balance_usd` some in-flight run has already claimed. */
  reserved_usd: number;
  /** A hard per-workspace ceiling, or null for "whatever the plan says". 0 is not null. */
  ceiling_usd: number | null;
  /** This workspace's negotiated exceptions to its plan's limits. Usually empty. */
  limit_overrides: Record<string, unknown>;
  updated_at: string;
}

export interface UsageEventInput {
  kind: UsageKind;
  /** What makes at-least-once ingestion safe here. See billing/usage.ts's `usageKey`. */
  idempotencyKey: string;
  runId?: string | null;
  provider?: string | null;
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cachedInputTokens?: number | null;
  /**
   * USD, or null for UNKNOWN.
   *
   * Null and 0 are different claims and this interface refuses to let them blur: passing null
   * writes `cost_known = false`, passing 0 writes `cost_known = true`. A caller that means "we
   * could not price this" must pass null, not a zero it rounded down to.
   */
  costUsd?: number | null;
  occurredAt?: string;
}

export interface UsageEventRow {
  id: number;
  workspace_id: string;
  run_id: string | null;
  kind: string;
  provider: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number | null;
  cost_usd: number | null;
  cost_known: boolean;
  occurred_at: string;
  idempotency_key: string;
}

export interface HoldRow {
  id: string;
  workspace_id: string;
  amount_usd: number;
  purpose: string;
  subject_id: string | null;
  created_at: string;
  expires_at: string;
  released_at: string | null;
}

export interface SubscriptionRow {
  id: string;
  workspace_id: string;
  plan_id: string;
  status: string;
  external_customer_id: string | null;
  external_subscription_id: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  created_at: string;
  updated_at: string;
}

/** What a workspace has spent, rolled up. `costKnown` is false when any row was unpriced. */
export interface SpendTotals {
  /** Sum of the rows that HAD a cost. A floor when `costKnown` is false. */
  usd: number;
  /** How many rows were metered but could not be priced. */
  unpricedEvents: number;
  /** False when `unpricedEvents > 0` — the total is an undercount, and must be shown as one. */
  costKnown: boolean;
}

const nowIso = (): string => new Date().toISOString();

/** The statuses that mean a subscription is in force. Matches the partial unique index. */
export const LIVE_SUBSCRIPTION_STATUSES = ["incomplete", "active", "past_due"] as const;

const USAGE_COLUMNS = `id, workspace_id, run_id, kind, provider, model, input_tokens,
                       output_tokens, cached_input_tokens, cost_usd, cost_known, occurred_at,
                       idempotency_key`;
const HOLD_COLUMNS = `id, workspace_id, amount_usd, purpose, subject_id, created_at,
                      expires_at, released_at`;
const SUBSCRIPTION_COLUMNS = `id, workspace_id, plan_id, status, external_customer_id,
                              external_subscription_id, current_period_end,
                              cancel_at_period_end, created_at, updated_at`;

export class BillingRepository {
  constructor(private db: Db) {}

  private q(ctx: TenantContext): Queryable {
    return this.db.forWorkspace(ctx.workspaceId);
  }

  // --- plans ------------------------------------------------------------------------------
  //
  // AnyContext, and no scope. `plans` is what the platform sells; every workspace reads the
  // same rows, and there is no policy on the table for the same reason there is none on
  // `workspaces`. The LIMITS each plan implies are not here at all — see billing/plans.ts and
  // migration 020's header.

  async listPlans(_ctx: AnyContext): Promise<PlanRow[]> {
    const rows = await this.db.all<Record<string, unknown>>(
      `SELECT id, display_name, external_price_id, purchasable, created_at FROM plans ORDER BY id`,
    );
    return rows.map((r) => ({
      id: String(r["id"]),
      display_name: String(r["display_name"]),
      external_price_id: (r["external_price_id"] as string | null) ?? null,
      purchasable: asBool(r["purchasable"]),
      created_at: String(r["created_at"]),
    }));
  }

  /** Bind a plan to this deployment's price object. Configuration, applied at boot or by hand. */
  async setPlanPrice(_ctx: AnyContext, planId: string, externalPriceId: string | null): Promise<void> {
    await this.db.run(`UPDATE plans SET external_price_id = ? WHERE id = ?`, [externalPriceId, planId]);
  }

  // --- balances ---------------------------------------------------------------------------

  /**
   * This workspace's balance row, creating an empty one if it has none.
   *
   * Created lazily rather than at signup, and that is deliberate: a workspace that never spends
   * anything never needs a row, and a migration that backfilled one for every existing workspace
   * would be writing rows to record the absence of activity. The INSERT is ON CONFLICT DO
   * NOTHING because two requests for the same workspace really do arrive together — the
   * dashboard and a run's own gate, in the same tick.
   */
  async balance(ctx: TenantContext): Promise<BalanceRow> {
    const existing = await this.readBalance(this.q(ctx), ctx.workspaceId);
    if (existing) return existing;
    await this.q(ctx).run(
      `INSERT INTO workspace_balances (workspace_id, balance_usd, reserved_usd, ceiling_usd,
         limit_overrides, updated_at)
       VALUES (?, 0, 0, NULL, ?, ?)
       ON CONFLICT (workspace_id) DO NOTHING`,
      [ctx.workspaceId, "{}", nowIso()],
    );
    const created = await this.readBalance(this.q(ctx), ctx.workspaceId);
    if (!created) throw new Error(`could not open a balance for workspace ${ctx.workspaceId}`);
    return created;
  }

  /** Add (or, with a negative amount, remove) credit. For a purchase, a grant, or a refund. */
  async addCredit(ctx: TenantContext, usd: number): Promise<BalanceRow> {
    await this.balance(ctx);
    await this.q(ctx).run(
      `UPDATE workspace_balances SET balance_usd = balance_usd + ?, updated_at = ?
        WHERE workspace_id = ?`,
      [usd, nowIso(), ctx.workspaceId],
    );
    return this.balance(ctx);
  }

  /**
   * Set this workspace's own ceiling, or clear it back to the plan's.
   *
   * `null` and `0` are different and both are meaningful: null means "use the plan's number",
   * 0 means "this workspace may start nothing". A signature that took a number and treated 0 as
   * unset could not express the second, which is the one an abuse response needs.
   */
  async setCeiling(ctx: TenantContext, usd: number | null): Promise<void> {
    await this.balance(ctx);
    await this.q(ctx).run(
      `UPDATE workspace_balances SET ceiling_usd = ?, updated_at = ? WHERE workspace_id = ?`,
      [usd, nowIso(), ctx.workspaceId],
    );
  }

  /** Replace this workspace's negotiated exceptions to its plan's limits. */
  async setLimitOverrides(ctx: TenantContext, overrides: Record<string, unknown>): Promise<void> {
    await this.balance(ctx);
    await this.q(ctx).run(
      `UPDATE workspace_balances SET limit_overrides = ?, updated_at = ? WHERE workspace_id = ?`,
      [JSON.stringify(overrides ?? {}), nowIso(), ctx.workspaceId],
    );
  }

  private async readBalance(q: Queryable, workspaceId: string): Promise<BalanceRow | undefined> {
    const row = await q.get<Record<string, unknown>>(
      `SELECT workspace_id, balance_usd, reserved_usd, ceiling_usd, limit_overrides, updated_at
         FROM workspace_balances WHERE workspace_id = ?`,
      [workspaceId],
    );
    if (!row) return undefined;
    const overrides = jsonFromColumn(this.db.dialect, row["limit_overrides"]);
    return {
      workspace_id: String(row["workspace_id"]),
      balance_usd: Number(row["balance_usd"] ?? 0),
      reserved_usd: Number(row["reserved_usd"] ?? 0),
      ceiling_usd: row["ceiling_usd"] === null || row["ceiling_usd"] === undefined
        ? null
        : Number(row["ceiling_usd"]),
      limit_overrides:
        overrides && typeof overrides === "object" ? (overrides as Record<string, unknown>) : {},
      updated_at: String(row["updated_at"]),
    };
  }

  // --- usage ------------------------------------------------------------------------------

  /**
   * Record one metered event. Returns false when this key was already recorded.
   *
   * ON CONFLICT DO NOTHING, never a SELECT-then-INSERT. The redelivery this defends against is
   * concurrent by construction — a worker whose lease lapsed is replaced while the original may
   * still be finishing — so a check that precedes the write is two writers both finding nothing
   * and both inserting. The unique index is the only thing that can arbitrate, and the return
   * value is how the caller learns which side of it landed.
   *
   * The boolean is worth having rather than swallowing: "we already billed this" is a normal
   * event on an at-least-once pipeline and a counter worth watching, exactly as
   * `trace_ingest_dropped` is on the other side of the same delivery.
   */
  async record(ctx: TenantContext, e: UsageEventInput): Promise<boolean> {
    const known = e.costUsd !== null && e.costUsd !== undefined;
    const res = await this.q(ctx).run(
      `INSERT INTO usage_events (workspace_id, run_id, kind, provider, model, input_tokens,
         output_tokens, cached_input_tokens, cost_usd, cost_known, occurred_at, idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        ctx.workspaceId,
        e.runId ?? null,
        e.kind,
        e.provider ?? null,
        e.model ?? null,
        e.inputTokens ?? null,
        e.outputTokens ?? null,
        e.cachedInputTokens ?? null,
        known ? e.costUsd : null,
        known ? 1 : 0,
        e.occurredAt ?? nowIso(),
        e.idempotencyKey,
      ],
    );
    return res.changes > 0;
  }

  /**
   * What this workspace has spent since `since`, optionally narrowed to some kinds.
   *
   * Two numbers rather than one, and that is the "unknown is not zero" rule surviving into the
   * aggregate. SUM over a column with NULLs quietly skips them, so a workspace with one
   * unpriced model would otherwise be shown a confident total that is a floor. The count of
   * unpriced rows travels with the sum so the caller cannot use one without the other.
   */
  async spendSince(ctx: TenantContext, since: string, kinds?: readonly UsageKind[]): Promise<SpendTotals> {
    const filter = kinds?.length ? `AND kind IN (${kinds.map(() => "?").join(", ")})` : "";
    const args = kinds?.length
      ? [ctx.workspaceId, since, ...kinds]
      : [ctx.workspaceId, since];
    const row = await this.q(ctx).get<{ total: unknown; unpriced: unknown }>(
      `SELECT COALESCE(SUM(cost_usd), 0) AS total,
              COUNT(CASE WHEN cost_usd IS NULL THEN 1 END) AS unpriced
         FROM usage_events
        WHERE workspace_id = ? AND occurred_at >= ? ${filter}`,
      args,
    );
    const unpriced = asInt(row?.unpriced);
    return { usd: Number(row?.total ?? 0), unpricedEvents: unpriced, costKnown: unpriced === 0 };
  }

  /** Every event for one run, oldest first. The dashboard's per-run drill-down. */
  async eventsForRun(ctx: TenantContext, runId: string): Promise<UsageEventRow[]> {
    const rows = await this.q(ctx).all<Record<string, unknown>>(
      `SELECT ${USAGE_COLUMNS} FROM usage_events
        WHERE workspace_id = ? AND run_id = ? ORDER BY occurred_at ASC, id ASC`,
      [ctx.workspaceId, runId],
    );
    return rows.map((r) => this.hydrateUsage(r));
  }

  /** The most recent events, newest first. What the dashboard's activity list renders. */
  async recentEvents(ctx: TenantContext, limit = 100): Promise<UsageEventRow[]> {
    const rows = await this.q(ctx).all<Record<string, unknown>>(
      `SELECT ${USAGE_COLUMNS} FROM usage_events
        WHERE workspace_id = ? ORDER BY occurred_at DESC, id DESC LIMIT ?`,
      [ctx.workspaceId, limit],
    );
    return rows.map((r) => this.hydrateUsage(r));
  }

  private hydrateUsage(r: Record<string, unknown>): UsageEventRow {
    return {
      id: asInt(r["id"]),
      workspace_id: String(r["workspace_id"]),
      run_id: (r["run_id"] as string | null) ?? null,
      kind: String(r["kind"]),
      provider: (r["provider"] as string | null) ?? null,
      model: (r["model"] as string | null) ?? null,
      input_tokens: r["input_tokens"] === null || r["input_tokens"] === undefined ? null : asInt(r["input_tokens"]),
      output_tokens: r["output_tokens"] === null || r["output_tokens"] === undefined ? null : asInt(r["output_tokens"]),
      cached_input_tokens:
        r["cached_input_tokens"] === null || r["cached_input_tokens"] === undefined
          ? null
          : asInt(r["cached_input_tokens"]),
      cost_usd: r["cost_usd"] === null || r["cost_usd"] === undefined ? null : Number(r["cost_usd"]),
      cost_known: asBool(r["cost_known"]),
      occurred_at: String(r["occurred_at"]),
      idempotency_key: String(r["idempotency_key"]),
    };
  }

  // --- holds ------------------------------------------------------------------------------
  //
  // Storage only. What makes a hold safe — taking it and moving `reserved_usd` in ONE atomic
  // step, and refusing rather than overdrawing — is billing/balances.ts's job, built on these.

  async hold(ctx: TenantContext, id: string): Promise<HoldRow | undefined> {
    const row = await this.q(ctx).get<Record<string, unknown>>(
      `SELECT ${HOLD_COLUMNS} FROM billing_holds WHERE id = ? AND workspace_id = ?`,
      [id, ctx.workspaceId],
    );
    return row ? this.hydrateHold(row) : undefined;
  }

  /** Holds still standing for this workspace, oldest expiry first. */
  async liveHolds(ctx: TenantContext): Promise<HoldRow[]> {
    const rows = await this.q(ctx).all<Record<string, unknown>>(
      `SELECT ${HOLD_COLUMNS} FROM billing_holds
        WHERE workspace_id = ? AND released_at IS NULL ORDER BY expires_at ASC`,
      [ctx.workspaceId],
    );
    return rows.map((r) => this.hydrateHold(r));
  }

  /**
   * Holds whose expiry has passed and which nobody released.
   *
   * The sweeper's input. Scoped like everything else, so the sweep walks the workspace list —
   * the same shape the eval reconciliation and the checkpoint sweep already have, and for the
   * same reason: an unscoped query returns nothing at all as the application role.
   */
  async expiredHolds(ctx: TenantContext, now = nowIso()): Promise<HoldRow[]> {
    const rows = await this.q(ctx).all<Record<string, unknown>>(
      `SELECT ${HOLD_COLUMNS} FROM billing_holds
        WHERE workspace_id = ? AND released_at IS NULL AND expires_at <= ?
        ORDER BY expires_at ASC`,
      [ctx.workspaceId, now],
    );
    return rows.map((r) => this.hydrateHold(r));
  }

  private hydrateHold(r: Record<string, unknown>): HoldRow {
    return {
      id: String(r["id"]),
      workspace_id: String(r["workspace_id"]),
      amount_usd: Number(r["amount_usd"] ?? 0),
      purpose: String(r["purpose"]),
      subject_id: (r["subject_id"] as string | null) ?? null,
      created_at: String(r["created_at"]),
      expires_at: String(r["expires_at"]),
      released_at: (r["released_at"] as string | null) ?? null,
    };
  }

  // --- subscriptions -----------------------------------------------------------------------

  /** The subscription in force for this workspace, or undefined. */
  async liveSubscription(ctx: TenantContext): Promise<SubscriptionRow | undefined> {
    const row = await this.q(ctx).get<Record<string, unknown>>(
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions
        WHERE workspace_id = ? AND status IN (${LIVE_SUBSCRIPTION_STATUSES.map(() => "?").join(", ")})
        ORDER BY created_at DESC LIMIT 1`,
      [ctx.workspaceId, ...LIVE_SUBSCRIPTION_STATUSES],
    );
    return row ? this.hydrateSubscription(row) : undefined;
  }

  async subscriptions(ctx: TenantContext): Promise<SubscriptionRow[]> {
    const rows = await this.q(ctx).all<Record<string, unknown>>(
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions
        WHERE workspace_id = ? ORDER BY created_at DESC`,
      [ctx.workspaceId],
    );
    return rows.map((r) => this.hydrateSubscription(r));
  }

  /**
   * Insert or update the subscription with this external id.
   *
   * Keyed on the PROVIDER's id, not on the workspace, because that is the identity a webhook
   * carries and webhooks arrive out of order. An update that matched on workspace would let a
   * late `customer.subscription.created` overwrite the `updated` that already superseded it.
   */
  async upsertSubscription(
    ctx: TenantContext,
    s: {
      planId: string;
      status: string;
      externalCustomerId?: string | null;
      externalSubscriptionId: string;
      currentPeriodEnd?: string | null;
      cancelAtPeriodEnd?: boolean;
    },
  ): Promise<SubscriptionRow> {
    const now = nowIso();
    await this.q(ctx).run(
      `INSERT INTO subscriptions (id, workspace_id, plan_id, status, external_customer_id,
         external_subscription_id, current_period_end, cancel_at_period_end, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (external_subscription_id) DO UPDATE SET
         plan_id = excluded.plan_id,
         status = excluded.status,
         external_customer_id = COALESCE(excluded.external_customer_id, subscriptions.external_customer_id),
         current_period_end = excluded.current_period_end,
         cancel_at_period_end = excluded.cancel_at_period_end,
         updated_at = excluded.updated_at
       WHERE subscriptions.workspace_id = ?`,
      [
        randomUUID(),
        ctx.workspaceId,
        s.planId,
        s.status,
        s.externalCustomerId ?? null,
        s.externalSubscriptionId,
        s.currentPeriodEnd ?? null,
        s.cancelAtPeriodEnd ? 1 : 0,
        now,
        now,
        ctx.workspaceId,
      ],
    );
    const row = await this.q(ctx).get<Record<string, unknown>>(
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions
        WHERE workspace_id = ? AND external_subscription_id = ?`,
      [ctx.workspaceId, s.externalSubscriptionId],
    );
    if (!row) throw new Error(`subscription ${s.externalSubscriptionId} did not persist`);
    return this.hydrateSubscription(row);
  }

  private hydrateSubscription(r: Record<string, unknown>): SubscriptionRow {
    return {
      id: String(r["id"]),
      workspace_id: String(r["workspace_id"]),
      plan_id: String(r["plan_id"]),
      status: String(r["status"]),
      external_customer_id: (r["external_customer_id"] as string | null) ?? null,
      external_subscription_id: (r["external_subscription_id"] as string | null) ?? null,
      current_period_end: (r["current_period_end"] as string | null) ?? null,
      cancel_at_period_end: asBool(r["cancel_at_period_end"]),
      created_at: String(r["created_at"]),
      updated_at: String(r["updated_at"]),
    };
  }
}
