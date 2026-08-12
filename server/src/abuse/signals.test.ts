// What gets recorded, what it adds up to, and what it deliberately does not say.
//
// TWO HALVES. The scoring and the detectors are pure functions and are tested as such — a
// half-life is arithmetic, and arithmetic tested through a database is arithmetic tested
// slowly. The repository half runs on both drivers, because "a signal about workspace A is
// invisible to workspace B" is a tenancy property and tenancy properties are exactly the ones
// that hold on one driver and not the other.
//
//   npm run test:abuse-signals
//   JAROKU_PG_URL=postgres://… npm run test:abuse-signals    # runs the store half twice

import { randomUUID } from "node:crypto";
import { AbuseRepository } from "../db/repositories/abuse.ts";
import { openTestSqlite, withScratchPostgres } from "../db/testDb.ts";
import type { Db } from "../db/db.ts";
import { newRequestId, systemContext, systemContextFor, type TenantContext } from "../db/tenant.ts";
import {
  EGRESS_BYTES_THRESHOLD,
  HALF_LIFE_MS,
  MINER_MIN_SECONDS,
  SIGNALS,
  SIGNAL_KINDS,
  isRunRateSpike,
  score,
  signalsFromRun,
  subjectDigest,
} from "./signals.ts";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

// --- the table --------------------------------------------------------------------------------

console.log("\nthe signal table");
{
  check(
    SIGNAL_KINDS.every((k) => SIGNALS[k] && SIGNALS[k].kind === k),
    "every kind has a definition, and it agrees with its own key",
  );
  check(
    SIGNAL_KINDS.every((k) => SIGNALS[k].weight > 0 && SIGNALS[k].describe.length > 15),
    "every signal weighs something and says in a sentence what it is",
  );
  check(
    SIGNALS["tenancy.cross_denied"].weight > SIGNALS["sandbox.cpu_without_llm"].weight,
    "reading another tenant's data outweighs any amount of resource abuse",
  );
  check(
    SIGNALS["rate.limit_tripped"].weight < SIGNALS["sandbox.cpu_without_llm"].weight / 5,
    "tripping a rate limit is nearly weightless — the limiter already dealt with it",
  );
  check(SIGNALS["signup.velocity"].actor === "subject", "signup velocity is about an address, not a workspace");
}

// --- decay ------------------------------------------------------------------------------------

console.log("\nscoring");
{
  const now = 1_700_000_000_000;
  check(score([], now) === 0, "nothing observed scores nothing");
  check(
    score([{ kind: "run.rate_spike", weight: 10, observedAt: now }], now) === 10,
    "a signal observed now counts fully",
  );
  check(
    Math.abs(score([{ kind: "run.rate_spike", weight: 10, observedAt: now - HALF_LIFE_MS }], now) - 5) < 0.01,
    "...half as much a half-life later",
  );
  check(
    score([{ kind: "run.rate_spike", weight: 10, observedAt: now - 10 * HALF_LIFE_MS }], now) < 0.02,
    "...and effectively nothing after ten",
  );

  // The property the whole design rests on: four signals in one afternoon in March must not
  // equal four a week, or the answer to "who is abusing us" becomes "the oldest accounts".
  const bunched = Array.from({ length: 4 }, () => ({ kind: "run.rate_spike" as const, weight: 10, observedAt: now - 60 * 86_400_000 }));
  const recent = Array.from({ length: 4 }, (_, i) => ({ kind: "run.rate_spike" as const, weight: 10, observedAt: now - i * 3_600_000 }));
  check(score(bunched, now) < 0.001, "a bad afternoon two months ago scores nothing today");
  check(score(recent, now) > 35, "...and four in the last four hours scores nearly all of it");

  // No cliff: a score falls smoothly, so it never jumps for a reason that is not about the actor.
  const at = (ageMs: number): number => score([{ kind: "run.rate_spike", weight: 10, observedAt: now - ageMs }], now);
  const before = at(24 * 3_600_000 - 1000);
  const after = at(24 * 3_600_000 + 1000);
  // Equal, to two decimal places, either side of the moment a 24-hour window would have
  // expired: a sliding window drops the whole weight there, and decay does not notice it.
  check(before >= after && before - after < 0.01, "there is no window edge for a score to fall off");
  check(at(0) - at(HALF_LIFE_MS) > 4, "...while a half-life away is genuinely half");
}

// --- the detectors ------------------------------------------------------------------------------

console.log("\nwhat a finished run says");
{
  const miner = signalsFromRun({ runId: "r1", sandboxSeconds: 600, llmCalls: 0 });
  check(miner.length === 1 && miner[0]!.kind === "sandbox.cpu_without_llm", "ten minutes of sandbox and no model call is the signal");
  check(miner[0]!.targetId === "r1", "...pointing at the run it came from");
  check(
    JSON.stringify(miner[0]!.detail).includes("600"),
    "...carrying the evidence, and no part of the trace — that is the user's data",
  );

  check(
    signalsFromRun({ runId: "r2", sandboxSeconds: 600, llmCalls: 1 }).length === 0,
    "a long run that called a model is an agent, however long it took",
  );
  check(
    signalsFromRun({ runId: "r3", sandboxSeconds: MINER_MIN_SECONDS - 1, llmCalls: 0 }).length === 0,
    "a short run with no model call is a failed import, a graph introspection, or a crash — not a miner",
  );

  const heavy = signalsFromRun({ runId: "r4", sandboxSeconds: 30, llmCalls: 4, egressBytes: EGRESS_BYTES_THRESHOLD + 1 });
  check(
    heavy.length === 1 && heavy[0]!.kind === "sandbox.egress_volume",
    "a run that moved a quarter of a gigabyte is a proxy with extra steps, model calls or not",
  );
  check(
    signalsFromRun({ runId: "r5", sandboxSeconds: 30, llmCalls: 4 }).length === 0,
    "...and a substrate that does not report egress produces no signal rather than a zero",
  );
}

console.log("\nrun-rate spikes are relative");
{
  check(!isRunRateSpike(30, null), "a workspace with no history gets the benefit of the doubt");
  check(!isRunRateSpike(30, 0), "...as does one whose baseline is zero");
  check(!isRunRateSpike(30, 20), "twenty an hour is unremarkable for a workspace that averages twenty");
  check(isRunRateSpike(300, 2), "...and remarkable for one that averages two");
  check(!isRunRateSpike(15, 0.1), "an absolute floor stops a tiny baseline making every burst a spike");
}

console.log("\nsubjects are digests");
{
  const key = "a-deployment-key";
  const digest = subjectDigest("203.0.113.7", key);
  check(!digest.includes("203.0.113.7"), "the digest does not contain the address");
  check(subjectDigest("203.0.113.7", key) === digest, "...is stable");
  check(subjectDigest("203.0.113.8", key) !== digest, "...distinguishes neighbours");
  check(subjectDigest("203.0.113.7", "another-key") !== digest, "...and is KEYED, so it is not a rainbow table of IPv4");
  check(subjectDigest(" 203.0.113.7 ", key) === digest, "...and one address has one spelling");
}

// --- the repository, on both drivers -------------------------------------------------------------

async function storeSuite(label: string, db: Db): Promise<void> {
  console.log(`\n${label}`);
  const repo = new AbuseRepository(db);
  const [a, b] = await workspaces(db);
  const sys = systemContext(newRequestId());

  console.log("  · recording and scoring");
  {
    await repo.record(a, { kind: "sandbox.cpu_without_llm", weight: 25, detail: { sandboxSeconds: 600 }, targetType: "run", targetId: "r1" });
    await repo.record(a, { kind: "rate.limit_tripped", weight: 2, detail: { action: "agent.generate" } });
    const rows = await repo.recent(a);
    check(rows.length === 2, `both observations are on record (${rows.length})`);
    check(rows[0]!.detail["requestId"] === a.requestId, "...each correlated to the request that produced it");
    check(typeof rows[0]!.weight === "number", "...with the weight as it was AT THE TIME, not a join");
    const s = await repo.score(a);
    check(s > 26 && s < 27.1, `the score is the sum, barely decayed (${s})`);
  }

  console.log("  · one workspace cannot see another's");
  {
    check((await repo.recent(b)).length === 0, "B sees none of A's observations");
    check((await repo.score(b)) === 0, "...and scores zero");
    await repo.record(b, { kind: "run.rate_spike", weight: 5, detail: {} });
    check((await repo.recent(a)).length === 2, "...and recording B's does not appear in A's");
  }

  console.log("  · counting one kind");
  {
    const n = await repo.countSince(a, "rate.limit_tripped", new Date(Date.now() - 3_600_000).toISOString());
    check(n === 1, `"is this the third time today" is a count, not a score (${n})`);
    check(
      (await repo.countSince(a, "rate.limit_tripped", new Date(Date.now() + 1000).toISOString())) === 0,
      "...bounded by the window it was asked about",
    );
  }

  console.log("  · an address with no workspace");
  {
    const subject = subjectDigest("198.51.100.4", "k");
    for (let i = 0; i < 3; i++) {
      await repo.recordForSubject(sys, subject, { kind: "signup.velocity", weight: 20, detail: { action: "auth.signup" } });
    }
    const s = await repo.scoreForSubject(sys, subject);
    check(s > 59 && s < 60.1, `three signups from one address score three signals (${s})`);
    check((await repo.scoreForSubject(sys, subjectDigest("198.51.100.5", "k"))) === 0, "...and its neighbour scores nothing");
    check((await repo.recent(a)).length === 2, "...and none of it lands in a workspace's own list");
  }

  console.log("  · retention");
  {
    const swept = await repo.sweep(sys);
    check(swept === 0, "nothing recent is swept");
    // A row older than retention, written directly: the repository has no way to backdate one,
    // which is the append-only property being asserted from the other side.
    await db.run(
      `INSERT INTO abuse_signals (workspace_id, subject, kind, weight, detail, observed_at)
       VALUES (?, NULL, ?, ?, ?, ?)`,
      [a.workspaceId, "run.rate_spike", 5, "{}", new Date(Date.now() - 60 * 86_400_000).toISOString()],
    );
    check((await repo.sweep(sys)) === 1, "...and a two-month-old one is");
    check((await repo.recent(a)).length === 2, "...leaving the recent ones alone");
  }
}

async function workspaces(db: Db): Promise<[TenantContext, TenantContext]> {
  const out: TenantContext[] = [];
  for (const _ of [0, 1]) {
    const id = randomUUID();
    await db.run(
      `INSERT INTO workspaces (id, slug, name, kind, plan, created_at) VALUES (?, ?, ?, 'team', 'free', ?)`,
      [id, `abuse-${id.slice(0, 8)}`, "abuse", new Date().toISOString()],
    );
    out.push(systemContextFor(id, newRequestId()));
  }
  return [out[0]!, out[1]!];
}

{
  const db = await openTestSqlite();
  try {
    await storeSuite("AbuseRepository (SqliteDb)", db);
  } finally {
    await db.close();
  }
}

await withScratchPostgres(async (db) => {
  await storeSuite("AbuseRepository (PostgresDb)", db);
});

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
