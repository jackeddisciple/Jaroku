// The sweep. What makes Law 2 real, and what stops this table becoming a landfill.
//
// §6.2's second generator, and the one the whole feature rests on. The event-driven half writes an
// item when something happens; nothing writes one when a problem stops being true, because "the
// credential is no longer missing" is not an event anybody emits — it is the absence of a condition,
// and only something that goes and looks can notice it. Without this pass an Inbox shows items that
// were fixed weeks ago, and an Inbox that shows stale items is dead in a week.
//
// FOUR PROPERTIES §6.2 REQUIRES, AND EACH IS A DESIGN DECISION VISIBLE IN THIS FILE:
//
//   IDEMPOTENT. Running it twice changes nothing the second time. That falls out of `resolve`'s own
//   `WHERE state = 'open'` rather than being arranged here, which is why it is true rather than
//   nearly true — there is no bookkeeping to get wrong.
//
//   WORKSPACE-SCOPED, ONE WORKSPACE AT A TIME, THROUGH THE SCOPED REPOSITORY LAYER. §6.3 calls this
//   the highest-risk code in the feature, because it is the one path that legitimately touches many
//   workspaces. It never runs unscoped "as the server": it loops workspaces and mints a
//   `systemContextFor` per pass, and every read and write below goes through a method that takes
//   one. The compiler is what enforces that, not this comment.
//
//   SAFE AGAINST CONCURRENT RUNS ON MULTIPLE REPLICAS. An advisory lock, taken the way the migration
//   runner takes one — except this one does not block. Three replicas waking on the same minute
//   should produce ONE sweep, not three in a queue, so a replica that loses the race skips its tick
//   rather than running the identical pass a second later against facts that have not moved.
//
//   CHEAP. One aggregate pass per workspace, not one query per agent. The pass itself is supplied by
//   the caller — `factsFor` — because the facts come from six subsystems this module deliberately
//   knows nothing about; what this file guarantees is that it asks for them ONCE and that its own
//   cost is two statements per workspace whatever is in it.
//
// AND THE FIFTH, WHICH IS THE REASON THE OTHER FOUR MATTER: EVERY RESOLVE PREDICATE LIVES IN THE
// REGISTRY. The loop below is generic — it reads open rows, asks `isResolved`, and settles the ones
// that say yes. There is no branch here for `credential_missing` and no special case for
// `version_drift`. A predicate written inline in this file would be a second statement of a rule
// whose first statement is the trigger, and the two would drift the first time either changed.

import { newRequestId, systemContext, systemContextFor, type TenantContext } from "../db/tenant.ts";
import type { InboxStore } from "./inboxStore.ts";
import { isResolved, type InboxFacts } from "./registry.ts";

export interface WorkspaceReconcile {
  workspaceId: string;
  /** Open items examined this pass. */
  examined: number;
  /** Items whose predicate said the problem is fixed. */
  resolved: number;
  /** Items the derived generators wrote or refreshed. Zero until commits 8–10 fill `derive` in. */
  derived: number;
}

export interface ReconcileReport {
  workspaces: WorkspaceReconcile[];
  /** True when another replica held the lock and this tick did nothing. A normal outcome. */
  skipped: boolean;
}

export interface ReconcilerDeps {
  inbox: InboxStore;
  /**
   * Every workspace to sweep.
   *
   * TAKES A `SystemContext`, which is the one honest type for it: this genuinely precedes a
   * workspace, because producing the list IS how the scope for each pass is chosen. Handing it a
   * `TenantContext` with a placeholder id would make "ran unscoped" indistinguishable from "ran
   * scoped to the wrong workspace", which is exactly what the two context types exist to separate.
   */
  workspaces: (ctx: ReturnType<typeof systemContext>) => Promise<{ id: string }[]>;
  /**
   * One aggregate pass over a workspace, producing everything every predicate needs.
   *
   * SUPPLIED RATHER THAN BUILT HERE, because the facts come from the secret refs, the MCP registry,
   * the deploy store, the agent repository, the billing ledger and the identity repository — six
   * subsystems, none of which this module should have to import in order to run a loop. It is also
   * what makes "constant in the number of agents" a property somebody can test: the cost is whatever
   * this one call costs, and the sweep adds two statements to it.
   */
  factsFor: (ctx: TenantContext) => Promise<InboxFacts>;
  /**
   * The derived generators: what should exist right now, given those facts.
   *
   * RUNS BEFORE THE SETTLE, INSIDE THE SAME SCOPED PASS AND OVER THE SAME FACTS. Before, because a
   * derived item written after the settle would sit unexamined until the next tick — a credential
   * that went missing and came back inside one interval would leave a card nothing had ever asked
   * the predicate about. Over the same facts, because deriving from one moment and settling against
   * another is how a sweep raises an item and immediately resolves it, twice an hour, forever.
   *
   * Optional, so the loop is testable with nothing behind it — and absent until the derived
   * generators exist.
   */
  derive?: (ctx: TenantContext, facts: InboxFacts) => Promise<number>;
  /**
   * Take the cross-replica lock, or answer null because somebody else has it.
   *
   * A FUNCTION RATHER THAN A `Db`, so this file never touches a database handle it did not get
   * through the store. `index.ts` passes `db.withAdvisoryLock` bound to the reconciler's own key.
   */
  withLock: <T>(fn: () => Promise<T>) => Promise<T | null>;
  /** Fired once per workspace that changed, so a caller can push a fresh board down (§5.6). */
  onChanged?: (ctx: TenantContext, changed: number) => void;
  /** The clock, so a suite can move it. Every predicate reads it off the facts rather than calling it. */
  now?: () => number;
  log?: (line: string) => void;
}

export class InboxReconciler {
  private log: (line: string) => void;
  private now: () => number;

  constructor(private deps: ReconcilerDeps) {
    this.log = deps.log ?? ((line) => console.log(line));
    this.now = deps.now ?? Date.now;
  }

  /**
   * Sweep every workspace, under the lock.
   *
   * THE LOCK WRAPS THE WHOLE LOOP rather than each workspace. Per workspace it would be correct and
   * pointless: the contention this exists for is two replicas doing the same work at the same time,
   * and taking the lock a thousand times would mean two replicas interleaving workspace by workspace
   * and both paying the full cost of the pass.
   */
  async sweep(): Promise<ReconcileReport> {
    const result = await this.deps.withLock(async () => {
      const sys = systemContext(newRequestId());
      const workspaces = await this.deps.workspaces(sys);
      const out: WorkspaceReconcile[] = [];
      for (const ws of workspaces) {
        const ctx = systemContextFor(ws.id, newRequestId());
        try {
          out.push(await this.sweepWorkspace(ctx));
        } catch (err) {
          // ONE WORKSPACE'S FAILURE MUST NOT STOP THE OTHERS, which is the retention sweeper's rule
          // and matters more here: a sweeper that gives up on the first error stops running entirely
          // the week somebody's MCP server has a bad afternoon, and every OTHER workspace's Inbox
          // silently stops resolving anything.
          this.log(`[inbox] ${ws.id} could not be swept: ${(err as Error)?.message ?? err}`);
        }
      }
      return out;
    });

    // `null` IS NOT AN ERROR. Another replica is doing it, which is the lock working. Nothing is
    // logged, because a line per replica per tick is a log that says only how many replicas there
    // are.
    if (result === null) return { workspaces: [], skipped: true };
    return { workspaces: result, skipped: false };
  }

  /**
   * One workspace: derive what should exist, then settle everything that no longer should.
   *
   * TWO STATEMENTS OF ITS OWN, whatever is in the workspace — one read of the open rows and one
   * batched UPDATE. Everything else it costs is `factsFor`, which is the caller's one aggregate
   * pass. That is what "constant in the number of agents" means, and it is checkable by counting.
   *
   * PUBLIC, because the suite drives one workspace directly and because a caller that has just
   * changed something in one workspace can reconcile that one rather than waiting for the tick.
   */
  async sweepWorkspace(ctx: TenantContext): Promise<WorkspaceReconcile> {
    const facts = await this.deps.factsFor(ctx);
    const derived = (await this.deps.derive?.(ctx, facts)) ?? 0;

    const open = await this.deps.inbox.listOpen(ctx);
    // THE GENERIC LOOP, AND THE WHOLE OF THE SWEEP'S LOGIC. No branch per type, no special case:
    // `isResolved` reads the registry, which is where the trigger that created each of these lives
    // too. Adding a seventeenth item type must not require a line in this file.
    const settled = open.filter((item) => isResolved(item, facts)).map((item) => item.id);
    const resolved = await this.deps.inbox.resolve(ctx, settled, new Date(this.now()).toISOString());

    if (resolved > 0 || derived > 0) this.deps.onChanged?.(ctx, resolved + derived);
    return { workspaceId: ctx.workspaceId, examined: open.length, resolved, derived };
  }
}

/**
 * One line about a sweep, or nothing.
 *
 * NOTHING WHEN NOTHING HAPPENED, which is the retention sweeper's rule and the right one for
 * something on a timer: a periodic job that logs every tick is a log nobody reads, and the tick that
 * mattered is the one that scrolls past.
 */
export function describeReconcile(report: ReconcileReport): string | null {
  if (report.skipped) return null;
  const resolved = report.workspaces.reduce((n, w) => n + w.resolved, 0);
  const derived = report.workspaces.reduce((n, w) => n + w.derived, 0);
  if (!resolved && !derived) return null;
  return (
    `[inbox] ${resolved} item(s) resolved` +
    (derived ? `, ${derived} derived` : "") +
    ` across ${report.workspaces.length} workspace(s)`
  );
}
