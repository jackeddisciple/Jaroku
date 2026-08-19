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
import type { Window } from "./range.ts";

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
