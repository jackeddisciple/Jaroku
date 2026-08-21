// The three caps, and the two cases in each that decide whether they are usable at all.
//
// EVERY ONE OF THESE FIRES AGAINST REAL CUSTOMERS IF IT IS SPECIFIED SLIGHTLY WRONG, and that is
// the failure mode this suite is about rather than "does the comparison work". A cap that catches
// abuse and also catches Tuesday is a cap somebody switches off in week two, at which point it
// protects nothing at all — so the assertions below are mostly about what must NOT trip:
//
//   the anomaly rule must not fire on a workspace's first real hour of work, where the trailing
//   average is a rounding error and any real usage is a thousand times it;
//
//   the runaway cap must not exist on a plan that includes no credit, where zero times two is
//   zero and every workspace is instantly over;
//
//   the first-week cap must not fire on a workspace whose age could not be read, because a failed
//   lookup is far likelier than a farm and freezing everybody is the worse outage.
//
// AND THE THRESHOLDS ARE READ FROM THE MODULE rather than restated here, so a number that moves
// moves in one place — but the RELATIONSHIPS between them are asserted, because those are the part
// somebody breaks while retuning.
//
//   npm run test:spend-caps

import {
  ANOMALY_MIN_BASELINE_USD, ANOMALY_MULTIPLE, NEW_ACCOUNT_CAP_USD, NEW_ACCOUNT_DAYS,
  RUNAWAY_MULTIPLE, USER_RATE_LIMIT_PER_MINUTE, anomalyBreach, firstBreach, newAccountBreach,
  runawayBreach, type SpendFacts,
} from "./spendCaps.ts";
import { RATE_RULES } from "../http/rateLimit.ts";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

/** An established workspace, comfortably inside every cap. Each block moves one fact. */
const ORDINARY: SpendFacts = {
  ageDays: 90,
  firstWeekPlatformUsd: 0,
  periodPlatformUsd: 5,
  includedCreditUsd: 15,
  lastHourUsd: 0.5,
  trailingDayAverageHourUsd: 0.4,
};

const facts = (over: Partial<SpendFacts>): SpendFacts => ({ ...ORDINARY, ...over });

// ---------------------------------------------------------------------------------------------
console.log("\nan ordinary workspace trips nothing");
// ---------------------------------------------------------------------------------------------
{
  check(firstBreach(ORDINARY) === null, "the baseline is inside every cap");
  // A DAY'S WORK IS NOT AN ANOMALY. Ten times the average is the rule; nine is a busy afternoon.
  check(
    anomalyBreach(facts({ lastHourUsd: 3.9, trailingDayAverageHourUsd: 0.4 })) === null,
    "nine times a busy workspace's average hour is a busy hour, not an anomaly",
  );
  check(
    runawayBreach(facts({ periodPlatformUsd: 29, includedCreditUsd: 15 })) === null,
    "spending nearly twice the included credit is not yet twice it",
  );
}

// ---------------------------------------------------------------------------------------------
console.log("\nfifty dollars in the first week, whatever the plan says");
// ---------------------------------------------------------------------------------------------
{
  const young = { ageDays: 2, firstWeekPlatformUsd: NEW_ACCOUNT_CAP_USD };
  const breach = newAccountBreach(facts(young));
  check(breach?.kind === "new_account", "a two-day-old workspace at the cap is stopped");
  check(breach?.capUsd === NEW_ACCOUNT_CAP_USD, "...against the stated cap");
  // NAMES SUPPORT, NOT AN UPGRADE. For the population this catches, waiting does not help and
  // paying more does not either — somebody has to look.
  check(breach?.message.includes("contact@jaroku.dev") === true, "...and tells them who to write to");
  check(
    breach?.message.includes("upgrade") !== true,
    "...rather than offering a bigger plan to what may be a stolen card",
  );

  check(
    newAccountBreach(facts({ ...young, firstWeekPlatformUsd: NEW_ACCOUNT_CAP_USD - 0.01 })) === null,
    "a cent under the cap is under the cap",
  );

  // THE SAME SPEND ON AN ESTABLISHED WORKSPACE IS ORDINARY. The cap draws "too much, too early"
  // rather than "too much", which is the whole reason it is a separate rule from the ceiling.
  check(
    newAccountBreach(facts({ ageDays: NEW_ACCOUNT_DAYS + 1, firstWeekPlatformUsd: 500 })) === null,
    "the same figure on a workspace past its first week is somebody's normal month",
  );

  // AN UNKNOWN AGE IS TREATED AS ESTABLISHED, which is the one place this file gives the benefit
  // of the doubt: a failed lookup is far likelier than a farm, and freezing every workspace on one
  // is a worse outage than missing one account for an afternoon.
  check(
    newAccountBreach(facts({ ageDays: null, firstWeekPlatformUsd: 500 })) === null,
    "a workspace whose age cannot be read is not frozen on a failed lookup",
  );
}

// ---------------------------------------------------------------------------------------------
console.log("\ntwice the included credit stops and re-checks the card");
// ---------------------------------------------------------------------------------------------
{
  const breach = runawayBreach(facts({ periodPlatformUsd: 30, includedCreditUsd: 15 }));
  check(breach?.kind === "runaway", "twice the included credit trips it");
  check(breach?.capUsd === 15 * RUNAWAY_MULTIPLE, "...at exactly the multiple, not a rounded figure");
  check(
    breach?.message.includes("looping") === true,
    "...and names the likeliest cause, which is an agent rather than a person",
  );

  // A PLAN THAT INCLUDES NOTHING HAS NO RUNAWAY CAP HERE, and that is correct rather than a gap:
  // zero times two is zero, so every Free workspace would be instantly over. Free is bounded by
  // `platformKeyCeilingUsd`, which is a far smaller number.
  check(
    runawayBreach(facts({ periodPlatformUsd: 100, includedCreditUsd: 0 })) === null,
    "a plan with no included credit is bounded by its ceiling instead, not by zero times two",
  );

  // Team's credit is per user and pooled, so the cap scales with the workspace rather than being
  // a constant that a five-person team hits on the second day.
  check(
    runawayBreach(facts({ periodPlatformUsd: 100, includedCreditUsd: 150 })) === null,
    "a bigger included credit is a proportionally bigger cap",
  );
}

// ---------------------------------------------------------------------------------------------
console.log("\nan hour ten times the day's average is frozen, and a first hour is not");
// ---------------------------------------------------------------------------------------------
{
  const breach = anomalyBreach(facts({ lastHourUsd: 40, trailingDayAverageHourUsd: 4 }));
  check(breach?.kind === "anomaly", "ten times the trailing average trips it");
  check(breach?.capUsd === 4 * ANOMALY_MULTIPLE, "...at the stated multiple");
  check(
    breach?.message.includes("paused") === true,
    "...and says inference is paused rather than that something failed",
  );

  // THE ASSERTION THIS RULE LIVES OR DIES BY. Without the floor, a workspace whose trailing day
  // cost two cents has an average hour of a tenth of a cent — and its first real hour of work is a
  // thousand times that. A rule that cries wolf on day one is a rule somebody switches off.
  check(
    anomalyBreach(facts({ lastHourUsd: 5, trailingDayAverageHourUsd: 0.005 })) === null,
    "a workspace's FIRST real hour is not an anomaly, however large the ratio",
  );
  check(
    ANOMALY_MIN_BASELINE_USD > 0,
    "...because the rule refuses to compare against a baseline that is a rounding error",
  );
  // And just past the floor it does apply, or the floor would be a permanent exemption for anybody
  // who stays small.
  check(
    anomalyBreach(facts({ lastHourUsd: 50, trailingDayAverageHourUsd: ANOMALY_MIN_BASELINE_USD })) !== null,
    "...but a baseline at the floor is compared like any other",
  );
}

// ---------------------------------------------------------------------------------------------
console.log("\none breach is reported, in the order the answers are useful");
// ---------------------------------------------------------------------------------------------
{
  // All three at once is a real state — a new account looping — and reporting all of them would be
  // three paragraphs describing one situation.
  const everything = facts({
    ageDays: 1,
    firstWeekPlatformUsd: 200,
    periodPlatformUsd: 200,
    includedCreditUsd: 15,
    lastHourUsd: 200,
    trailingDayAverageHourUsd: 5,
  });
  const breach = firstBreach(everything);
  check(breach?.kind === "new_account", "a new account looping is reported as a new account");
  check(
    newAccountBreach(everything) !== null && runawayBreach(everything) !== null &&
      anomalyBreach(everything) !== null,
    "...even though all three genuinely apply",
  );

  // The order is which sentence somebody should read first: a new account has one thing to do.
  const established = facts({ ageDays: 90, periodPlatformUsd: 200, includedCreditUsd: 15, lastHourUsd: 200, trailingDayAverageHourUsd: 5 });
  check(firstBreach(established)?.kind === "runaway", "an established one looping is reported as a runaway");
}

// ---------------------------------------------------------------------------------------------
console.log("\nthe per-user rate limit is where the specification put it");
// ---------------------------------------------------------------------------------------------
{
  const rule = RATE_RULES["inference.call"];
  check(rule !== undefined, "the inference path has a rule at all");
  check(
    rule?.perMinute === USER_RATE_LIMIT_PER_MINUTE,
    `a hundred a minute (${rule?.perMinute})`,
  );
  // PER USER AND NOT PER WORKSPACE. A Team of twenty legitimately makes twenty times what one
  // person does, so a workspace-scoped limit either throttles the team or is twenty times too
  // loose for the compromised account inside it.
  check(rule?.scope === "user", "...per person, because what is being bounded is one credential");
  // Capacity equal to the rate, so a burst is a minute's worth. A large bucket would let a script
  // take its thousand calls up front and then look well-behaved.
  check(
    rule?.capacity === rule?.perMinute,
    "...and the burst is a minute's worth rather than a reservoir",
  );
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
