// Eval orchestrator — expands a dataset into jobs and drains them through the run pool.
//
// This is the "distributed job system" of doc §5.5, built in-process: a task queue holding
// each (example × provider) run, a bounded worker pool executing them in parallel under
// per-provider limits, and results aggregated back into one comparison. §5.5 also says a
// single Node process and SQLite stay correct until the load is real — so the QUEUE
// SEMANTICS are built properly and the transport isn't Redis.
//
// Three properties the design turns on:
//
//   1. JOBS ARE PERSISTED BEFORE ANYTHING DISPATCHES. The queue is a table, not an array.
//      A crash mid-eval leaves a readable record of what was meant to run and what already
//      spent money, instead of orphaned runs nothing points at.
//
//   2. PER-PROVIDER CONCURRENCY, not just a global cap. Providers rate-limit independently;
//      eight simultaneous calls to one provider earns 429s that look like that provider
//      being unreliable, which is exactly the wrong conclusion for a tool whose job is
//      comparing providers.
//
//   3. ONE FAILING JOB IS ONE FAILING CELL. A job that errors, times out, or can't spawn
//      is recorded and the drain continues. Partial-failure isolation (§5.5) is the whole
//      reason a batch is worth running unattended.
//
// Every job executes through the ORDINARY run path — pool slot -> jaroku_runner ->
// JarokuTracer -> TraceStore. There is no second way to run an agent.

import { randomUUID } from "node:crypto";
import type { RunPool } from "./runPool.ts";
import type { TraceStore } from "./store.ts";
import type { TenantContext } from "./db/tenant.ts";
import type { EvalStore, EvalJob, EvalTarget } from "./evalStore.ts";
import { aggregateJob } from "./evalAggregate.ts";
import { Dispatcher } from "./queue/dispatcher.ts";
import { jobClassConfig, type QueueJob } from "./queue/jobs.ts";
import { providerSemaphore } from "./queue/semaphores.ts";

/**
 * What a `run.eval` queue job carries. The dispatcher and the worker-side admit loop never
 * look inside it — this shape exists only so `dispatch()` and `executeAdmitted()` (both in
 * this file) agree on what they put in and what they read back out.
 */
interface RunEvalPayload {
  evalId: string;
  jobId: string;
  agentId: string;
  input: string;
  provider: string;
  model: string;
  attempt: number;
}

/** Wall-clock deadline per job. A wedged subprocess must not hold a slot forever. Reads the
 *  SAME env var queue/jobs.ts's run.eval config does, rather than keeping a second copy of
 *  the same default that could drift from it. */
const DEFAULT_JOB_TIMEOUT_MS = jobClassConfig("run.eval").timeoutMs ?? 180_000;

/** How much longer than the job's own timeout a provider-semaphore lease is held for, so a
 *  legitimately slow job doesn't get its provider slot reclaimed by a reaper while it's still
 *  running fair and square. */
const PROVIDER_LEASE_TTL_MS = DEFAULT_JOB_TIMEOUT_MS + 30_000;

/** Total attempts per job, including the first. Bounded: every retry costs money again. */
const MAX_ATTEMPTS = Math.max(1, Number(process.env.JAROKU_JOB_ATTEMPTS ?? 3));
const RETRY_BASE_MS = Number(process.env.JAROKU_RETRY_BASE_MS ?? 2_000);

/**
 * Is this failure worth paying to retry?
 *
 * The distinction is the whole point of bounding retries. A rate limit or a dropped
 * connection is luck, and retrying converts it into a result. A ContractError, a missing
 * module, or an unset API key is a property of the agent or the configuration — it will
 * fail identically every time, and retrying just multiplies the bill by the attempt count
 * while making the eval slower and the failure less legible.
 *
 * Unrecognized failures are treated as DETERMINISTIC. Getting this backwards means silently
 * paying 3x for every broken agent, so the default has to be the cheap one.
 */
export function isTransientFailure(error: string | null, timedOut: boolean): boolean {
  if (timedOut) return true; // a wedged call is the canonical retryable case
  if (!error) return false;
  const e = error.toLowerCase();

  // Deterministic markers win: an import error inside a retry-shaped message is still an
  // import error.
  const deterministic = [
    "contracterror", "modulenotfounderror", "importerror", "syntaxerror",
    "attributeerror", "typeerror", "nameerror", "indentationerror",
    "api key", "api_key", "authentication", "unauthorized", "permission",
    "not_found_error", "invalid_request_error", "does not exist",
  ];
  if (deterministic.some((m) => e.includes(m))) return false;

  const transient = [
    "rate limit", "rate_limit", "429", "overloaded", "529",
    "timeout", "timed out", "econnreset", "econnrefused", "etimedout", "enotfound",
    "connection error", "connection reset", "temporarily unavailable",
    "503", "502", "504", "internal server error", "apiconnectionerror",
  ];
  return transient.some((m) => e.includes(m));
}

export interface EvalProgress {
  evalId: string;
  total: number;
  done: number;
  running: number;
  queued: number;
  failed: number;
}

export interface EvalRunnerDeps {
  pool: RunPool;
  store: TraceStore;
  /** Where a run.eval job actually goes once its dataset row is written — the fair,
   *  per-workspace-capped queue, not a direct pool.tryStart(). See dispatch() and
   *  executeAdmitted() below for the two halves of what used to be one function. */
  dispatcher: Dispatcher;
  /**
   * The workspace every job in this runner belongs to.
   *
   * A function, not a value, matching the deploy manager's `token`: it is read at the
   * moment of use so the runner never holds a context that has gone stale, and so the
   * per-command contexts of Session 2 can replace this without changing a call site here.
   */
  context: () => TenantContext;
  evalStore: EvalStore;
  runtimeDir: string;
  /** Register/unregister a run id as belonging to an eval, so its events stay off "trace". */
  markEvalRun: (runId: string, isEval: boolean) => void;
  onStarted: (e: { evalId: string; datasetId: string; agentId: string; total: number; targets: EvalTarget[] }) => void;
  onProgress: (p: EvalProgress) => void;
  onFinished: (e: { evalId: string; status: string; error?: string }) => void;
  /** Called when a job reaches a terminal state, so later stages (aggregation, judging)
   *  can hook in without this file knowing about them. */
  onJobFinished?: (job: EvalJob) => void;
  /**
   * Record which workspace a new eval belongs to, before anything else runs.
   *
   * `context()` above answers "the workspace of the eval in flight", which it can only do once
   * something has told it — and everything after this point (the pump, a job's exit, the
   * judge) reads it. Called inside `start`, between the eval becoming live and the first job
   * being dispatched, because a gap there is a job whose events are recorded in the wrong
   * workspace. The caller cannot close that gap itself: it does not know the eval's id until
   * `start` returns, which is already too late.
   */
  bindWorkspace?: (evalId: string, ctx: TenantContext) => void;
  /**
   * Whether the WORKSPACE has run out of room, and why — or null when it has not.
   *
   * Distinct from the eval's own `budget_usd`, which is a ceiling somebody set on this
   * comparison. This is the workspace's ceiling for the period, and it has to be consulted here
   * as well as at start: a five-hundred-job fan-out is five hundred things being STARTED, and a
   * gate that only ran once would let the first job's authorisation cover all of them. The eval
   * budget has always been checked on every pump for exactly this reason; the workspace's is
   * checked in the same place, on the same rule.
   *
   * Optional, so a runner constructed without billing — every existing suite — behaves exactly
   * as it did.
   */
  workspaceOverBudget?: () => Promise<string | null>;
}

export interface StartEvalRequest {
  /**
   * The workspace that asked for this eval.
   *
   * NOT `deps.context()`, which is what every read and write below used to use. That function
   * answers "the workspace of the eval currently in flight", and at the moment `start` runs
   * there is no eval in flight — so it fell back to the server's own workspace. The dataset
   * lookup then ran in the wrong workspace and found nothing, and every workspace but the
   * server's was told its own dataset had no examples. Had it found rows, the eval and its
   * jobs would have been WRITTEN there too.
   */
  ctx: TenantContext;
  datasetId: string;
  agentId: string;
  rubricId: string;
  targets: EvalTarget[];
  budgetUsd: number | null;
}

interface Live {
  evalId: string;
  /** runId -> jobId, so a pool exit can be attributed to the job that caused it. */
  runToJob: Map<string, string>;
  /** `${jobId}:${attempt}` already sent to the dispatcher, so pump()'s reconciliation scan
   *  never enqueues the same attempt twice. A NEW attempt (a retry) is a new key, and gets
   *  enqueued fresh once its backoff has passed — see scheduleRetryWake. */
  enqueuedAttempts: Set<string>;
  cancelled: boolean;
  /** Single timer for the earliest backing-off retry. See scheduleRetryWake. */
  retryTimer: NodeJS.Timeout | null;
}

/** What a job's admission needs released once its run is done — the dispatcher's own lease,
 *  and the provider semaphore acquired on top of it. Keyed by runId because that's what
 *  onRunExit is handed; nothing upstream of it needs to know a lease exists at all. */
interface RunLease {
  jobId: string;
  dispatcherLeaseId: string;
  provider: string;
  providerLeaseId: string;
}

export class EvalRunner {
  /** Evals currently draining. More than one is allowed; they share the pool's slots. */
  private live = new Map<string, Live>();
  private jobToEval = new Map<string, string>();
  private leaseByRun = new Map<string, RunLease>();

  constructor(private deps: EvalRunnerDeps) {
    // A job's run finishing is what advances the queue. Attribution is by run id — the
    // pool tags every event with one precisely so N concurrent runs stay distinguishable.
    deps.pool.on("exit", ({ runId, timedOut }) => this.guard("run exit", this.onRunExit(runId, timedOut, null)));
    deps.pool.on("spawnError", ({ runId, error }) =>
      this.guard("spawn error", this.onRunExit(runId, false, error.message)),
    );

    // A SAFETY NET, not the primary driver. dispatch() already attempts an immediate drain
    // right after enqueueing, and onRunExit's own pump() does too once a slot frees up — this
    // timer only matters for capacity that opens for a reason NEITHER of those triggers on:
    // another eval's job finishing releases the global run.eval semaphore, or a provider
    // semaphore lease simply expiring. Unref'd so it never holds the process open.
    setInterval(() => this.guard("periodic drain", this.drainAvailable()), 500).unref();
  }

  /**
   * Every promise this class starts and does not await goes through here.
   *
   * NOT DEFENSIVE TIDYING — a floating promise that rejects is an `unhandledRejection`, and Node
   * has ENDED THE PROCESS for that since v15. Everything that drives this file forward is
   * floating by design: an EventEmitter listener cannot be awaited, and neither can a 500 ms
   * timer. So one SQLITE_BUSY under exactly the concurrency this session exists to support, or
   * one Redis blip, took down the gateway — the eval would have recovered on the next tick if
   * anything had been left running to take it.
   *
   * Logged rather than swallowed: the drain is idempotent and self-healing (the timer tries
   * again, and pump() reconciles against the persisted rows either way), so the right response to
   * one failed pass is to say so and let the next one run.
   */
  private guard(what: string, p: Promise<unknown>): void {
    void p.catch((err) => {
      console.error(`[eval] ${what} failed:`, (err as Error)?.message ?? err);
    });
  }

  /**
   * A start that has begun but has no eval id yet. `live` only gains an entry once the dataset
   * has been read and the rows written, which is five awaits after `start` was called — and
   * "one eval at a time" has to hold across that whole span, not just at its end. See start().
   */
  private starting = false;

  /** Whether any eval is draining, or is on its way to. Used to refuse a second start. */
  get active(): boolean {
    return this.starting || this.live.size > 0;
  }

  activeEvalIds(): string[] {
    return [...this.live.keys()];
  }

  /**
   * Expand the dataset into jobs and begin draining.
   *
   * Fails loudly rather than starting an empty or malformed eval — a comparison built on
   * nothing is worse than an error, because it renders as a dashboard full of blanks.
   *
   * ONE AT A TIME, CLAIMED SYNCHRONOUSLY. The refusal used to live in the WebSocket handler as
   * `if (evalRunner.active)`, followed by five awaits before anything became live — and wsRelay
   * dispatches commands concurrently, so two startEval messages genuinely overlap and both saw
   * `active === false`. That is not merely two evals contending for slots: index.ts resolves the
   * runner's workspace as `contextForEval(activeEvalIds()[0])`, so a second live eval has every
   * read and write attributed to the FIRST one's workspace — its jobs looked up in the wrong
   * tenancy scope, its rows written there. The claim belongs here, where the invariant is, and it
   * is taken before the first await so there is no window to lose.
   */
  async start(req: StartEvalRequest): Promise<{ evalId: string } | { error: string }> {
    if (this.active) return { error: "an eval is already running" };
    this.starting = true;
    try {
      return await this.startClaimed(req);
    } finally {
      this.starting = false;
    }
  }

  private async startClaimed(req: StartEvalRequest): Promise<{ evalId: string } | { error: string }> {
    const examples = await this.deps.evalStore.listExamples(req.ctx, req.datasetId);
    if (!examples.length) return { error: "that dataset has no examples" };
    if (!req.targets.length) return { error: "pick at least one provider to compare" };

    // (example × provider) — the fan-out. Ordered example-major so the first results to
    // land cover one example across every provider, which is the comparison the user is
    // actually waiting to see.
    const spec = examples.flatMap((ex) =>
      req.targets.map((t) => ({ example_id: ex.id, provider: t.provider, model: t.model })),
    );

    const evalRun = await this.deps.evalStore.createEvalRun(req.ctx, {
      dataset_id: req.datasetId,
      agent_id: req.agentId,
      rubric_id: req.rubricId,
      targets: req.targets,
      budget_usd: req.budgetUsd,
    });
    // Rows first, dispatch second. If the process dies right here, the eval is recoverable
    // rather than a set of runs nothing points at.
    await this.deps.evalStore.createJobs(req.ctx, evalRun.id, spec);
    await this.deps.evalStore.setEvalStatus(req.ctx, evalRun.id, "running");

    this.live.set(evalRun.id, {
      evalId: evalRun.id,
      runToJob: new Map(),
      enqueuedAttempts: new Set(),
      cancelled: false,
      retryTimer: null,
    });
    // Before the first job, never after: from here on `deps.context()` is what answers for
    // this eval, and it can only answer once it has been told.
    this.deps.bindWorkspace?.(evalRun.id, req.ctx);

    console.log(
      `[eval] ${evalRun.id} started — ${examples.length} example(s) × ${req.targets.length} target(s) = ${spec.length} job(s)`,
    );
    this.deps.onStarted({
      evalId: evalRun.id,
      datasetId: req.datasetId,
      agentId: req.agentId,
      total: spec.length,
      targets: req.targets,
    });
    this.guard("initial pump", this.pump(evalRun.id));
    return { evalId: evalRun.id };
  }

  /**
   * Stop an eval: kill what's running, cancel what's queued.
   *
   * A job already admitted (leased, mid-execution) is stopped below same as before. A job
   * still sitting unadmitted in the dispatcher's queue is now pulled back out too — purged by
   * idempotencyKey, best-effort (see backend.ts's own note on why this isn't the actual
   * safety mechanism). `executeAdmitted`'s `live.cancelled` check is what still catches
   * anything that slips past the purge because it was admitted in the same instant.
   */
  async cancel(evalId: string): Promise<void> {
    const live = this.live.get(evalId);
    if (!live) return;
    live.cancelled = true;
    if (live.retryTimer) { clearTimeout(live.retryTimer); live.retryTimer = null; }
    await this.deps.evalStore.cancelQueuedJobs(this.deps.context(), evalId, "cancelled");
    const keys = new Set([...live.enqueuedAttempts].map((attemptKey) => `run.eval:${attemptKey}`));
    if (keys.size) {
      const purged = await this.deps.dispatcher.purgePending("run.eval", this.deps.context().workspaceId, keys);
      if (purged) console.log(`[eval] ${evalId} purged ${purged} still-queued job(s) from the dispatcher`);
    }
    for (const runId of live.runToJob.keys()) this.deps.pool.stop(runId);
    console.log(`[eval] ${evalId} cancelled`);
  }

  // --- draining --------------------------------------------------------------

  /**
   * Dispatch as many queued jobs as the caps allow, then stop.
   *
   * Deliberately not a loop with a timer: it is called on start and on each job's exit, so
   * it advances exactly when capacity frees up. Nothing polls, and nothing can spin.
   */
  private async pump(evalId: string): Promise<void> {
    const live = this.live.get(evalId);
    if (!live) return;

    // THE BUDGET CEILING. Checked before dispatching anything, against TRUE spend (every
    // attempt plus judge cost) — never the comparison figure, which excludes failures and
    // would let a retry storm spend straight past the limit.
    //
    // It bounds what is STARTED, not what is spent: a job already in flight runs to
    // completion, so the final total can exceed the ceiling by at most the cost of the
    // runs already going. Stopping mid-run would spend the money and throw away the result.
    // TWO CEILINGS, ONE RULE. The eval's own `budget_usd` is a limit somebody set on this
    // comparison; the workspace's is the limit on everything it starts this period. Both bound
    // what is STARTED, both are checked on every pump for the same reason — a fan-out is many
    // starts, not one — and both stop the queue rather than the jobs already running.
    const workspaceReason = live.cancelled ? null : ((await this.deps.workspaceOverBudget?.()) ?? null);
    if (!live.cancelled && (workspaceReason !== null || (await this.overBudget(evalId)))) {
      const cancelled = await this.deps.evalStore.cancelQueuedJobs(
        this.deps.context(),
        evalId,
        workspaceReason ?? "budget ceiling reached",
      );
      live.cancelled = true;
      const spent = await this.deps.evalStore.trueSpend(this.deps.context(), evalId);
      const ceiling = (await this.deps.evalStore.getEvalRun(this.deps.context(), evalId))?.budget_usd;
      await this.deps.evalStore.setEvalStatus(this.deps.context(),
        evalId,
        "aborted_over_budget",
        // Which ceiling stopped it, in the words the user will read. "Over budget" with no
        // subject leaves somebody raising the wrong number and watching it stop again.
        workspaceReason ?? `stopped after $${spent.toFixed(4)} of a $${ceiling?.toFixed(4)} budget`,
      );
      console.log(
        `[eval] ${evalId} stopped — ${cancelled} queued job(s) cancelled ` +
          `(${workspaceReason ? "workspace ceiling" : "this eval's budget"})`,
      );
    }

    // WHICH QUEUED JOBS NEED TO REACH THE DISPATCHER — reconciliation against the persisted
    // rows, not execution. Capacity (pool slots, the provider semaphore) is a SEPARATE
    // concern now, checked by executeAdmitted() once the dispatcher's own fair rotation has
    // actually chosen a job to run; this loop's only job is "does the dispatcher know about
    // every eligible attempt yet."
    const jobs = await this.deps.evalStore.jobsForEval(this.deps.context(), evalId);
    if (!live.cancelled) {
      const now = Date.now();
      for (const job of jobs) {
        if (job.status !== "queued") continue;
        // A backing-off retry isn't eligible yet. Skipping (not breaking) lets other jobs
        // through — one provider's rate limit must not stall the whole eval.
        if (job.retry_not_before && Date.parse(job.retry_not_before) > now) continue;
        const attemptKey = `${job.id}:${job.attempt}`;
        if (live.enqueuedAttempts.has(attemptKey)) continue;
        live.enqueuedAttempts.add(attemptKey);
        await this.enqueueJob(live, job);
      }
    }
    this.guard("drain", this.drainAvailable()); // best-effort; the periodic timer covers the rest
    await this.reportProgress(evalId);
    await this.finishIfDone(evalId);
    await this.scheduleRetryWake(evalId);
  }

  /** True when this eval has spent at or past its ceiling. No ceiling => never true. */
  private async overBudget(evalId: string): Promise<boolean> {
    const budget = (await this.deps.evalStore.getEvalRun(this.deps.context(), evalId))?.budget_usd;
    if (budget === null || budget === undefined) return false;
    return (await this.deps.evalStore.trueSpend(this.deps.context(), evalId)) >= budget;
  }

  /**
   * Wake once when the earliest backing-off retry comes due.
   *
   * Needed because pump() is otherwise driven purely by job exits, and a job waiting on a
   * backoff has no exit coming — without this the eval would sit forever with queued work
   * and idle slots. One timer for the earliest deadline, replaced each pump, so backoffs
   * never accumulate timers or spin.
   */
  private async scheduleRetryWake(evalId: string): Promise<void> {
    const live = this.live.get(evalId);
    if (!live) return;
    if (live.retryTimer) { clearTimeout(live.retryTimer); live.retryTimer = null; }
    if (live.cancelled) return;

    const now = Date.now();
    const waiting = (await this.deps.evalStore.jobsForEval(this.deps.context(), evalId))
      .filter((j) => j.status === "queued" && j.retry_not_before)
      .map((j) => Date.parse(j.retry_not_before!))
      .filter((t) => t > now);
    if (!waiting.length) return;

    const wakeIn = Math.max(50, Math.min(...waiting) - now);
    live.retryTimer = setTimeout(() => {
      const l = this.live.get(evalId);
      if (l) l.retryTimer = null;
      this.guard("retry wake", this.pump(evalId));
    }, wakeIn);
  }

  /**
   * Tell the dispatcher a queued job exists. This is the whole of what used to be dispatch()
   * — it does NOT touch the pool, and does not know whether or when a slot will actually
   * open up. Fairness across workspaces is the dispatcher's job now, not a loop counting
   * pool.freeSlots one eval at a time.
   */
  private async enqueueJob(live: Live, job: EvalJob): Promise<void> {
    const example = await this.deps.evalStore.getExample(this.deps.context(), job.example_id);
    if (!example) {
      // The example was deleted after the eval was queued. Record it rather than skipping
      // silently — a missing cell in the dashboard needs a reason.
      await this.deps.evalStore.finishJob(this.deps.context(), job.id, "failed", { error: "example no longer exists" });
      return;
    }
    const evalRun = (await this.deps.evalStore.getEvalRun(this.deps.context(), live.evalId))!;
    const payload: RunEvalPayload = {
      evalId: live.evalId,
      jobId: job.id,
      agentId: evalRun.agent_id,
      input: example.input,
      provider: job.provider,
      model: job.model,
      attempt: job.attempt,
    };
    this.jobToEval.set(job.id, live.evalId);
    await this.deps.dispatcher.enqueue("run.eval", this.deps.context().workspaceId, payload, {
      id: job.id,
      idempotencyKey: `run.eval:${job.id}:${job.attempt}`,
      attempt: job.attempt,
    });
  }

  /**
   * Admit as many run.eval jobs as the dispatcher and this process's own pool both have room
   * for, right now, and start each one.
   *
   * WHY THIS LOOP AWAITS EACH START, AND WHY IT STOPS ON A REQUEUE.
   *
   * It used to do neither, and the combination was a livelock that took the whole process with
   * it. `pool.freeSlots` only moves once a job actually reaches tryStart, which is several awaits
   * into executeAdmitted — so a loop that fires each one off unawaited kept reading room it had
   * already spoken for. That alone is over-admission. The livelock is what happens next: a job
   * admitted with no provider slot left is put straight BACK on the queue, so the queue never
   * empties, and `freeSlots > 0` stays true because the provider cap (two, for a real provider)
   * is tighter than the eval pool (four). Admit, refuse, requeue, admit the same job again,
   * forever — and because every step of it resolves as a microtask, the event loop never reaches
   * a timer or a socket. Not a busy loop beside a working server: a wedged one. Any eval against
   * a real provider with more queued jobs than the provider cap did this.
   *
   * A requeue means the thing standing in the way is a lease held by a run that has not finished,
   * so no amount of asking again in this pass changes the answer. Stop, and let the next trigger
   * — a job exiting, or the 500 ms timer — ask again once something has actually changed.
   */
  private draining = false;

  private async drainAvailable(): Promise<void> {
    // Overlapping drains (the timer firing into one already running, two exits landing together)
    // do not admit twice — tryAdmit is atomic — but they do each add a full pass of round trips
    // to a queue that one pass is already walking.
    if (this.draining) return;
    this.draining = true;
    try {
      for (;;) {
        if (this.deps.pool.freeSlots <= 0) return; // this process has nowhere to put another one
        const admission = await this.deps.dispatcher.tryAdmit<RunEvalPayload>("run.eval");
        if (!admission) return;
        const outcome = await this.executeAdmitted(admission.job, admission.leaseId);
        // "dropped" is progress — the queue got shorter and nothing went back on it.
        if (outcome === "requeued") return;
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * A job the dispatcher has fairly chosen. From here it either actually runs, or is put
   * straight back — never left admitted-but-stranded, which would hold its capacity hostage
   * for nothing.
   *
   * Reports which of the three it was, because drainAvailable's loop cannot tell them apart from
   * the outside and has to stop on one of them — see its own note.
   */
  private async executeAdmitted(
    job: QueueJob<RunEvalPayload>,
    leaseId: string,
  ): Promise<"started" | "dropped" | "requeued"> {
    const payload = job.payload;
    const live = this.live.get(payload.evalId);
    if (!live || live.cancelled) {
      // The eval finished or was cancelled between being enqueued and being admitted. Ack
      // and drop it — see cancel()'s note on why this is a lazy purge rather than an eager one.
      await this.deps.dispatcher.ack("run.eval", leaseId);
      return "dropped";
    }

    // The provider cap is GLOBAL now — every eval, every workspace, one shared count per
    // provider — where the old per-eval-instance map let two concurrent evals each get their
    // own budget against the same provider. Checked here, after a fair admit rather than
    // fused into it: see queue/semaphores.ts for why that composition is deliberate.
    const provLeaseId = randomUUID();
    const provSem = providerSemaphore(this.deps.dispatcher.backend, "run.eval", payload.provider);
    if (!(await provSem.acquire(provLeaseId, PROVIDER_LEASE_TTL_MS))) {
      await this.deps.dispatcher.ack("run.eval", leaseId);
      await this.requeueVerbatim(job);
      return "requeued";
    }

    const runId = randomUUID();
    live.runToJob.set(runId, payload.jobId);
    this.leaseByRun.set(runId, {
      jobId: payload.jobId,
      dispatcherLeaseId: leaseId,
      provider: payload.provider,
      providerLeaseId: provLeaseId,
    });
    this.deps.markEvalRun(runId, true);

    // FROM HERE ON THIS RUN HOLDS TWO RESERVATIONS — the dispatcher's lease and the provider
    // slot — and something has to give them back on EVERY path out. The happy one is
    // onRunExit's; there is no exit event coming for a run that never started, so any throw
    // between here and a successful tryStart has to hand them back itself. Without this, one
    // failing markJobRunning (SQLITE_BUSY under exactly the concurrency this session is about)
    // silently retired one of the two provider slots a real provider gets, permanently.
    let started = false;
    try {
      await this.deps.evalStore.markJobRunning(this.deps.context(), payload.jobId, runId, payload.attempt);
      started = this.deps.pool.tryStart({
        runId,
        runtimeDir: this.deps.runtimeDir,
        agentId: payload.agentId,
        input: payload.input,
        timeoutMs: DEFAULT_JOB_TIMEOUT_MS,
        env: {
          JAROKU_RUN_ID: runId,
          JAROKU_PROVIDER: payload.provider,
          JAROKU_MODEL: payload.model,
        },
      });
    } catch (err) {
      live.runToJob.delete(runId);
      this.leaseByRun.delete(runId);
      this.deps.markEvalRun(runId, false);
      await provSem.release(provLeaseId);
      await this.deps.dispatcher.ack("run.eval", leaseId);
      await this.requeueVerbatim(job);
      throw err; // guard() logs it; the reservations are already back
    }

    // freeSlots > 0 in drainAvailable() only proves there was room a moment ago — another
    // caller of drainAvailable() (the periodic timer, another eval's own pump()) can win the
    // same slot in between. Undo everything and put the job back exactly as it was; no
    // attempt is consumed, because nothing ran.
    if (!started) {
      live.runToJob.delete(runId);
      this.leaseByRun.delete(runId);
      this.deps.markEvalRun(runId, false);
      await provSem.release(provLeaseId);
      await this.deps.dispatcher.ack("run.eval", leaseId);
      await this.deps.evalStore.requeueJob(this.deps.context(), payload.jobId);
      await this.requeueVerbatim(job);
      return "requeued";
    }
    return "started";
  }

  /** Put an admitted-but-not-executed job straight back on the queue, unchanged — no attempt
   *  bump, no backoff. It didn't fail; there just wasn't room yet. */
  private async requeueVerbatim(job: QueueJob<RunEvalPayload>): Promise<void> {
    await this.deps.dispatcher.enqueue("run.eval", job.workspaceId, job.payload, {
      id: job.id,
      idempotencyKey: job.idempotencyKey,
      attempt: job.attempt,
    });
  }

  private async onRunExit(runId: string, timedOut: boolean, spawnError: string | null): Promise<void> {
    // Release the dispatcher lease and the provider slot the moment the run is actually done,
    // regardless of how it turned out — a job that failed still frees the capacity it was
    // holding, and holding it any longer starves whatever is waiting behind it.
    //
    // BEFORE the "is this run's eval still live" check below, not after. Those are two different
    // questions: an eval can stop being live (finished, swept, cancelled and reconciled) while a
    // run it started is still winding down, and returning early on the second question used to
    // skip the release for the first — the run's provider slot then sat held until its own
    // three-and-a-half-minute TTL lapsed. A real provider gets two.
    const lease = this.leaseByRun.get(runId);
    if (lease) {
      this.leaseByRun.delete(runId);
      await this.deps.dispatcher.ack("run.eval", lease.dispatcherLeaseId);
      await providerSemaphore(this.deps.dispatcher.backend, "run.eval", lease.provider).release(lease.providerLeaseId);
    }

    // Find the eval this run belongs to. Interactive runs match nothing and fall through.
    let live: Live | undefined;
    for (const l of this.live.values()) {
      if (l.runToJob.has(runId)) { live = l; break; }
    }
    if (!live) return;

    const jobId = live.runToJob.get(runId)!;
    live.runToJob.delete(runId);
    this.deps.markEvalRun(runId, false);

    const job = await this.deps.evalStore.getJob(this.deps.context(), jobId);

    // The run row is the source of truth for what happened — the runner brackets every
    // execution with run_start/run_end, so a contract violation or a mid-graph crash is
    // already recorded there as status 'error'.
    const run = await this.deps.store.getRun(this.deps.context(), runId);
    const status = timedOut
      ? "timed_out"
      : spawnError
        ? "failed"
        : run?.status === "completed"
          ? "succeeded"
          : "failed";
    const error = timedOut
      ? `timed out after ${DEFAULT_JOB_TIMEOUT_MS}ms`
      : (spawnError ?? run?.error ?? (run ? null : "the run produced no trace"));

    // Metrics come from the run's STEPS, not runs.cost — a run that died mid-graph never
    // emitted run_end, so its row reads 0 while its steps record what it really spent.
    // Recorded for failed and timed-out jobs too: partial spend is still spend, and the
    // budget ceiling has to see it.
    const metrics = await aggregateJob(
      this.deps.context(),
      this.deps.store,
      runId,
      job?.model ?? run?.model ?? "",
    );

    await this.deps.evalStore.finishJob(this.deps.context(), jobId, status as "succeeded" | "failed" | "timed_out", {
      error,
      cost_usd: metrics.cost_usd,
      tokens: metrics.tokens,
      latency_ms: metrics.latency_ms,
      cost_complete: metrics.cost_complete,
    });

    // Retry only what's worth paying to retry, and only while attempts remain. `finishJob`
    // above has already folded this attempt's spend into spent_usd, so the retry is
    // accounted for even though the job goes back on the queue.
    const attempt = (job?.attempt ?? 0) + 1;
    const retryable =
      status !== "succeeded" &&
      !live.cancelled &&
      attempt < MAX_ATTEMPTS &&
      isTransientFailure(error, timedOut) &&
      // Never spend past EITHER ceiling to retry. A retry is another start, and the workspace's
      // limit binds it exactly as the eval's own does — without this, a workspace that ran out
      // mid-eval would keep paying for attempts on the jobs that happened to fail.
      !(await this.overBudget(live.evalId)) &&
      ((await this.deps.workspaceOverBudget?.()) ?? null) === null;

    if (retryable) {
      // Exponential backoff: a rate limit retried immediately is a rate limit again.
      const delay = RETRY_BASE_MS * 2 ** (attempt - 1);
      await this.deps.evalStore.retryJob(this.deps.context(), jobId, attempt, new Date(Date.now() + delay));
      console.log(
        `[eval] job ${jobId.slice(0, 8)} attempt ${attempt}/${MAX_ATTEMPTS} in ${delay}ms — ${error}`,
      );
    } else {
      const finished = await this.deps.evalStore.getJob(this.deps.context(), jobId);
      if (finished) this.deps.onJobFinished?.(finished);
    }

    // One failed job is one failed cell — keep draining.
    await this.pump(live.evalId);
  }

  private async counts(evalId: string) {
    const jobs = await this.deps.evalStore.jobsForEval(this.deps.context(), evalId);
    const by = (s: string) => jobs.filter((j) => j.status === s).length;
    const terminal = jobs.filter(
      (j) => j.status !== "queued" && j.status !== "running",
    ).length;
    return {
      total: jobs.length,
      done: terminal,
      running: by("running"),
      queued: by("queued"),
      failed: by("failed") + by("timed_out"),
    };
  }

  private async reportProgress(evalId: string): Promise<void> {
    this.deps.onProgress({ evalId, ...(await this.counts(evalId)) });
  }

  private async finishIfDone(evalId: string): Promise<void> {
    const live = this.live.get(evalId);
    if (!live) return;
    const c = await this.counts(evalId);
    if (c.done < c.total) return;

    if (live.retryTimer) { clearTimeout(live.retryTimer); live.retryTimer = null; }
    this.live.delete(evalId);
    // A budget abort already recorded its own status and reason; don't overwrite it with
    // the generic "cancelled", which would lose why the eval stopped.
    const current = (await this.deps.evalStore.getEvalRun(this.deps.context(), evalId))?.status;
    const status =
      current === "aborted_over_budget" ? current : live.cancelled ? "cancelled" : "completed";
    if (current !== "aborted_over_budget") await this.deps.evalStore.setEvalStatus(this.deps.context(), evalId, status);
    console.log(
      `[eval] ${evalId} ${status} — ${c.total - c.failed}/${c.total} succeeded, ${c.failed} failed`,
    );
    this.deps.onFinished({ evalId, status });
  }
}
