// §5's unified event feed: nine sources, one chronology, one keyset page at a time.
//
// A UNION RATHER THAN A TABLE, and that is the decision this file exists to make and defend. The
// obvious alternative is an `activity_events` table every writer in the control plane appends to —
// and it is the wrong one twice over. It would be a SECOND COPY of facts that already exist in
// `runs`, `agent_versions`, `deployments`, `eval_runs`, `steps` and `audit_log`, and a second copy
// is the one that goes stale: a run cancelled, a version undone or a deploy superseded after the
// fact would leave a feed row describing a world that has moved on. And it would be a write on
// every hot path in the system to serve a read nobody has opened yet.
//
// So the feed is DERIVED, every time, from the rows that are already the truth. What that costs is
// a union of nine bounded subqueries; what it buys is a feed that cannot disagree with the trace it
// links to.
//
// NOTHING NEW IS RECORDED FOR THIS TAB. `schema/events.md` is untouched, no table gains a column,
// and no code path gains a write. The one row that looked as though it needed one — §5's "MCP
// confirmations resolved" — turned out not to: a high-impact MCP call IS its own record, because
// the confirmation gate raises inside the tool and the refusal lands on the step as an error, in a
// sentence `mcp_bridge.py` writes and this file recognises. See `MCP_CONFIRM`.
//
// KEYSET, NOT OFFSET (§5.2). This feed is written to constantly — every run, every step, every
// deploy — and an offset page under concurrent inserts silently repeats rows and silently skips
// them. A cursor of `(at, id)` is stable under any amount of writing: it says "everything strictly
// older than this row", which stays true however many rows arrive above it.

import type { Dialect } from "../db/db.ts";
import type { TenantContext } from "../db/tenant.ts";
import { TraceStore } from "../store.ts";
import type { Window } from "./range.ts";

/**
 * What kinds of thing appear in the feed. §5's list, plus the two splits it implies.
 *
 * A BRANCH IS ITS OWN KIND rather than a run with a flag, because §4 makes it a first-class run and
 * §5's filter is by kind — somebody looking for "what did we branch this week" is asking a different
 * question from "what ran". They are two rows of the same table, told apart by `parent_run_id`.
 *
 * AN EDIT AND ITS UNDO ARE TWO KINDS AND TWO ROWS, from ONE `agent_versions` row. A version is
 * published at `created_at` and taken back at `undone_at`, sometimes days apart, and the feed has to
 * place each at its own moment — which is what migration 051's partial index on `undone_at` is for.
 */
export const FEED_KINDS = [
  "run",
  "branch",
  "version",
  "edit",
  "edit_undone",
  "deploy",
  "eval",
  "mcp_confirm",
  "member",
] as const;
export type FeedKind = (typeof FEED_KINDS)[number];

export function isFeedKind(v: unknown): v is FeedKind {
  return typeof v === "string" && (FEED_KINDS as readonly string[]).includes(v);
}

/** Where a row navigates to. §5: "Rows navigate. Navigation only. No row has an action." */
export type FeedTarget = "run" | "version" | "deploy" | "eval" | "step" | "workspace";

/**
 * One row of the feed, in the shape `ActionRow` renders.
 *
 * ICON, VERB, OBJECT, TRAILING — the shared narrative line this app has used since v0.2.2, which is
 * exactly what a feed row is. §5 asks for the existing vocabulary to be reused so a feed row reads
 * "Called get_time" in the same voice the trace already uses, so the server sends the PIECES and
 * the client assembles the sentence from `lib/actionIcons.tsx`. A server that sent a formatted
 * sentence would be a second place the app's verbs are decided.
 */
export interface FeedRow {
  /**
   * Stable and unique across all nine sources: `${kind}:${sourceId}`.
   *
   * COMPOSITE BECAUSE THE SOURCES SHARE NO ID SPACE, and the keyset needs a total order. Two rows at
   * the identical millisecond — a run and the deploy that triggered it, which is common — are
   * separated by this, so a page boundary landing between them can never repeat or skip one.
   */
  id: string;
  at: string;
  kind: FeedKind;
  /** The agent this is about, as a slug. Null for a row that is about the workspace. */
  agentId: string | null;
  /** Who did it, where the row records that. See `ACTOR_SOURCES` for why most rows do not. */
  actorUserId: string | null;
  /** The thing acted on: a tool name, a deploy target, a dataset. Bounded, never prose. */
  object: string | null;
  /** How it went, where the row has an outcome at all. */
  outcome: "ok" | "error" | "refused" | "running" | null;
  /** A number the row's trailing column shows: a version, a token count, a step count. */
  num: number | null;
  targetType: FeedTarget;
  targetId: string;
}

/** One page, plus the cursor that asks for the next. */
export interface FeedPage {
  rows: FeedRow[];
  /** Pass back as `cursor` for the next page. Null when this page reached the end. */
  next: FeedCursor | null;
}

/** The keyset. Both halves are needed — see `FeedRow.id`. */
export interface FeedCursor {
  at: string;
  id: string;
}

/** What a client may narrow the feed by. §5: by kind, by agent, by member. */
export interface FeedFilters {
  kinds?: readonly FeedKind[];
  agentId?: string | null;
  actorUserId?: string | null;
}

/** How many rows one page carries by default, and the most a client may ask for. */
export const FEED_PAGE_DEFAULT = 50;
export const FEED_PAGE_MAX = 200;

/**
 * The sentence `mcp_bridge.py` raises when a high-impact call is not approved.
 *
 * MATCHED RATHER THAN RECORDED, and this is the whole reason §5's confirmation row needs no new
 * write anywhere. The gate raises INSIDE the tool, so the refusal lands on the step as an error in
 * a sentence the runtime already writes — "…was not approved: you declined this call." for a denial
 * and "…was not approved: nobody confirmed it within 120s…" for a timeout. §9 treats both as a
 * refusal, "which is already how the runtime treats them", so the feed does not distinguish them
 * either; the tool rollup, which reports the two rates separately, does.
 *
 * A PREFIX MATCH RATHER THAN THE WHOLE SENTENCE, because the timeout's text carries a number that
 * is configurable and the "unreadable verdict" branch quotes back whatever arrived. All three
 * begin the same way, and that beginning is the runtime's own phrase for "this was refused".
 */
export const NOT_APPROVED = "was not approved";

/**
 * One source of feed rows, as SQL that produces the union's column list.
 *
 * A TABLE OF SOURCES RATHER THAN ONE ENORMOUS QUERY STRING, because the filters are applied by
 * INCLUDING OR EXCLUDING BRANCHES rather than by a `WHERE kind IN (…)` on the outside — which is
 * both faster and the only way a per-branch `LIMIT` can be correct. A branch that is filtered out
 * on the outside still costs its share of the page, and the page then comes back short for no
 * reason a reader could see.
 */
interface FeedSource {
  kind: FeedKind;
  /** The SELECT, with `?` for: the keyset triple, the window pair, and any filter values. */
  sql: (opts: { agentFilter: boolean; actorFilter: boolean }) => string;
  /** Whether this source can answer an agent filter at all. */
  hasAgent: boolean;
  /** Whether this source records WHO did it. See the note on `ACTOR_SOURCES`. */
  hasActor: boolean;
  /** The bound values, in the order the SQL's `?` appear, after the standard window+keyset ones. */
  extra?: readonly unknown[];
}

/**
 * The column list every source produces, in order. Written once so a source cannot drift from it.
 *
 * `CAST(NULL AS …)` EVERYWHERE A BRANCH HAS NO VALUE. Postgres resolves a UNION's column types
 * across every branch and refuses a column that is NULL in all of them ("could not determine data
 * type"); SQLite is happy either way. Casting explicitly means the union's types are decided by
 * this file rather than by which branch happens to be listed first.
 */
const COLUMNS = "feed_id, at, kind, agent_id, actor_user_id, object, outcome, num, target_type, target_id";

/**
 * WHICH SOURCES RECORD AN ACTOR, and — more usefully — which do not.
 *
 * `agent_versions` carries `created_by` and `audit_log` carries `actor_user_id`. `runs`,
 * `deployments`, `eval_runs` and `steps` carry NOBODY, and that is a fact about the schema rather
 * than an omission here: `runs` is part of the frozen event schema, which this tab does not touch,
 * and the other three predate workspaces having more than one member.
 *
 * SO §5'S MEMBER FILTER NARROWS TO THE SOURCES THAT CAN ANSWER IT, and the ones that cannot are
 * omitted from the page rather than included unattributed. Including them would mean filtering by
 * "Ada" and getting back every run in the workspace, which is worse than a short list: it looks
 * like an answer. This is recorded plainly in the release notes as a gap rather than papered over.
 */
export const ACTOR_SOURCES: readonly FeedKind[] = ["version", "edit", "edit_undone", "member"];

/**
 * The nine sources.
 *
 * EVERY ONE IS BOUNDED BY THE WINDOW AND BY THE KEYSET, and both bounds are inside the branch
 * rather than outside the union. A branch that fetched its whole history and let the outer query
 * sort it would read a year of runs to serve fifty rows.
 */
function sources(w: Window, dialect: Dialect): FeedSource[] {
  const key = (col: string, id: string): string =>
    // The keyset, as one predicate per branch: strictly older, or the same instant and a lower id.
    `(${col} < ? OR (${col} = ? AND ${id} < ?))`;
  const bound = (col: string): string => `${col} >= ? AND ${col} < ?`;

  // THE `at` COLUMN OF EVERY BRANCH HAS TO BE THE SAME TYPE, and on Postgres it was not.
  //
  // Nine sources, and the schema genuinely disagrees with itself about what a moment is: `runs`,
  // `steps` and `eval_runs` are the frozen trace schema and carry ISO-8601 `text`, while
  // `agent_versions`, `deployments` and `audit_log` were written later and carry `timestamptz`.
  // A UNION across both is "UNION types text and timestamp with time zone cannot be matched" —
  // the whole feed, unreachable on the production driver, while SQLite ran it happily because
  // there a timestamp IS text. The file header above already argued this exact point about the
  // NULL columns and then left `at` out of it.
  //
  // TEXT IS THE COMMON TYPE, not timestamptz, and that direction is forced rather than chosen:
  // `runs.started_at` is the partition key of `steps` and cannot move, so the frozen half wins
  // and the newer half is rendered to match. `to_char` reproduces exactly what SQLite stores,
  // which matters because the value goes out to the client as-is and comes back as a cursor.
  //
  // ONLY THE SELECT LIST IS WRAPPED. `bound` and `key` keep the raw column, so the window and the
  // keyset are still index-visible predicates rather than comparisons against a computed string.
  const iso = (col: string): string =>
    dialect === "postgres"
      ? `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
      : col;
  void w;

  return [
    {
      kind: "run",
      hasAgent: true,
      hasActor: false,
      sql: ({ agentFilter }) => `
        SELECT 'run:' || r.id AS feed_id, r.started_at AS at, 'run' AS kind,
               r.agent_id AS agent_id, CAST(NULL AS TEXT) AS actor_user_id,
               r.model AS object,
               CASE WHEN r.status = 'completed' THEN 'ok'
                    WHEN r.status = 'error'     THEN 'error'
                    WHEN r.status = 'running'   THEN 'running'
                    ELSE 'running' END AS outcome,
               r.tokens AS num, 'run' AS target_type, r.id AS target_id
          FROM runs r
         WHERE r.workspace_id = ? AND ${bound("r.started_at")}
           AND r.parent_run_id IS NULL
           AND ${key("r.started_at", "('run:' || r.id)")}
           ${agentFilter ? "AND r.agent_id = ?" : ""}`,
    },
    {
      kind: "branch",
      hasAgent: true,
      hasActor: false,
      sql: ({ agentFilter }) => `
        SELECT 'branch:' || r.id AS feed_id, r.started_at AS at, 'branch' AS kind,
               r.agent_id AS agent_id, CAST(NULL AS TEXT) AS actor_user_id,
               r.parent_run_id AS object,
               CASE WHEN r.status = 'completed' THEN 'ok'
                    WHEN r.status = 'error'     THEN 'error'
                    ELSE 'running' END AS outcome,
               r.branch_from_seq AS num, 'run' AS target_type, r.id AS target_id
          FROM runs r
         WHERE r.workspace_id = ? AND ${bound("r.started_at")}
           AND r.parent_run_id IS NOT NULL
           AND ${key("r.started_at", "('branch:' || r.id)")}
           ${agentFilter ? "AND r.agent_id = ?" : ""}`,
    },
    {
      // A version somebody PUBLISHED: a generation, an import, or a build a deploy produced.
      // `agent_versions` has no `workspace_id` of its own — it hangs off `agents` — so the scope is
      // the join, exactly as every read of it in `AgentRepository` is scoped.
      kind: "version",
      hasAgent: true,
      hasActor: true,
      sql: ({ agentFilter, actorFilter }) => `
        SELECT 'version:' || v.id AS feed_id, ${iso("v.created_at")} AS at, 'version' AS kind,
               a.slug AS agent_id, v.created_by AS actor_user_id,
               v.source AS object, CAST('ok' AS TEXT) AS outcome,
               v.version AS num, 'version' AS target_type, v.id AS target_id
          FROM agent_versions v
          JOIN agents a ON a.id = v.agent_id
         WHERE a.workspace_id = ? AND ${bound("v.created_at")}
           AND v.source <> 'edit'
           AND ${key("v.created_at", "('version:' || v.id)")}
           ${agentFilter ? "AND a.slug = ?" : ""}
           ${actorFilter ? "AND v.created_by = ?" : ""}`,
    },
    {
      kind: "edit",
      hasAgent: true,
      hasActor: true,
      sql: ({ agentFilter, actorFilter }) => `
        SELECT 'edit:' || v.id AS feed_id, ${iso("v.created_at")} AS at, 'edit' AS kind,
               a.slug AS agent_id, v.created_by AS actor_user_id,
               v.instruction AS object, CAST('ok' AS TEXT) AS outcome,
               v.version AS num, 'version' AS target_type, v.id AS target_id
          FROM agent_versions v
          JOIN agents a ON a.id = v.agent_id
         WHERE a.workspace_id = ? AND ${bound("v.created_at")}
           AND v.source = 'edit'
           AND ${key("v.created_at", "('edit:' || v.id)")}
           ${agentFilter ? "AND a.slug = ?" : ""}
           ${actorFilter ? "AND v.created_by = ?" : ""}`,
    },
    {
      // THE SAME ROW, AT A DIFFERENT MOMENT. See the note on FEED_KINDS.
      kind: "edit_undone",
      hasAgent: true,
      hasActor: true,
      sql: ({ agentFilter, actorFilter }) => `
        SELECT 'edit_undone:' || v.id AS feed_id, ${iso("v.undone_at")} AS at, 'edit_undone' AS kind,
               a.slug AS agent_id, v.created_by AS actor_user_id,
               v.instruction AS object, CAST('ok' AS TEXT) AS outcome,
               v.version AS num, 'version' AS target_type, v.id AS target_id
          FROM agent_versions v
          JOIN agents a ON a.id = v.agent_id
         WHERE a.workspace_id = ? AND v.undone_at IS NOT NULL AND ${bound("v.undone_at")}
           AND ${key("v.undone_at", "('edit_undone:' || v.id)")}
           ${agentFilter ? "AND a.slug = ?" : ""}
           ${actorFilter ? "AND v.created_by = ?" : ""}`,
    },
    {
      // INCLUDING THE FAILURES, which §8 spells out for the release timeline and which is just as
      // true here: "a release log that only shows successes is a marketing page".
      kind: "deploy",
      hasAgent: true,
      hasActor: false,
      sql: ({ agentFilter }) => `
        SELECT 'deploy:' || d.id AS feed_id, d.created_at AS at, 'deploy' AS kind,
               d.agent_id AS agent_id, CAST(NULL AS TEXT) AS actor_user_id,
               d.target AS object,
               CASE WHEN d.status = 'live'   THEN 'ok'
                    WHEN d.status = 'failed' THEN 'error'
                    ELSE 'running' END AS outcome,
               d.version AS num, 'deploy' AS target_type, d.id AS target_id
          FROM deployments d
         WHERE d.workspace_id = ? AND ${bound("d.created_at")}
           AND ${key("d.created_at", "('deploy:' || d.id)")}
           ${agentFilter ? "AND d.agent_id = ?" : ""}`,
    },
    {
      kind: "eval",
      hasAgent: true,
      hasActor: false,
      sql: ({ agentFilter }) => `
        SELECT 'eval:' || e.id AS feed_id, e.started_at AS at, 'eval' AS kind,
               e.agent_id AS agent_id, CAST(NULL AS TEXT) AS actor_user_id,
               e.dataset_id AS object,
               CASE WHEN e.status = 'completed' THEN 'ok'
                    WHEN e.status = 'failed'    THEN 'error'
                    WHEN e.status = 'cancelled' THEN 'refused'
                    ELSE 'running' END AS outcome,
               CAST(NULL AS INTEGER) AS num, 'eval' AS target_type, e.id AS target_id
          FROM eval_runs e
         WHERE e.workspace_id = ? AND ${bound("e.started_at")}
           AND ${key("e.started_at", "('eval:' || e.id)")}
           ${agentFilter ? "AND e.agent_id = ?" : ""}`,
    },
    {
      // §5's "MCP confirmations resolved", read off the step the confirmation gated — see
      // `NOT_APPROVED`. The join to `mcp_tools` is what makes it high-impact calls only: an
      // ordinary tool call is trace noise on this surface, and the whole point of the row is that
      // somebody was asked to approve something.
      //
      // `impact_override` WINS WHERE IT IS SET, which is the same precedence the registry applies
      // everywhere else — a workspace that raised a tool's classification means it.
      kind: "mcp_confirm",
      hasAgent: true,
      hasActor: false,
      extra: [`%${NOT_APPROVED}%`],
      sql: ({ agentFilter }) => `
        SELECT 'mcp_confirm:' || s.id AS feed_id, s.started_at AS at, 'mcp_confirm' AS kind,
               r.agent_id AS agent_id, CAST(NULL AS TEXT) AS actor_user_id,
               s.name AS object,
               CASE WHEN s.error LIKE ? THEN 'refused' ELSE 'ok' END AS outcome,
               CAST(NULL AS INTEGER) AS num, 'step' AS target_type, s.id AS target_id
          FROM steps s
          JOIN runs r ON r.id = s.run_id AND r.workspace_id = s.workspace_id
          JOIN mcp_tools t ON t.workspace_id = s.workspace_id AND t.name = s.name
                          AND COALESCE(t.impact_override, t.impact) = 'high'
         WHERE s.workspace_id = ? AND s.type = 'tool_call' AND ${bound("s.started_at")}
           AND ${key("s.started_at", "('mcp_confirm:' || s.id)")}
           ${agentFilter ? "AND r.agent_id = ?" : ""}`,
    },
    {
      // Members joining, leaving and changing role. The one source with no agent at all, which is
      // why it is dropped when an agent filter is set rather than answering it with nulls.
      kind: "member",
      hasAgent: false,
      hasActor: true,
      sql: ({ actorFilter }) => `
        SELECT 'member:' || CAST(l.id AS TEXT) AS feed_id, ${iso("l.created_at")} AS at, 'member' AS kind,
               CAST(NULL AS TEXT) AS agent_id, l.actor_user_id AS actor_user_id,
               l.action AS object, CAST('ok' AS TEXT) AS outcome,
               CAST(NULL AS INTEGER) AS num, 'workspace' AS target_type,
               COALESCE(l.target_id, '') AS target_id
          FROM audit_log l
         WHERE l.workspace_id = ? AND ${bound("l.created_at")}
           AND (l.action LIKE 'member.%' OR l.action LIKE 'invite.%')
           AND ${key("l.created_at", "('member:' || CAST(l.id AS TEXT))")}
           ${actorFilter ? "AND l.actor_user_id = ?" : ""}`,
    },
  ];
}

/**
 * Build the union and its bound parameters for one page.
 *
 * SEPARATE FROM THE STORE so it can be read and reasoned about without a database, and so the
 * parameter ORDER — which is the thing that goes wrong in a query assembled from nine pieces — is
 * decided in one loop rather than at nine call sites.
 */
export function feedQuery(
  ctx: TenantContext,
  w: Window,
  filters: FeedFilters,
  cursor: FeedCursor | null,
  limit: number,
  dialect: Dialect,
): { sql: string; params: unknown[] } | null {
  const wanted = filters.kinds?.length ? new Set(filters.kinds) : null;
  const agentFilter = typeof filters.agentId === "string" && filters.agentId.length > 0;
  const actorFilter = typeof filters.actorUserId === "string" && filters.actorUserId.length > 0;

  // A cursor of "nothing yet" is the newest possible row: a timestamp no real row can exceed and an
  // id above every composite. Expressed as values rather than as a branch, so the SQL is identical
  // for the first page and the fiftieth — one shape to get right, not two.
  const at = cursor?.at ?? "9999-12-31T23:59:59.999Z";
  const id = cursor?.id ?? "￿";

  const parts: string[] = [];
  const params: unknown[] = [];
  for (const source of sources(w, dialect)) {
    if (wanted && !wanted.has(source.kind)) continue;
    if (agentFilter && !source.hasAgent) continue;
    if (actorFilter && !source.hasActor) continue;

    parts.push(`SELECT ${COLUMNS} FROM (${source.sql({ agentFilter, actorFilter })}) AS ${source.kind}_rows`);
    // The order below IS the order the `?` appear in each branch: the source's own extras first
    // (only `mcp_confirm` has one, and it sits in the SELECT list), then the workspace, the window
    // pair, the keyset triple, and last the filters.
    params.push(...(source.extra ?? []));
    params.push(ctx.workspaceId, w.from, w.to, at, at, id);
    if (agentFilter) params.push(filters.agentId);
    if (actorFilter) params.push(filters.actorUserId);
  }

  // Every source was filtered out, which is a real answer and not an error: "deploys by Ada" in a
  // workspace where deploys record no actor is an empty page, and building a `SELECT` with no
  // branches would be a syntax error dressed up as one.
  if (parts.length === 0) return null;

  // ONE MORE THAN ASKED FOR, so `next` can be decided by whether the extra row exists rather than
  // by a second COUNT over the same union. A page that reported "there is more" by counting would
  // be a second scan to answer a question the first one already knows.
  return {
    sql: `${parts.join("\n UNION ALL\n")}\n ORDER BY at DESC, feed_id DESC LIMIT ?`,
    params: [...params, limit + 1],
  };
}

/** Clamp a client's page size. See FEED_PAGE_MAX. */
export function pageSize(requested: number | undefined): number {
  if (!Number.isFinite(requested ?? NaN)) return FEED_PAGE_DEFAULT;
  return Math.max(1, Math.min(FEED_PAGE_MAX, Math.trunc(requested as number)));
}

/**
 * The marker `mcp_bridge.sanitize` appends when a tool's result hits the size cap.
 *
 * A CROSS-LANGUAGE COUPLING, NAMED AS ONE. §9 asks for a truncation rate and nothing records
 * truncation in a column — the Python runtime writes this sentence into the result the model reads,
 * and that sentence is the whole of the evidence. §5.1 freezes the schema, so no column is being
 * added for it, which leaves matching the string.
 *
 * The risk is stated rather than hidden: if the phrase changes on the Python side, this rate
 * silently becomes zero. `test:activity-tools` therefore asserts the marker against the value the
 * runtime file actually contains rather than against a copy of it here, so the two cannot drift
 * without a suite going red.
 */
export const TRUNCATION_MARKER = "[truncated by Jaroku:";

/** Whether a step's error is the confirmation gate's refusal. Exported for the tool rollup. */
export function isConfirmationRefusal(error: string | null | undefined): boolean {
  return typeof error === "string" && error.includes(NOT_APPROVED);
}

/** The two refusals the runtime distinguishes, for §9's approve / deny / timeout split. */
export function refusalKind(error: string): "denied" | "timeout" | "other" {
  if (error.includes("you declined this call")) return "denied";
  if (error.includes("nobody confirmed it within")) return "timeout";
  return "other";
}

/** Re-exported so the store's interrupted-run split and this file agree on one source. */
export const RUN_SENTINELS = {
  interrupted: TraceStore.INTERRUPTED_BY_RESTART,
  cancelled: TraceStore.CANCELLED_BY_USER,
} as const;
