// The ladder: what it will do by itself, what it refuses to do by itself, and what it never
// takes away.
//
// THE THREE ASSERTIONS THAT MATTER MOST, in the order somebody would ask about them:
//
//   Nothing automatic ever suspends. Every rung the machine may apply is reversible and leaves
//   the workspace able to work, slowly. A system that can suspend accounts unattended will
//   eventually suspend the wrong one at 3am.
//
//   A human's decision does not lapse. In particular it does not lapse BECAUSE the suspension
//   worked: a suspended workspace runs nothing, produces no signals, and its score decays to
//   zero within days. An automatic lift on that basis would un-suspend every account it ever
//   suspended, which is the most obvious hole in a ladder like this.
//
//   Enforcement bounds what is STARTED. Nothing here stops a run in flight, and nothing here
//   makes anybody's data unreadable — the same rule the budget ceiling has followed since the
//   eval engine landed.
//
//   npm run test:enforcement
//   JAROKU_PG_URL=postgres://… npm run test:enforcement    # runs the store half twice

import { randomUUID } from "node:crypto";
import { AbuseRepository } from "../db/repositories/abuse.ts";
import { EnforcementRepository } from "../db/repositories/enforcement.ts";
import { openTestSqlite, withScratchPostgres } from "../db/testDb.ts";
import type { Db } from "../db/db.ts";
import { newRequestId, systemContext, systemContextFor, type TenantContext } from "../db/tenant.ts";
import { PLANS } from "../billing/plans.ts";
import { AbuseGate } from "./gate.ts";
import {
  ENFORCEMENT_LEVELS,
  LADDER,
  NO_ENFORCEMENT,
  decide,
  enforcementRefusal,
  levelForScore,
  limitsUnderEnforcement,
  refusesWork,
  rungFor,
  severity,
  type EnforcementState,
} from "./enforcement.ts";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

console.log("\nthe ladder");
{
  check(
    LADDER.every((r) => ENFORCEMENT_LEVELS.includes(r.level)),
    "every rung is a level, and every rung is in order",
  );
  check(
    LADDER.map((r) => severity(r.level)).every((s, i, all) => i === 0 || s > all[i - 1]!),
    "...strictly increasing, so `severity` can compare two without knowing the order by heart",
  );
  const automatic = LADDER.filter((r) => r.automatic);
  check(
    automatic.every((r) => severity(r.level) <= severity("verify")),
    "NOTHING AUTOMATIC PASSES `verify` — the two rungs that stop somebody working need a person",
  );
  check(
    automatic.every((r) => r.expiresAfterMs !== null && r.expiresAfterMs > 0),
    "...and every automatic rung expires by itself, so behaving again is enough to be free of one",
  );
  check(
    LADDER.filter((r) => !r.automatic).every((r) => r.expiresAfterMs === null && r.atScore === null),
    "a human decision has no expiry and no score — it ends when a human ends it",
  );
  check(
    LADDER.every((r) => r.explain.length > 30),
    "every rung says what it means in a sentence the person it happened to can read",
  );
  check(
    LADDER.filter((r) => r.automatic).every((r) => (r.atScore ?? 0) > 0),
    "...and every automatic one names the score that reaches it",
  );
}

console.log("\nwhich rung a score reaches");
{
  check(levelForScore(0) === "none", "a quiet workspace is on no rung");
  check(levelForScore(24) === "none", "...and one signal short of the first threshold is still none");
  check(levelForScore(25) === "watch", "one miner run reaches `watch`, which does nothing but record");
  check(levelForScore(70) === "soft_limit", "a pattern reaches the limit");
  check(levelForScore(500) === "verify", "and an enormous score reaches `verify` — and stops there");
  check(levelForScore(100_000) === "verify", "...however enormous. There is no automatic suspension.");
}

console.log("\nwhat a rung does to the limits");
{
  const free = limitsUnderEnforcement("free", {}, "none");
  check(free.platformKeyCeilingUsd === PLANS.free.platformKeyCeilingUsd, "no rung means the plan's own numbers");
  const limited = limitsUnderEnforcement("free", {}, "soft_limit");
  check(limited.platformKeyCeilingUsd === 0, "a soft limit takes the platform's money off the table");
  check(limited.features.byok === true, "...and leaves a workspace on its own key working");
  check(limited.concurrency["run.eval"] === 1, "...and narrows concurrency to one");

  // The negotiated exception loses to the enforcement, which is the whole point of the order.
  const negotiated = limitsUnderEnforcement("scale", { platformKeyCeilingUsd: 9999 }, "soft_limit");
  check(
    negotiated.platformKeyCeilingUsd === 0,
    "a generous negotiated ceiling does not survive the rung — the ladder is applied last",
  );
  check(
    limitsUnderEnforcement("scale", { platformKeyCeilingUsd: 9999 }, "watch").platformKeyCeilingUsd === 9999,
    "...and `watch` changes nothing at all, which is what makes it safe to apply eagerly",
  );

  check(!refusesWork("watch") && !refusesWork("soft_limit"), "the first two rungs slow work down rather than refusing it");
  check(refusesWork("verify") && refusesWork("suspended"), "and the rest refuse to start new work");
  check(enforcementRefusal({ ...NO_ENFORCEMENT, level: "suspended", reason: "x" }).includes("exportable"), "a refusal says the data is still theirs");
  check(rungFor("suspended")!.explain.includes("appealed"), "...and that the decision can be argued with");
}

console.log("\ndeciding");
{
  const now = 1_700_000_000_000;
  const auto = (level: EnforcementState["level"], expiresInMs: number | null): EnforcementState => ({
    level,
    reason: "",
    appliedAt: new Date(now - 1000).toISOString(),
    expiresAt: expiresInMs === null ? null : new Date(now + expiresInMs).toISOString(),
    byHuman: false,
  });

  check(decide(NO_ENFORCEMENT, 10, now).action === "none", "a quiet workspace produces no writes");
  check(decide(NO_ENFORCEMENT, 70, now).action === "apply", "crossing a threshold applies");
  check(decide(NO_ENFORCEMENT, 70, now).level === "soft_limit", "...the rung the score reaches");
  check(decide(auto("soft_limit", 3_600_000), 70, now).action === "none", "the rung already in force is not re-applied");
  check(
    decide(auto("soft_limit", 3_600_000), 200, now).action === "apply",
    "...but a rising score climbs",
  );
  check(decide(auto("soft_limit", 3_600_000), 5, now).action === "lift", "a fallen score lifts rather than stepping down");
  check(decide(auto("soft_limit", -1000), 5, now).action === "lift", "an expired rung with nothing to replace it is lifted");
  check(
    decide(auto("soft_limit", -1000), 200, now).action === "apply",
    "...and an expired one under a rising score is replaced rather than left",
  );

  const human: EnforcementState = { level: "suspended", reason: "manual", appliedAt: "x", expiresAt: null, byHuman: true };
  check(decide(human, 0, now).action === "none", "A HUMAN'S SUSPENSION DOES NOT LAPSE BECAUSE IT WORKED");
  check(decide(human, 5000, now).action === "none", "...nor is it replaced by an automatic rung underneath it");
}

// --- the gate, against a real database -----------------------------------------------------------

async function storeSuite(label: string, db: Db): Promise<void> {
  console.log(`\n${label}`);
  const signals = new AbuseRepository(db);
  const enforcement = new EnforcementRepository(db);
  const [a, b] = await workspaces(db);
  const sys = systemContext(newRequestId());
  const notices: string[] = [];
  const gate = new AbuseGate({
    signals,
    enforcement,
    notify: (_ctx, e) => notices.push(`${e.level}:${e.applied}`),
    log: () => {},
  });

  console.log("  · nothing observed, nothing done");
  {
    check((await gate.evaluate(a)).level === "none", "an evaluation with no signals applies nothing");
    check((await enforcement.history(a)).length === 0, "...and writes no row");
    check((await gate.mayStartWork(a)).ok, "...and work may start");
  }

  console.log("  · a pattern earns a rung");
  {
    for (let i = 0; i < 3; i++) {
      await signals.record(a, { kind: "sandbox.cpu_without_llm", weight: 25, detail: { i } });
    }
    const state = await gate.evaluate(a);
    check(state.level === "soft_limit", `three miner runs reach the soft limit (${state.level})`);
    check(state.expiresAt !== null, "...with an expiry, because it undoes itself");
    check(notices.includes("soft_limit:true"), "...and the workspace is told");
    const rows = await enforcement.history(a);
    check(rows.length === 1 && rows[0]!.applied_by === null, "...recorded as an automatic decision");
    check(
      (rows[0]!.evidence["counts"] as Record<string, number>)["sandbox.cpu_without_llm"] === 3,
      "...with the evidence copied in, since signals are swept before an appeal arrives",
    );
    check((await gate.mayStartWork(a)).ok, "a soft limit still lets work start — it narrows, it does not refuse");
  }

  console.log("  · it does not re-apply itself");
  {
    const before = (await enforcement.history(a)).length;
    await gate.evaluate(a);
    await gate.evaluate(a);
    check((await enforcement.history(a)).length === before, "evaluating again writes nothing while nothing changed");
  }

  console.log("  · a human rung refuses work, and only a human lifts it");
  {
    const actor = a.actorUserId;
    await enforcement.apply({ ...a, actorUserId: actor }, {
      level: "suspended",
      reason: "a person looked at this",
      appliedBy: SOMEBODY,
    });
    gate.invalidate(a.workspaceId);
    const verdict = await gate.mayStartWork(a);
    check(!verdict.ok, "a suspended workspace may not start work");
    check(verdict.ok === false && verdict.state.byHuman, "...and the refusal knows a person decided it");

    // The score has since decayed to nothing, which is exactly what a suspension causes.
    await gate.evaluate(a);
    check(!(await gate.mayStartWork(a)).ok, "...and evaluating does not lift it");

    check(await enforcement.appeal(a, "we were running a benchmark"), "the workspace can appeal");
    check((await enforcement.history(a))[0]!.appeal_note !== null, "...and the appeal is on the record");

    check(await enforcement.lift(a, "appeal upheld", SOMEBODY), "a person can lift it");
    gate.invalidate(a.workspaceId);
    check((await gate.mayStartWork(a)).ok, "...and then work may start again");
    check(!(await enforcement.lift(a, "again")), "lifting nothing is not an error, and not a second row");
  }

  console.log("  · one workspace's rung is its own");
  {
    check((await enforcement.current(b)).level === "none", "B is under nothing while A was suspended");
    check((await enforcement.history(b)).length === 0, "...and sees none of A's history");
    check((await enforcement.workspacesAt(sys, ["suspended"])).length === 0, "nothing is suspended platform-wide now");
  }
}

/** A user id for the "a person did this" rows. Any uuid: the column is a reference, not a login. */
const SOMEBODY = randomUUID();

async function workspaces(db: Db): Promise<[TenantContext, TenantContext]> {
  await db.run(
    `INSERT INTO users (id, external_id, email, display_name, created_at) VALUES (?, ?, ?, ?, ?)`,
    [SOMEBODY, `ext-${SOMEBODY}`, `${SOMEBODY.slice(0, 8)}@example.test`, "An Operator", new Date().toISOString()],
  );
  const out: TenantContext[] = [];
  for (const _ of [0, 1]) {
    const id = randomUUID();
    await db.run(
      `INSERT INTO workspaces (id, slug, name, kind, plan, created_at) VALUES (?, ?, ?, 'team', 'free', ?)`,
      [id, `enf-${id.slice(0, 8)}`, "enforcement", new Date().toISOString()],
    );
    out.push(systemContextFor(id, newRequestId()));
  }
  return [out[0]!, out[1]!];
}

{
  const db = await openTestSqlite();
  try {
    await storeSuite("EnforcementRepository + AbuseGate (SqliteDb)", db);
  } finally {
    await db.close();
  }
}

await withScratchPostgres(async (db) => {
  await storeSuite("EnforcementRepository + AbuseGate (PostgresDb)", db);
});

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
