// Response variants — §5.4's regenerate, and the metadata row that reports each one honestly.
//
// THE ONE RULE THIS MODULE EXISTS TO KEEP: "Each variant records its own metadata (model, effort,
// duration). Never overwrite variant 1's metadata with variant 2's."
//
// It sounds like bookkeeping and it is not. The metadata row's whole job is answering "which model
// wrote THIS?" while a user compares two responses in one thread — §6.1 spends the row's only
// saturated colour on it for exactly that reason. A store that updated a turn in place would
// answer that question with whichever model ran LAST, on a response a different model produced,
// and there would be no way to tell from the screen.
//
// SWITCHING VARIANTS IS A VIEW CHANGE AND NOTHING ELSE (§5.4, §12.22). `agent_version_id` records
// what a variant PRODUCED; the published pointer lives on the agent and is moved by the publish
// path alone. There is deliberately no method here that touches it — promoting a variant's version
// is an explicit Apply on that variant, and a "switch" that also published would turn reading into
// deploying.
//
// AND REGENERATION IS BLOCKED WHILE A TURN IS STREAMING (§5.4, §9). That is enforced at the route,
// where the live state is known, rather than here — this store would have to learn about the run
// pool to answer it, and a store that knew about the run pool would be the third place liveness is
// modelled.
//
//   npm run test:turn-variants

import { randomUUID } from "node:crypto";

import { type Db, type Queryable } from "./db/db.ts";
import type { TenantContext } from "./db/tenant.ts";
import { isEffort, type Effort } from "./effort.ts";

export interface TurnVariant {
  id: string;
  turn_id: string;
  /** 1-based, and what the switcher renders — the "2" in `‹ 2/2 ›`. */
  ordinal: number;
  model_id: string | null;
  provider: string | null;
  /** What was asked for. Kept beside `effort_applied` so §6.2's clamp marker stays derivable. */
  effort_requested: Effort | null;
  /** What was actually spent. This is the one the metadata row shows. */
  effort_applied: Effort | null;
  duration_ms: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  /** What this variant produced. NEVER what is published — see the header. */
  agent_version_id: string | null;
  created_at: string;
}

/** What a dispatch knows about the response it is about to produce. */
export interface VariantInput {
  modelId?: string | null;
  provider?: string | null;
  effortRequested?: Effort | null;
  effortApplied?: Effort | null;
}

/** What a finished response actually cost. Every field optional — see `null rather than guessing`. */
export interface VariantOutcome {
  durationMs?: number | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  costUsd?: number | null;
  agentVersionId?: string | null;
}

const nowIso = (): string => new Date().toISOString();

const asEffort = (v: unknown): Effort | null => (isEffort(v) ? v : null);
const asNum = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export class TurnVariantStore {
  constructor(private db: Db) {}

  private q(ctx: TenantContext): Queryable {
    return this.db.forWorkspace(ctx.workspaceId);
  }

  private static hydrate(row: Record<string, unknown>): TurnVariant {
    return {
      id: String(row["id"]),
      turn_id: String(row["turn_id"]),
      ordinal: Number(row["ordinal"]),
      model_id: (row["model_id"] as string | null) ?? null,
      provider: (row["provider"] as string | null) ?? null,
      effort_requested: asEffort(row["effort_requested"]),
      effort_applied: asEffort(row["effort_applied"]),
      duration_ms: asNum(row["duration_ms"]),
      tokens_in: asNum(row["tokens_in"]),
      tokens_out: asNum(row["tokens_out"]),
      cost_usd: asNum(row["cost_usd"]),
      agent_version_id: (row["agent_version_id"] as string | null) ?? null,
      created_at: String(row["created_at"]),
    };
  }

  /** Every variant of a turn, in the order the switcher walks them. */
  async forTurn(ctx: TenantContext, turnId: string): Promise<TurnVariant[]> {
    const rows = await this.q(ctx).all<Record<string, unknown>>(
      `SELECT id, turn_id, ordinal, model_id, provider, effort_requested, effort_applied,
              duration_ms, tokens_in, tokens_out, cost_usd, agent_version_id, created_at
         FROM turn_variants
        WHERE workspace_id = ? AND turn_id = ?
        ORDER BY ordinal ASC`,
      [ctx.workspaceId, turnId],
    );
    return rows.map((r) => TurnVariantStore.hydrate(r));
  }

  /**
   * Start a new variant, taking the next ordinal.
   *
   * THE ORDINAL IS ALLOCATED INSIDE A TRANSACTION, and the unique constraint is what actually
   * enforces it. Two people pressing Regenerate at the same moment would otherwise both read
   * "there is 1 variant", both write ordinal 2, and leave a switcher rendering `‹ 2/3 ›` with two
   * variants claiming the same number. The constraint turns that race into a failed insert, and
   * the retry below turns the failed insert into the right answer.
   */
  async begin(ctx: TenantContext, turnId: string, input: VariantInput): Promise<TurnVariant> {
    // Three attempts, because the only way this loses is a genuine race and a race that repeats
    // three times is not a race. An unbounded retry on a constraint that can also be violated for
    // other reasons would be a hang rather than an error.
    for (let attempt = 0; attempt < 3; attempt++) {
      const next = await this.db.scoped(ctx.workspaceId, async (q) => {
        const row = await q.get<{ n: number }>(
          `SELECT COALESCE(MAX(ordinal), 0) AS n FROM turn_variants
            WHERE workspace_id = ? AND turn_id = ?`,
          [ctx.workspaceId, turnId],
        );
        const ordinal = Number(row?.n ?? 0) + 1;
        const id = randomUUID();
        await q.run(
          `INSERT INTO turn_variants
             (id, workspace_id, turn_id, ordinal, model_id, provider,
              effort_requested, effort_applied, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id, ctx.workspaceId, turnId, ordinal,
            input.modelId ?? null, input.provider ?? null,
            input.effortRequested ?? null, input.effortApplied ?? null,
            nowIso(),
          ],
        );
        return id;
      }).catch((err: unknown) => {
        if (attempt === 2) throw err;
        return null;
      });
      if (next === null) continue;
      const made = (await this.forTurn(ctx, turnId)).find((v) => v.id === next);
      if (made) return made;
    }
    throw new Error(`could not allocate a variant for turn ${turnId}`);
  }

  /**
   * Record what a variant actually cost, once it is finished.
   *
   * BY VARIANT ID, NEVER BY TURN. A method that took a turn and wrote "the latest" would be the
   * overwrite §5.4 forbids, one refactor later: a slow variant 1 finishing after a fast variant 2
   * would land its duration on variant 2's row.
   *
   * `undefined` LEAVES A FIELD ALONE, so a caller that knows the duration but not the cost does not
   * have to null the cost to say so. Nothing here writes a value it was not given — §7's "null the
   * rest rather than guessing", applied at every write rather than only at the backfill.
   */
  async settle(ctx: TenantContext, variantId: string, outcome: VariantOutcome): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    const put = (col: string, v: unknown): void => {
      if (v === undefined) return;
      sets.push(`${col} = ?`);
      params.push(v);
    };
    put("duration_ms", outcome.durationMs);
    put("tokens_in", outcome.tokensIn);
    put("tokens_out", outcome.tokensOut);
    put("cost_usd", outcome.costUsd);
    put("agent_version_id", outcome.agentVersionId);
    if (sets.length === 0) return;

    params.push(ctx.workspaceId, variantId);
    await this.q(ctx).run(
      `UPDATE turn_variants SET ${sets.join(", ")} WHERE workspace_id = ? AND id = ?`,
      params,
    );
  }

  /**
   * The variants for many turns at once.
   *
   * ONE QUERY FOR THE WHOLE THREAD, not one per turn. Opening a conversation renders every turn's
   * metadata row at once, and a per-turn read would be N round trips to draw one screen — the same
   * reason `allItems` exists beside `itemsFor`.
   */
  async forTurns(ctx: TenantContext, turnIds: readonly string[]): Promise<Map<string, TurnVariant[]>> {
    const out = new Map<string, TurnVariant[]>();
    if (turnIds.length === 0) return out;
    // The placeholders are built from the LENGTH of the list and every id is still bound — the ids
    // themselves never reach the SQL string.
    const holes = turnIds.map(() => "?").join(", ");
    const rows = await this.q(ctx).all<Record<string, unknown>>(
      `SELECT id, turn_id, ordinal, model_id, provider, effort_requested, effort_applied,
              duration_ms, tokens_in, tokens_out, cost_usd, agent_version_id, created_at
         FROM turn_variants
        WHERE workspace_id = ? AND turn_id IN (${holes})
        ORDER BY turn_id ASC, ordinal ASC`,
      [ctx.workspaceId, ...turnIds],
    );
    for (const r of rows) {
      const v = TurnVariantStore.hydrate(r);
      const list = out.get(v.turn_id);
      if (list) list.push(v);
      else out.set(v.turn_id, [v]);
    }
    return out;
  }
}
