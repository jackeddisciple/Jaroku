// The load-test harness — N workspaces × M jobs through the real dispatcher, reporting the
// numbers Session 5's capacity planning is actually built on.
//
// WHAT THIS MEASURES, AND WHAT IT DELIBERATELY DOES NOT. It measures DISPATCH: enqueue
// throughput, admission latency (p50/p95), and the fairness ratio across workspaces. It does
// NOT start sandboxes, spawn Python, or call a provider — a run's own cost is dominated by a
// LangGraph import and a model round trip, neither of which this session changed, and mixing
// them in would bury the one number that IS new behind noise nobody can attribute.
//
// WHY THAT IS THE RIGHT SCOPE, GIVEN D6. The target is ~6,000 concurrent SESSIONS — people
// with the app open, mostly idle — not 6,000 concurrent runs. Concurrent RUNS at that session
// count are perhaps 1-2% of it, so the queue's job is to dispatch a modest number of runs
// fairly, promptly, and without one workspace's bulk submission delaying anyone else's. That
// is exactly what this measures. A harness that tried to hold 6,000 live sandboxes would be
// measuring a machine this session does not provision and a number D6 explicitly says is not
// the target.
//
//   npm run loadtest:queue                    # in-memory, no dependencies
//   JAROKU_REDIS_URL=redis://127.0.0.1:6380 npm run loadtest:queue     # against real Redis
//
// Tunables: JAROKU_LOADTEST_WORKSPACES (default 200), JAROKU_LOADTEST_JOBS_PER_WS (default
// 25), JAROKU_LOADTEST_CONCURRENCY (default 32 — how many admitted at once, standing in for
// total worker slots across the fleet).

import { randomUUID } from "node:crypto";
import { Dispatcher, defaultQueueBackend } from "./dispatcher.ts";
import { redisUrlFromEnv } from "./redis.ts";

const WORKSPACES = Math.max(1, Number(process.env.JAROKU_LOADTEST_WORKSPACES ?? 200));
const JOBS_PER_WS = Math.max(1, Number(process.env.JAROKU_LOADTEST_JOBS_PER_WS ?? 25));
const CONCURRENCY = Math.max(1, Number(process.env.JAROKU_LOADTEST_CONCURRENCY ?? 32));
const TOTAL = WORKSPACES * JOBS_PER_WS;

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

function fmtMs(ms: number): string {
  return ms < 1 ? `${(ms * 1000).toFixed(0)}µs` : `${ms.toFixed(2)}ms`;
}

const backend = defaultQueueBackend();
const dispatcher = new Dispatcher(backend);
const usingRedis = Boolean(redisUrlFromEnv());

console.log(
  `\nqueue load test — ${WORKSPACES} workspaces × ${JOBS_PER_WS} jobs = ${TOTAL} jobs, ` +
    `${CONCURRENCY} admitted at once, backend: ${usingRedis ? "redis" : "in-memory"}`,
);

const workspaceIds = Array.from({ length: WORKSPACES }, (_, i) => `ws-load-${i}-${randomUUID().slice(0, 8)}`);

// --- enqueue -----------------------------------------------------------------------------
//
// Interleaved across workspaces rather than one workspace at a time, which is both the more
// realistic arrival pattern and the harder one for the ring: every workspace is pending at
// once from the very first admit.
const enqueueStart = Date.now();
for (let j = 0; j < JOBS_PER_WS; j++) {
  for (const ws of workspaceIds) {
    await dispatcher.enqueue("run.eval", ws, { n: j });
  }
}
const enqueueMs = Date.now() - enqueueStart;
console.log(
  `  enqueue      ${TOTAL} jobs in ${enqueueMs}ms  (${Math.round(TOTAL / (enqueueMs / 1000)).toLocaleString()}/s)`,
);

// --- drain -------------------------------------------------------------------------------
//
// `CONCURRENCY` leases outstanding at a time: admit, hold, ack, admit again — the shape a
// fleet of workers actually produces, rather than admitting everything instantly with no cap.
const admitLatencies: number[] = [];
const servedPerWorkspace = new Map<string, number>();
const serveOrder: string[] = [];

const drainStart = Date.now();
let drained = 0;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      const t0 = performance.now();
      const leaseId = randomUUID();
      const admission = await dispatcher.tryAdmit("run.eval", { leaseId });
      const elapsed = performance.now() - t0;
      if (!admission) return; // queue empty
      admitLatencies.push(elapsed);
      servedPerWorkspace.set(admission.job.workspaceId, (servedPerWorkspace.get(admission.job.workspaceId) ?? 0) + 1);
      serveOrder.push(admission.job.workspaceId);
      drained++;
      await dispatcher.ack("run.eval", leaseId);
    }
  }),
);
const drainMs = Date.now() - drainStart;

admitLatencies.sort((a, b) => a - b);
console.log(
  `  drain        ${drained} jobs in ${drainMs}ms  (${Math.round(drained / (drainMs / 1000)).toLocaleString()}/s)`,
);
console.log(
  `  admit p50 ${fmtMs(percentile(admitLatencies, 50))}   p95 ${fmtMs(percentile(admitLatencies, 95))}   ` +
    `p99 ${fmtMs(percentile(admitLatencies, 99))}   max ${fmtMs(admitLatencies[admitLatencies.length - 1] ?? 0)}`,
);

// --- fairness ----------------------------------------------------------------------------
//
// THE RATIO IS THE POINT (doc §S5 acceptance: one workspace's bulk submission must not
// degrade another's). Every workspace enqueued the same count, so a perfectly fair dispatcher
// serves every one of them exactly JOBS_PER_WS times and the ratio is 1.00.
const served = [...servedPerWorkspace.values()];
const minServed = Math.min(...served);
const maxServed = Math.max(...served);
const ratio = minServed === 0 ? Infinity : maxServed / minServed;
console.log(
  `  fairness     min ${minServed}  max ${maxServed}  ratio ${ratio.toFixed(3)}  ` +
    `(1.000 = perfectly even; every workspace enqueued ${JOBS_PER_WS})`,
);

// HOW LONG A LATECOMER WAITS is the other half of fairness, and the one a ratio hides: a
// dispatcher could serve everyone equally overall and still make one workspace wait for
// thousands of other jobs first. Measured as how far into the serve order each workspace's
// FIRST job landed — under round-robin every workspace should be served once before any
// workspace is served twice, so the worst first-serve position is ~WORKSPACES, not ~TOTAL.
const firstServeAt = new Map<string, number>();
serveOrder.forEach((ws, i) => {
  if (!firstServeAt.has(ws)) firstServeAt.set(ws, i);
});
const worstFirstServe = Math.max(...firstServeAt.values());
console.log(
  `  head-of-line worst first-serve position ${worstFirstServe} of ${TOTAL}  ` +
    `(round-robin bound is ~${WORKSPACES}; ~${TOTAL} would mean FIFO starvation)`,
);

const complete = drained === TOTAL;
const fair = ratio === 1;
const noStarvation = worstFirstServe < WORKSPACES * 2;
console.log(
  `\n  ${complete ? "ok  " : "FAIL"} every enqueued job was dispatched exactly once (${drained}/${TOTAL})`,
);
console.log(`  ${fair ? "ok  " : "FAIL"} every workspace got an equal share (ratio ${ratio.toFixed(3)})`);
console.log(
  `  ${noStarvation ? "ok  " : "FAIL"} no workspace waited behind another's whole backlog ` +
    `(worst first-serve ${worstFirstServe} < ${WORKSPACES * 2})`,
);

const ok = complete && fair && noStarvation;
console.log(ok ? "\nALL CORRECT" : "\nFAILURES");
process.exit(ok ? 0 : 1);
