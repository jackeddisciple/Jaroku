# ADR-011: Execute Evaluations as Batches of Ordinary Runs on a Persisted Job Queue

## Status

Accepted. Introduced in v0.1.9 (28 July 2026).

## Context

The evaluation engine compares an agent's quality, cost and latency across providers. That
means running the same agent many times: every example in a dataset, against every provider
being compared. A dataset of twenty examples across three providers is sixty runs.

Two designs were available, and the difference between them is the whole architecture.

An evaluation could have its own execution path, optimised for batch: one process running many
agent invocations, sharing imports, batching provider calls. That is faster and cheaper. It
also means the numbers on the comparison dashboard describe a code path that is not the code
path the user exercises when they press Run, so a discrepancy between "it worked in the
evaluation" and "it fails when I run it" becomes possible and unexplainable.

Alternatively an evaluation could be a *batch of ordinary runs*, going through exactly the same
pool slot, runner, tracer and trace store as a run triggered by hand.

There were four further constraints that shaped the queue design:

1. **Providers rate limit independently.** Eight simultaneous calls to one provider earns 429s
   that look like *that provider being unreliable*, which is exactly the wrong conclusion for a
   tool whose job is comparing providers.
2. **Evaluations spend real money**, so a crash must leave a readable record of what was meant
   to run and what already spent, and a budget must be enforceable.
3. **Failures must isolate.** One broken example must not take down a sixty-run comparison.
4. **The interactive experience must not degrade.** Pausing, resuming and branching assume a
   single addressable run the user is driving, and a background evaluation must never take that
   away.

## Decision

**An evaluation is a batch of ordinary runs. There is deliberately no second way to execute an
agent.**

Every job goes through the same pool slot, `jaroku_runner`, `JarokuTracer` and `TraceStore` path
as a run triggered by hand, and produces the same `Run` and `Step` rows. `eval_jobs.run_id` is a
plain foreign key into `runs.id`, and that foreign key is the entire integration surface between
the evaluation engine and the trace pipeline.

The flow:

```
dataset (examples)  x  targets (provider, model)
      -> jobs PERSISTED to the database, before anything dispatches
      -> drained through the run pool under per-provider caps
      -> transient failure: bounded retry with exponential backoff
      -> terminal: judged in a separate phase
      -> aggregated -> comparison dashboard -> CSV / JSON export
```

Six properties are the decision.

**Jobs are persisted before dispatch.** The queue is a table, not an array. A crash mid-eval
leaves a readable record of what was meant to run and what already spent money, instead of
orphaned runs nothing points at. A restart marks interrupted evaluations as cancelled rather
than leaving rows claiming to be in flight forever.

**Per-provider concurrency, not just a global cap.** Default 16 for the free local dry-run
provider and 2 for real providers, overridable per provider with
`JAROKU_LIMIT_<PROVIDER>`.

**One failing job is one failing cell.** A job that errors, times out or cannot spawn is
recorded, and the drain continues.

**Retries are bounded and discriminating.** A rate limit or a dropped connection is luck, and
retrying converts it into a result. A `ContractError`, a missing module or an unset API key is
a property of the agent: it will fail identically every time, and retrying multiplies the bill.
**Unrecognised failures are treated as deterministic**, because getting this backwards means
silently paying three times for every broken agent.

**A budget ceiling the server enforces**, checked before dispatching anything, against *true
spend*: every attempt plus judge cost, never the comparison figure, which excludes failures and
would let a retry storm spend straight past the limit. It bounds what is **started**, not what
is spent, because stopping a job already in flight would spend the money and throw away the
result.

**Evaluation runs stay off the live trace channel.** Their events persist normally, but twenty
parallel runs broadcasting `run_start` would yank the timeline away from whatever the user was
reading. Drill-down loads them on demand through the ordinary `loadRun` path.

Slot 0 of the run pool is permanently reserved for the interactive run, so a background
evaluation can never occupy the path that pause, resume and branch depend on.

## Alternatives Considered

### Option 1: Evaluations as ordinary runs on a persisted job queue

- Pros
  - Numbers describe exactly the execution path the user exercises by hand.
  - One integration surface, a single foreign key, so aggregation can join evaluation jobs
    against the frozen `steps` table directly.
  - Every debugging tool works on an evaluation run: drill-down loads the full trace, and a
    failing example can be branched from.
  - A persisted queue survives a crash with a readable record of spend.
  - Per-provider caps make the comparison fair rather than an artefact of concurrency.
- Cons
  - One process per job, so process startup cost is paid sixty times rather than once.
  - Higher wall-clock time than a batched implementation.
  - The queue is a set of database tables to maintain and reconcile on restart.

### Option 2: A dedicated batch execution path

- Pros
  - Much faster: shared imports, one process, potentially batched provider calls.
  - Lower overhead per example.
- Cons
  - The evaluated code path is not the run code path, so "it passed the evaluation but fails
    when I run it" becomes possible and hard to explain.
  - Every debugging feature would need a second implementation for evaluation runs, or would
    simply not work on them.
  - Two execution paths drift. The one exercised less often is the one that breaks.

### Option 3: An external queue and worker system, for example Redis plus dedicated workers

- Pros
  - Horizontal scale, durable delivery semantics, and standard operational tooling.
  - Workers can be scaled independently of the control plane.
- Cons
  - Requires a service to be installed and running, which costs the property that
    `npm run dev` works with nothing installed.
  - Substantial infrastructure for a workload that is currently a single user comparing a
    handful of providers.
  - The queue *semantics* that matter here (persist before dispatch, bounded retry, per-provider
    caps, budget ceiling) are independent of the transport, and can be built correctly without
    it.

## Consequences

### Positive

- The comparison dashboard's numbers are trustworthy, because they come from the same pipeline
  as everything else.
- A failing cell in the comparison table can be drilled into and shows a complete, ordinary
  trace, which can then be branched from or fed into the fix loop.
- A crash mid-evaluation is recoverable and auditable: the jobs table says what was meant to
  run and what already spent.
- Per-provider caps mean a provider is not penalised in the comparison for concurrency Jaroku
  chose.
- Because the queue semantics were built properly with SQLite as the transport, moving to Redis
  later is a transport change rather than a redesign.

### Negative

- Wall-clock time is dominated by process startup multiplied by the number of jobs, bounded by
  concurrency. A sixty-job evaluation is slower than a batched implementation would be.
- The evaluation control plane is six tables (`datasets`, `dataset_examples`, `rubrics`,
  `eval_runs`, `eval_jobs`, `eval_scores`) that must all be workspace scoped and migrated.
- Restart reconciliation is required, and it runs unscoped across workspaces, which is stated
  in its signature and needs an administrative connection under row-level security.
- Checkpoint blobs from finished jobs accumulate and must be swept.

### Trade-offs

- Throughput was traded for fidelity. The product's claim is that the numbers mean something,
  and that claim depends on the evaluated path being the real path.
- The budget ceiling bounds what is started rather than what is spent, which is a documented
  limit: a few in-flight jobs can finish after the ceiling is crossed. Stopping them would spend
  the money and discard the result.
- Unrecognised failures are treated as deterministic, which means a genuinely transient failure
  of an unfamiliar shape is not retried. That is the safe direction: the cost of a missed retry
  is one failed cell, and the cost of the opposite error is paying three times for every broken
  agent.

## Implementation Notes

- `server/src/evalRunner.ts` is the orchestrator; `server/src/evalStore.ts` owns the tables;
  `server/src/evalAggregate.ts` turns traces into dashboard numbers;
  `server/src/evalEstimate.ts` produces the pre-run estimate.
- `server/src/runPool.ts` holds N process managers with slot 0 reserved. Timeouts are opt-in:
  evaluation jobs get `JAROKU_JOB_TIMEOUT_MS` (default 180000), interactive runs deliberately
  get no deadline.
- `providerLimit()` reads `JAROKU_LIMIT_<PROVIDER>`, defaulting to 16 for `fake` and 2 for real
  providers.
- Retry classification lives in `isTransientFailure`, and `npm run test:retry` covers it in both
  directions. `JAROKU_JOB_ATTEMPTS` (default 3) and `JAROKU_RETRY_BASE_MS` (default 2000) bound
  it.
- The budget check runs before dispatch and reads true spend, including judge cost.
- The estimate is deliberately a range rather than a point, states whether it was calibrated
  from this agent's real runs on this model or from a built-in default, and estimates an
  unpriced model to `null` rather than zero. The estimate informs; the ceiling enforces.
- Documented limits recorded at the time: a run killed for taking too long can still be billed
  by the provider for the call in progress, even though that spend never appears in the trace;
  and pre-run estimates assume a fixed ratio of input to output tokens, because only a combined
  count is available beforehand.

## Security Considerations

- Evaluation jobs are workspace scoped like everything else. `eval_runs`, `eval_jobs` and
  `eval_scores` all carry `workspace_id` and are covered by row-level security on Postgres.
- Evaluation runs execute the same model-written code as interactive runs, with the same stated
  sandbox limitation.
- The budget ceiling is a server-enforced control, not a client-side one. A client cannot raise
  it by sending a different value with a command, because the check happens in the runner
  against the stored evaluation record.
- Restart reconciliation reads across workspaces and says so in its signature. Under row-level
  security it requires an administrative connection rather than the application role.
- Evaluation runs deliberately do not broadcast on the live trace channel, which also means an
  evaluation in one workspace cannot push events at clients in another. Channel scoping is
  audited separately. See ADR-023.

## Performance Considerations

- Concurrency is bounded twice: globally by `JAROKU_EVAL_CONCURRENCY` (default 4, with slot 0
  reserved) and per provider by `JAROKU_LIMIT_<PROVIDER>`.
- The free dry-run provider is local and effectively free, so its default cap is 16 and it is
  bounded mainly by the pool.
- Aggregation joins evaluation jobs against `steps` directly, which is why both SQLite stores
  share one database file on one connection.
- Cost comes from `steps`, never `runs.cost`, because a run that crashes mid-graph never emits
  a `run_end` and its row still reads zero while its steps record real money already spent.
  See ADR-013.
- Judging is a separate phase and has its own concurrency (`JAROKU_JUDGE_CONCURRENCY`, default
  4), so it does not compete with execution for pool slots.

## Operational Considerations

- On restart, evaluations still marked in flight are cancelled rather than left claiming to be
  running.
- `evalCleanup` sweeps checkpoint blobs left by finished evaluation jobs, and collects orphans
  from evaluations whose sweep never ran, at startup. It never touches an interactive run's
  checkpoint.
- A stuck evaluation is usually a provider problem. Per-provider caps and job timeouts bound it;
  cancelling the evaluation releases the pool slots.
- Export is CSV and JSON, and the one rule is that an export must not launder an uncertain
  number into a clean one. Unknown cost is an empty cell with a `cost_known` column beside it,
  and an unscored run is an empty score with the judge's reason.
- Real-provider evaluations were verified against the Anthropic billing console: the pre-run
  estimate, the actual cost and the internally recorded cost agreed, and the published per-token
  rate was reconstructed from the recorded numbers alone.

## Rejected Alternatives

**A dedicated batch execution path** was rejected because it would make the comparison dashboard
describe a code path the user never runs. The moment "it passed the evaluation" and "it works
when I run it" can differ, the evaluation stops being evidence. It would also require a second
implementation of every debugging feature, or leave those features simply not working on
evaluation runs, which is the opposite of what a failing cell needs.

**An external queue and worker system** was rejected as premature. It would cost the property
that `npm run dev` needs nothing installed and nothing running, in exchange for scale the
workload does not yet require. The queue semantics that actually matter (persist before
dispatch, bounded discriminating retries, per-provider caps, an enforced budget ceiling) are
transport independent and were built properly against the database already present, so
introducing Redis later is a substitution behind an existing interface.

## Related Decisions

- ADR-001: Freeze a versioned trace event schema as the product's primitive
- ADR-003: Three process architecture with a Python runtime and a Node control plane
- ADR-010: A checkpointed twin for pause, resume and branch
- ADR-012: LLM as judge as a separate phase with a data driven rubric
- ADR-013: One pricing table read by both runtimes, and unknown is never zero
- ADR-016: A database interface with two drivers
- ADR-023: One WebSocket carrying many logical channels

## References

- `server/src/evalRunner.ts`, `server/src/evalStore.ts`, `server/src/evalAggregate.ts`,
  `server/src/evalEstimate.ts`, `server/src/evalCleanup.ts`, `server/src/runPool.ts`
- `server/src/evalRetry.test.ts` (`npm run test:retry`),
  `server/src/evalAggregate.test.ts` (`npm run test:aggregate`),
  `server/src/runPool.test.ts` (`npm run test:pool`)
- `client/src/components/EvalDashboard.tsx`, `client/src/lib/evalExport.ts`
- README section "The eval engine"
- CHANGELOG v0.1.9 "Eval Engine, Multi Provider Comparison"
