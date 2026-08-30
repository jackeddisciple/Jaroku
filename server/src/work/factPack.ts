// What the record actually says about an agent, bounded, scoped, and assembled before anything is
// asked to write prose about it.
//
// §7'S ORDER IS THE WHOLE DESIGN: "Collect facts, then answer from them. Never the other way
// round." The alternative — a prompt that describes the tables and a model that decides what to
// look at — is a product that answers "did that email go out?" with something plausible. Every
// sentence the explainer is allowed to produce about what happened has to have a row behind it, so
// the rows are gathered first, by code, and the model never gets to choose which.
//
// §3'S FIRST CONSEQUENCE IS ENFORCED BY THIS FILE EXISTING. "A question never touches the
// container. No dispatch, no run, no provider spend on the agent's key, no latency. It is a read
// against the record." Nothing here can reach a deployment: it takes a `Queryable` and two stores
// and it has no dispatch client to call.
//
// IT DOES NOT ASSUME ONE AGENT, and that is §12's requirement rather than generality for its own
// sake: "Who can do X?" is a dispatcher across agents and is Part 4's problem, and this part must
// not make it harder. So the input is a LIST of agent ids and the statement count does not change
// when the list grows — which is the same property the Agents grid asserts of itself, and which §7
// asks for here by name.
//
// BOUNDED BY COUNT AND BY BYTES, both, because the two failure modes are different. The count is
// what stops a busy workspace's fact pack becoming a thousand rows; the byte cap is what stops
// FIFTY rows becoming an enormous pack because somebody's agent answers with a document. A pack
// bounded only by count is one that fits until the day an agent starts returning JSON.
//
// AND WHAT IS TRIMMED SAYS SO. §7.5's rule — "not in the pack, not in the answer" — only works if
// the prompt can tell the difference between "there is nothing else" and "there is more and it did
// not fit". Silence about a truncation is exactly the shape of a confident wrong answer.

import { asInt, type Queryable } from "../db/db.ts";
import type { TenantContext } from "../db/tenant.ts";
import { costsForItems, type WorkCost } from "./cost.ts";
import type { WorkFailureKind, WorkItem, WorkStatus } from "./workStore.ts";

/**
 * How many items a pack may carry.
 *
 * FORTY, which is the number of rows a person can be shown as evidence and still open one of them.
 * It is deliberately smaller than the Cockpit's page of fifty: a list is scanned and a fact pack is
 * READ, by a model with a context budget and by a person checking a citation.
 */
export const PACK_ITEMS = 40;

/**
 * How large a pack may get, in BYTES of rendered text.
 *
 * BYTES RATHER THAN CHARACTERS, for the reason `MAX_WORK_INPUT_BYTES` is: this crosses a boundary
 * that counts bytes, and a JavaScript string's length is not what a tokeniser or an HTTP body
 * counts. Sixteen kilobytes is roughly four thousand tokens — a fifth of what the explainer's model
 * will take, which leaves room for the question, the prompt and the answer.
 */
export const PACK_BYTES = 16 * 1024;

/** How much of one job's prose may appear. Long enough to recognise, short enough that forty fit. */
export const FIELD_CHARS = 400;

/**
 * One job, as a fact.
 *
 * `id` IS FIRST AND IT IS NOT DECORATION. §7.4: "Every claim cites a work item, and the citation is
 * clickable." A fact with no id is a fact nothing can be checked against, so the id travels with
 * every row from here to the prompt to the chip in the conversation.
 */
export interface WorkFactRow {
  /** `work_items.id`. The citation. */
  id: string;
  agent_id: string;
  agent_name: string;
  status: WorkStatus;
  failure_kind: WorkFailureKind | null;
  /** What was asked, trimmed to `FIELD_CHARS`. */
  input: string;
  /** What came back, trimmed. Null while it is still running. */
  output: string | null;
  /** Why it failed, trimmed. Already redacted by the store — see `payload.ts`. */
  error: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  /** From the item's own clocks, including any wait for a person. Null while running. */
  duration_ms: number | null;
  /** Summed from `steps`, never `runs.cost`. Null means UNPRICED, never zero standing in for it. */
  cost_usd: number | null;
  /** False when the total is a floor: some `llm_call` reported tokens and no cost. */
  cost_complete: boolean;
  /** The trace. Null for a job that never reached the container, or one whose trace was swept. */
  run_id: string | null;
  /**
   * Whether anybody has opened this failure's trace.
   *
   * THE INBOX'S OWN SIGNAL, and it is the only one in this system: `unreviewed_failures` is an open
   * card per agent carrying the run ids nobody has looked at, and `noteTraceOpened` is what clears
   * it. Deriving a second answer here would be a second definition of "reviewed" — and the one that
   * disagreed with the Inbox would be this one, on the surface that is supposed to be telling
   * somebody what still needs them.
   *
   * `true` for anything that is not a failure, and for a failure with no open card: both mean there
   * is nothing outstanding to look at, which is what the word is being used for.
   */
  trace_reviewed: boolean;
}

/**
 * How many of the agent's jobs are in each state, across the whole record rather than the page.
 *
 * KEYED BY `WorkStatus` RATHER THAN LISTED OUT, so that adding a seventh status to migration 063's
 * CHECK is a compiler error here rather than a status that silently counts as nothing. `Record`
 * also makes this readable by `prompt.ts`, which takes the record structurally and must not import
 * the work subsystem — see `RecordForPrompt`.
 */
export type PackCounts = Record<WorkStatus, number>;

/** Why a pack stops where it does. Both false means the pack IS the record. */
export interface PackTruncation {
  /** More jobs exist than `PACK_ITEMS`. */
  by_count: boolean;
  /** The rows were cut short of `PACK_ITEMS` because the byte budget ran out first. */
  by_bytes: boolean;
  /** How many jobs the record holds for these agents in total. Always exact — it is a COUNT. */
  total: number;
}

export interface FactPack {
  /** The agents this pack is about, in the order they were asked for. */
  agents: { id: string; name: string }[];
  /** Newest first: `created_at DESC, created_seq DESC`, which is §7.1's order exactly. */
  items: WorkFactRow[];
  counts: PackCounts;
  truncation: PackTruncation;
}

/** What the builder needs, each one a read that already exists somewhere in the server. */
export interface PackDeps {
  /**
   * The model each deployment ran on, for pricing.
   *
   * A MAP RATHER THAN A LOOKUP, because `costsForItems` needs one per item and reading them per
   * item is the N+1 this file's statement-count claim is about. The caller already has the
   * deployments loaded on every surface that would ask a question.
   */
  modelByDeployment: (ctx: TenantContext) => Promise<Map<string, string>>;
  /** Run ids sitting in an OPEN `unreviewed_failures` card. See `WorkFactRow.trace_reviewed`. */
  unreviewedRunIds: (ctx: TenantContext) => Promise<Set<string>>;
}

export interface PackRequest {
  /**
   * Whose record to read. Empty means "no agents", which produces an empty pack rather than the
   * workspace's — a request that named nothing must never widen into everything.
   */
  agents: readonly { id: string; name: string }[];
  /** Overridable for tests and for a caller that knows it wants less. Never more than the cap. */
  maxItems?: number;
  maxBytes?: number;
}

/** Trim to `FIELD_CHARS` and say so, rather than ending a sentence in the middle of a word. */
function clip(text: string | null, chars = FIELD_CHARS): string | null {
  if (text === null) return null;
  const t = text.trim();
  if (t.length <= chars) return t;
  return `${t.slice(0, chars)}…(trimmed)`;
}

/**
 * Roughly how much of the budget one row will cost.
 *
 * MEASURED ON THE ROW'S OWN TEXT rather than on the rendered prompt, because the prompt's format is
 * `prompt.ts`'s business and this file must not have to change when a heading is reworded. It is an
 * approximation on purpose and it errs LARGE — the fixed cost of a row's labels is counted in — so
 * the pack lands under the budget rather than at it.
 */
function rowBytes(row: WorkFactRow): number {
  return Buffer.byteLength(
    [row.id, row.agent_name, row.status, row.failure_kind ?? "", row.input, row.output ?? "",
     row.error ?? "", row.created_at, row.ended_at ?? ""].join(" "),
    "utf8",
  ) + 160;
}

/**
 * The record, for these agents, in this workspace.
 *
 * THREE STATEMENTS, WHATEVER THE LIST HOLDS — and that is the claim `test:convo-facts` asserts as
 * an equality rather than as a threshold, because a threshold is a budget somebody spends:
 *
 *   1. the page of items       one, with an `IN` over the agent ids
 *   2. the counts by status    one, grouped, and over the WHOLE record rather than the page
 *   3. the cost, from `steps`  one per two hundred jobs — so one, for a page of forty
 *
 * THE OTHER TWO READS ARE DEPENDENCIES RATHER THAN QUERIES, and that is what keeps the figure
 * three: the deployments' models and the Inbox's unreviewed run ids are both workspace-wide reads
 * the calling surface already performs for its own reasons, and issuing them again here would be
 * two more round trips per question to fetch what the caller is already holding.
 */
export async function buildFactPack(
  ctx: TenantContext,
  q: Queryable,
  deps: PackDeps,
  req: PackRequest,
): Promise<FactPack> {
  const agents = [...req.agents];
  const maxItems = Math.min(Math.max(req.maxItems ?? PACK_ITEMS, 1), PACK_ITEMS);
  const maxBytes = Math.min(Math.max(req.maxBytes ?? PACK_BYTES, 512), PACK_BYTES);
  const empty: FactPack = {
    agents,
    items: [],
    counts: { queued: 0, running: 0, waiting: 0, succeeded: 0, failed: 0, cancelled: 0 },
    truncation: { by_count: false, by_bytes: false, total: 0 },
  };
  if (agents.length === 0) return empty;

  const ids = agents.map((a) => a.id);
  const holes = ids.map(() => "?").join(", ");
  const nameById = new Map(agents.map((a) => [a.id, a.name]));

  // ONE ROW MORE THAN THE CAP, so "is there more" is answered by this read rather than by a second
  // COUNT that can disagree with it — the same trick `WorkStore.list` uses for its cursor.
  //
  // `created_at DESC, created_seq DESC` IS §7.1'S ORDER AND THE TIE-BREAK IS NOT OPTIONAL. Two jobs
  // dispatched in the same millisecond — a double-click, or two members of a team — have no defined
  // order without it, so the "most recent five" a pack claims to hold would depend on the scan the
  // planner chose. That is a fact pack that changes between two reads of an unchanged record.
  const [rows, countRows, models, unreviewed] = await Promise.all([
    q.all<Record<string, unknown>>(
      `SELECT id, agent_id, deployment_id, run_id, input, status, output, error, failure_kind,
              created_at, started_at, ended_at, created_seq
         FROM work_items
        WHERE workspace_id = ? AND agent_id IN (${holes})
        ORDER BY created_at DESC, created_seq DESC
        LIMIT ?`,
      [ctx.workspaceId, ...ids, maxItems + 1],
    ),
    // THE COUNTS ARE OVER THE WHOLE RECORD, not over the page, and that is the difference between
    // "what is currently waiting" and "what is waiting among the last forty things that happened".
    // §7 asks for the first. One grouped statement, whatever the list holds.
    q.all<{ status: string; n: unknown }>(
      `SELECT status, COUNT(*) AS n FROM work_items
        WHERE workspace_id = ? AND agent_id IN (${holes})
        GROUP BY status`,
      [ctx.workspaceId, ...ids],
    ),
    deps.modelByDeployment(ctx),
    deps.unreviewedRunIds(ctx),
  ]);

  const counts = { ...empty.counts };
  let total = 0;
  for (const r of countRows) {
    const n = asInt(r.n);
    total += n;
    if (r.status in counts) counts[r.status as WorkStatus] = n;
  }

  const byCount = rows.length > maxItems;
  const page = rows.slice(0, maxItems);

  // The items in the shape `costsForItems` takes, which is the store's own `WorkItem`. Built once
  // and reused, so the cost pass and the rendering below are talking about the same rows.
  const items: WorkItem[] = page.map((r) => ({
    id: String(r["id"]),
    agent_id: String(r["agent_id"]),
    deployment_id: String(r["deployment_id"]),
    run_id: r["run_id"] === null || r["run_id"] === undefined ? null : String(r["run_id"]),
    created_by: "",
    input: String(r["input"] ?? ""),
    status: r["status"] as WorkStatus,
    output: r["output"] === null || r["output"] === undefined ? null : String(r["output"]),
    error: r["error"] === null || r["error"] === undefined ? null : String(r["error"]),
    failure_kind: (r["failure_kind"] ?? null) as WorkFailureKind | null,
    created_at: String(r["created_at"]),
    started_at: r["started_at"] === null || r["started_at"] === undefined ? null : String(r["started_at"]),
    ended_at: r["ended_at"] === null || r["ended_at"] === undefined ? null : String(r["ended_at"]),
    created_seq: asInt(r["created_seq"]),
  }));

  // COST FROM `steps`, NEVER `runs.cost` — §10, and `cost.ts`'s header opens with the reason. The
  // model comes from the DEPLOYMENT that ran the job rather than from the agent's current one,
  // because that is what decided the price.
  const costs: Map<string, WorkCost> = await costsForItems(
    ctx, q, items, (item) => models.get(item.deployment_id),
  );

  const out: WorkFactRow[] = [];
  let bytes = 0;
  let byBytes = false;
  for (const item of items) {
    const cost = costs.get(item.id);
    const row: WorkFactRow = {
      id: item.id,
      agent_id: item.agent_id,
      agent_name: nameById.get(item.agent_id) ?? item.agent_id,
      status: item.status,
      failure_kind: item.failure_kind,
      input: clip(item.input) ?? "",
      output: clip(item.output),
      error: clip(item.error),
      created_at: item.created_at,
      started_at: item.started_at,
      ended_at: item.ended_at,
      duration_ms: cost?.duration_ms ?? null,
      cost_usd: cost?.cost_usd ?? null,
      cost_complete: cost?.cost_complete ?? true,
      run_id: item.run_id,
      // ONLY A FAILURE CAN BE UNREVIEWED. Anything else has nothing outstanding to look at, and
      // reporting a succeeded job as "nobody opened its trace" would be true and useless.
      trace_reviewed: item.status !== "failed" || !item.run_id || !unreviewed.has(item.run_id),
    };
    const size = rowBytes(row);
    // THE FIRST ROW ALWAYS GOES IN, even if it alone is over budget. A pack that could be empty
    // because one job's input was enormous would answer "there is nothing recorded" about a
    // workspace that has a record — which is the one wrong answer §7.5 exists to prevent.
    if (out.length > 0 && bytes + size > maxBytes) {
      byBytes = true;
      break;
    }
    bytes += size;
    out.push(row);
  }

  return {
    agents,
    items: out,
    counts,
    truncation: {
      // A pack cut by bytes is also short of the count, so both flags can be true; they are
      // separate because the prompt says something different about each and a reader deciding
      // whether to ask a narrower question needs to know which limit was hit.
      by_count: byCount,
      by_bytes: byBytes,
      total,
    },
  };
}
