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
}

export interface StartEvalRequest {
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
  start(req: StartEvalRequest): { evalId: string } | { error: string } {
    const examples = this.deps.evalStore.listExamples(req.datasetId);
    if (!examples.length) return { error: "that dataset has no examples" };
    if (!req.targets.length) return { error: "pick at least one provider to compare" };

    // (example × provider) — the fan-out. Ordered example-major so the first results to
    // land cover one example across every provider, which is the comparison the user is
    // actually waiting to see.
    const spec = examples.flatMap((ex) =>
      req.targets.map((t) => ({ example_id: ex.id, provider: t.provider, model: t.model })),
    );

    const evalRun = this.deps.evalStore.createEvalRun({
      dataset_id: req.datasetId,
      agent_id: req.agentId,
      rubric_id: req.rubricId,
      targets: req.targets,
      budget_usd: req.budgetUsd,
    });
    // Rows first, dispatch second. If the process dies right here, the eval is recoverable
    // rather than a set of runs nothing points at.
    this.deps.evalStore.createJobs(evalRun.id, spec);
    this.deps.evalStore.setEvalStatus(evalRun.id, "running");

    this.live.set(evalRun.id, {
      evalId: evalRun.id,
      runToJob: new Map(),
      inFlight: new Map(),
      cancelled: false,
    });

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
    this.pump(evalRun.id);
    return { evalId: evalRun.id };
  }

  /** Stop an eval: kill what's running, cancel what's queued. */
  cancel(evalId: string): void {
    const live = this.live.get(evalId);
    if (!live) return;
    live.cancelled = true;
    this.deps.evalStore.cancelQueuedJobs(evalId, "cancelled");
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
  private pump(evalId: string): void {
    const live = this.live.get(evalId);
    if (!live) return;

    const jobs = this.deps.evalStore.jobsForEval(evalId);
    if (!live.cancelled) {
      for (const job of jobs) {
        if (job.status !== "queued") continue;
        if (this.deps.pool.freeSlots <= 0) break; // pool saturated — try again on the next exit
        const running = live.inFlight.get(job.provider) ?? 0;
        if (running >= providerLimit(job.provider)) continue; // this provider is at its cap
        this.dispatch(live, job);
      }
    }
    this.reportProgress(evalId);
    this.finishIfDone(evalId);
  }

  private dispatch(live: Live, job: EvalJob): void {
    const example = this.deps.evalStore.getExample(job.example_id);
    if (!example) {
      // The example was deleted after the eval was queued. Record it rather than skipping
      // silently — a missing cell in the dashboard needs a reason.
      this.deps.evalStore.finishJob(job.id, "failed", { error: "example no longer exists" });
      return;
    }

    const evalRun = this.deps.evalStore.getEvalRun(live.evalId)!;
    const runId = randomUUID();
    live.runToJob.set(runId, job.id);
    this.jobToEval.set(job.id, live.evalId);
    live.inFlight.set(job.provider, (live.inFlight.get(job.provider) ?? 0) + 1);
    this.deps.markEvalRun(runId, true);
    this.deps.evalStore.markJobRunning(job.id, runId, job.attempt);

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
      this.deps.evalStore.requeueJob(job.id);
    }
  }

  private onRunExit(runId: string, timedOut: boolean, spawnError: string | null): void {
    // Find the eval this run belongs to. Interactive runs match nothing and fall through.
    let live: Live | undefined;
    for (const l of this.live.values()) {
      if (l.runToJob.has(runId)) { live = l; break; }
    }
    if (!live) return;

    const jobId = live.runToJob.get(runId)!;
    live.runToJob.delete(runId);
    this.deps.markEvalRun(runId, false);

    const job = this.deps.evalStore.getJob(jobId);
    if (job) live.inFlight.set(job.provider, Math.max(0, (live.inFlight.get(job.provider) ?? 1) - 1));

    // The run row is the source of truth for what happened — the runner brackets every
    // execution with run_start/run_end, so a contract violation or a mid-graph crash is
    // already recorded there as status 'error'.
    const run = this.deps.store.getRun(runId);
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
    const metrics = aggregateJob(this.deps.store, runId, job?.model ?? run?.model ?? "");

    this.deps.evalStore.finishJob(jobId, status as "succeeded" | "failed" | "timed_out", {
      error,
      cost_usd: metrics.cost_usd,
      tokens: metrics.tokens,
      latency_ms: metrics.latency_ms,
      cost_complete: metrics.cost_complete,
    });
    const finished = this.deps.evalStore.getJob(jobId);
    if (finished) this.deps.onJobFinished?.(finished);

    // One failed job is one failed cell — keep draining.
    this.pump(live.evalId);
  }

  private counts(evalId: string) {
    const jobs = this.deps.evalStore.jobsForEval(evalId);
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

  private reportProgress(evalId: string): void {
    this.deps.onProgress({ evalId, ...this.counts(evalId) });
  }

  private finishIfDone(evalId: string): void {
    const live = this.live.get(evalId);
    if (!live) return;
    const c = this.counts(evalId);
    if (c.done < c.total) return;

    this.live.delete(evalId);
    const status = live.cancelled ? "cancelled" : "completed";
    this.deps.evalStore.setEvalStatus(evalId, status);
    console.log(
      `[eval] ${evalId} ${status} — ${c.total - c.failed}/${c.total} succeeded, ${c.failed} failed`,
    );
    this.deps.onFinished({ evalId, status });
  }
}
