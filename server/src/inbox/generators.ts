// The event-driven half of §6.2: things that already happened, written down as items.
//
// TWO GENERATORS IN THE FEATURE AND THIS IS THE FIRST. A run fails, a deploy fails, an eval
// completes, an MCP server changes status, an edit is applied — each of those is a moment something
// in this process already knows about, and each upserts on a dedupe key from the handler that is
// already there. The other generator is the reconciler, which computes what nothing emits: a
// credential that is missing, a version that is behind, a server that has been unreachable for a
// day. The split is not stylistic. An event exists or it does not, and inventing one so a derived
// item could be written the same way would mean adding to the frozen schema, which §6.2 refuses in
// as many words: subscribe to what the control plane already emits.
//
// NOTHING HERE ADDS A TRACE EVENT, TOUCHES `schema/events.md`, OR CHANGES A RUN. Every function
// below is called from a handler that has already done its own work, takes what that handler
// already has in hand, and writes one row. If one of them throws, the thing it was told about has
// still happened — which is why every call site floats and catches, exactly as `meterPlatformCall`
// and `noteThreadItem` do. A deploy must not fail because a card could not be written.
//
// THE FUNCTIONS ARE FREE RATHER THAN METHODS ON A CLASS, and they take their dependencies as an
// argument. That is what lets the suite drive them against a real store with no server standing up,
// which is the same shape `collectThreadFacts` has and for the same reason: the interesting half is
// a decision about what counts as one problem, and that half should be testable on its own.

import type { TenantContext } from "../db/tenant.ts";
import type { InboxItem, InboxStore } from "./inboxStore.ts";
import { dedupeKey, type InboxPayload } from "./registry.ts";

export interface GeneratorDeps {
  inbox: InboxStore;
  /**
   * Called after a write that changed something. The caller broadcasts; this module does not know
   * what a socket is.
   *
   * Optional, because the suite has no relay and the reconciler does its own broadcasting once per
   * pass rather than once per row.
   */
  onChanged?: (ctx: TenantContext) => void;
}

/**
 * How many failed run ids one `unreviewed_failures` card carries.
 *
 * TWENTY, AND THE CAP IS THE POINT RATHER THAN THE NUMBER. §6.5 requires the payload to be bounded,
 * and this is the only field in the feature that grows without one — forty failures collapse into
 * one row precisely so the count can reach forty, and an unbounded list would put forty uuids in a
 * payload broadcast to every socket in the workspace on every failure. Twenty is more than "view all
 * failures" needs to open a useful list, and the `count` beside it is the honest total.
 *
 * THE NEWEST ARE KEPT, because the resolve condition is "any one of those traces is opened" and the
 * one somebody will open is the most recent. Dropping the newest to keep the oldest would make the
 * card point at the failure least likely to explain anything.
 */
export const RUN_IDS_MAX = 20;

/**
 * A run of this agent failed, and nobody has looked at a trace.
 *
 * ONE CARD PER AGENT, NOT PER RUN, which is Law 3 and also the only shape that says anything useful.
 * "Run 7f3a failed" is Activity — it happened, and there is nothing to decide about it. "api_gateway
 * has failed nine times and nobody has opened a trace" is a thing to do, and it is one thing however
 * many runs are behind it.
 *
 * THE ITEM IS RAISED ON THE FIRST FAILURE RATHER THAN AFTER A THRESHOLD. §2.2's trigger is "N runs
 * of one agent failed and no trace was opened", and N is one: a single unreviewed failure is already
 * a failure nobody has looked at, and waiting for a second means the card appears at the moment
 * somebody has already stopped noticing. The count on the badge is what distinguishes one from
 * forty.
 */
export async function noteRunFailed(
  deps: GeneratorDeps,
  ctx: TenantContext,
  input: { runId: string; agentUuid: string; agentName: string },
): Promise<InboxItem | null> {
  const key = dedupeKey("unreviewed_failures", input.agentUuid);
  const existing = await deps.inbox.byKey(ctx, key);

  // The ids this card already carries, unless it had been resolved — a recurrence starts over, so
  // it starts over here too rather than resurrecting run ids from a batch somebody already reviewed.
  const carried =
    existing && existing.state === "open" && Array.isArray(existing.payload["run_ids"])
      ? (existing.payload["run_ids"] as readonly string[])
      : [];
  const runIds = [input.runId, ...carried.filter((id) => id !== input.runId)].slice(0, RUN_IDS_MAX);

  const item = await deps.inbox.record(ctx, {
    type: "unreviewed_failures",
    subjectId: input.agentUuid,
    dedupeKey: key,
    payload: { agent_name: input.agentName, run_ids: runIds } satisfies InboxPayload,
  });
  deps.onChanged?.(ctx);
  return item;
}

/**
 * Somebody opened a trace. §2.2's resolve condition, arriving as the event it actually is.
 *
 * WRITTEN ONTO THE ITEM RATHER THAN HELD IN THIS PROCESS. The obvious implementation — a set of
 * reviewed run ids in memory, consulted by the sweep — is wrong in the way that matters: a restart
 * empties it, the sweep concludes nothing has been reviewed, and every card somebody dealt with last
 * week comes back. Law 2's promise is that a fixed problem stays gone, and a fact that does not
 * survive a deploy cannot keep it.
 *
 * IT RESOLVES FROM ANYWHERE A TRACE CAN BE OPENED — the sidebar's run list, the Agents tab's health
 * sparkline, the command palette, a deep link. All of them go through `loadRun`, which is where this
 * is called from, and none of them is the Inbox. That is the whole of Law 2 in one call site: the
 * card disappears because the work was done, not because the card was pressed.
 */
export async function noteTraceOpened(
  deps: GeneratorDeps,
  ctx: TenantContext,
  runId: string,
  at: string = new Date().toISOString(),
): Promise<boolean> {
  // Every open card that collapsed this run. Usually one — a run belongs to one agent — but the
  // read is over the open set rather than by key, because the caller has a run id and the key is
  // composed from an agent uuid it would otherwise have to look up.
  const open = await deps.inbox.listOpen(ctx);
  const hits = open.filter(
    (i) =>
      i.type === "unreviewed_failures" &&
      Array.isArray(i.payload["run_ids"]) &&
      (i.payload["run_ids"] as readonly string[]).includes(runId),
  );
  if (hits.length === 0) return false;

  for (const hit of hits) {
    // `setPayload` RATHER THAN `record`, and the difference is the badge. `record` means "this
    // happened again": it moves `last_seen_at` and increments the count, so stamping a review
    // through it would report a tenth failure that never occurred and the card would read `×10`
    // for nine. This is not a new occurrence, it is something more known about the same one.
    //
    // The stamp is what the registry's predicate reads; the sweep is what actually settles the row,
    // so there is still exactly one thing in this codebase that decides an item is resolved.
    await deps.inbox.setPayload(ctx, hit.dedupe_key, { ...hit.payload, reviewed_at: at } satisfies InboxPayload);
  }
  deps.onChanged?.(ctx);
  return true;
}

/**
 * A deploy failed its build or its health gate.
 *
 * ONE CARD PER DEPLOYMENT, not per agent, and that is the exception to the "one card per subject"
 * shape everything else here takes. A deploy is an attempt with its own build log, and the actions
 * on the card — view logs, retry, cancel — all address that attempt. Two failed attempts are two
 * things somebody may want the logs of.
 */
export async function noteDeployFailed(
  deps: GeneratorDeps,
  ctx: TenantContext,
  input: { deploymentId: string; agentUuid: string; agentName: string; error?: string | null },
): Promise<InboxItem> {
  const item = await deps.inbox.record(ctx, {
    type: "deploy_failed",
    subjectId: input.deploymentId,
    dedupeKey: dedupeKey("deploy_failed", input.deploymentId),
    payload: {
      agent_uuid: input.agentUuid,
      agent_name: input.agentName,
      // A build log's own error text, which is third-party output on its way into a payload every
      // socket in the workspace receives. It goes through the bounding and redaction §6.5 requires
      // before it lands — see `payload.ts`.
      error: input.error ?? null,
    } satisfies InboxPayload,
  });
  deps.onChanged?.(ctx);
  return item;
}

/**
 * An eval finished, and its results have not been opened.
 *
 * TWO ITEMS FROM ONE EVENT, AND THEY ARE NOT THE SAME ITEM. A completed eval is `eval_finished`,
 * which is Attention: there is something to read. An eval that crossed its ceiling is
 * `budget_ceiling_hit`, which is Blocking: the work did not all happen. An eval can be both — it hit
 * the ceiling and the jobs that ran produced results worth reading — and collapsing them would mean
 * choosing which half of that to tell somebody.
 */
export async function noteEvalFinished(
  deps: GeneratorDeps,
  ctx: TenantContext,
  input: {
    evalId: string;
    datasetName: string;
    status: string;
    /** The ceiling the eval was refused against, when it was. */
    ceilingUsd?: number | null;
  },
): Promise<void> {
  // A CANCELLED EVAL RAISES NOTHING. Somebody stopped it on purpose; there is no decision left, and
  // a card asking them to look at results they chose not to produce is the second-activity-feed
  // failure mode §1 warns about.
  if (input.status === "cancelled") return;

  if (input.status === "aborted_over_budget" && typeof input.ceilingUsd === "number") {
    await deps.inbox.record(ctx, {
      type: "budget_ceiling_hit",
      subjectId: input.evalId,
      dedupeKey: dedupeKey("budget_ceiling_hit", input.evalId),
      payload: { dataset_name: input.datasetName, ceiling_usd: input.ceilingUsd } satisfies InboxPayload,
    });
  }

  await deps.inbox.record(ctx, {
    type: "eval_finished",
    subjectId: input.evalId,
    dedupeKey: dedupeKey("eval_finished", input.evalId),
    payload: { dataset_name: input.datasetName } satisfies InboxPayload,
  });
  deps.onChanged?.(ctx);
}

/**
 * Somebody opened an eval's comparison. The mirror of `noteTraceOpened`, for the same reason.
 *
 * Called from `loadEvalResults`, which is the one path into a comparison however somebody arrived
 * at it — the Evals tab, a drill-down, this card's own primary action. The card resolving when the
 * Evals tab is used is the point rather than a side effect.
 */
export async function noteEvalResultsOpened(
  deps: GeneratorDeps,
  ctx: TenantContext,
  evalId: string,
  at: string = new Date().toISOString(),
): Promise<boolean> {
  const key = dedupeKey("eval_finished", evalId);
  const existing = await deps.inbox.byKey(ctx, key);
  if (!existing || existing.state !== "open") return false;
  // `setPayload`, for the reason `noteTraceOpened` uses it: reading results is not the eval
  // finishing a second time.
  await deps.inbox.setPayload(ctx, key, { ...existing.payload, opened_at: at } satisfies InboxPayload);
  deps.onChanged?.(ctx);
  return true;
}
