// What a job cost, and the two ways of getting that wrong that this file exists to refuse.
//
// COST IS SUMMED FROM `steps`, NEVER FROM `runs.cost` — §11.2, and `evalAggregate.ts`'s header
// opens with the same sentence for the same reason. `runs.cost` is written by `run_end`, so a run
// that crashed mid-graph has a row reading 0 while its steps record real money already spent. That
// is not an edge case on this surface: a container that went quiet is one of six failure kinds,
// and its run row never gets an ending at all. There is deliberately no `cost` column on
// `work_items` so that this cannot quietly become two answers.
//
// UNPRICED IS NULL, NEVER ZERO — §11.1. If the model has no pricing entry the sum is meaningless
// and the honest answer is "unknown", rendered `—`. Coalescing that to 0 would put an unpriced
// model beside a priced one as FREE, which is not a rounding error but a different claim. And
// "priced and free" is a real answer the dry-run provider gives, so the gate is whether the model
// is in the table rather than whether the sum came out empty.
//
// PARTIAL PRICING IS FLAGGED — §11.1's second half. A run with one `llm_call` that reported tokens
// and no cost has a total that is a FLOOR, and the card says so rather than presenting a
// confidently wrong number.
//
// AND IT IS BATCHED, WHICH IS THE ONE THING HERE THAT IS ABOUT THIS SURFACE RATHER THAN ABOUT
// HONESTY. §16 asks directly: "If deriving cost per work item from steps is expensive at list
// scale, tell me before writing an N+1. The Agents grid's statement count is asserted equal for
// one agent and for forty; hold that line here." `aggregateJob` is three statements per run, which
// is a hundred and fifty for a page of fifty — so this is two statements for a page, whatever the
// page holds, and `test:work-cost` asserts the count is the same for one job and for forty.
//
// THE DURATION IS THE ITEM'S OWN, not the run's, and that is a deliberate difference from
// `aggregateJob`. An eval measures how long the agent took; an operator asks how long their JOB
// took, and a job that spent four minutes parked on a confirmation waiting for somebody to answer
// really did take four minutes. `work_items.started_at` is when the container accepted it and
// `ended_at` is when it finished, so the figure includes the wait — which is the honest answer to
// the question the Cockpit is asking, and the one that makes a slow queue visible.

import { asInt, type Queryable } from "../db/db.ts";
import type { TenantContext } from "../db/tenant.ts";
import { isPriced, round8 } from "../pricing.ts";
import type { WorkItem } from "./workStore.ts";

export interface WorkCost {
  /** Null means UNKNOWN — an unpriced model. Never zero standing in for it. */
  cost_usd: number | null;
  tokens: number | null;
  /** Wall clock from acceptance to ending, including any wait for a person. Null while running. */
  duration_ms: number | null;
  /** False when some `llm_call` had tokens but no cost: the total is a floor, not the total. */
  cost_complete: boolean;
}

/** What a job with no steps yet reports. Zero tokens is a fact; the cost is not yet a claim. */
export const NO_COST: WorkCost = { cost_usd: null, tokens: null, duration_ms: null, cost_complete: true };

/**
 * A parameter list has a limit on both drivers, so a page's worth of ids goes in batches.
 *
 * Two hundred, matching the retention sweep's, which is the only other place in this codebase that
 * builds an `IN` list out of run ids. A page is fifty, so this is one batch in practice — the
 * chunking is here so the fleet strip, which reads across every live job in a workspace, cannot be
 * the query that fails on the first workspace big enough to need it.
 */
const BATCH = 200;

/**
 * Cost, tokens and duration for a page of work items, in two statements.
 *
 * `model` COMES FROM THE DEPLOYMENT, not from the run, and it is passed in rather than read here.
 * The deployment is what decided which model this job would run on, it is already loaded by every
 * caller that has the items, and reading it again would be a third statement per page to answer a
 * question the caller already knows the answer to. A run whose model is not in the map reports
 * null cost, which is the same answer an unpriced model gets and is the correct one: nothing knows
 * what it was priced at.
 */
export async function costsForItems(
  ctx: TenantContext,
  q: Queryable,
  items: WorkItem[],
  modelFor: (item: WorkItem) => string | undefined,
): Promise<Map<string, WorkCost>> {
  const out = new Map<string, WorkCost>();
  const byRun = new Map<string, WorkItem>();
  for (const item of items) {
    out.set(item.id, { ...NO_COST, duration_ms: durationOf(item) });
    if (item.run_id) byRun.set(item.run_id, item);
  }
  if (byRun.size === 0) return out;

  const runIds = [...byRun.keys()];
  for (let i = 0; i < runIds.length; i += BATCH) {
    const chunk = runIds.slice(i, i + BATCH);
    const holes = chunk.map(() => "?").join(", ");
    // ONE GROUPED QUERY FOR ALL OF IT, including the unpriced count — `evalAggregate` asks that as
    // a second statement because it is answering about one run and the clarity is worth a query.
    // Here it would be a second query PER PAGE, so it is a conditional sum in the same pass.
    //
    // `SUM(CASE WHEN … THEN 1 ELSE 0 END)` RATHER THAN `COUNT(*) FILTER (WHERE …)`, which is the
    // form Postgres would prefer and SQLite does not have. Both drivers run this file.
    const rows = await q.all<{ run_id: string; cost: unknown; tokens: unknown; unpriced: unknown }>(
      `SELECT run_id,
              SUM(cost)   AS cost,
              SUM(tokens) AS tokens,
              SUM(CASE WHEN type = 'llm_call' AND tokens IS NOT NULL AND cost IS NULL
                       THEN 1 ELSE 0 END) AS unpriced
         FROM steps
        WHERE workspace_id = ? AND run_id IN (${holes})
        GROUP BY run_id`,
      [ctx.workspaceId, ...chunk],
    );
    for (const row of rows) {
      const item = byRun.get(String(row.run_id));
      if (!item) continue;
      const model = modelFor(item);
      out.set(item.id, {
        // PRICED-AND-FREE ($0) AND UNPRICED (UNKNOWN) ARE DIFFERENT ANSWERS — never conflated.
        // The gate is whether the model is in the pricing table, not whether the sum was empty.
        cost_usd: model && isPriced(model) ? round8(numberOr(row.cost, 0)) : null,
        tokens: row.tokens === null || row.tokens === undefined ? null : asInt(row.tokens),
        duration_ms: durationOf(item),
        cost_complete: asInt(row.unpriced) === 0,
      });
    }
  }
  return out;
}

/**
 * How long the job took, from the item's own clocks.
 *
 * NULL WHILE IT IS STILL RUNNING rather than "so far", because a card that rendered a growing
 * number would be reporting a duration for something that has not got one — and the two are
 * different claims in exactly the way §11's honesty rules are about. A running job's elapsed time
 * is a rendering decision the client can make from `started_at`; this is the recorded fact.
 */
function durationOf(item: WorkItem): number | null {
  if (!item.started_at || !item.ended_at) return null;
  const ms = Date.parse(item.ended_at) - Date.parse(item.started_at);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/** SUM over no rows is NULL on both drivers; over rows that are all NULL it is NULL too. */
function numberOr(v: unknown, fallback: number): number {
  if (v === null || v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
