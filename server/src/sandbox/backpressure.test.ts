// BackpressureTracker: the pure bytes/lines/rate accounting both transports share.
//
//   npm run test:backpressure

import { BackpressureTracker, describeViolation, type BackpressureLimits } from "./backpressure.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const TINY: BackpressureLimits = { maxBytesPerRun: 100, maxLineBytes: 40, maxLinesPerSecond: 5 };

{
  const t = new BackpressureTracker(TINY);
  check("an ordinary small write is admitted", t.recordBytes("r1", 10) === null);
  check("...and does not mark the run as violated", !t.hasViolated("r1"));
}

{
  const t = new BackpressureTracker(TINY);
  const v = t.recordBytes("r1", 50); // over maxLineBytes=40
  check("a single write over the line cap is refused", v?.kind === "line_too_long");
  check("...and marks the run violated", t.hasViolated("r1"));
}

{
  const t = new BackpressureTracker(TINY);
  t.recordBytes("r1", 30);
  t.recordBytes("r1", 30);
  const v = t.recordBytes("r1", 30); // 90 total, still under 100... one more tips it
  check("staying under the per-run cap across several writes is fine", v === null, `unexpected violation`);
  const v2 = t.recordBytes("r1", 30); // 120 total, over 100
  check("crossing the cumulative per-run cap is refused", v2?.kind === "bytes_per_run_exceeded");
}

{
  const t = new BackpressureTracker(TINY);
  t.recordBytes("r1", 30); // under maxLineBytes=40, cumulative 30
  t.recordBytes("r1", 30); // cumulative 60
  const v = t.recordBytes("r1", 30); // cumulative 90, still under maxBytesPerRun=100
  check("a write staying just under the cumulative cap is fine", v === null);
}

{
  const t = new BackpressureTracker(TINY);
  const violation = t.recordBytes("r1", 60); // over maxLineBytes immediately
  check("a violation makes EVERY subsequent write refused, not just the offending one", violation !== null);
  const after = t.recordBytes("r1", 1); // a tiny, otherwise harmless write
  check("...including a tiny one sent right afterward", after !== null);
}

{
  const t = new BackpressureTracker(TINY);
  let lastViolation: ReturnType<typeof t.recordLine> = null;
  for (let i = 0; i < 10; i++) lastViolation = t.recordLine("r1");
  check("exceeding lines-per-second is refused", lastViolation?.kind === "rate_exceeded");
}

{
  const t = new BackpressureTracker(TINY);
  for (let i = 0; i < 5; i++) {
    const v = t.recordLine("r1");
    check(`line ${i + 1}/5 within the per-second cap is admitted`, v === null);
  }
}

{
  const t = new BackpressureTracker(TINY);
  t.recordBytes("r1", 200); // violates
  check("run r1 is violated", t.hasViolated("r1"));
  check("an unrelated run r2 is not affected", !t.hasViolated("r2"));
  const v2 = t.recordBytes("r2", 10);
  check("r2 can still write normally", v2 === null);
}

{
  const t = new BackpressureTracker(TINY);
  t.recordBytes("r1", 200);
  check("r1 is violated before release", t.hasViolated("r1"));
  t.release("r1");
  check("release() clears the violated flag", !t.hasViolated("r1"));
  const v = t.recordBytes("r1", 10);
  check("...and a fresh budget after release admits an ordinary write", v === null);
}

check(
  "describeViolation produces a readable message for each kind",
  ["line_too_long", "bytes_per_run_exceeded", "rate_exceeded"].every((kind) => {
    const v =
      kind === "line_too_long"
        ? { kind: "line_too_long" as const, bytes: 999, limit: 100 }
        : kind === "bytes_per_run_exceeded"
          ? { kind: "bytes_per_run_exceeded" as const, bytes: 999, limit: 100 }
          : { kind: "rate_exceeded" as const, linesInWindow: 50, limit: 5 };
    return describeViolation(v).length > 0;
  }),
);

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
