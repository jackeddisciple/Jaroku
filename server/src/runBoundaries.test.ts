// A step is stamped with the checkpoint after its own node, whichever of the two arrives first.
//
//   npm run test:run-boundaries

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RunBoundaries } from "./runBoundaries.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

console.log("§1 the boundary that covers a step is the earliest at or after it");
{
  // #25's run: extract_jd (0,1), extract_resume (2,3), score_candidate (4,5), route (6), shortlist_note (7,8).
  const b = new RunBoundaries();
  b.note("r", 1, "after-jd");
  b.note("r", 3, "after-resume");
  b.note("r", 6, "after-score");
  b.note("r", 8, "after-note");
  check("score_candidate's model call belongs to the checkpoint after score_candidate", b.checkpointFor("r", 5) === "after-score");
  check("...and its node step too", b.checkpointFor("r", 4) === "after-score");
  check("the first node's steps to the first checkpoint, not the last", b.checkpointFor("r", 0) === "after-jd" && b.checkpointFor("r", 1) === "after-jd");
  check("a step past every boundary has none yet", b.checkpointFor("r", 9) === undefined);
  check("another run's steps are not stamped from this one's", b.checkpointFor("other", 0) === undefined);
}

console.log("\n§2 arrival order does not matter");
{
  const b = new RunBoundaries();
  b.note("r", 6, "after-score"); // arrived first
  b.note("r", 1, "after-jd");
  check("boundaries announced out of order still answer by seq", b.checkpointFor("r", 0) === "after-jd" && b.checkpointFor("r", 4) === "after-score");
  b.forget("r");
  check("an ended run is dropped", b.size === 0 && b.checkpointFor("r", 0) === undefined);
}

console.log("\n§3 the server stamps a step that arrives after its boundary, and the runner sends steps first");
{
  const here = dirname(fileURLToPath(import.meta.url));
  const index = readFileSync(join(here, "index.ts"), "utf8");
  check("a step written after its boundary is stamped with it",
    /await store\.insertStep\(runCtx, event\.step\);\s*await stampLateStep\(runCtx, runId, event\.step\.seq\);/.test(index)
      && /async function stampLateStep[\s\S]{0,300}?runBoundaries\.checkpointFor\(runId, seq\)[\s\S]{0,120}?store\.stampStep\(ctx, runId, seq, checkpoint\)/.test(index));
  check("every boundary is noted as it is applied",
    /ingest\(async \(\) => \{\s*if \(checkpointId && seqHigh >= 0\) \{\s*runBoundaries\.note\(runId, seqHigh, checkpointId\);/.test(index));
  check("and a run's boundaries go when its process does, behind what it sent", /ingest\(async \(\) => runBoundaries\.forget\(runId\)\)/.test(index));
  const runner = readFileSync(join(here, "..", "..", "runtime", "jaroku_runner", "controlplane_http.py"), "utf8");
  const push = /def push_control_line[\s\S]*?\n\n\n/.exec(runner)?.[0] ?? "";
  check("the runner sends the steps it is holding before a control line", /flush_trace_events\(\)/.test(push), push.slice(0, 120));
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
