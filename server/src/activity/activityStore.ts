// Every aggregate the Activity tab is drawn from, and the one rule that makes them safe.
//
// EVERY METHOD TAKES A `TenantContext` FIRST AND A `Window` SECOND. The context is the tenancy
// boundary — on SQLite it is the ONLY one, since migration 009 grants that driver no RLS at all —
// and the window is §1's single date range, resolved once in `range.ts` and handed down so that no
// module here can decide for itself what "7d" means.
//
// WHY THIS FILE IS THE HIGHEST-RISK SURFACE IN THE PRODUCT FOR ROW-LEVEL SECURITY, stated plainly
// because the specification says so and because the history backs it up. Row-level security has
// bitten this project repeatedly and EVERY SINGLE INSTANCE WAS AN AGGREGATE: the eval job aggregate
// read `steps` unscoped and zeroed every job's cost, tokens and latency; the eval cost estimate read
// `runs` unscoped and always fell back to "no history". Both worked locally, on SQLite, and as the
// database owner — which is what every test connects as and what no deployment connects as. This
// tab is nothing BUT aggregates over exactly those tables, so:
//
//   * `q(ctx)` is the only way to the database in this file, and it is `forWorkspace`, not `db`.
//   * Every statement also carries `workspace_id = ?` in its own WHERE. Belt and braces on purpose:
//     the RLS policy is the wall on Postgres and the predicate is the whole of it on SQLite, and a
//     method that relied on only one of them would be correct on exactly one driver.
//   * `test:db-boundary`'s structural rule reads the policied tables out of the migrations and fails
//     when one is reached without a scope, and this module is on its `SCOPED_MODULES` list.
//   * `test:tenancy` seeds two workspaces and asserts EVERY module's figures for A are unaffected by
//     B's rows — not one module, every module.
//
// COST IS NEVER RECOMPUTED HERE. Not once, anywhere in this file. Every dollar figure is a SUM over
// `usage_events.cost_usd`, which `UsageMeter` wrote through `pricing.costFor` over the shared
// `runtime/pricing.json` that the Python interceptor reads too. §5.2's rule is that there must be
// exactly ONE place in this codebase that turns tokens into dollars, and this is emphatically not a
// second one — a dashboard that did its own arithmetic would be the fastest way to make the number
// on the invoice and the number on the screen disagree.
//
// AND `usage_events` RATHER THAN `runs.cost`, which is the oldest rule in the cost model and the one
// §2 spends four bullets on. `runs.cost` is written by `run_end`; a run that crashes mid-graph never
// emits one, so a bill assembled from run rows omits every run that failed — precisely the
// population a retry storm produces. The usage row is written per STEP, as the step arrives, so a
// crashed run's completed steps hold their real spend and are counted.

import { asInt, type Db, type Queryable } from "../db/db.ts";
import type { TenantContext } from "../db/tenant.ts";
import { TraceStore } from "../store.ts";
import {
  GRAIN_PREFIX,
  columnFor,
  bucketStarts,
  grainFor,
  grainInstant,
  type Window,
} from "./range.ts";

/**
 * One agent, as every module on this tab names it.
 *
 * THE SLUG IS THE ID ON THE WIRE, as it is on every other agent-addressed surface in this product:
 * `runs.agent_id`, `deployments.agent_id` and `eval_runs.agent_id` all hold a slug, the client's
 * navigation is by slug, and the uuid is a storage detail that only `agents` and `agent_versions`
 * ever join on. Carrying both is what lets the release timeline — which reaches versions through
 * the uuid — put a name somebody recognises on its rows.
 *
 * `archived` TRAVELS RATHER THAN FILTERING. This tab is historical: an agent somebody archived on
 * Tuesday still spent money on Monday, and dropping it would make the leaderboard's rows not add up
 * to the hero row above them. What the client does with the flag is a rendering decision.
 */
export interface AgentRef {
  agentId: string;
  uuid: string;
  name: string;
  archived: boolean;
}

/**
 * §2's rollup: what the workspace spent in the range, against what it may spend.
 *
 * `usd` IS A FLOOR WHENEVER `costKnown` IS FALSE, and the pair travels together for the reason
 * `SpendTotals` in the billing repository makes them travel together: SUM skips NULLs, so a
 * workspace with one unpriced model would otherwise be shown a confident total that is short. §2
 * asks for `$12.40 · 2 agents unpriced` rather than a number that quietly omits them, and the two
 * counts below are what a card needs to write that sentence.
 */
export interface SpendRollup {
  /** USD in the window. A floor when `costKnown` is false. */
  usd: number;
  /**
   * How many usage rows the window held at all.
   *
   * §3.5's EMPTY-IS-NOT-ZERO, AS A FIELD RATHER THAN AS A GUESS. `usd === 0` is two completely
   * different sentences — "nothing was billed here" and "everything billed here was free" — and a
   * card cannot tell them apart from the total. Zero rows renders `--`; rows that summed to nothing
   * renders `$0.00`, which is a real figure about a real week.
   */
  events: number;
  /** The same for the previous equivalent window, for §3.3's delta. Null when there was nothing. */
  previousUsd: number | null;
  /** Usage rows in the window whose cost could not be computed. */
  unpricedEvents: number;
  /** The models behind those rows, by name. Names only — see §6's payload discipline. */
  unpricedModels: string[];
  /** How many distinct agents have incomplete spend because of them. §2's `2 agents unpriced`. */
  unpricedAgents: number;
  costKnown: boolean;
  /** §2's ring: spend against budget. Null when this workspace has set no ceiling of its own. */
  budgetUsd: number | null;
  /** The provider split the ring's segments are drawn from, largest first. */
  byProvider: { provider: string; usd: number; costKnown: boolean }[];
}

/**
 * §3's volume: how many tokens moved, and how many of them were cache reads.
 *
 * THE SPLIT IS HONEST ABOUT ITS OWN COVERAGE, which is the whole difficulty of this module. A usage
 * row records `cached_input_tokens` only when the caller HAD a split to record — `meterModelCall`
 * does, because the Anthropic SDK reports cache reads separately, and `meterStep` does not, because
 * the frozen event schema puts one `tokens` number on a step and no breakdown under it. So a null
 * there means "not broken out", NOT "none cached", and reporting `cached: 0` across a workspace
 * whose agents all run through `meterStep` would be a confident zero about a figure nobody measured
 * — the same false-zero this product has now fixed twice.
 *
 * `unsplitTokens` is therefore carried beside the split, and a card whose entire volume is unsplit
 * renders §3.5's `--` for the cached figure rather than a zero. Fresh is deliberately NOT a field:
 * it is `total - cached` and a second stored copy of a subtraction is a second thing to disagree.
 */
export interface TokenVolume {
  total: number;
  /** How many usage rows the window held. §3.5's empty-is-not-zero — see `SpendRollup.events`. */
  events: number;
  previousTotal: number | null;
  /** Tokens read from cache, across rows that recorded a split. */
  cached: number;
  /** Tokens on rows that recorded no split at all. See the note above — this is not zero-cached. */
  unsplitTokens: number;
}

/**
 * §4's run health strip: how the workspace's runs went, across every agent in it.
 *
 * FOUR OUTCOMES, NOT TWO, and the third is the whole reason this shape is not a pair of counters.
 * A run that a restart killed, or that somebody cancelled, writes `status = 'error'` on its row —
 * correctly, because it did not complete — and folding it into a FAILURE RATE would report the
 * server bouncing as the agents being broken. §4 forbids that silently and asks for either its own
 * slice or an exclusion that says so; this is the slice.
 *
 * `successRate` IS OVER SETTLED RUNS ONLY. A run still executing has no outcome, and counting it as
 * anything makes the rate drift while nothing has happened. `runs` is every run in the window
 * because that is what "total runs" means, and the two numbers are deliberately not the same
 * denominator — the card says which it is showing.
 */
export interface RunHealth {
  /** Every run started in the window, whatever became of it. */
  runs: number;
  ok: number;
  /** Runs that failed on their own account. Excludes the slice below. */
  failed: number;
  /** Runs a restart or a cancellation closed out. §4's distinct outcome. */
  interrupted: number;
  running: number;
  paused: number;
  /** `ok / (ok + failed)`, or null when nothing has settled. Never 0, which would claim total failure. */
  successRate: number | null;
  previousSuccessRate: number | null;
  /**
   * Per-run latency, in milliseconds, nearest-rank.
   *
   * SUMMED STEP TIME, NOT WALL CLOCK, which §4 requires the card to say out loud. The two differ by
   * exactly the thing this product is built to allow: a run paused at a boundary for four hours and
   * resumed has four hours of wall clock and perhaps nine seconds of work in it, and a p95 drawn
   * from `ended_at - started_at` would report that as the slowest run of the month.
   */
  p50: number | null;
  p95: number | null;
}

/**
 * One column of §3.1's WORKSPACE PULSE band: runs and spend over the range.
 *
 * TWO SERIES IN ONE ROW, because they are read against each other. "Spend went up and runs did not"
 * is the whole question the band answers, and two independently bucketed charts would let a column
 * in one sit beside a different hour in the other — which is exactly the ambiguity a shared window
 * exists to remove.
 *
 * `errors` RIDES ALONG so §4's failure trend has somewhere to come from without a second query. The
 * health strip states the rate; this states the shape of it over time, which is what makes a bad
 * afternoon distinguishable from a bad month.
 */
export interface PulseColumn {
  /** The column's own start, ISO-8601. Named so the chart can label an axis without arithmetic. */
  at: string;
  runs: number;
  errors: number;
  usd: number;
  tokens: number;
}

export class ActivityStore {
  /** Shares the trace store's database: same file, single writer. See TraceStore.database(). */
  constructor(private db: Db) {}

  // No `init()`. This store owns no tables and writes nothing — every table it reads was declared by
  // an earlier migration, and migration 051 adds the three access paths its range-bounded reads
  // stand on and no columns at all. A tab that is entirely a read has nothing to patch.

  /**
   * The scoped handle. THE ONLY WAY TO THE DATABASE IN THIS FILE.
   *
   * `forWorkspace` rather than `db`, so on Postgres each statement carries its own `SET LOCAL
   * app.workspace_id` and the `tenant_isolation` policies apply. On SQLite there is nothing to
   * scope and this is the connection itself — which is exactly why every statement below ALSO
   * writes its own `workspace_id = ?`.
   */
  private q(ctx: TenantContext): Queryable {
    return this.db.forWorkspace(ctx.workspaceId);
  }

  /**
   * Every agent this workspace has, as a slug-keyed directory.
   *
   * ONE QUERY FOR THE WHOLE TAB, and that is the point rather than a convenience. Six of the ten
   * modules render an agent's NAME — the leaderboard's rows, the feed's rows, Model Mix's
   * highlight, the release timeline, the tool rollup and the team pulse — and every one of them
   * receives a slug from its own aggregate. Resolving that per row is the N+1 the Agents grid was
   * tested against, six times over, on a page whose whole promise is that it is one dataset seen
   * through several lenses.
   *
   * ARCHIVED AGENTS ARE INCLUDED, deliberately and unlike the Agents grid's default. See `AgentRef`.
   *
   * NOT BOUNDED BY THE WINDOW, which is the one method here that is not — and the exception is the
   * reason it is stated. A range is a bound on EVENTS; an agent is not an event. An agent created
   * last year that ran twice yesterday belongs in yesterday's leaderboard, and a directory bounded
   * by the range would leave its rows nameless.
   */
  async agentDirectory(ctx: TenantContext): Promise<Map<string, AgentRef>> {
    const rows = await this.q(ctx).all<Record<string, unknown>>(
      `SELECT id, slug, display_name, archived_at
         FROM agents
        WHERE workspace_id = ? AND deleted_at IS NULL`,
      [ctx.workspaceId],
    );
    const out = new Map<string, AgentRef>();
    for (const row of rows) {
      const slug = String(row["slug"]);
      out.set(slug, {
        agentId: slug,
        uuid: String(row["id"]),
        // The slug is the fallback because it is what every other surface falls back to, and
        // because a row labelled with an empty string is a row nobody can find in a leaderboard.
        name: (row["display_name"] as string | null) ?? slug,
        archived: row["archived_at"] !== null && row["archived_at"] !== undefined,
      });
    }
    return out;
  }

  /**
   * The workspace itself, for §1's header and for §3.3's "is there anything to compare against".
   *
   * `created_at` IS THE POINT. A delta with no comparable previous window renders `--` rather than
   * `0%` or `100%` — "a workspace that is four days old has no previous 30 days" — and the only
   * fact that can decide that is when the workspace began. `range.comparable` is the rule; this is
   * the one input it takes.
   *
   * THE MEMBER COUNT IS A COUNT AND NEVER A LIST. §1 puts "Personal or Team, and how many members"
   * in the header, and §6's payload discipline says this wire carries names, ids, counts and short
   * summaries only. The membership LIST already has its own channel, its own capability and its own
   * broadcast; a second copy riding on an activity snapshot would be a second place to leak it.
   *
   * Undefined for a workspace this context cannot see, which is what a scoped read produces for
   * another tenant's id — §5.4's rule that an id belonging to another workspace reads as ABSENT.
   */
  async workspaceMeta(
    ctx: TenantContext,
  ): Promise<{ name: string; kind: string; createdAt: string; members: number } | undefined> {
    const row = await this.q(ctx).get<Record<string, unknown>>(
      `SELECT w.name AS name, w.kind AS kind, w.created_at AS created_at,
              (SELECT COUNT(*) FROM workspace_members m WHERE m.workspace_id = w.id) AS members
         FROM workspaces w
        WHERE w.id = ? AND w.deleted_at IS NULL`,
      [ctx.workspaceId],
    );
    if (!row) return undefined;
    return {
      name: String(row["name"]),
      kind: String(row["kind"]),
      createdAt: String(row["created_at"]),
      members: asInt(row["members"]),
    };
  }

  /**
   * §2's spend rollup. Three statements, and the count does not move with the number of agents.
   *
   * ONE SCAN COVERS BOTH WINDOWS. The bound runs from `previousFrom` to `to` — the current window
   * and the one before it, contiguous by construction — and a `CASE WHEN occurred_at >= from`
   * separates them inside the aggregate. Two queries would read the same index twice and, worse,
   * could disagree about the boundary between them: a row at exactly `from` counted by both, or by
   * neither, is a run that appears twice on a dashboard or not at all.
   *
   * `SUM(CASE WHEN … THEN cost_usd ELSE 0 END)` AND NOT `COALESCE(cost_usd, 0)`. The difference is
   * the whole unpriced rule: a NULL cost passes through the CASE as NULL, SUM skips it, and the
   * total is a floor that the unpriced count beside it declares. Coalescing would price an unknown
   * model at zero, which is the exact bug v0.1.9 shipped and which §2 forbids by name.
   *
   * THE UNPRICED TEST IS `cost_usd IS NULL`, WHICH IS WHAT WAS RECORDED, not `isPriced(model)` asked
   * of today's table. A ledger row records what was known when the money was spent. Re-pricing
   * history against the current `pricing.json` would silently rewrite a past total the day somebody
   * adds an entry — a number that changed without anything happening, on a page whose figures get
   * screenshotted and quoted.
   *
   * A CRASHED RUN'S SPEND IS COUNTED, and it is counted because of where these rows come from
   * rather than because of anything this query does. `runs.cost` is written by `run_end`, which a
   * run that died mid-graph never emits; `usage_events` is written per STEP as the step arrives, so
   * the completed steps of a crashed run hold real spend and are here. Reading the run-level field
   * instead is the shipped bug §2 says not to reintroduce, and the reason this file never touches
   * it is that there is no join to `runs` in this statement at all.
   */
  async spend(ctx: TenantContext, w: Window): Promise<SpendRollup> {
    const q = this.q(ctx);

    const totals = await q.get<Record<string, unknown>>(
      `SELECT
         SUM(CASE WHEN occurred_at >= ? THEN cost_usd END)                       AS usd,
         SUM(CASE WHEN occurred_at <  ? THEN cost_usd END)                       AS prev_usd,
         COUNT(CASE WHEN occurred_at >= ? THEN 1 END)                            AS events,
         COUNT(CASE WHEN occurred_at <  ? THEN 1 END)                            AS prev_events,
         COUNT(CASE WHEN occurred_at >= ? AND cost_usd IS NULL THEN 1 END)       AS unpriced
       FROM usage_events
       WHERE workspace_id = ? AND occurred_at >= ? AND occurred_at < ?`,
      [w.from, w.from, w.from, w.from, w.from, ctx.workspaceId, w.previousFrom, w.to],
    );

    // The models behind the unpriced rows, and how many agents they leave short. GROUPED BY MODEL
    // RATHER THAN LISTED PER ROW: a workspace running one unpriced model for a week has thousands
    // of rows and one name to show, and §6 bounds this payload to names and counts.
    //
    // The join to `runs` is LEFT and carries the workspace on both sides, exactly as `spendByAgent`
    // does: a usage row with no run — a generation, a plan, a judge verdict — is real money and
    // must not be dropped from the count of what is unpriced.
    const unpriced = await q.all<Record<string, unknown>>(
      `SELECT u.model AS model, COUNT(DISTINCT r.agent_id) AS agents
         FROM usage_events u
         LEFT JOIN runs r ON r.id = u.run_id AND r.workspace_id = u.workspace_id
        WHERE u.workspace_id = ? AND u.occurred_at >= ? AND u.occurred_at < ?
          AND u.cost_usd IS NULL
        GROUP BY u.model`,
      bounds(ctx, w),
    );

    // §2's provider split, for the ring's segments. `provider` and not `model`: the ring answers
    // "who are we paying", and Model Mix (§6) answers "what are we running" — two questions, and
    // putting eleven model ids on a ring gauge would answer neither.
    const providers = await q.all<Record<string, unknown>>(
      `SELECT COALESCE(provider, '') AS provider,
              SUM(cost_usd) AS usd,
              COUNT(CASE WHEN cost_usd IS NULL THEN 1 END) AS unpriced
         FROM usage_events
        WHERE workspace_id = ? AND occurred_at >= ? AND occurred_at < ?
        GROUP BY COALESCE(provider, '')`,
      bounds(ctx, w),
    );

    const balance = await q.get<{ ceiling_usd: unknown }>(
      `SELECT ceiling_usd FROM workspace_balances WHERE workspace_id = ?`,
      [ctx.workspaceId],
    );

    const unpricedModels = unpriced
      .map((r) => String(r["model"] ?? ""))
      .filter((m) => m.length > 0)
      .sort();
    // The union across models rather than the sum of their per-model counts: one agent running two
    // unpriced models is one agent short, not two. A DISTINCT per group cannot see across groups,
    // so the maximum is the honest floor available from this shape — and it is a floor that is
    // correct in the ordinary case of a single unpriced model.
    const unpricedAgents = unpriced.reduce((n, r) => Math.max(n, asInt(r["agents"])), 0);
    const events = asInt(totals?.["events"]);
    const previousEvents = asInt(totals?.["prev_events"]);

    return {
      usd: Number(totals?.["usd"] ?? 0),
      // NULL, NOT ZERO, WHEN THE PREVIOUS WINDOW HELD NOTHING AT ALL. §3.3's delta against a
      // genuine zero is undefined, and reporting `$0.00` for a window nobody billed would make the
      // badge read `+100%` for the first dollar a workspace ever spends.
      previousUsd: previousEvents === 0 ? null : Number(totals?.["prev_usd"] ?? 0),
      unpricedEvents: asInt(totals?.["unpriced"]),
      unpricedModels,
      unpricedAgents,
      costKnown: asInt(totals?.["unpriced"]) === 0,
      budgetUsd:
        balance?.ceiling_usd === null || balance?.ceiling_usd === undefined
          ? null
          : Number(balance.ceiling_usd),
      events,
      byProvider: providers
        .map((r) => ({
          // An empty provider is a row nothing named one on — storage, sandbox seconds. It is real
          // money and belongs in the ring, so it is labelled rather than dropped.
          provider: String(r["provider"] ?? "") || "platform",
          usd: Number(r["usd"] ?? 0),
          costKnown: asInt(r["unpriced"]) === 0,
        }))
        .sort((a, b) => b.usd - a.usd),
    };
  }

  /**
   * §3's token volume, with the cached split. One statement, both windows.
   *
   * `total_tokens` IS THE COLUMN, and it is the derived one the billing repository writes: a caller
   * that gave a split has already said what the total is, so the row carries the sum rather than
   * asking for it twice. Summing `input + output + cached` here instead would be a second
   * derivation of a number the ledger already holds, and the two would part company on the first
   * row that recorded a total and no split — which is every row `meterStep` writes.
   *
   * THE CACHED SUM COALESCES AND THE UNSPLIT SUM DOES NOT, and that asymmetry is the point. Cache
   * reads add up across the rows that have them, so a NULL there contributes nothing to the sum;
   * but a row with a NULL split is not a row with no cache, it is a row nobody measured, and its
   * tokens are counted separately so the card can say how much of the volume the split covers. See
   * `TokenVolume`.
   */
  async tokens(ctx: TenantContext, w: Window): Promise<TokenVolume> {
    const row = await this.q(ctx).get<Record<string, unknown>>(
      `SELECT
         SUM(CASE WHEN occurred_at >= ? THEN total_tokens END)                        AS total,
         COUNT(CASE WHEN occurred_at >= ? THEN 1 END)                                 AS events,
         SUM(CASE WHEN occurred_at <  ? THEN total_tokens END)                        AS prev_total,
         COUNT(CASE WHEN occurred_at <  ? THEN 1 END)                                 AS prev_events,
         SUM(CASE WHEN occurred_at >= ? THEN COALESCE(cached_input_tokens, 0) END)    AS cached,
         SUM(CASE WHEN occurred_at >= ? AND cached_input_tokens IS NULL
                  THEN total_tokens END)                                              AS unsplit
       FROM usage_events
       WHERE workspace_id = ? AND occurred_at >= ? AND occurred_at < ?`,
      [w.from, w.from, w.from, w.from, w.from, w.from, ctx.workspaceId, w.previousFrom, w.to],
    );
    return {
      total: asInt(row?.["total"]),
      events: asInt(row?.["events"]),
      previousTotal: asInt(row?.["prev_events"]) === 0 ? null : asInt(row?.["prev_total"]),
      cached: asInt(row?.["cached"]),
      unsplitTokens: asInt(row?.["unsplit"]),
    };
  }

  /**
   * §4's run health strip. ONE statement, and its cost does not move with the number of agents.
   *
   * THREE THINGS THIS QUERY GETS RIGHT THAT THE OBVIOUS ONE DOES NOT, each of them a sentence in §4
   * and each of them invisible in a screenshot:
   *
   * A PAUSED-AND-RESUMED RUN IS ONE RUN. That falls out of counting `runs` rows rather than
   * `run_start` events: resuming continues under the same run identity and emits no new start, so
   * there is only ever one row to count. It is asserted anyway, because the tempting alternative —
   * counting distinct `run_id` in `steps`, or counting `run_start` in a feed — would double it, and
   * this is the surface where that number gets quoted.
   *
   * A BRANCH COUNTS AS ONE RUN AND DOES NOT CARRY ITS INHERITED PREFIX. `copyRunPrefix` copies the
   * parent's steps up to the branch point into the child under fresh ids, so a naive SUM over a
   * branch's steps charges it for work its parent already did — and both runs then appear in the
   * p95 carrying the same seconds. The join therefore takes only `seq > branch_from_seq` for a run
   * that has one, which is exactly the boundary `branchRun` passes to the copy.
   *
   * AN INTERRUPTED RUN IS NOT A FAILED ONE. The two sentinels come from `TraceStore` rather than
   * being spelled out here — see their note there.
   *
   * THE PERCENTILES ARE COMPUTED IN SQL, unlike the Agents grid's, and the reason is the window
   * rather than a preference. `agentHealth.percentiles` takes the last ~20 runs of one agent, which
   * is twenty numbers; this is every run in the workspace over as much as thirty days, which is
   * tens of thousands, and reading them into this process to sort them would put the size of a
   * month's history into one cached payload's memory. The arithmetic is deliberately the SAME
   * nearest-rank rule — `ceil(q × n)`, written in integer division so both dialects agree and
   * neither needs a `ceil` this SQLite build may not have — so a p95 here and a p95 on an agent
   * card mean the same thing.
   */
  async runHealth(ctx: TenantContext, w: Window): Promise<RunHealth> {
    const row = await this.q(ctx).get<Record<string, unknown>>(
      `WITH per_run AS (
         SELECT r.id                                          AS run_id,
                r.status                                      AS status,
                r.error                                       AS error,
                CASE WHEN r.started_at >= ? THEN 1 ELSE 0 END AS cur,
                SUM(s.latency_ms)                             AS latency_ms
           FROM runs r
           LEFT JOIN steps s
             ON s.workspace_id = r.workspace_id
            AND s.run_id = r.id
            -- The branch's own work only. See the note above.
            AND (r.branch_from_seq IS NULL OR s.seq > r.branch_from_seq)
          WHERE r.workspace_id = ? AND r.started_at >= ? AND r.started_at < ?
          GROUP BY r.id, r.status, r.error, cur
       ),
       settled AS (
         SELECT latency_ms FROM per_run
          WHERE cur = 1 AND latency_ms IS NOT NULL AND status IN ('completed', 'error')
       ),
       ranked AS (
         SELECT latency_ms,
                ROW_NUMBER() OVER (ORDER BY latency_ms) AS rn,
                COUNT(*)     OVER ()                    AS n
           FROM settled
       )
       SELECT
         (SELECT COUNT(*) FROM per_run WHERE cur = 1)                                   AS runs,
         (SELECT COUNT(*) FROM per_run WHERE cur = 1 AND status = 'completed')          AS ok,
         (SELECT COUNT(*) FROM per_run WHERE cur = 1 AND status = 'error'
                 AND (error IS NULL OR (error <> ? AND error <> ?)))                    AS failed,
         (SELECT COUNT(*) FROM per_run WHERE cur = 1 AND status = 'error'
                 AND (error = ? OR error = ?))                                          AS interrupted,
         (SELECT COUNT(*) FROM per_run WHERE cur = 1 AND status = 'running')            AS running,
         (SELECT COUNT(*) FROM per_run WHERE cur = 1 AND status = 'paused')             AS paused,
         (SELECT COUNT(*) FROM per_run WHERE cur = 0 AND status = 'completed')          AS prev_ok,
         (SELECT COUNT(*) FROM per_run WHERE cur = 0 AND status = 'error'
                 AND (error IS NULL OR (error <> ? AND error <> ?)))                    AS prev_failed,
         -- Nearest-rank, in integer division: ceil(n/2) and ceil(95n/100).
         (SELECT MIN(latency_ms) FROM ranked WHERE rn = (n + 1) / 2)                    AS p50,
         (SELECT MIN(latency_ms) FROM ranked WHERE rn = (95 * n + 99) / 100)            AS p95`,
      [
        w.from,
        ctx.workspaceId,
        w.previousFrom,
        w.to,
        TraceStore.INTERRUPTED_BY_RESTART,
        TraceStore.CANCELLED_BY_USER,
        TraceStore.INTERRUPTED_BY_RESTART,
        TraceStore.CANCELLED_BY_USER,
        TraceStore.INTERRUPTED_BY_RESTART,
        TraceStore.CANCELLED_BY_USER,
      ],
    );

    const ok = asInt(row?.["ok"]);
    const failed = asInt(row?.["failed"]);
    const prevOk = asInt(row?.["prev_ok"]);
    const prevFailed = asInt(row?.["prev_failed"]);

    return {
      runs: asInt(row?.["runs"]),
      ok,
      failed,
      interrupted: asInt(row?.["interrupted"]),
      running: asInt(row?.["running"]),
      paused: asInt(row?.["paused"]),
      // NULL RATHER THAN ZERO WHEN NOTHING HAS SETTLED. §3.5 again, and here it is the difference
      // between "no run has finished yet" and "every run failed" — two sentences a card must never
      // confuse, on a figure people quote.
      successRate: rate(ok, failed),
      previousSuccessRate: rate(prevOk, prevFailed),
      p50: numberOrNull(row?.["p50"]),
      p95: numberOrNull(row?.["p95"]),
    };
  }

  /**
   * §3.1's workspace pulse: runs and spend over the range, bucketed. Two statements.
   *
   * GROUPED IN SQL BY A GRAIN AND FOLDED INTO COLUMNS IN JAVASCRIPT, which is the one genuinely
   * non-obvious decision in this file and is explained at length on `grainFor`. The short version:
   * `substr` is the only date arithmetic both dialects spell identically, so the query groups by
   * minute, hour or day, and `bucketIndex` — already a pure, tested rule — does the rest. That
   * bounds what crosses into this process at a few hundred rows whatever the workspace's size,
   * where grouping per RUN would be tens of thousands.
   *
   * TWO STATEMENTS BECAUSE THERE ARE TWO TABLES AND NO USEFUL JOIN BETWEEN THEM. A run and the
   * usage rows it produced are bucketed by different columns — `runs.started_at` and
   * `usage_events.occurred_at` — and a usage row with no run at all (a generation, a plan, a judge
   * verdict) is real money that a join through `runs` would drop. Two reads, one fold, one series.
   *
   * EVERY COLUMN EXISTS, INCLUDING THE EMPTY ONES. A series that returned only the buckets with
   * rows in them would draw a chart whose columns are unevenly spaced and whose gaps read as
   * "narrower period" rather than "nothing happened". §3.5's empty-is-not-zero applies to the CARD,
   * which renders `--` when the whole series is empty; a zero inside a series that has data
   * elsewhere is a genuine zero and is drawn as one.
   */
  async pulse(ctx: TenantContext, w: Window): Promise<PulseColumn[]> {
    const q = this.q(ctx);
    const grain = grainFor(w.bucketMs);
    const { length } = GRAIN_PREFIX[grain];

    const runRows = await q.all<Record<string, unknown>>(
      `SELECT SUBSTR(started_at, 1, ?) AS k,
              COUNT(*)                                        AS runs,
              COUNT(CASE WHEN status = 'error' THEN 1 END)    AS errors
         FROM runs
        WHERE workspace_id = ? AND started_at >= ? AND started_at < ?
        GROUP BY SUBSTR(started_at, 1, ?)`,
      [length, ...bounds(ctx, w), length],
    );

    const usageRows = await q.all<Record<string, unknown>>(
      `SELECT SUBSTR(occurred_at, 1, ?) AS k,
              SUM(cost_usd)     AS usd,
              SUM(total_tokens) AS tokens
         FROM usage_events
        WHERE workspace_id = ? AND occurred_at >= ? AND occurred_at < ?
        GROUP BY SUBSTR(occurred_at, 1, ?)`,
      [length, ...bounds(ctx, w), length],
    );

    const series: PulseColumn[] = bucketStarts(w).map((at) => ({
      at, runs: 0, errors: 0, usd: 0, tokens: 0,
    }));
    const place = (key: unknown, apply: (column: PulseColumn) => void): void => {
      const i = columnFor(w, grainInstant(grain, String(key)));
      // A grain cell whose instant falls outside the window is one the WHERE already excluded, so
      // this is unreachable in practice — and it is guarded rather than asserted because the
      // alternative when a driver surprises us is writing into `series[-1]`.
      if (i >= 0) apply(series[i]!);
    };

    for (const r of runRows) {
      place(r["k"], (c) => {
        c.runs += asInt(r["runs"]);
        c.errors += asInt(r["errors"]);
      });
    }
    for (const r of usageRows) {
      place(r["k"], (c) => {
        // An unpriced row contributes NULL, which adds nothing — the same rule the hero figure
        // follows, and for the same reason. The card states the floor once; a column does not
        // repeat the caveat.
        c.usd += Number(r["usd"] ?? 0);
        c.tokens += asInt(r["tokens"]);
      });
    }
    return series;
  }
}

/** `ok / settled`, or null when nothing settled. Never 0 for an empty denominator. */
function rate(ok: number, failed: number): number | null {
  const settled = ok + failed;
  return settled === 0 ? null : ok / settled;
}

/** A numeric column that is genuinely allowed to be absent. Unknown is not zero. */
function numberOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * The three bound parameters every range-bounded statement in this file takes, in one place.
 *
 * A HELPER RATHER THAN THREE LITERALS PER QUERY, because the ordering is the thing that goes wrong:
 * `[ctx.workspaceId, w.from, w.to]` written out at fourteen call sites is fourteen chances to swap
 * the last two, and a window with its ends reversed returns nothing rather than failing — a card
 * that renders `--` on a busy workspace and no error anywhere.
 */
export function bounds(ctx: TenantContext, w: Window): [string, string, string] {
  return [ctx.workspaceId, w.from, w.to];
}

/** The same, for the previous equivalent window §3.3's deltas are measured against. */
export function previousBounds(ctx: TenantContext, w: Window): [string, string, string] {
  return [ctx.workspaceId, w.previousFrom, w.previousTo];
}
