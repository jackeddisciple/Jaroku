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
  FEED_PAGE_DEFAULT,
  NOT_APPROVED,
  TRUNCATION_MARKER,
  feedQuery,
  pageSize,
  type FeedCursor,
  type FeedFilters,
  type FeedPage,
  type FeedRow,
} from "./feed.ts";
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

/**
 * §7's leaderboard row: one agent, comparable against every other.
 *
 * WHY A TABLE AND NOT MORE CARDS. The Agents tab is a card grid, and cards cannot be ranked against
 * each other — you cannot read forty of them and say which is expensive. This is the surface that
 * answers the two questions a grid structurally cannot: which agent costs the most, and which one
 * is flaky. Everything here is therefore a COLUMN, comparable down its own length.
 *
 * `models` RIDES ALONG FOR §3.4'S CROSS-HIGHLIGHT, not for display. Hovering a Model Mix segment
 * has to dim every leaderboard row that does not use that model, and the alternative to carrying
 * the list is the client asking the server on hover — which §3.4 forbids in one sentence: "Nothing
 * is clicked. Nothing changes. Nothing is fetched."
 */
export interface LeaderboardRow {
  agentId: string;
  name: string;
  archived: boolean;
  runs: number;
  ok: number;
  failed: number;
  interrupted: number;
  successRate: number | null;
  usd: number;
  /** False when this agent ran an unpriced model, so its spend is a floor. §2's rule, per row. */
  costKnown: boolean;
  p95: number | null;
  /** The most recent run of this agent INSIDE the window. Null when it did not run in it. */
  lastActive: string | null;
  /** Distinct models this agent ran in the window. For the hover, not for the eye. */
  models: string[];
}

/**
 * §6's mix: one model, and how much of the workspace's spend and volume it accounts for.
 *
 * WHY THIS EXISTS NOWHERE ELSE IN THE PRODUCT. The eval comparison answers "which provider is
 * better on this dataset", which is a question about quality on a fixed set of examples. This
 * answers "what are we actually spending on", which is a question about production. Different
 * question, different data, and neither substitutes for the other.
 *
 * TWO SHARES, NOT ONE, and they disagree on purpose. A cheap model can be most of the volume and a
 * tenth of the bill; an expensive one is the reverse. A single stacked bar would have to pick one
 * and would be answering half the question — §6 asks for both views, toggleable, which is only
 * meaningful if the two numbers are carried side by side.
 *
 * AN UNPRICED MODEL APPEARS IN THE VOLUME VIEW AND IS EXCLUDED FROM THE SPEND VIEW, labelled rather
 * than dropped silently. Dropping it would make the volume view and the spend view disagree about
 * which models the workspace even runs, and a reader comparing the two would conclude one of them
 * is broken. `priced` is what the segment's label is drawn from.
 */
export interface ModelShare {
  model: string;
  provider: string;
  /** USD attributed to this model. Zero and meaningless when `priced` is false. */
  usd: number;
  tokens: number;
  /** How many usage rows named it. The honest denominator for "how often is this actually used". */
  calls: number;
  /** False when any row for this model recorded no cost. §6's label rather than a silent drop. */
  priced: boolean;
}

/** §6's mix, with the two denominators its two views are drawn against. */
export interface ModelMix {
  models: ModelShare[];
  /** Spend across PRICED models only — the denominator of the spend view. */
  pricedUsd: number;
  /** Volume across every model, priced or not — the denominator of the volume view. */
  totalTokens: number;
}

/**
 * §8's release timeline: one entry in the workspace's release log.
 *
 * WHY IT IS NOT THE FEED WITH A FILTER. The feed answers "what happened, in order"; this answers
 * "what did we ship". They read some of the same rows and they are not the same view: the timeline
 * pairs a PUBLISH with the DEPLOY that carried it, shows the version numbers side by side, and is
 * read vertically to see that three agents went out on Tuesday and two of them failed. A filtered
 * feed would give the same rows in the same order with none of that adjacency.
 *
 * WHY IT IS NOT THE PER-AGENT DEPLOY PANEL. That panel shows one agent's deployments, which is the
 * question you ask when you are already looking at an agent. This is the workspace's release log —
 * the view that makes a bad Tuesday visible at all.
 *
 * FAILED DEPLOYS ARE IN IT. §8: "a release log that only shows successes is a marketing page."
 */
export interface ReleaseEntry {
  id: string;
  at: string;
  kind: "version" | "deploy";
  agentId: string;
  agentName: string;
  /** The version published, or the version a deploy built from. Null for a deploy that recorded none. */
  version: number | null;
  /** Who published it. Null for a deploy, which records nobody — see `ACTOR_SOURCES`. */
  actorUserId: string | null;
  outcome: "ok" | "error" | "running";
  /** For a version, what made it. For a deploy, where it went. */
  detail: string;
  /** A live deploy's URL. Names only — never a credential, and never a build log. */
  url: string | null;
}

/**
 * §9's per-tool row: how often a tool was called across every agent, and how it went.
 *
 * PROVENANCE TRAVELS WITH IT, because §9 is explicit that "a reviewed connector and an unread server
 * tool must never look alike here either". `reviewed` and `mcp` are two different origins with two
 * different trust stories, and a rollup that listed them in one undifferentiated column would be
 * the one surface in the product where that distinction is dropped.
 */
export interface ToolRow {
  name: string;
  /** Where the tool came from. `bespoke` is code a model wrote for one agent. */
  origin: "reviewed" | "mcp" | "bespoke";
  /** The MCP server it belongs to, for a tool that has one. */
  serverId: string | null;
  /** Its classification, for an MCP tool. `impact_override` wins where a workspace set one. */
  impact: "high" | "low" | null;
  calls: number;
  failures: number;
  /** Calls whose result hit the size cap. §9's truncation rate, per tool. */
  truncated: number;
}

/**
 * §9's rollup: call counts, and the four numbers nothing else in the product reports.
 *
 * THE CONFIRMATION RATES ARE READ OFF THE STEPS THE GATE RAISED ON, not off a table. Nothing records
 * a confirmation being answered — the gate lives inside `mcp_bridge.py`, raises `ToolNotApproved`
 * when it is refused, and returns silently when it is not — so the step IS the record: an error
 * carrying the runtime's own "was not approved" sentence is a refusal, and a high-impact call
 * without one went through. That makes the numbers available for history as well as for today,
 * which a new write would not.
 *
 * A DENIAL AND A TIMEOUT ARE BOTH REFUSALS AND ARE STILL COUNTED APART. §9 says both count as a
 * refusal, "which is already how the runtime treats them" — so the RATE is over their sum. They are
 * reported separately anyway, because "nobody was there" and "somebody said no" call for different
 * next steps, which is exactly why `mcp_bridge.py` raises two different sentences.
 */
export interface ToolUsage {
  tools: ToolRow[];
  /** Calls to tools classified high-impact, in the range. §9's own figure. */
  highImpactCalls: number;
  approved: number;
  denied: number;
  timedOut: number;
  /** Calls whose result hit the size cap, across every tool. */
  truncatedCalls: number;
  /** Every tool call in the range — the denominator the truncation rate is over. */
  totalCalls: number;
  /**
   * Failures of REVIEWED connector tools. §9, and v0.1.12's bug in aggregate.
   *
   * "Trust in reviewed code depends on failures being loud, and v0.1.12 fixed a bug where a reviewed
   * connector's failures had no route to the user at all." This is the workspace-level view of that:
   * a number that should be zero, in a place somebody will notice it is not.
   */
  reviewedFailures: number;
}

/**
 * §10's Team pulse: one member's contribution to the range.
 *
 * THREE COLUMNS AND NOT FIVE, AND THE ABSENCE IS THE HONEST PART. §10 asks for "agents created,
 * edits applied, deploys, runs, spend attributed". Three of those five are attributable in this
 * schema and two are not: `deployments`, `eval_runs` and `runs` carry no actor column, so there is
 * no row anywhere that says who started a run or who pressed deploy. `runs` in particular is part of
 * the frozen event schema, which §5.1 says this tab does not touch — and spend is attributed
 * THROUGH runs, so it inherits the same silence.
 *
 * SO THE CARD SHOWS WHAT IS RECORDED AND SAYS WHAT IS NOT, rather than showing a zero in a column
 * nothing can ever fill. A "0 deploys" beside somebody's name is a claim about that person; an
 * absent column is a claim about the schema, which is the true one. This is recorded in the release
 * notes as a gap rather than papered over.
 */
export interface MemberPulse {
  userId: string;
  agentsCreated: number;
  /** Versions published whose source is `edit`. */
  editsApplied: number;
  /** Versions published by any other route: a generation, an import, a deploy's build. */
  versionsPublished: number;
  /** Build sessions started. `threads.created_by` is the one session-level attribution there is. */
  threadsStarted: number;
}

/**
 * §10's personal summary: the same range, for a workspace of one.
 *
 * RENDERED INSTEAD OF THE TEAM CARD, NEVER BESIDE IT. §10: "Render one or the other by scope; do
 * not show an empty Team card in a Personal workspace." A per-member table in a workspace with one
 * member is a table with one row and a column header explaining who that is.
 */
export interface PersonalSummary {
  /** The agent with the most runs in the range. Null when nothing ran. */
  mostActiveAgent: { agentId: string; name: string; runs: number } | null;
  runs: number;
  usd: number;
  costKnown: boolean;
  /**
   * Consecutive days ending today on which at least one run started. §10's "simple streak".
   *
   * ENDING TODAY, WHICH IS WHAT MAKES IT A STREAK. A count of active days in the range would be a
   * different and less interesting number — "you used this 9 times this month" — and would not
   * break, which is the only thing a streak is for. A day with no runs ends it, and the count is
   * zero rather than a fraction of one.
   *
   * BOUNDED BY THE WINDOW like everything else on this page. A 24-hour range can show a streak of
   * at most one, which is correct: every figure here describes the same window, and a streak that
   * reached outside it would be the one number on the screen answering a different question.
   */
  streakDays: number;
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

    // GROUP BY THE OUTPUT NAME, NOT A SECOND COPY OF THE EXPRESSION, and this is a driver
    // difference that cost a red CI for days. Postgres decides whether a column is functionally
    // grouped by comparing the GROUP BY expression to the select-list one SYNTACTICALLY — and a
    // repeated `SUBSTR(started_at, 1, ?)` is not the same expression, because the two `?` become
    // $1 and $5. So Postgres saw a bare `started_at` in the select list under a GROUP BY it could
    // not match and refused the statement; SQLite is lenient about exactly this and ran it.
    // Both dialects accept an output-column name in GROUP BY, so naming `k` once is the version
    // that means the same thing on both — and it drops the duplicated parameter with it.
    const runRows = await q.all<Record<string, unknown>>(
      `SELECT SUBSTR(started_at, 1, ?) AS k,
              COUNT(*)                                        AS runs,
              COUNT(CASE WHEN status = 'error' THEN 1 END)    AS errors
         FROM runs
        WHERE workspace_id = ? AND started_at >= ? AND started_at < ?
        GROUP BY k`,
      [length, ...bounds(ctx, w)],
    );

    // AND THE SECOND ONE CANNOT SPELL ITS COLUMN THE SAME WAY, because `occurred_at` is not the
    // same TYPE on the two drivers. `runs.started_at` above is `text` on both — migration 002 froze
    // the trace schema on ISO-8601 strings — but `usage_events.occurred_at` is a real `timestamptz`
    // on Postgres, and `substr` has no overload that takes one. So this query could never have run
    // there; it was only ever reached after the GROUP BY above had already failed the statement.
    //
    // `to_char` REPRODUCES SQLITE'S STORED SPELLING EXACTLY, and that is the requirement rather than
    // "some canonical date string": `grainInstant` puts the key back together by appending a suffix
    // to it, so the key has to be an ISO-8601 PREFIX with the `T` in it. Postgres's own
    // `timestamptz::text` gives `2026-08-21 07:32:30.776+00` — a space, and an offset — which
    // produces the right answer at day grain and a key nothing can parse at hour grain.
    //
    // The dialect is interpolated rather than bound because a placeholder cannot carry a function
    // call; it is a constant chosen from a closed set two lines up and never anything a caller said.
    // Same shape `deployStore` and `evalStore` already use for their own driver divergences.
    const occurredIso = this.db.dialect === "postgres"
      ? `to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
      : "occurred_at";
    const usageRows = await q.all<Record<string, unknown>>(
      `SELECT SUBSTR(${occurredIso}, 1, ?) AS k,
              SUM(cost_usd)     AS usd,
              SUM(total_tokens) AS tokens
         FROM usage_events
        WHERE workspace_id = ? AND occurred_at >= ? AND occurred_at < ?
        GROUP BY k`,
      [length, ...bounds(ctx, w)],
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

  /**
   * §7's leaderboard. THREE statements, and none of them moves with the number of agents.
   *
   * THAT LAST CLAUSE IS THE POINT AND IT HAS A TEST. `test:activity-leaderboard` counts the
   * statements this method issues for one agent and for forty and asserts the two counts are equal
   * — exactly as `test:agent-grid` does for the Agents grid, and for the same reason: an N+1 here
   * is invisible in review and instantly visible in a real workspace. A leaderboard is the most
   * natural place in the product to write one, because every row wants a per-agent figure.
   *
   * THE FIRST STATEMENT IS THE RUN HALF, and it is the health strip's query grouped one level
   * coarser — same per-run CTE, same branch-prefix rule, same nearest-rank arithmetic, same
   * interrupted-is-not-failed split. That repetition is deliberate rather than lazy: the two
   * modules must agree, and the only way to guarantee that is for the row's rule and the strip's
   * rule to be the same expression. A leaderboard whose success rates did not average to the
   * headline rate would be the fastest way to make somebody stop believing both.
   *
   * THE SECOND IS THE MONEY HALF, grouped by (agent, model) rather than by agent alone. One query
   * then answers two questions — what each agent spent, and which models each agent ran — and the
   * second of those is what §3.4's cross-highlight needs in the payload rather than on hover.
   *
   * THE THIRD IS THE DIRECTORY, which is the one read here that is not an aggregate: a row needs a
   * NAME, and the run table holds only a slug. It is a whole-workspace read rather than a lookup
   * per row, which is the same reason it exists at all — see `agentDirectory`.
   *
   * AN AGENT WITH NO RUNS IN THE WINDOW IS NOT A ROW. §3.5 again: a leaderboard padded with agents
   * at `0 runs / $0.00` is a table whose top half is noise, and worse, it renders zeros for agents
   * that were simply not used. The Agents tab is where every agent appears; this is where the ones
   * that did something are ranked.
   */
  async leaderboard(ctx: TenantContext, w: Window): Promise<LeaderboardRow[]> {
    const q = this.q(ctx);

    const runRows = await q.all<Record<string, unknown>>(
      `WITH per_run AS (
         SELECT r.agent_id       AS agent_id,
                r.id             AS run_id,
                r.status         AS status,
                r.error          AS error,
                r.started_at     AS started_at,
                SUM(s.latency_ms) AS latency_ms
           FROM runs r
           LEFT JOIN steps s
             ON s.workspace_id = r.workspace_id
            AND s.run_id = r.id
            -- The branch's own work only, exactly as the health strip does it.
            AND (r.branch_from_seq IS NULL OR s.seq > r.branch_from_seq)
          WHERE r.workspace_id = ? AND r.started_at >= ? AND r.started_at < ?
          GROUP BY r.agent_id, r.id, r.status, r.error, r.started_at
       ),
       ranked AS (
         SELECT agent_id, latency_ms,
                ROW_NUMBER() OVER (PARTITION BY agent_id ORDER BY latency_ms) AS rn,
                COUNT(*)     OVER (PARTITION BY agent_id)                     AS n
           FROM per_run
          WHERE latency_ms IS NOT NULL AND status IN ('completed', 'error')
       ),
       pct AS (
         SELECT agent_id, MIN(CASE WHEN rn = (95 * n + 99) / 100 THEN latency_ms END) AS p95
           FROM ranked GROUP BY agent_id
       )
       SELECT p.agent_id                                              AS agent_id,
              COUNT(*)                                                AS runs,
              COUNT(CASE WHEN p.status = 'completed' THEN 1 END)      AS ok,
              COUNT(CASE WHEN p.status = 'error'
                          AND (p.error IS NULL
                               OR (p.error <> ? AND p.error <> ?)) THEN 1 END) AS failed,
              COUNT(CASE WHEN p.status = 'error'
                          AND (p.error = ? OR p.error = ?) THEN 1 END)         AS interrupted,
              MAX(p.started_at)                                       AS last_active,
              MAX(pct.p95)                                            AS p95
         FROM per_run p
         LEFT JOIN pct ON pct.agent_id = p.agent_id
        GROUP BY p.agent_id`,
      [
        ...bounds(ctx, w),
        TraceStore.INTERRUPTED_BY_RESTART,
        TraceStore.CANCELLED_BY_USER,
        TraceStore.INTERRUPTED_BY_RESTART,
        TraceStore.CANCELLED_BY_USER,
      ],
    );

    // The money half. INNER-joined to `runs` on purpose, unlike the spend rollup's LEFT join: a
    // usage row with no run is real money and belongs in the workspace total, but it belongs to no
    // AGENT and a leaderboard row for it would be a row nobody could click.
    const moneyRows = await q.all<Record<string, unknown>>(
      `SELECT r.agent_id                                  AS agent_id,
              u.model                                     AS model,
              SUM(u.cost_usd)                             AS usd,
              COUNT(CASE WHEN u.cost_usd IS NULL THEN 1 END) AS unpriced
         FROM usage_events u
         JOIN runs r ON r.id = u.run_id AND r.workspace_id = u.workspace_id
        WHERE u.workspace_id = ? AND u.occurred_at >= ? AND u.occurred_at < ?
        GROUP BY r.agent_id, u.model`,
      bounds(ctx, w),
    );

    const money = new Map<string, { usd: number; unpriced: number; models: Set<string> }>();
    for (const r of moneyRows) {
      const agentId = String(r["agent_id"] ?? "");
      if (!agentId) continue;
      const at = money.get(agentId) ?? { usd: 0, unpriced: 0, models: new Set<string>() };
      at.usd += Number(r["usd"] ?? 0);
      at.unpriced += asInt(r["unpriced"]);
      const model = String(r["model"] ?? "");
      if (model) at.models.add(model);
      money.set(agentId, at);
    }

    const directory = await this.agentDirectory(ctx);
    const rows: LeaderboardRow[] = runRows.map((r) => {
      const agentId = String(r["agent_id"] ?? "");
      const spent = money.get(agentId);
      const ok = asInt(r["ok"]);
      const failed = asInt(r["failed"]);
      const ref = directory.get(agentId);
      return {
        agentId,
        // An agent whose row has since been swept still has runs pointing at its slug, and the
        // slug is a name somebody recognises. Falling back to it beats an empty cell.
        name: ref?.name ?? agentId,
        archived: ref?.archived ?? false,
        runs: asInt(r["runs"]),
        ok,
        failed,
        interrupted: asInt(r["interrupted"]),
        successRate: rate(ok, failed),
        usd: spent?.usd ?? 0,
        costKnown: (spent?.unpriced ?? 0) === 0,
        p95: numberOrNull(r["p95"]),
        lastActive: (r["last_active"] as string | null) ?? null,
        models: [...(spent?.models ?? [])].sort(),
      };
    });

    // Most expensive first, which is the question §7 says a card grid cannot answer. The client may
    // sort by any column; this is only the order it arrives in, so a client that has not chosen yet
    // is already showing the useful one.
    return rows.sort((a, b) => b.usd - a.usd || b.runs - a.runs || a.agentId.localeCompare(b.agentId));
  }

  /**
   * §6's model and provider mix. ONE statement.
   *
   * GROUPED BY (MODEL, PROVIDER) RATHER THAN BY MODEL ALONE. The same model id can arrive under two
   * providers — a workspace running Claude on its own key and through the platform, or the same
   * open-weights id served by two hosts — and folding them together would put one bar where there
   * are two facts. It also means the provider is a column of the answer rather than something the
   * client has to look up, which is what lets §6's brand logos be resolved without a second table.
   *
   * EVERY USAGE ROW IS HERE, INCLUDING THE ONES WITH NO RUN. A generation, a plan, a judge verdict
   * and an explanation are model calls the workspace paid for, and the leaderboard cannot show them
   * because they belong to no agent. This is the one module where they are visible, which is
   * another reason it is not a per-agent breakdown wearing a different hat.
   *
   * A ROW WITH NO MODEL AT ALL IS DROPPED, and it is the only thing this method drops. Sandbox
   * seconds and stored bytes are metered as usage and name no model, so a segment for them would be
   * a bar in a MODEL mix labelled with nothing. They are still in the spend rollup's provider ring,
   * which is where "what did we pay for" is answered — see `SpendRollup.byProvider`.
   */
  async modelMix(ctx: TenantContext, w: Window): Promise<ModelMix> {
    const rows = await this.q(ctx).all<Record<string, unknown>>(
      `SELECT model                                          AS model,
              COALESCE(provider, '')                         AS provider,
              SUM(cost_usd)                                  AS usd,
              SUM(total_tokens)                              AS tokens,
              COUNT(*)                                       AS calls,
              COUNT(CASE WHEN cost_usd IS NULL THEN 1 END)   AS unpriced
         FROM usage_events
        WHERE workspace_id = ? AND occurred_at >= ? AND occurred_at < ?
          AND model IS NOT NULL AND model <> ''
        GROUP BY model, COALESCE(provider, '')`,
      bounds(ctx, w),
    );

    const models: ModelShare[] = rows.map((r) => ({
      model: String(r["model"]),
      provider: String(r["provider"] ?? "") || "unknown",
      usd: Number(r["usd"] ?? 0),
      tokens: asInt(r["tokens"]),
      calls: asInt(r["calls"]),
      priced: asInt(r["unpriced"]) === 0,
    }));

    return {
      models: models.sort((a, b) => b.usd - a.usd || b.tokens - a.tokens || a.model.localeCompare(b.model)),
      // THE SPEND DENOMINATOR EXCLUDES THE UNPRICED, which is §2's "excluded from every ranking"
      // applied to a share rather than to a row. Including their zero would leave the priced
      // segments summing to less than the bar's width, and a reader would take the gap for a model
      // nobody had named.
      pricedUsd: models.filter((m) => m.priced).reduce((n, m) => n + m.usd, 0),
      totalTokens: models.reduce((n, m) => n + m.tokens, 0),
    };
  }

  /**
   * §5's unified event feed, one keyset page. ONE statement, whatever the filters.
   *
   * THE UNION AND ITS PARAMETERS ARE BUILT IN `feed.ts`, deliberately outside this class, so the
   * part that is easy to get wrong — the order of nine branches' bound values — can be read and
   * reasoned about without a database in front of you. What stays here is the scope: the workspace
   * id goes into every branch from the context, and `feedQuery` cannot be called without one.
   *
   * A NULL QUERY IS AN EMPTY PAGE, NOT AN ERROR. "Deploys by Ada" in a workspace whose deploy rows
   * record no actor filters every source out, and the honest answer is a page with nothing on it —
   * see `ACTOR_SOURCES` for why that combination exists at all.
   */
  async feed(
    ctx: TenantContext,
    w: Window,
    filters: FeedFilters = {},
    cursor: FeedCursor | null = null,
    limit = FEED_PAGE_DEFAULT,
  ): Promise<FeedPage> {
    const size = pageSize(limit);
    const built = feedQuery(ctx, w, filters, cursor, size, this.db.dialect);
    if (!built) return { rows: [], next: null };

    const rows = await this.q(ctx).all<Record<string, unknown>>(built.sql, built.params);
    // One more than asked for was fetched, so "is there another page" is answered by whether it
    // arrived rather than by a second scan. The extra row is dropped, never rendered.
    const page = rows.slice(0, size);
    const hasMore = rows.length > size;

    const out: FeedRow[] = page.map((r) => ({
      id: String(r["feed_id"]),
      at: String(r["at"]),
      kind: String(r["kind"]) as FeedRow["kind"],
      agentId: (r["agent_id"] as string | null) ?? null,
      actorUserId: (r["actor_user_id"] as string | null) ?? null,
      object: (r["object"] as string | null) ?? null,
      outcome: (r["outcome"] as FeedRow["outcome"]) ?? null,
      num: numberOrNull(r["num"]),
      targetType: String(r["target_type"]) as FeedRow["targetType"],
      targetId: String(r["target_id"] ?? ""),
    }));

    const last = out[out.length - 1];
    return {
      rows: out,
      // THE CURSOR IS THE LAST ROW THIS PAGE ACTUALLY RETURNED, not the extra one that proved there
      // is more. Taking the extra row's key would skip it on the next page — the classic off-by-one
      // in a look-ahead pagination, and one that only shows up at a page boundary.
      next: hasMore && last ? { at: last.at, id: last.id } : null,
    };
  }

  /**
   * §8's release timeline. TWO statements, plus the shared directory for the names.
   *
   * BOUNDED BY A COUNT AS WELL AS BY THE WINDOW, and unlike the feed it is not paginated. A release
   * log is read by scanning down it, not by scrolling forever: a workspace that shipped four
   * hundred times in a month has a problem the timeline cannot help with, and a card that tried to
   * render all four hundred would be a second feed. The bound is stated rather than implicit, so a
   * timeline that is truncated can say so.
   *
   * A VERSION WHOSE SOURCE IS `edit` IS NOT A RELEASE. An edit publishes a version — the feed shows
   * it, and the version browser shows it — but nobody would call it a release, and putting every
   * edit in the release log would bury the four things that actually went out this week under
   * forty that did not.
   *
   * `env_keys` AND THE BUILD LOG ARE NOT HERE, deliberately. A deployment row carries the NAMES of
   * the variables it was given (never the values, per migration 015's design) and its logs live in
   * their own table; §6's payload discipline says this wire carries names, ids, counts and short
   * summaries only, so the timeline carries the URL and the outcome and nothing else. A build log
   * that reached this payload would be a redaction problem on a surface that gets screenshotted.
   */
  async releases(ctx: TenantContext, w: Window, limit = 60): Promise<ReleaseEntry[]> {
    const q = this.q(ctx);
    const cap = Math.max(1, Math.min(200, Math.trunc(limit)));

    const versions = await q.all<Record<string, unknown>>(
      `SELECT v.id AS id, v.created_at AS at, a.slug AS agent_id, v.version AS version,
              v.created_by AS actor_user_id, v.source AS source
         FROM agent_versions v
         JOIN agents a ON a.id = v.agent_id
        WHERE a.workspace_id = ? AND v.created_at >= ? AND v.created_at < ?
          AND v.source <> 'edit'
        ORDER BY v.created_at DESC
        LIMIT ?`,
      [...bounds(ctx, w), cap],
    );

    const deployments = await q.all<Record<string, unknown>>(
      `SELECT id, created_at AS at, agent_id, version, status, target, url
         FROM deployments
        WHERE workspace_id = ? AND created_at >= ? AND created_at < ?
        ORDER BY created_at DESC
        LIMIT ?`,
      [...bounds(ctx, w), cap],
    );

    const directory = await this.agentDirectory(ctx);
    const name = (slug: string): string => directory.get(slug)?.name ?? slug;

    const entries: ReleaseEntry[] = [
      ...versions.map((r): ReleaseEntry => ({
        id: `version:${String(r["id"])}`,
        at: String(r["at"]),
        kind: "version",
        agentId: String(r["agent_id"]),
        agentName: name(String(r["agent_id"])),
        version: numberOrNull(r["version"]),
        actorUserId: (r["actor_user_id"] as string | null) ?? null,
        // A published version is a fact rather than an attempt: the validator is the gate on
        // publishing, so a row that exists passed it. There is no failed publish to show.
        outcome: "ok",
        detail: String(r["source"] ?? "import"),
        url: null,
      })),
      ...deployments.map((r): ReleaseEntry => {
        const status = String(r["status"] ?? "");
        return {
          id: `deploy:${String(r["id"])}`,
          at: String(r["at"]),
          kind: "deploy",
          agentId: String(r["agent_id"]),
          agentName: name(String(r["agent_id"])),
          version: numberOrNull(r["version"]),
          actorUserId: null,
          outcome: status === "live" ? "ok" : status === "failed" ? "error" : "running",
          detail: String(r["target"] ?? ""),
          // ONLY WHEN IT IS ACTUALLY SERVING. A URL on a failed deploy is a link to nothing, and
          // one on a superseded deploy points at whatever is there now — which is a different
          // release. The same guard the Agents card puts on its drift badge, for the same reason.
          url: status === "live" ? ((r["url"] as string | null) ?? null) : null,
        };
      }),
    ];

    return entries
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : -1))
      .slice(0, cap);
  }

  /**
   * §9's tool and MCP usage rollup. ONE statement.
   *
   * `reviewedTools` IS A PARAMETER RATHER THAN A QUERY, because the reviewed vocabulary is not in
   * the database at all: it is `runtime/tool_templates/catalog.json`, which the connector layer
   * already loads and which is a property of the INSTALL rather than of the tenant. A store method
   * that read a file to answer a question about rows would be a store method with a filesystem
   * dependency, and the caller already holds the catalogue.
   *
   * THE THREE ORIGINS ARE DECIDED HERE AND NOT BY THE STEP. A step records a tool's NAME and
   * nothing about where it came from, so provenance is a lookup: a name in the MCP registry is an
   * MCP tool, a name in the catalogue is a reviewed connector, and anything else is bespoke code a
   * model wrote for one agent. A tool granted by an MCP server AND present in the catalogue would
   * be a name collision the manifest builder already refuses, so MCP is checked first and the
   * ambiguity cannot arrive here.
   *
   * THE TRUNCATION MARKER IS A STRING THE PYTHON RUNTIME WRITES. `mcp_bridge.sanitize` appends
   * "[truncated by Jaroku: N more characters were returned]" when a result passes the size cap, and
   * that sentence is the only record that it happened — there is no column and, per §5.1, no new one
   * is being added. Matching it is a cross-language coupling and it is named as such: if the phrase
   * changes there, this rate silently becomes zero, which is why `test:activity-tools` asserts the
   * marker against the value the runtime actually produces rather than against a copy of it.
   */
  async toolUsage(
    ctx: TenantContext,
    w: Window,
    reviewedTools: readonly string[] = [],
  ): Promise<ToolUsage> {
    const rows = await this.q(ctx).all<Record<string, unknown>>(
      `SELECT s.name                                                        AS name,
              t.server_id                                                   AS server_id,
              COALESCE(t.impact_override, t.impact)                         AS impact,
              COUNT(*)                                                      AS calls,
              COUNT(CASE WHEN s.error IS NOT NULL THEN 1 END)               AS failures,
              COUNT(CASE WHEN s.error LIKE ? THEN 1 END)                    AS refused,
              COUNT(CASE WHEN s.error LIKE ? THEN 1 END)                    AS denied,
              COUNT(CASE WHEN s.error LIKE ? THEN 1 END)                    AS timed_out,
              COUNT(CASE WHEN s.output LIKE ? THEN 1 END)                   AS truncated
         FROM steps s
         LEFT JOIN mcp_tools t ON t.workspace_id = s.workspace_id AND t.name = s.name
        WHERE s.workspace_id = ? AND s.type = 'tool_call'
          AND s.started_at >= ? AND s.started_at < ?
        GROUP BY s.name, t.server_id, COALESCE(t.impact_override, t.impact)`,
      [
        `%${NOT_APPROVED}%`,
        "%you declined this call%",
        "%nobody confirmed it within%",
        `%${TRUNCATION_MARKER}%`,
        ...bounds(ctx, w),
      ],
    );

    const reviewed = new Set(reviewedTools);
    const tools: ToolRow[] = [];
    const totals = {
      highImpactCalls: 0, approved: 0, denied: 0, timedOut: 0,
      truncatedCalls: 0, totalCalls: 0, reviewedFailures: 0,
    };

    for (const r of rows) {
      const name = String(r["name"] ?? "");
      const serverId = (r["server_id"] as string | null) ?? null;
      const impactRaw = (r["impact"] as string | null) ?? null;
      const impact = impactRaw === "high" ? "high" : impactRaw === "low" ? "low" : null;
      const origin: ToolRow["origin"] = serverId ? "mcp" : reviewed.has(name) ? "reviewed" : "bespoke";
      const calls = asInt(r["calls"]);
      const failures = asInt(r["failures"]);
      const denied = asInt(r["denied"]);
      const timedOut = asInt(r["timed_out"]);
      const refused = asInt(r["refused"]);
      const truncated = asInt(r["truncated"]);

      tools.push({ name, origin, serverId, impact, calls, failures, truncated });

      totals.totalCalls += calls;
      totals.truncatedCalls += truncated;
      totals.denied += denied;
      totals.timedOut += timedOut;
      if (impact === "high") {
        totals.highImpactCalls += calls;
        // WHAT WAS APPROVED IS WHAT WAS NOT REFUSED. There is no positive record of an approval —
        // the gate returns silently — so approvals are the high-impact calls that ran. `refused`
        // rather than `denied + timedOut`, because the runtime has a third refusal sentence for an
        // answer it could not read, and a rate that ignored it would count a garbled verdict as
        // consent.
        totals.approved += Math.max(0, calls - refused);
      }
      if (origin === "reviewed") totals.reviewedFailures += failures;
    }

    return {
      tools: tools.sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name)),
      ...totals,
    };
  }

  /**
   * §10's Team pulse. ONE statement, and it does not move with the number of members.
   *
   * A UNION OF FOUR COUNTS RATHER THAN FOUR QUERIES, and rather than a join. The four facts live in
   * two tables with no relationship to each other, so a join would be a cross product; four queries
   * would be four scans to fill one card. The union produces one row per (member, kind) and the
   * fold below turns that into one row per member.
   *
   * MEMBERS WITH NOTHING TO SHOW ARE ABSENT, exactly as the leaderboard omits agents that did not
   * run. §3.5 again: a row of zeros beside somebody's name is a statement about that person, and
   * "did not use Jaroku this week" is not what a contribution card is for.
   */
  async teamPulse(ctx: TenantContext, w: Window): Promise<MemberPulse[]> {
    const rows = await this.q(ctx).all<Record<string, unknown>>(
      `SELECT actor AS actor, kind AS kind, COUNT(*) AS n FROM (
         SELECT created_by AS actor, 'agent' AS kind
           FROM agents
          WHERE workspace_id = ? AND created_at >= ? AND created_at < ?
            AND created_by IS NOT NULL AND deleted_at IS NULL
         UNION ALL
         SELECT v.created_by AS actor,
                CASE WHEN v.source = 'edit' THEN 'edit' ELSE 'version' END AS kind
           FROM agent_versions v
           JOIN agents a ON a.id = v.agent_id
          WHERE a.workspace_id = ? AND v.created_at >= ? AND v.created_at < ?
            AND v.created_by IS NOT NULL
         UNION ALL
         SELECT created_by AS actor, 'thread' AS kind
           FROM threads
          WHERE workspace_id = ? AND created_at >= ? AND created_at < ?
            AND created_by IS NOT NULL
       ) contributions
       GROUP BY actor, kind`,
      [...bounds(ctx, w), ...bounds(ctx, w), ...bounds(ctx, w)],
    );

    const byUser = new Map<string, MemberPulse>();
    for (const r of rows) {
      const userId = String(r["actor"] ?? "");
      if (!userId) continue;
      const at = byUser.get(userId) ?? {
        userId, agentsCreated: 0, editsApplied: 0, versionsPublished: 0, threadsStarted: 0,
      };
      const n = asInt(r["n"]);
      const kind = String(r["kind"]);
      if (kind === "agent") at.agentsCreated += n;
      else if (kind === "edit") at.editsApplied += n;
      else if (kind === "version") at.versionsPublished += n;
      else if (kind === "thread") at.threadsStarted += n;
      byUser.set(userId, at);
    }

    return [...byUser.values()].sort(
      (a, b) =>
        b.agentsCreated + b.editsApplied + b.versionsPublished + b.threadsStarted -
          (a.agentsCreated + a.editsApplied + a.versionsPublished + a.threadsStarted) ||
        a.userId.localeCompare(b.userId),
    );
  }

  /**
   * §10's personal summary. TWO statements plus the shared directory.
   *
   * THE STREAK IS COMPUTED FROM DAY KEYS, in the same `substr` grain the pulse uses and for the same
   * dialect reason. What comes back is at most 366 rows — one per day the workspace ran anything —
   * and the consecutive-day walk happens here, where it can be read.
   *
   * "TODAY" IS THE WINDOW'S END, not the process's clock. Every figure on this page describes one
   * window; a streak measured against `new Date()` would be the only number on the screen answering
   * a slightly different question, and would change under a client that had the page open at
   * midnight while nothing else did.
   */
  async personalSummary(ctx: TenantContext, w: Window): Promise<PersonalSummary> {
    const q = this.q(ctx);

    const byAgent = await q.all<Record<string, unknown>>(
      `SELECT agent_id, COUNT(*) AS runs
         FROM runs
        WHERE workspace_id = ? AND started_at >= ? AND started_at < ?
        GROUP BY agent_id
        ORDER BY COUNT(*) DESC, agent_id ASC
        LIMIT 1`,
      bounds(ctx, w),
    );

    const days = await q.all<Record<string, unknown>>(
      `SELECT DISTINCT SUBSTR(started_at, 1, 10) AS day
         FROM runs
        WHERE workspace_id = ? AND started_at >= ? AND started_at < ?`,
      bounds(ctx, w),
    );

    const spend = await this.spend(ctx, w);
    const health = await this.runHealth(ctx, w);
    const directory = await this.agentDirectory(ctx);

    const active = new Set(days.map((r) => String(r["day"])));
    let streak = 0;
    // Walk back from the window's last day. `toISOString().slice(0, 10)` is the same key `SUBSTR`
    // produced, which is only true because both are UTC — the reason every timestamp in this
    // schema is stored as an ISO-8601 UTC string in the first place.
    for (let day = new Date(Date.parse(w.to) - 1); ; day = new Date(day.getTime() - 86_400_000)) {
      const key = day.toISOString().slice(0, 10);
      if (!active.has(key)) break;
      streak++;
      if (Date.parse(key) < Date.parse(w.from.slice(0, 10))) break;
    }

    const top = byAgent[0];
    const topSlug = top ? String(top["agent_id"] ?? "") : "";
    return {
      mostActiveAgent: top
        ? { agentId: topSlug, name: directory.get(topSlug)?.name ?? topSlug, runs: asInt(top["runs"]) }
        : null,
      runs: health.runs,
      usd: spend.usd,
      costKnown: spend.costKnown,
      streakDays: streak,
    };
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
