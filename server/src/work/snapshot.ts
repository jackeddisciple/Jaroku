// What the Cockpit is rendered from, and what the SERVER decides rather than the client.
//
// THE LINE IS THE SAME ONE THE INBOX DREW. What the server decides is which jobs exist, what state
// each is in, what it cost, who asked for it and what may be done about it — because every one of
// those is a FACT. What a card looks like, which glyph a status wears, how a duration is spelled
// and whether a row is amber are the client's, because every one of those is a rendering.
//
// TWO PAYLOADS, NOT ONE, and that is §5's own list of events rather than a convenience: `snapshot`
// is the work list, and `fleet` is the strip across the top. They change on different clocks — the
// list moves every time a job does, the strip moves when a deployment does — and one combined
// payload would mean every job transition re-sent the fleet, which is the "a transition is a delta,
// not a board" rule broken at a different grain.
//
// THE FLEET'S ONE SENTENCE IS ASSEMBLED HERE, not on the client, and §9 calls it the hardest design
// in the feature: "Not 'Running'. A card reads: name, connection state, and one sentence of real
// state." The pieces of that sentence — how many are running, how many are waiting, how many jobs
// today, what today cost — are facts, so they travel as numbers and the client writes the sentence.
// What must NOT happen is the client deriving them: a count assembled in a browser out of a page of
// rows would be a count of the page rather than of the workspace.
//
// EVERY FIGURE IS BATCHED. §16 asks that forty agents cost what one costs, and the reads here are:
// one page of items, one grouped cost query over their runs, one grouped live-count query, one
// grouped today query, one agent list and one member list. None of them is per row and none is per
// agent. `test:work-channel` asserts the statement count is flat.

import type { Queryable } from "../db/db.ts";
import type { TenantContext } from "../db/tenant.ts";
import type { Deployment } from "../deployStore.ts";
import type { HealthState } from "../deployOps.ts";
import { isPriced as isPricedModel, round8 } from "../pricing.ts";
import { costsForItems, type WorkCost } from "./cost.ts";
import { preview } from "./payload.ts";
import type { ListWorkFilters, WorkItem, WorkStatus, WorkStore } from "./workStore.ts";

/**
 * A deployment's credential state, as §9's four.
 *
 * `unconnected` AND `unauthorised` ARE DIFFERENT AND BOTH OFFER RECONNECT, which looks like a
 * distinction without a difference and is not: the first is an agent deployed before Jaroku kept a
 * token, and the second is one whose token was rotated on Railway out from under it. The button is
 * the same; the sentence beside it is not, and an operator who has just rotated a token needs to be
 * told that is what happened rather than that their agent was never connected.
 *
 * `public` IS A WARNING STATE AND NOT A HEALTHY ONE — §9 says so in as many words. `JAROKU_SERVE_
 * PUBLIC=1` means anyone with the URL can spend the workspace's provider key, and rendering it as
 * "fine, no credential needed" would be the product agreeing with the most expensive misconfiguration
 * it can have.
 */
export type FleetConnection = "connected" | "unconnected" | "unauthorised" | "public";

/** One row of the work list. */
export interface WorkItemView {
  id: string;
  agent_id: string;
  /** Resolved here so a row is not a second lookup in the client. Null for a deleted agent. */
  agent_name: string | null;
  deployment_id: string;
  /** The trace. Null only for a job that never reached a container. */
  run_id: string | null;
  created_by: string;
  /** Who asked. Null when the person has left the workspace — §4's actor is never null in the row. */
  created_by_name: string | null;
  /** One line of what was asked. The full text is on `loadWorkItem`. */
  input_preview: string;
  status: WorkStatus;
  /** One line of what came back, on a job that succeeded. */
  output_preview: string | null;
  error: string | null;
  failure_kind: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  /** Null means UNKNOWN, rendered `—`. Never a zero standing in for it — §11.1. */
  cost_usd: number | null;
  tokens: number | null;
  duration_ms: number | null;
  /** False when the cost is a floor rather than a total. The card says so. */
  cost_complete: boolean;
}

/** One job in full, for the detail panel. The same shape plus what a row does not carry. */
export interface WorkItemDetailView extends WorkItemView {
  input: string;
  output: string | null;
}

/** One compact card in the strip across the top. */
export interface FleetCardView {
  agent_id: string;
  agent_name: string;
  deployment_id: string;
  url: string | null;
  /** The version this deployment built from, or null for a row that predates migration 041. */
  version: number | null;
  /**
   * What a job dispatched to this agent will actually run on.
   *
   * ON THE CARD RATHER THAN LOOKED UP AT DISPATCH TIME, because §9's pre-flight gate has to name
   * them BEFORE the button is pressed — "one line naming the agent, the deployment version, and
   * the provider and model it will run on". A gate that fetched them would be a gate that
   * appears empty for a moment, which is a confirmation dialog somebody presses through.
   *
   * THE DEPLOYMENT'S, NOT THE AGENT'S CURRENT DEFAULT. A container was built against one
   * provider and one model and cannot be told to use another; showing what the agent would use
   * if redeployed would be naming a price nobody is about to pay.
   */
  provider: string;
  model: string;
  connection: FleetConnection;
  /** What is happening right now, for §9's one sentence. */
  running: number;
  waiting: number;
  queued: number;
  /** Today, so an idle card still says something real. */
  jobs_today: number;
  /**
   * When this agent was last given anything, at all — the UI specification's §5 third clause.
   *
   * NOT BOUNDED BY TODAY, which is the whole reason it is a second field rather than a corner of
   * `jobs_today`. "Last job 4m ago" and "last job 3d ago" are both answers a settled card can give;
   * an agent whose last job was yesterday has `jobs_today: 0` and is not idle in any sense the
   * reader means, and a card that said "Idle" over it would be describing the calendar rather than
   * the agent. §5's own words: "Idle is a real answer" — for an agent that has never been asked
   * for anything, which is a different card from one that finished at four this morning.
   *
   * NULL MEANS NOTHING HAS EVER BEEN ASKED OF IT, and that is the card §5 renders "Idle" for.
   */
  last_job_at: string | null;
  /** Null is UNKNOWN and never zero, the same rule the rows follow. */
  spend_today: number | null;
  spend_complete: boolean;
  /**
   * The agent's own answer, when somebody has asked recently, and how old that answer is.
   *
   * NULL MEANS NOBODY HAS ASKED, which is a third state and not "unhealthy". §10's health is a
   * bounded poll with a STATED staleness rather than a per-render fetch, so a card that has not
   * been probed says nothing rather than guessing — and the staleness travels so the screen can
   * say "as of 12s ago" instead of implying it just checked.
   */
  health: HealthState | null;
  health_stale_ms: number | null;
}

export interface WorkSnapshotPayload {
  items: WorkItemView[];
  /** Null when there is no further page. */
  nextCursor: string | null;
  /**
   * The counts UNDER THIS PAGE'S SCOPE, because they are rendered on the chips that set the status.
   *
   * A chip is a promise about what clicking it will show, and workspace-wide numbers broke that
   * promise under the default scope — §8 defaults to `mine`, so in any workspace with two people
   * the strip offered counts for jobs the list would not show. `status` is not applied: every chip
   * carries its own count, including for the status that is not currently selected.
   */
  counts: Record<WorkStatus, number>;
  /**
   * The same six counts for the WHOLE workspace — the sidebar badge, and only it.
   *
   * SEPARATE FROM `counts` because always-visible chrome must not move when somebody toggles a
   * filter on a tab they are not looking at, and because anyone who can answer a confirmation can
   * answer it whoever asked for the job.
   *
   * THE WHOLE SHAPE RATHER THAN THE ONE NUMBER THE BADGE READS, so `workBadgeCount` stays a
   * function over `WorkCounts` with one definition — and so `test:work-badge`, which §9 asks for
   * by name, keeps every case that says which statuses must NOT light it.
   */
  workspaceCounts: Record<WorkStatus, number>;
  /**
   * The filters this page ANSWERS FOR, echoed back.
   *
   * For the reason every Activity message carries its range: snapshots can arrive after somebody
   * has changed the filter, and a list assembled from two filters is the thing the echo lets a
   * client refuse. It is also what makes the zero states distinguishable — "nothing matches this
   * filter" and "nothing has been asked of them yet" are different sentences.
   */
  filters: { scope: "mine" | "all"; status: WorkStatus | null; agentId: string | null };
}

export interface FleetPayload {
  cards: FleetCardView[];
  /**
   * Whether this workspace has any live deployment at all.
   *
   * SEPARATE FROM `cards.length`, because §11.4's three zero states need to tell "no agents are
   * live yet" from "nothing has been asked of them yet", and an empty card list is the first while
   * a full one with no jobs is the second. A client counting cards would collapse them.
   */
  anyLive: boolean;
}

/** What the snapshot builder needs, without knowing where any of it comes from. */
export interface WorkSnapshotDeps {
  work: WorkStore;
  /** Agent uuid → display name. One read for the page, not one per row. */
  agentNames: (ctx: TenantContext) => Promise<Map<string, string>>;
  /** User uuid → display name or email. One read for the page. */
  actorNames: (ctx: TenantContext) => Promise<Map<string, string>>;
  /**
   * Agent UUID → its current deployment. One read for the strip.
   *
   * KEYED BY UUID, WHICH `DeployStore.currentByAgent` IS NOT — that map is keyed by the agent's
   * SLUG, because `deployments.agent_id` is a `text` column from migration 002 that predates agent
   * uuids and `DeployManager` still writes a slug into it. The join is the caller's, and it is
   * declared here rather than done inside this class so the two spellings meet in exactly one
   * place: a map keyed by slug and read with a uuid matches nothing, which renders every card as
   * "an agent that has been deleted" and looks like a data problem rather than a lookup one.
   */
  deployments: (ctx: TenantContext) => Promise<Map<string, Deployment>>;
  /** Whether a Railway service has a stored serve token. Null for a deployment with no service. */
  hasServeToken: (ctx: TenantContext, serviceId: string) => Promise<boolean>;
  /** The last health answer for a deployment, if anything has asked. Never a fresh probe. */
  cachedHealth?: (deploymentId: string) => { state: HealthState; staleMs: number } | undefined;
  /** A scoped handle, for the two grouped aggregate reads. */
  scoped: (ctx: TenantContext) => Queryable;
  now?: () => number;
}

export class WorkSnapshots {
  constructor(private readonly deps: WorkSnapshotDeps) {}

  /** One page of the work list, with the workspace's counts and the filters it answers for. */
  async list(ctx: TenantContext, filters: ListWorkFilters = {}): Promise<WorkSnapshotPayload> {
    // NARROWED, so the chips describe the list under them; and WHOLE, for the badge, which is
    // always-visible chrome and must not move because a filter changed on a tab nobody is looking
    // at. The second read is skipped when the page is already the whole workspace, which is what
    // "Everyone's" with no agent filter means — the two answers are then the same answer.
    const wholeWorkspace = filters.scope === "all" && !filters.agentId;
    const [page, counts, workspaceCounts, agents, actors, deployments] = await Promise.all([
      this.deps.work.list(ctx, filters),
      this.deps.work.countsByStatus(ctx, filters),
      wholeWorkspace ? Promise.resolve(null) : this.deps.work.countsByStatus(ctx, { scope: "all" }),
      this.deps.agentNames(ctx),
      this.deps.actorNames(ctx),
      this.deps.deployments(ctx),
    ]);
    const costs = await costsForItems(
      ctx,
      this.deps.scoped(ctx),
      page.items,
      (item) => modelOf(deployments, item),
    );
    return {
      items: page.items.map((item) => view(item, costs.get(item.id), agents, actors)),
      nextCursor: page.nextCursor,
      counts,
      workspaceCounts: workspaceCounts ?? counts,
      filters: {
        scope: filters.scope === "all" ? "all" : "mine",
        status: filters.status ?? null,
        agentId: filters.agentId ?? null,
      },
    };
  }

  /**
   * One item, changed — §5's `item` event, and the reason a transition is a delta rather than a
   * board.
   *
   * IT IS BUILT THE SAME WAY A ROW IN THE SNAPSHOT IS, out of the same three lookups, so a client
   * REPLACES the row it holds rather than merging fields into it. A delta whose shape differed
   * from the snapshot's would be a second definition of a row that the first change to either
   * makes wrong — which is the mistake the Inbox's own delta note is about.
   */
  async item(ctx: TenantContext, item: WorkItem): Promise<WorkItemView> {
    const [agents, actors, deployments] = await Promise.all([
      this.deps.agentNames(ctx),
      this.deps.actorNames(ctx),
      this.deps.deployments(ctx),
    ]);
    const costs = await costsForItems(ctx, this.deps.scoped(ctx), [item], (i) => modelOf(deployments, i));
    return view(item, costs.get(item.id), agents, actors);
  }

  /** One item in full, for the detail panel. */
  async detail(ctx: TenantContext, item: WorkItem): Promise<WorkItemDetailView> {
    const row = await this.item(ctx, item);
    return { ...row, input: item.input, output: item.output };
  }

  /**
   * The strip across the top: one card per LIVE deployment.
   *
   * NOT ONE PER AGENT. The Cockpit is about agents that are already live — an agent nobody has
   * deployed has nothing to operate — and putting a card up for every draft would turn the glance
   * into a second Agents grid, which §3 spends a paragraph saying this must not be.
   */
  async fleet(ctx: TenantContext): Promise<FleetPayload> {
    const [agents, deployments, live, today, lastJob] = await Promise.all([
      this.deps.agentNames(ctx),
      this.deps.deployments(ctx),
      this.deps.work.liveByAgent(ctx),
      this.todayByAgent(ctx),
      this.lastJobByAgent(ctx),
    ]);

    const cards: FleetCardView[] = [];
    for (const [agentId, deployment] of deployments) {
      if (deployment.status !== "live") continue;
      const mine = live.filter((r) => r.agent_id === agentId);
      const at = today.get(agentId);
      const health = this.deps.cachedHealth?.(deployment.id);
      cards.push({
        agent_id: agentId,
        agent_name: agents.get(agentId) ?? "an agent that has been deleted",
        deployment_id: deployment.id,
        url: deployment.url,
        version: deployment.version,
        provider: deployment.provider,
        model: deployment.model,
        connection: await this.connectionOf(ctx, deployment),
        running: mine.find((r) => r.status === "running")?.count ?? 0,
        waiting: mine.find((r) => r.status === "waiting")?.count ?? 0,
        queued: mine.find((r) => r.status === "queued")?.count ?? 0,
        jobs_today: at?.jobs ?? 0,
        last_job_at: lastJob.get(agentId) ?? null,
        spend_today: at && isPricedModel(deployment.model) ? at.cost : null,
        spend_complete: at?.complete ?? true,
        health: health?.state ?? null,
        health_stale_ms: health?.staleMs ?? null,
      });
    }
    cards.sort((a, b) => a.agent_name.localeCompare(b.agent_name));
    return { cards, anyLive: cards.length > 0 };
  }

  /**
   * Which of §9's four states this deployment's credential is in.
   *
   * `unauthorised` IS NOT DECIDED HERE, and the absence is the decision: this function knows only
   * what is STORED, and a token that exists but was rotated on Railway is indistinguishable from a
   * working one until something actually presents it. The store has no way to know a token was
   * rotated out from under it — §6.3 says so — so the state a card shows becomes `unauthorised`
   * when a JOB fails that way, from the failure kind, and never from a guess made here.
   */
  private async connectionOf(ctx: TenantContext, deployment: Deployment): Promise<FleetConnection> {
    // A public endpoint has no token by design, so the absence of one says nothing about it. The
    // env key is what the deploy wrote, and it is the only record of the choice.
    if (deployment.env_keys.includes("JAROKU_SERVE_PUBLIC")) return "public";
    if (!deployment.railway_service_id) return "unconnected";
    return (await this.deps.hasServeToken(ctx, deployment.railway_service_id)) ? "connected" : "unconnected";
  }

  /**
   * Today's job count and spend, per agent, in ONE statement.
   *
   * A LEFT JOIN RATHER THAN TWO QUERIES, and `COUNT(DISTINCT w.id)` rather than `COUNT(*)`, because
   * the join multiplies: a job with four steps would otherwise be four jobs. That is the kind of
   * mistake that produces a plausible number on a card built to be glanced at.
   *
   * TODAY IS UTC MIDNIGHT, which is a limit worth stating rather than hiding — the same one the
   * Inbox's snooze has. Nothing in this product records a person's timezone, so "today" is the
   * server's day, and for somebody in Los Angeles the counter turns over in the afternoon. The
   * honest fix is a timezone on the user and it is not this part.
   */
  /**
   * When each agent was last given anything — §5's third clause, and a query of its own.
   *
   * NOT FOLDED INTO `todayByAgent`, and the reason is the join. That statement LEFT JOINs `steps`
   * so it can sum a cost, which multiplies a job by its step count; it survives that with
   * `COUNT(DISTINCT w.id)`, and a `MAX(w.created_at)` would survive it too — but only because a
   * maximum happens to be idempotent under duplication. Widening its `WHERE` from "today" to "all
   * time" so one extra column could ride along would make the whole aggregate scan every job this
   * workspace has ever dispatched, over the multiplied row set, to answer a question about
   * timestamps. This is one grouped read of one indexed column, and it runs beside the other four
   * rather than after them.
   *
   * A TEXT MAX RATHER THAN A DATE ONE, which is safe here for the reason the whole schema stores
   * instants as ISO-8601 text: that encoding is lexicographically ordered wherever the offset is
   * `Z` and the precision is fixed, which `migration 063` guarantees for this column. It is worth
   * stating rather than assuming, because it is exactly the kind of thing that is true in SQLite
   * and true in Postgres for different reasons and would stop being true the day somebody wrote a
   * local timestamp into the column.
   */
  private async lastJobByAgent(ctx: TenantContext): Promise<Map<string, string>> {
    const rows = await this.deps.scoped(ctx).all<{ agent_id: string; last_job: unknown }>(
      `SELECT agent_id, MAX(created_at) AS last_job
         FROM work_items
        WHERE workspace_id = ?
        GROUP BY agent_id`,
      [ctx.workspaceId],
    );
    const out = new Map<string, string>();
    for (const row of rows) {
      // A GROUP WITH NO ROWS CANNOT HAPPEN, but a null maximum can if the column were ever
      // nullable — and a `String(null)` in this map would put the text "null" on a card.
      if (row.last_job != null) out.set(String(row.agent_id), String(row.last_job));
    }
    return out;
  }

  private async todayByAgent(ctx: TenantContext): Promise<Map<string, { jobs: number; cost: number; complete: boolean }>> {
    const midnight = new Date(this.deps.now?.() ?? Date.now());
    midnight.setUTCHours(0, 0, 0, 0);
    const rows = await this.deps.scoped(ctx).all<{
      agent_id: string; jobs: unknown; cost: unknown; unpriced: unknown;
    }>(
      `SELECT w.agent_id,
              COUNT(DISTINCT w.id) AS jobs,
              SUM(s.cost)          AS cost,
              SUM(CASE WHEN s.type = 'llm_call' AND s.tokens IS NOT NULL AND s.cost IS NULL
                       THEN 1 ELSE 0 END) AS unpriced
         FROM work_items w
         LEFT JOIN steps s ON s.run_id = w.run_id AND s.workspace_id = w.workspace_id
        WHERE w.workspace_id = ? AND w.created_at >= ?
        GROUP BY w.agent_id`,
      [ctx.workspaceId, midnight.toISOString()],
    );
    const out = new Map<string, { jobs: number; cost: number; complete: boolean }>();
    for (const row of rows) {
      out.set(String(row.agent_id), {
        jobs: Number(row.jobs ?? 0),
        cost: round8(Number(row.cost ?? 0)),
        complete: Number(row.unpriced ?? 0) === 0,
      });
    }
    return out;
  }
}

function modelOf(deployments: Map<string, Deployment>, item: WorkItem): string | undefined {
  for (const d of deployments.values()) if (d.id === item.deployment_id) return d.model;
  return undefined;
}

function view(
  item: WorkItem,
  cost: WorkCost | undefined,
  agents: Map<string, string>,
  actors: Map<string, string>,
): WorkItemView {
  return {
    id: item.id,
    agent_id: item.agent_id,
    agent_name: agents.get(item.agent_id) ?? null,
    deployment_id: item.deployment_id,
    run_id: item.run_id,
    created_by: item.created_by,
    created_by_name: actors.get(item.created_by) ?? null,
    input_preview: preview(item.input) ?? "",
    status: item.status,
    output_preview: preview(item.output),
    error: item.error,
    failure_kind: item.failure_kind,
    created_at: item.created_at,
    started_at: item.started_at,
    ended_at: item.ended_at,
    cost_usd: cost?.cost_usd ?? null,
    tokens: cost?.tokens ?? null,
    duration_ms: cost?.duration_ms ?? null,
    cost_complete: cost?.cost_complete ?? true,
  };
}

