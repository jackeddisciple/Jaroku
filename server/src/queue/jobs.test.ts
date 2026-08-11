// Pure logic, no server needed: every class has a config, env overrides are read correctly,
// and idempotency keys are actually deterministic.
//
//   npm run test:jobs

import { JOB_CLASSES, isJobClass, jobClassConfig, buildIdempotencyKey } from "./jobs.ts";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

console.log("\nevery job class has a config");

for (const jc of JOB_CLASSES) {
  const cfg = jobClassConfig(jc);
  check(cfg.perWorkspaceConcurrency > 0, `${jc}: perWorkspaceConcurrency is positive`);
  check(typeof cfg.label === "string" && cfg.label.length > 0, `${jc}: has a label`);
  check(typeof cfg.queued === "boolean", `${jc}: queued is a boolean`);
}

check(isJobClass("run.eval"), "isJobClass recognises a real class");
check(!isJobClass("run.something-made-up"), "isJobClass refuses a made-up one");

console.log("\nwhich classes are actually queued this session");

check(jobClassConfig("run.interactive").queued, "run.interactive is queued");
check(jobClassConfig("run.eval").queued, "run.eval is queued");
check(jobClassConfig("judge").queued, "judge is queued");
for (const jc of ["generate", "plan", "edit", "explain", "mcp.discover"] as const) {
  check(!jobClassConfig(jc).queued, `${jc} stays synchronous this session`);
}

console.log("\ntimeouts");

check(jobClassConfig("run.interactive").timeoutMs === null, "run.interactive has no default deadline");
check(jobClassConfig("run.eval").timeoutMs !== null, "run.eval has one");

console.log("\nenv overrides");

{
  const before = jobClassConfig("run.eval").timeoutMs;
  process.env.JAROKU_JOB_TIMEOUT_MS_RUN_EVAL = "5000";
  check(jobClassConfig("run.eval").timeoutMs === 5000, "a per-class timeout override is read");
  delete process.env.JAROKU_JOB_TIMEOUT_MS_RUN_EVAL;
  check(jobClassConfig("run.eval").timeoutMs === before, "and reverts once unset");
}
{
  process.env.JAROKU_WORKSPACE_CONCURRENCY_JUDGE = "9";
  check(jobClassConfig("judge").perWorkspaceConcurrency === 9, "a per-class concurrency override is read");
  delete process.env.JAROKU_WORKSPACE_CONCURRENCY_JUDGE;
}
{
  const defaultTimeout = jobClassConfig("run.eval").timeoutMs;
  process.env.JAROKU_JOB_TIMEOUT_MS_RUN_EVAL = "not-a-number";
  check(
    jobClassConfig("run.eval").timeoutMs === defaultTimeout,
    "a garbage override falls back to the default rather than becoming NaN",
  );
  delete process.env.JAROKU_JOB_TIMEOUT_MS_RUN_EVAL;
}

console.log("\nidempotency keys");

check(
  buildIdempotencyKey("run.eval", "job-1", "1") === "run.eval:job-1:1",
  "a key is the class and its parts, joined",
);
check(
  buildIdempotencyKey("run.eval", "job-1", "1") === buildIdempotencyKey("run.eval", "job-1", "1"),
  "the same parts always produce the same key",
);
check(
  buildIdempotencyKey("run.eval", "job-1", "1") !== buildIdempotencyKey("run.eval", "job-1", "2"),
  "a different attempt is a different key",
);
check(
  buildIdempotencyKey("run.eval", "job-1", "1") !== buildIdempotencyKey("judge", "job-1", "1"),
  "the same parts under a different class are a different key",
);

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
