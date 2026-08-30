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
import type { Payer, UsageKind } from "../../billing/usage.ts";

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
  /**
   * Whether this workspace's OWN provider key pays for the platform's calls on its behalf —
   * generation, the plan gate, the fix loop, explain and the judge.
   *
   * False by default and by design. A tenant's credential used for a call they did not ask for
   * is a use they did not consent to, whatever the accounting says. See migration 023.
   */
  own_key_for_platform: boolean;
  updated_at: string;
}

export interface UsageEventInput {
  kind: UsageKind;
  /** What makes at-least-once ingestion safe here. See billing/usage.ts's `usageKey`. */
  idempotencyKey: string;
  runId?: string | null;
  /**
   * The build session this call belongs to, for a row that has no run to attribute through.
   *
   * The platform's own thinking — a plan, a generation, an edit, an explanation — happens inside a
   * thread and inside nothing else, so `run_id` is null on all four and §4.3's per-thread cost
   * would silently omit them. Every other kind still attributes through its run, which is why this
   * is optional rather than required — see migration 044.
   */
  threadId?: string | null;
  provider?: string | null;
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cachedInputTokens?: number | null;
  /**
   * Every token the call consumed, when the split is not known.
   *
   * The frozen event schema gives a Step one combined figure and no split, so a usage row
   * derived from a run's trace can only ever fill this one — see migration 021. A platform-side
   * call fills the split AND this, because it knows both.
   */
  totalTokens?: number | null;
  /**
   * How much of `unit` this row is for — sandbox seconds, stored bytes.
   *
   * For the kinds that are not measured in tokens. See migration 022 for why a model call is
   * deliberately not expressed this way.
   */
  quantity?: number | null;
  unit?: string | null;
  /**
   * Whose money paid. `platform` unless the call went out on the workspace's own key.
   *
   * Defaults to the platform when a caller does not say, which is the tighter direction: the
   * platform-key ceiling then counts a row it might not have needed to, and the failure is a
   * workspace being throttled rather than the platform paying for something silently.
   */
  payer?: Payer;
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
  total_tokens: number | null;
  quantity: number | null;
  unit: string | null;
  payer: string;
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
  /** The other end of the period. Null on every row written before migration 052. */
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  /** Seats bought. One on every tier that is not Team, and the multiplier on the price if it is. */
  seat_count: number;
  /** Platform fee only, inference on the workspace's own keys. See the spec's BYOK toggle. */
  byok_enabled: boolean;
  created_at: string;
  updated_at: string;
}

/** What a workspace has spent, rolled up. `costKnown` is false when any row was unpriced. */
export interface SpendTotals {
  /** Sum of the rows that HAD a cost. A floor when `costKnown` is false. */
  usd: number;
  /** Every token metered over the same rows, priced or not. */
  tokens: number;
  /** How many rows were metered but could not be priced. */
  unpricedEvents: number;
  /** False when `unpricedEvents > 0` — the total is an undercount, and must be shown as one. */
  costKnown: boolean;
}

const nowIso = (): string => new Date().toISOString();

/**
 * The total a split implies, or null when there is no split to add up.
 *
 * Null rather than 0, and that distinction is the same one `cost_usd` draws: a call with no
 * token information recorded is not a call that used no tokens. Cached input counts — it was
 * read, it was charged for (at a cache rate, which `costFor` already applies), and leaving it
 * out would make the total disagree with the cost computed from the same three numbers.
 */
function sumTokens(e: UsageEventInput): number | null {
  const parts = [e.inputTokens, e.outputTokens, e.cachedInputTokens].filter(
    (n): n is number => typeof n === "number",
  );
  return parts.length ? parts.reduce((a, b) => a + b, 0) : null;
}

/** The statuses that mean a subscription is in force. Matches the partial unique index. */
export const LIVE_SUBSCRIPTION_STATUSES = ["incomplete", "active", "past_due"] as const;

const USAGE_COLUMNS = `id, workspace_id, run_id, kind, provider, model, input_tokens,
                       output_tokens, cached_input_tokens, total_tokens, quantity, unit, payer,
                       cost_usd, cost_known, occurred_at, idempotency_key`;
const HOLD_COLUMNS = `id, workspace_id, amount_usd, purpose, subject_id, created_at,
                      expires_at, released_at`;
const SUBSCRIPTION_COLUMNS = `id, workspace_id, plan_id, status, external_customer_id,
                              external_subscription_id, current_period_start, current_period_end,
                              cancel_at_period_end, seat_count, byok_enabled, created_at, updated_at`;

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

  /**
   * Decide whether this workspace's own provider key pays for the platform's own calls.
   *
   * An explicit boolean rather than a toggle, so the caller states the intent it wants rather
   * than the change it thinks is needed — two clicks racing on a toggle end up wherever the
   * ordering left them.
   */
  async setOwnKeyForPlatform(ctx: TenantContext, on: boolean): Promise<void> {
    await this.balance(ctx);
    await this.q(ctx).run(
      `UPDATE workspace_balances SET own_key_for_platform = ?, updated_at = ? WHERE workspace_id = ?`,
      [on ? 1 : 0, nowIso(), ctx.workspaceId],
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
      `SELECT workspace_id, balance_usd, reserved_usd, ceiling_usd, limit_overrides,
              own_key_for_platform, updated_at
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
      own_key_for_platform: asBool(row["own_key_for_platform"]),
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
      `INSERT INTO usage_events (workspace_id, run_id, thread_id, kind, provider, model, input_tokens,
         output_tokens, cached_input_tokens, total_tokens, quantity, unit, payer, cost_usd,
         cost_known, occurred_at, idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        ctx.workspaceId,
        e.runId ?? null,
        e.threadId ?? null,
        e.kind,
        e.provider ?? null,
        e.model ?? null,
        e.inputTokens ?? null,
        e.outputTokens ?? null,
        e.cachedInputTokens ?? null,
        // Derived rather than demanded: a caller that gave a split has already said what the
        // total is, and asking for it twice is asking for two numbers that can disagree.
        e.totalTokens ?? sumTokens(e),
        e.quantity ?? null,
        e.unit ?? null,
        e.payer ?? "platform",
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
    const row = await this.q(ctx).get<{ total: unknown; tokens: unknown; unpriced: unknown }>(
      `SELECT COALESCE(SUM(cost_usd), 0) AS total,
              COALESCE(SUM(total_tokens), 0) AS tokens,
              COUNT(CASE WHEN cost_usd IS NULL THEN 1 END) AS unpriced
         FROM usage_events
        WHERE workspace_id = ? AND occurred_at >= ? ${filter}`,
      args,
    );
    const unpriced = asInt(row?.unpriced);
    return {
      usd: Number(row?.total ?? 0),
      tokens: asInt(row?.tokens),
      unpricedEvents: unpriced,
      costKnown: unpriced === 0,
    };
  }

  /**
   * What one run actually cost, across every kind metered against it.
   *
   * The settle figure. A hold is an estimate and this is the bill — see billing/balances.ts on
   * why releasing and settling are two movements rather than one. Carries the same
   * unpriced-row count `spendSince` does, so a caller that settles against an incomplete total
   * can know it is settling a floor rather than discovering it later.
   */
  async runSpend(ctx: TenantContext, runId: string): Promise<SpendTotals> {
    const row = await this.q(ctx).get<{ total: unknown; tokens: unknown; unpriced: unknown }>(
      `SELECT COALESCE(SUM(cost_usd), 0) AS total,
              COALESCE(SUM(total_tokens), 0) AS tokens,
              COUNT(CASE WHEN cost_usd IS NULL THEN 1 END) AS unpriced
         FROM usage_events WHERE workspace_id = ? AND run_id = ?`,
      [ctx.workspaceId, runId],
    );
    const unpriced = asInt(row?.unpriced);
    return {
      usd: Number(row?.total ?? 0),
      tokens: asInt(row?.tokens),
      unpricedEvents: unpriced,
      costKnown: unpriced === 0,
    };
  }

  /**
   * What the PLATFORM paid on this workspace's behalf, this period.
   *
   * `payer = 'platform'` and nothing else — not a kind filter. Counting by kind would count an
   * `llm.provider` call a workspace made on its own key, and the platform-key ceiling would then
   * throttle somebody for spending their own money. Sandbox seconds and stored bytes are
   * included because they are ours to pay for whoever the agent's key belonged to, and a free
   * tier farmed for compute rather than for tokens shows up in no token counter.
   */
  async platformSpendSince(ctx: TenantContext, since: string): Promise<SpendTotals> {
    const row = await this.q(ctx).get<{ total: unknown; tokens: unknown; unpriced: unknown }>(
      `SELECT COALESCE(SUM(cost_usd), 0) AS total,
              COALESCE(SUM(total_tokens), 0) AS tokens,
              COUNT(CASE WHEN cost_usd IS NULL THEN 1 END) AS unpriced
         FROM usage_events
        WHERE workspace_id = ? AND occurred_at >= ? AND payer = 'platform'`,
      [ctx.workspaceId, since],
    );
    const unpriced = asInt(row?.unpriced);
    return {
      usd: Number(row?.total ?? 0),
      tokens: asInt(row?.tokens),
      unpricedEvents: unpriced,
      costKnown: unpriced === 0,
    };
  }

  /**
   * Spend this period, grouped by the AGENT whose run produced it.
   *
   * Joined through `runs` rather than stored on the usage row, and that is deliberate: an agent
   * can be renamed, deleted or replaced, and a usage row that carried a copy of its id would go
   * on describing an agent that no longer means what it did. The join answers "what does this
   * spend belong to NOW", which is the question a dashboard is actually asking.
   *
   * Rows with no run — a generation, a plan, a judge verdict — are grouped under a null agent
   * rather than dropped. They are real money and a breakdown that omitted them would not add up
   * to the total shown above it, which is the fastest way to make somebody stop believing a
   * billing page.
   */
  async spendByAgent(
    ctx: TenantContext,
    since: string,
  ): Promise<{ agentId: string | null; usd: number; tokens: number; costKnown: boolean; runs: number }[]> {
    const rows = await this.q(ctx).all<Record<string, unknown>>(
      `SELECT r.agent_id AS agent_id,
              COALESCE(SUM(u.cost_usd), 0) AS usd,
              COALESCE(SUM(u.total_tokens), 0) AS tokens,
              COUNT(CASE WHEN u.cost_usd IS NULL THEN 1 END) AS unpriced,
              COUNT(DISTINCT u.run_id) AS runs
         FROM usage_events u
         LEFT JOIN runs r ON r.id = u.run_id AND r.workspace_id = u.workspace_id
        WHERE u.workspace_id = ? AND u.occurred_at >= ?
        GROUP BY r.agent_id`,
      [ctx.workspaceId, since],
    );
    return rows
      .map((r) => ({
        agentId: (r["agent_id"] as string | null) ?? null,
        usd: Number(r["usd"] ?? 0),
        tokens: asInt(r["tokens"]),
        costKnown: asInt(r["unpriced"]) === 0,
        runs: asInt(r["runs"]),
      }))
      .sort((a, b) => b.usd - a.usd);
  }

  /**
   * What each build session has spent, all of it, ever.
   *
   * NO `since`, unlike every other aggregate here, and that is §4.3's cost column rather than an
   * omission: the row shows "cumulative spend attributed to this thread", which is a fact about the
   * session and not about the billing period. A thread somebody comes back to after five weeks has
   * to show what it actually cost, not what it cost since the first of the month.
   *
   * TWO QUERIES, BECAUSE THERE ARE TWO WAYS A ROW BELONGS TO A THREAD (migration 044). An agent's
   * own model calls carry `run_id`, and the run is joined to its session through `thread_items`. The
   * platform's own thinking — plan, generation, edit, explain — carries no run at all and names the
   * thread directly. Summing only one of the two would produce a figure that is confidently short,
   * which is the same failure mode as a silent zero.
   *
   * THE UNPRICED COUNT TRAVELS WITH THE SUM, exactly as `spendSince` makes it. An unpriced model
   * contributes null, SUM skips nulls, and a thread with one such call would otherwise render a
   * total that is a floor as though it were the answer — which §4.3 spells out as the difference
   * between `$0.04+` and `$0.04`.
   */
  async spendByThread(
    ctx: TenantContext,
  ): Promise<Map<string, { usd: number; costKnown: boolean }>> {
    const totals = new Map<string, { usd: number; unpriced: number }>();
    const add = (threadId: string, usd: number, unpriced: number): void => {
      const at = totals.get(threadId) ?? { usd: 0, unpriced: 0 };
      at.usd += usd;
      at.unpriced += unpriced;
      totals.set(threadId, at);
    };

    // Through the run that produced them.
    const viaRun = await this.q(ctx).all<Record<string, unknown>>(
      `SELECT ti.thread_id AS thread_id,
              COALESCE(SUM(u.cost_usd), 0) AS usd,
              COUNT(CASE WHEN u.cost_usd IS NULL THEN 1 END) AS unpriced
         FROM usage_events u
         JOIN thread_items ti ON ti.workspace_id = u.workspace_id
                             AND ti.kind = 'run' AND ti.ref_id = u.run_id
        WHERE u.workspace_id = ? AND u.run_id IS NOT NULL
        GROUP BY ti.thread_id`,
      [ctx.workspaceId],
    );
    for (const r of viaRun) add(String(r["thread_id"]), Number(r["usd"] ?? 0), asInt(r["unpriced"]));

    // And the platform's own calls, which name the thread themselves.
    const direct = await this.q(ctx).all<Record<string, unknown>>(
      `SELECT thread_id,
              COALESCE(SUM(cost_usd), 0) AS usd,
              COUNT(CASE WHEN cost_usd IS NULL THEN 1 END) AS unpriced
         FROM usage_events
        WHERE workspace_id = ? AND thread_id IS NOT NULL AND run_id IS NULL
        GROUP BY thread_id`,
      [ctx.workspaceId],
    );
    for (const r of direct) add(String(r["thread_id"]), Number(r["usd"] ?? 0), asInt(r["unpriced"]));

    // AND A THIRD WAY, WHICH ARRIVED WITH PART 3'S OPERATE THREADS. A job an operate conversation
    // dispatched is bound to it as a `work` item, not as a `run` one — §5: "a work item carries
    // `ref_id` = the `work_items.id`, exactly as a run item carries a run id" — so the first query
    // above cannot see it. Its trace is reachable in one more hop, through `work_items.run_id`.
    //
    // WITHOUT THIS, AN OPERATE THREAD SHOWED THE COST OF ASKING AND NOT THE COST OF DOING: a
    // conversation that spent four pence on questions and eleven pounds on jobs would have rendered
    // fourpence, which is the confidently-short figure this method's own header is about. The
    // `LEFT JOIN` is not needed — a work item with no run never reached the container and has no
    // usage rows to find.
    const viaWork = await this.q(ctx).all<Record<string, unknown>>(
      `SELECT ti.thread_id AS thread_id,
              COALESCE(SUM(u.cost_usd), 0) AS usd,
              COUNT(CASE WHEN u.cost_usd IS NULL THEN 1 END) AS unpriced
         FROM usage_events u
         JOIN work_items w ON w.workspace_id = u.workspace_id AND w.run_id = u.run_id
         JOIN thread_items ti ON ti.workspace_id = u.workspace_id
                             AND ti.kind = 'work' AND ti.ref_id = w.id
        WHERE u.workspace_id = ? AND u.run_id IS NOT NULL
        GROUP BY ti.thread_id`,
      [ctx.workspaceId],
    );
    for (const r of viaWork) add(String(r["thread_id"]), Number(r["usd"] ?? 0), asInt(r["unpriced"]));

    return new Map(
      [...totals].map(([threadId, t]) => [threadId, { usd: t.usd, costKnown: t.unpriced === 0 }]),
    );
  }

  /**
   * What ASKING has cost, per thread — Part 3 §10.
   *
   * SEPARATE FROM THE TOTAL ABOVE RATHER THAN INSTEAD OF IT, and §10 says why in terms of the
   * AGENT rather than the thread: "it is the same model on every question, and folding it into the
   * agent's figure would add a constant to each and make a cheap agent look expensive." The same
   * argument applies one level down. A conversation's total is what the conversation cost, which is
   * the honest number for a bill; but "of which fourpence was me asking" is the number that tells
   * somebody whether the questions are worth what they cost, and it cannot be recovered from a
   * total.
   *
   * IT IS ALREADY SEPARATE FROM `spendByAgent` AND THAT IS BY CONSTRUCTION, not by a filter here:
   * `meterPlatformCall` writes these rows with no `run_id`, and `spendByAgent` groups through
   * `runs` — so an explain lands in that method's null-agent bucket, beside the generations and the
   * judge verdicts, exactly as §10 asks. It still counts toward true spend and toward the ceiling,
   * because it is in this table like everything else.
   *
   * `kind = 'llm.explain'` IS THE WHOLE FILTER. Both callers of the explainer meter under that kind
   * — the build composer's answers and Part 3's — because they are the same model on the same key,
   * and a second kind for the second caller would be a second thing to remember to add up.
   */
  async askSpendByThread(
    ctx: TenantContext,
  ): Promise<Map<string, { usd: number; costKnown: boolean }>> {
    const rows = await this.q(ctx).all<Record<string, unknown>>(
      `SELECT thread_id,
              COALESCE(SUM(cost_usd), 0) AS usd,
              COUNT(CASE WHEN cost_usd IS NULL THEN 1 END) AS unpriced
         FROM usage_events
        WHERE workspace_id = ? AND thread_id IS NOT NULL AND kind = 'llm.explain'
        GROUP BY thread_id`,
      [ctx.workspaceId],
    );
    return new Map(
      rows.map((r) => [
        String(r["thread_id"]),
        { usd: Number(r["usd"] ?? 0), costKnown: asInt(r["unpriced"]) === 0 },
      ]),
    );
  }

  /** The most expensive runs this period. The row a per-run drill-down opens from. */
  async spendByRun(
    ctx: TenantContext,
    since: string,
    limit = 20,
  ): Promise<{ runId: string; agentId: string | null; usd: number; tokens: number; costKnown: boolean }[]> {
    const rows = await this.q(ctx).all<Record<string, unknown>>(
      `SELECT u.run_id AS run_id,
              r.agent_id AS agent_id,
              COALESCE(SUM(u.cost_usd), 0) AS usd,
              COALESCE(SUM(u.total_tokens), 0) AS tokens,
              COUNT(CASE WHEN u.cost_usd IS NULL THEN 1 END) AS unpriced
         FROM usage_events u
         LEFT JOIN runs r ON r.id = u.run_id AND r.workspace_id = u.workspace_id
        WHERE u.workspace_id = ? AND u.occurred_at >= ? AND u.run_id IS NOT NULL
        GROUP BY u.run_id, r.agent_id
        ORDER BY usd DESC
        LIMIT ?`,
      [ctx.workspaceId, since, limit],
    );
    return rows.map((r) => ({
      runId: String(r["run_id"]),
      agentId: (r["agent_id"] as string | null) ?? null,
      usd: Number(r["usd"] ?? 0),
      tokens: asInt(r["tokens"]),
      costKnown: asInt(r["unpriced"]) === 0,
    }));
  }

  /** Spend this period by kind. What separates "our agents" from "the platform" on a bill. */
  async spendByKind(
    ctx: TenantContext,
    since: string,
  ): Promise<{ kind: string; payer: string; usd: number; tokens: number; costKnown: boolean }[]> {
    const rows = await this.q(ctx).all<Record<string, unknown>>(
      `SELECT kind, payer,
              COALESCE(SUM(cost_usd), 0) AS usd,
              COALESCE(SUM(total_tokens), 0) AS tokens,
              COUNT(CASE WHEN cost_usd IS NULL THEN 1 END) AS unpriced
         FROM usage_events
        WHERE workspace_id = ? AND occurred_at >= ?
        GROUP BY kind, payer`,
      [ctx.workspaceId, since],
    );
    return rows
      .map((r) => ({
        kind: String(r["kind"]),
        payer: String(r["payer"] ?? "platform"),
        usd: Number(r["usd"] ?? 0),
        tokens: asInt(r["tokens"]),
        costKnown: asInt(r["unpriced"]) === 0,
      }))
      .sort((a, b) => b.usd - a.usd);
  }

  /**
   * What the platform spent AUTHORING code, in one window — §B.8.1's `Jaroku-Model` and
   * `Jaroku-Cost`.
   *
   * A TIME WINDOW IS THE ONLY JOIN AVAILABLE, AND THIS IS THE COMMENT THAT SAYS SO OUT LOUD. A
   * generation, an edit and a plan call have no `run_id` — migration 020's own comment says why —
   * and `agent_versions` has never carried a model or a cost column. So the honest question is
   * "which authoring calls happened while this version was being made", answered by the interval
   * between the previous version's timestamp and this one's, and it is an approximation. It is
   * used for a trailer line and for nothing that decides anything: no gate, no bill, no refusal.
   *
   * COST IS NULL WHENEVER ANY MATCHED EVENT WAS UNPRICED, not a partial sum. That is v0.1.9's rule
   * applied at the only point where under-reporting would be invisible — a receipt that said
   * `$0.0012` when two of five calls could not be priced would be exact-looking and wrong, and
   * §B.8.1's whole argument is that an omitted line is better than a fabricated one.
   *
   * NULL WHEN NOTHING MATCHED AT ALL, which is the ordinary case for a version generated before
   * cost accounting existed. The trailer omits both lines and says nothing, which is true.
   *
   * The kinds are the authoring ones only. `llm.provider` is the agent RUNNING, which is a
   * different question with a different answer, and rolling it in would put a user's test runs in
   * the commit's price tag.
   */
  async authoringSpend(
    ctx: TenantContext,
    window: { after: string | null; until: string },
  ): Promise<{ model: string | null; costUsd: number | null }> {
    const params: unknown[] = [ctx.workspaceId];
    let range = "";
    if (window.after) {
      range = " AND occurred_at > ?";
      params.push(window.after);
    }
    params.push(window.until);
    const rows = await this.q(ctx).all<Record<string, unknown>>(
      `SELECT model,
              COALESCE(SUM(cost_usd), 0) AS usd,
              COUNT(*) AS n,
              COUNT(CASE WHEN cost_usd IS NULL THEN 1 END) AS unpriced
         FROM usage_events
        WHERE workspace_id = ?${range} AND occurred_at <= ?
          AND kind IN ('llm.generation', 'llm.edit', 'llm.plan')
        GROUP BY model`,
      params,
    );
    if (rows.length === 0) return { model: null, costUsd: null };

    // The model that did the most work in the window, by event count. A version authored by one
    // model and then explained by another is one commit, and naming both would make the line a
    // list nobody can act on; naming the busier one is a claim that is true of most of the work.
    const byUse = [...rows].sort((a, b) => asInt(b["n"]) - asInt(a["n"]));
    const model = (byUse[0]?.["model"] as string | null) ?? null;
    const unpriced = rows.reduce((n, r) => n + asInt(r["unpriced"]), 0);
    const usd = rows.reduce((n, r) => n + Number(r["usd"] ?? 0), 0);
    return { model, costUsd: unpriced > 0 ? null : usd };
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
      total_tokens: r["total_tokens"] === null || r["total_tokens"] === undefined ? null : asInt(r["total_tokens"]),
      quantity: r["quantity"] === null || r["quantity"] === undefined ? null : Number(r["quantity"]),
      unit: (r["unit"] as string | null) ?? null,
      payer: String(r["payer"] ?? "platform"),
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
      /**
       * The plan this subscription is for, or omitted by a caller that does not know.
       *
       * OMITTED IS NOT `free`. An INVOICE event carries no plan — `metadata.plan_id` is set on the
       * checkout session and on the subscription, never on an invoice — so `invoice.payment_failed`
       * read one that was not there, defaulted it, and wrote `plan_id = 'free'` over the paid plan
       * a workspace was still on. The row survives only because `planForStatus` returns null for
       * `past_due` and so `workspaces.plan` never moved; the stored subscription itself was wrong,
       * which is what a support query, an invoice screen or anybody debugging a dunning case reads.
       */
      planId?: string | null;
      status: string;
      externalCustomerId?: string | null;
      externalSubscriptionId: string;
      /** Omitted keeps what is stored, for the same reason. An invoice carries no period. */
      /** Omitted keeps what is stored, for the same reason. An invoice carries no period start. */
      currentPeriodStart?: string | null;
      currentPeriodEnd?: string | null;
      /** Omitted keeps what is stored. Most events carry no seat count, and a default would erase one. */
      seatCount?: number | null;
      /** Omitted keeps what is stored. An invoice says nothing about a pending cancellation. */
      cancelAtPeriodEnd?: boolean;
    },
  ): Promise<SubscriptionRow> {
    const now = nowIso();
    const cancelling = s.cancelAtPeriodEnd === undefined ? null : s.cancelAtPeriodEnd ? 1 : 0;
    await this.q(ctx).run(
      // COALESCE ON EVERY FIELD A CALLER MAY NOT KNOW, which is the shape `external_customer_id`
      // already had and the other three needed for the same reason: an event that carries a status
      // and nothing else must patch the status and nothing else. The DO UPDATE binds its own
      // parameters rather than reading `excluded`, because the insert side has to supply a
      // non-null plan and would otherwise hide the caller's "I do not know" behind that default.
      //
      // THE DEFAULTS ARE APPLIED IN JS, NOT IN SQL, and that is a driver-parity decision rather
      // than a style one. `COALESCE(?, 0)` resolves to INTEGER on Postgres, and
      // `cancel_at_period_end` is `boolean` there — "column is of type boolean but expression is of
      // type integer". A bare placeholder carries no type at all, so Postgres reads it from the
      // column and SQLite stores what it is given; putting a literal beside it is what forces a
      // type onto the pair. Same reasoning for the plan's `'free'`.
      `INSERT INTO subscriptions (id, workspace_id, plan_id, status, external_customer_id,
         external_subscription_id, current_period_start, current_period_end, cancel_at_period_end,
         seat_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (external_subscription_id) DO UPDATE SET
         plan_id = COALESCE(?, subscriptions.plan_id),
         status = excluded.status,
         external_customer_id = COALESCE(excluded.external_customer_id, subscriptions.external_customer_id),
         current_period_start = COALESCE(?, subscriptions.current_period_start),
         current_period_end = COALESCE(?, subscriptions.current_period_end),
         cancel_at_period_end = COALESCE(?, subscriptions.cancel_at_period_end),
         seat_count = COALESCE(?, subscriptions.seat_count),
         updated_at = excluded.updated_at
       WHERE subscriptions.workspace_id = ?`,
      [
        randomUUID(),
        ctx.workspaceId,
        // The INSERT side has to supply a value; a subscription nobody named a plan for is `free`,
        // and one nobody said anything about cancelling is not cancelling.
        s.planId ?? "free",
        s.status,
        s.externalCustomerId ?? null,
        s.externalSubscriptionId,
        s.currentPeriodStart ?? null,
        s.currentPeriodEnd ?? null,
        cancelling ?? 0,
        // One seat is what a subscription nobody counted seats for means, and it is what every row
        // written before 052 already holds.
        s.seatCount ?? 1,
        now,
        now,
        // The DO UPDATE's own five, in the order they appear above.
        s.planId ?? null,
        s.currentPeriodStart ?? null,
        s.currentPeriodEnd ?? null,
        cancelling,
        s.seatCount ?? null,
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

  // --- metered periods ----------------------------------------------------------------------
  //
  // The counters every quota check reads, one row per workspace per period per metric. Separate
  // from `usage_events` because they answer different questions: that table is the ledger, one
  // immutable row per thing that happened; these are the running totals, incremented in place and
  // read on the hot path. Counting the ledger on every check is the right answer computed the
  // expensive way. See migration 052's header.

  /**
   * Add `by` to one counter, creating the period's row if this is its first event.
   *
   * ONE STATEMENT, NOT A READ THEN A WRITE. Two runs starting in the same millisecond are the
   * ordinary case, not the race nobody hits, and a SELECT-then-UPDATE loses one of them silently —
   * which on a quota counter means a workspace that quietly gets more than it paid for. The unique
   * constraint from 052 is what arbitrates, and `count = count + ?` is evaluated by the database
   * on the row it just locked.
   *
   * `period_end` is written on the insert and never updated. The period a counter belongs to is
   * decided by its `period_start`; carrying the end as well is what lets a reader render "resets
   * on the 1st" without recomputing a calendar it did not choose.
   */
  async incrementUsage(
    ctx: TenantContext,
    u: { metric: string; periodStart: string; periodEnd: string; by: number },
  ): Promise<void> {
    await this.q(ctx).run(
      `INSERT INTO workspace_usage_periods (id, workspace_id, period_start, period_end, metric, count)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (workspace_id, period_start, metric) DO UPDATE SET
         count = workspace_usage_periods.count + ?
       WHERE workspace_usage_periods.workspace_id = ?`,
      [randomUUID(), ctx.workspaceId, u.periodStart, u.periodEnd, u.metric, u.by, u.by, ctx.workspaceId],
    );
  }

  /**
   * Every counter this workspace has for one period, as a map.
   *
   * A MAP WITH THE ABSENT METRICS MISSING, not zero-filled, and the caller decides what absence
   * means. For a quota check it is zero — nothing has happened yet — but for a usage screen the
   * two are worth telling apart, the same distinction `billingStore`'s `loaded` flag draws on
   * the client. `usageCount` below is the zero-filling reader, so nobody has to write `?? 0`
   * twice with two different opinions about it.
   */
  async usageForPeriod(ctx: TenantContext, periodStart: string): Promise<Record<string, number>> {
    const rows = await this.q(ctx).all<Record<string, unknown>>(
      `SELECT metric, count FROM workspace_usage_periods
        WHERE workspace_id = ? AND period_start = ?`,
      [ctx.workspaceId, periodStart],
    );
    const out: Record<string, number> = {};
    for (const r of rows) out[String(r["metric"])] = Number(r["count"] ?? 0);
    return out;
  }

  /** One counter, or zero when the period has seen nothing of that kind yet. */
  async usageCount(ctx: TenantContext, periodStart: string, metric: string): Promise<number> {
    const row = await this.q(ctx).get<Record<string, unknown>>(
      `SELECT count FROM workspace_usage_periods
        WHERE workspace_id = ? AND period_start = ? AND metric = ?`,
      [ctx.workspaceId, periodStart, metric],
    );
    return row ? Number(row["count"] ?? 0) : 0;
  }

  /**
   * Turn BYOK on or off for this workspace's LIVE subscription.
   *
   * ON THE SUBSCRIPTION AND NOT ON THE WORKSPACE, which is where it looks like it should go. The
   * reason is what happens at the boundary: a workspace that cancels and comes back later gets a
   * new subscription row, and a flag on `workspaces` would silently carry a decision made about a
   * plan they are no longer on into one they have just bought. Attached to the subscription, the
   * question "is this workspace on its own keys" is only ever asked about the arrangement that is
   * actually in force.
   *
   * A WORKSPACE WITH NO LIVE SUBSCRIPTION IS A NO-OP rather than an error, and answers false: Free
   * runs on the user's own key by construction, so there is nothing here to turn on.
   */
  async setByok(ctx: TenantContext, on: boolean): Promise<boolean> {
    const res = await this.q(ctx).run(
      `UPDATE subscriptions SET byok_enabled = ?, updated_at = ?
        WHERE workspace_id = ? AND status IN ('incomplete', 'active', 'past_due')`,
      [on ? 1 : 0, nowIso(), ctx.workspaceId],
    );
    return res.changes > 0;
  }

  // --- webhook events -----------------------------------------------------------------------
  //
  // No context, and no scope. A webhook arrives before we know whose it is — resolving a
  // customer id to a workspace is the handler's first job — so a row that required the answer in
  // order to record the question could not be written for the events that fail to resolve, which
  // are exactly the ones worth keeping. See migration 025.

  /**
   * Claim an event id. Returns false when something already has it.
   *
   * INSERT ... ON CONFLICT DO NOTHING, never a SELECT first. Two deliveries of the same event
   * genuinely do arrive together — a provider retrying because a response was slow, while the
   * original is still in flight — and a check that precedes the write is both of them finding
   * nothing and both of them acting. The primary key is the only thing that can arbitrate.
   */
  async claimWebhookEvent(id: string, type: string): Promise<boolean> {
    const res = await this.db.run(
      `INSERT INTO billing_webhook_events (id, type, received_at) VALUES (?, ?, ?)
       ON CONFLICT (id) DO NOTHING`,
      [id, type, nowIso()],
    );
    return res.changes > 0;
  }

  /**
   * Mark an event finished, with what became of it.
   *
   * An event left unfinished — this never called, because the handler threw — is the queue an
   * operator replays. That is why it is a second statement rather than a column set at insert:
   * "arrived" and "acted on" are different facts and a crash lands between them.
   */
  async finishWebhookEvent(id: string, workspaceId: string | null, outcome: string): Promise<void> {
    await this.db.run(
      `UPDATE billing_webhook_events SET processed_at = ?, workspace_id = ?, outcome = ?
        WHERE id = ?`,
      [nowIso(), workspaceId, outcome.slice(0, 500), id],
    );
  }

  /** Events that arrived and never finished. What a replay would start from. */
  async unprocessedWebhookEvents(limit = 100): Promise<{ id: string; type: string; received_at: string }[]> {
    return this.db.all<{ id: string; type: string; received_at: string }>(
      `SELECT id, type, received_at FROM billing_webhook_events
        WHERE processed_at IS NULL ORDER BY received_at ASC LIMIT ?`,
      [limit],
    );
  }

  private hydrateSubscription(r: Record<string, unknown>): SubscriptionRow {
    return {
      id: String(r["id"]),
      workspace_id: String(r["workspace_id"]),
      plan_id: String(r["plan_id"]),
      status: String(r["status"]),
      external_customer_id: (r["external_customer_id"] as string | null) ?? null,
      external_subscription_id: (r["external_subscription_id"] as string | null) ?? null,
      current_period_start: (r["current_period_start"] as string | null) ?? null,
      current_period_end: (r["current_period_end"] as string | null) ?? null,
      cancel_at_period_end: asBool(r["cancel_at_period_end"]),
      // A driver difference, not a preference: Postgres answers `integer` and SQLite answers
      // whatever it stored, so the Number() is what makes a seat count arithmetic on both.
      seat_count: Number(r["seat_count"] ?? 1),
      byok_enabled: asBool(r["byok_enabled"]),
      created_at: String(r["created_at"]),
      updated_at: String(r["updated_at"]),
    };
  }
}
