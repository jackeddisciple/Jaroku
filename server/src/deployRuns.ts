// The lifetime of a run that happens somewhere else.
//
// A run in a pool slot has a process to be the run: the slot knows when it started, the exit
// event says when it stopped, and `release()` revokes its token on the way past. A DEPLOYED run
// has none of that. It happens inside a container in somebody else's Railway account, over an
// HTTP request Jaroku answered in milliseconds, and the only evidence it exists at all is what
// it pushes to the control plane. So the bookkeeping a slot did implicitly has to be done
// explicitly, and this is where.
//
// IT MINTS THE SAME TOKEN THE SANDBOX PATH ALREADY USES, on the same runTokens.ts, against the
// same revocation list the control-plane routes already consult. Nothing here is a second
// credential scheme — a deployed run is not more trusted than a sandboxed one, and the whole
// point of Part 1 is that it goes down the paths that already exist.
//
// WHY THE TOKEN AND NOT THE DEPLOYMENT'S OWN BEARER. The serve token gates `POST /run`; it is
// long-lived, it is the same value for every request, and it is set as a variable on a service
// somebody else operates. A run token is scoped to one run, expires, and can be revoked in
// flight — so a container that is compromised mid-run holds nothing that outlives the run it
// was already executing, and a container that has finished holds nothing at all.
//
// REVOKED ON EVERY WAY OUT, and that is three ways rather than one: the run ended, the user
// cancelled it, or nobody has heard from it in long enough that Jaroku has given up. The third
// is the one that is easy to forget and the only one where forgetting is silent — an abandoned
// run whose token was never revoked is a container that can push into a workspace's trace for
// the next two hours with nothing watching.

import { EventEmitter } from "node:events";

import { mintRunToken, MAX_RUN_TOKEN_TTL_S, type RunTokenRevocationList } from "./sandbox/runTokens.ts";
import type { RunEventBus } from "./sandbox/eventBus.ts";
import type { RunPoolEvents } from "./runPool.ts";

/**
 * How long a deployed run's token lives.
 *
 * THE POLICY CEILING, DELIBERATELY, and not a smaller number computed from something. §6 asks
 * for "generous enough for a long job plus a human-length pause on a confirmation": the
 * confirmation gate alone can hold for ten minutes (MAX_MCP_CONFIRM_TIMEOUT_MS), a graph that
 * calls a slow tool a dozen times is minutes more, and a run that is paused for a person to
 * look at is bounded by that person rather than by anything here. Two hours is several of all
 * of those.
 *
 * It is spelled as `MAX_RUN_TOKEN_TTL_S` rather than as `60 * 60 * 2` so there is exactly one
 * number: `mintRunToken` clamps to that ceiling anyway, and a local constant that read 3 hours
 * would silently become 2 with nothing saying so. The sandbox path made the same choice for the
 * same reason (runPool.ts's RUN_TOKEN_TTL_S), and the two agreeing is not a coincidence — a
 * deployed run and a sandboxed run are the same kind of thing to this credential.
 */
export const DEPLOY_RUN_TOKEN_TTL_S = MAX_RUN_TOKEN_TTL_S;

/** Why a deployed run stopped being tracked. Recorded because the three are genuinely
 *  different outcomes and the reconciliation sweep has to be able to tell them apart. */
export type DeployRunClose = "ended" | "cancelled" | "abandoned";

export interface DeployRunEntry {
  runId: string;
  workspaceId: string;
  deploymentId: string;
  agentId: string;
  /** Epoch ms. Never the token itself — see the note on `open`. */
  tokenExpiresAtMs: number;
  startedAtMs: number;
  /** When the control plane last heard anything at all from this run. Seeded at dispatch, so a
   *  container that never says a word is still measured from the moment it was asked to. */
  lastHeardAtMs: number;
}

export interface DeployRunsDeps {
  signingKey: Buffer;
  revocations: RunTokenRevocationList;
  /** The same bus the control-plane routes push into. A deployed run registers here for exactly
   *  the reason a hosted sandbox run does: it is how what it pushes reaches anything. */
  bus: RunEventBus;
  now?: () => number;
}

export interface OpenedDeployRun {
  /**
   * The run token, returned once and held by nobody.
   *
   * It goes into the body of the dispatch and into the container's environment, and this class
   * keeps only its expiry — which is all `revoke` needs, since a self-contained token cannot be
   * un-minted and the denylist entry is keyed by run id. Keeping the value would mean a live
   * credential sitting in a server-side map for two hours for no purpose at all.
   */
  runToken: string;
  entry: DeployRunEntry;
}

/**
 * A deployed run's lifetime, and the events it produces, as one thing.
 *
 * IT EMITS WHAT A RunPool EMITS, deliberately and exactly — `event`, `control`, `stderr`,
 * `parseError`, `exit`, each carrying the run id the way a slot attributes its own output. That
 * is not an aesthetic choice about interfaces; it is the whole of how "traces, cost, pause,
 * resume, cancel and MCP confirmation work in production without one new mechanism" is true.
 * index.ts already has handlers for every one of those events — they persist a step, meter it,
 * count a run against a quota, broadcast to the relay, raise an Inbox card on a failure, stamp a
 * checkpoint boundary. A deployed run reaches all of it by looking, to those handlers, exactly
 * like a run in a slot.
 *
 * The alternative was a second ingest path with its own copy of that chain, which is the thing
 * §7 says not to build: "Trace ingest is already built. Use it, do not fork it."
 */
export class DeployRuns extends EventEmitter<RunPoolEvents> {
  private open_ = new Map<string, DeployRunEntry>();
  private readonly now: () => number;

  constructor(private readonly deps: DeployRunsDeps) {
    super();
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Start tracking a dispatch: mint its token and register it on the bus.
   *
   * THE BUS ENTRY COMES FIRST, before the token exists. `RunEventBus.pushTrace` silently drops
   * an event for a run it has never heard of, so a container that is quick enough to push its
   * `run_start` before this method returned would have had it discarded — and the run would
   * arrive in the UI missing exactly the event that creates it. Registering first costs nothing
   * and removes the race entirely.
   */
  open(input: { runId: string; workspaceId: string; deploymentId: string; agentId: string }): OpenedDeployRun {
    const at = this.now();
    const emitter = this.deps.bus.register(input.runId);
    // ATTRIBUTED BY THE ENTRY THAT REGISTERED IT, never by anything in the payload. The run id
    // here is the one JAROKU minted at dispatch; the ids INSIDE an event are text a container
    // sent, and the ingest chain reconciles the two before it writes anything. That is the same
    // separation runPool.makeSlot draws between the slot and the line, for the same reason: a
    // container is running code a model wrote, on somebody else's infrastructure.
    const runId = input.runId;
    emitter.on("event", (event) => { this.heard(runId); this.emit("event", { runId, event }); });
    emitter.on("control", (ctrl) => { this.heard(runId); this.emit("control", { runId, ctrl }); });
    emitter.on("stderr", (line) => { this.heard(runId); this.emit("stderr", { runId, line }); });
    emitter.on("parseError", ({ line, error }) => { this.heard(runId); this.emit("parseError", { runId, line, error }); });
    const runToken = mintRunToken(
      this.deps.signingKey,
      input.runId,
      input.workspaceId,
      DEPLOY_RUN_TOKEN_TTL_S,
      at,
    );
    const entry: DeployRunEntry = {
      runId: input.runId,
      workspaceId: input.workspaceId,
      deploymentId: input.deploymentId,
      agentId: input.agentId,
      tokenExpiresAtMs: at + DEPLOY_RUN_TOKEN_TTL_S * 1000,
      startedAtMs: at,
      lastHeardAtMs: at,
    };
    this.open_.set(input.runId, entry);
    return { runToken, entry };
  }

  /** One more sign of life, from anything the container pushed. What the sweep measures. */
  heard(runId: string): void {
    const entry = this.open_.get(runId);
    if (entry) entry.lastHeardAtMs = this.now();
  }

  get(runId: string): DeployRunEntry | undefined {
    return this.open_.get(runId);
  }

  /** Every run this process believes is still executing in a container. */
  entries(): DeployRunEntry[] {
    return [...this.open_.values()];
  }

  has(runId: string): boolean {
    return this.open_.has(runId);
  }

  /**
   * Stop tracking a run: revoke its token, release the bus entry, forget it.
   *
   * IDEMPOTENT, because it is genuinely reachable twice. A run that is cancelled emits a
   * `run_end` for the cancellation, so the cancel path and the ingest path both arrive here for
   * the same run — and a second call throwing, or double-revoking, would turn a correct
   * sequence into an error in a log nobody reads. Returns whether this call was the one that
   * closed it, so a caller that needs to act exactly once still can.
   *
   * THE REVOCATION OUTLIVES THE ENTRY. `revoke` records the token's own expiry so the denylist
   * can drop it once `verifyRunToken` would refuse it on age alone — which is why the expiry is
   * the one thing worth having kept.
   */
  close(runId: string, reason: DeployRunClose): boolean {
    const entry = this.open_.get(runId);
    if (!entry) return false;
    this.open_.delete(runId);
    // REVOKED BEFORE THE BUS ENTRY GOES, not after. `unregister` resolves every waiter this run
    // has parked — a long-poll, a held confirmation — and a container woken by that answers by
    // pushing again immediately. Between the two calls the token is either valid or not, and a
    // finished run's must not be.
    this.deps.revocations.revoke(runId, entry.tokenExpiresAtMs);
    if (this.deps.bus.has(runId)) this.deps.bus.unregister(runId);
    // AND THE EXIT A SLOT WOULD HAVE EMITTED. index.ts's exit handler is what releases an
    // interactive slot, ends the run's span, drops it from `runWorkspaces` and settles the
    // billing attribution — none of which has anything to do with a POSIX process, and all of
    // which a deployed run needs. `code` is 0 for a run that ended under its own power and 1
    // otherwise, which is the same distinction a local exit carries; there is no signal, because
    // nothing here is a process this server owns.
    this.emit("exit", {
      runId,
      code: reason === "ended" ? 0 : 1,
      signal: null,
      timedOut: reason === "abandoned",
      elapsedMs: Math.max(0, this.now() - entry.startedAtMs),
    });
    return true;
  }

  /**
   * Runs that have not been heard from for longer than `ceilingMs`.
   *
   * Reported rather than closed here, because what to DO about one is a decision with a
   * database write and an honest error message in it — see the reconciliation sweep. This is
   * only the arithmetic.
   */
  stale(ceilingMs: number): DeployRunEntry[] {
    const cutoff = this.now() - ceilingMs;
    return [...this.open_.values()].filter((e) => e.lastHeardAtMs <= cutoff);
  }
}
