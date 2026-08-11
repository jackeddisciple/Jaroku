// TraceIngestMetrics — a dropped event has to be counted, not merely logged and forgotten.
//
//   npm run test:trace-ingest-metrics

import { TraceIngestMetrics } from "./traceIngestMetrics.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const metrics = new TraceIngestMetrics();
check("starts at zero", metrics.dropped === 0);

metrics.recordDropped({ runId: "run-a", reason: "not a recognized trace event" });
check("one drop increments the total", metrics.dropped === 1);
check("...and the per-run count", metrics.droppedFor("run-a") === 1);
check("an unrelated run's count is unaffected", metrics.droppedFor("run-b") === 0);

metrics.recordDropped({ runId: "run-a", reason: "malformed" });
metrics.recordDropped({ runId: "run-b", reason: "malformed" });
check("the total sums across runs", metrics.dropped === 3);
check("run-a accumulates its own drops", metrics.droppedFor("run-a") === 2);
check("run-b accumulates its own, separately", metrics.droppedFor("run-b") === 1);

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
