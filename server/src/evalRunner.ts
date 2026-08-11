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

/** Per-provider ceiling on simultaneous runs. */
function providerLimit(provider: string): number {
  const env = Number(process.env[`JAROKU_LIMIT_${provider.toUpperCase()}`]);
  if (Number.isFinite(env) && env > 0) return env;
  // `fake` is local and free, so it's bounded only by the pool. Real providers get a low
  // default: the cost of being conservative is a slower eval, the cost of being greedy is
  // rate-limit errors misread as provider unreliability.
  return provider === "fake" ? 16 : 2;
}

/** Wall-clock deadline per job. A wedged subprocess must not hold a slot forever. */
const DEFAULT_JOB_TIMEOUT_MS = Number(process.env.JAROKU_JOB_TIMEOUT_MS ?? 180_000);

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
  /** provider -> currently running count, for the per-provider cap. */
  inFlight: Map<string, number>;
  cancelled: boolean;
  /** Single timer for the earliest backing-off retry. See scheduleRetryWake. */
  retryTimer: NodeJS.Timeout | null;
}

export class EvalRunner {
  /** Evals currently draining. More than one is allowed; they share the pool's slots. */
  private live = new Map<string, Live>();
  private jobToEval = new Map<string, string>();

  constructor(private deps: EvalRunnerDeps) {
    // A job's run finishing is what advances the queue. Attribution is by run id — the
    // pool tags every event with one precisely so N concurrent runs stay distinguishable.
    deps.pool.on("exit", ({ runId, timedOut }) => this.onRunExit(runId, timedOut, null));
    deps.pool.on("spawnError", ({ runId, error }) => this.onRunExit(runId, false, error.message));
  }

  /** Whether any eval is draining — used to refuse a second start from the UI. */
  get active(): boolean {
    return this.live.size > 0;
  }

  activeEvalIds(): string[] {
    return [...this.live.keys()];
  }

  /**
   * Expand the dataset into jobs and begin draining.
   *
   * Fails loudly rather than starting an empty or malformed eval — a comparison built on
   * nothing is worse than an error, because it renders as a dashboard full of blanks.
   */
  async start(req: StartEvalRequest): Promise<{ evalId: string } | { error: string }> {
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
      inFlight: new Map(),
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
    void this.pump(evalRun.id);
    return { evalId: evalRun.id };
  }

  /** Stop an eval: kill what's running, cancel what's queued. */
  async cancel(evalId: string): Promise<void> {
    const live = this.live.get(evalId);
    if (!live) return;
    live.cancelled = true;
    if (live.retryTimer) { clearTimeout(live.retryTimer); live.retryTimer = null; }
    await this.deps.evalStore.cancelQueuedJobs(this.deps.context(), evalId, "cancelled");
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
    if (!live.cancelled && (await this.overBudget(evalId))) {
      const cancelled = await this.deps.evalStore.cancelQueuedJobs(this.deps.context(), evalId, "budget ceiling reached");
      live.cancelled = true;
      const spent = await this.deps.evalStore.trueSpend(this.deps.context(), evalId);
      const ceiling = (await this.deps.evalStore.getEvalRun(this.deps.context(), evalId))?.budget_usd;
      await this.deps.evalStore.setEvalStatus(this.deps.context(), 
        evalId,
        "aborted_over_budget",
        `stopped after $${spent.toFixed(4)} of a $${ceiling?.toFixed(4)} budget`,
      );
      console.log(`[eval] ${evalId} hit its budget ceiling — ${cancelled} queued job(s) cancelled`);
    }

    const jobs = await this.deps.evalStore.jobsForEval(this.deps.context(), evalId);
    if (!live.cancelled) {
      const now = Date.now();
      for (const job of jobs) {
        if (job.status !== "queued") continue;
        // A backing-off retry isn't eligible yet. Skipping (not breaking) lets other jobs
        // through — one provider's rate limit must not stall the whole eval.
        if (job.retry_not_before && Date.parse(job.retry_not_before) > now) continue;
        if (this.deps.pool.freeSlots <= 0) break; // pool saturated — try again on the next exit
        const running = live.inFlight.get(job.provider) ?? 0;
        if (running >= providerLimit(job.provider)) continue; // this provider is at its cap
        await this.dispatch(live, job);
      }
    }
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
      void this.pump(evalId);
    }, wakeIn);
  }

  private async dispatch(live: Live, job: EvalJob): Promise<void> {
    const example = await this.deps.evalStore.getExample(this.deps.context(), job.example_id);
    if (!example) {
      // The example was deleted after the eval was queued. Record it rather than skipping
      // silently — a missing cell in the dashboard needs a reason.
      await this.deps.evalStore.finishJob(this.deps.context(), job.id, "failed", { error: "example no longer exists" });
      return;
    }

    const evalRun = (await this.deps.evalStore.getEvalRun(this.deps.context(), live.evalId))!;
    const runId = randomUUID();
    live.runToJob.set(runId, job.id);
    this.jobToEval.set(job.id, live.evalId);
    live.inFlight.set(job.provider, (live.inFlight.get(job.provider) ?? 0) + 1);
    this.deps.markEvalRun(runId, true);
    await this.deps.evalStore.markJobRunning(this.deps.context(), job.id, runId, job.attempt);

    const started = this.deps.pool.tryStart({
      runId,
      runtimeDir: this.deps.runtimeDir,
      agentId: evalRun.agent_id,
      input: example.input,
      timeoutMs: DEFAULT_JOB_TIMEOUT_MS,
      env: {
        JAROKU_RUN_ID: runId,
        JAROKU_PROVIDER: job.provider,
        JAROKU_MODEL: job.model,
      },
    });

    // The cap check above should make this unreachable; if the pool refuses anyway, undo
    // the bookkeeping so the job goes back on the queue rather than being stranded in
    // 'running' with no process behind it. No attempt is consumed — nothing ran.
    if (!started) {
      live.runToJob.delete(runId);
      live.inFlight.set(job.provider, Math.max(0, (live.inFlight.get(job.provider) ?? 1) - 1));
      this.deps.markEvalRun(runId, false);
      await this.deps.evalStore.requeueJob(this.deps.context(), job.id);
    }
  }

  private async onRunExit(runId: string, timedOut: boolean, spawnError: string | null): Promise<void> {
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
    if (job) live.inFlight.set(job.provider, Math.max(0, (live.inFlight.get(job.provider) ?? 1) - 1));

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
      !(await this.overBudget(live.evalId)); // never spend past the ceiling to retry

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
