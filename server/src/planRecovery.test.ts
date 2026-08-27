// WHAT A FAILED BUILD COSTS, which used to be the whole plan.
//
// `take()` is called with the comment "spend it: this generation is now certain to start" — and
// every refusal above it is checked against `peek()` first, precisely so that a refused click does
// not burn the approval. That care stops at the word START. A generation that starts and is then
// refused by the validator wrote nothing, published no version and left no agent, and it had
// already consumed the plan on its way there.
//
// WHAT THE USER SEES WHEN THAT HAPPENS is a card with no Generate, no Revise and no Discard — the
// footer renders for `pending` and `stale` only, and a spent plan is neither — an empty composer,
// and an error message that says "Nothing was written — any previous agent is untouched". That
// sentence is true and reads as "nothing was lost", while the plan is exactly what has been. The
// only way forward was to re-type the brief and pay for a second planning call.
//
// THE ASSERTIONS THAT MATTER ARE THE REFUSALS. A `restore` that always restored would resurrect a
// card the user has visibly replaced by describing a different agent, and would put a plan back
// after a build that succeeded — offering to generate a second time from an approval already spent
// on the agent now sitting on disk.
//
//   npm run test:plan-recovery

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { Planner, type PendingPlan } from "./planner.ts";

const SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNTIME_DIR = resolve(SERVER_DIR, "..", "runtime");
const FIXTURE = join(SERVER_DIR, "fixtures", "plan-support-bot.txt");

let failures = 0;
const check = (ok: boolean, msg: string, detail = ""): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}${detail ? ` — ${detail}` : ""}`);
  }
};

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

/** One plan, off the recorded fixture, resolved when the card would appear. */
function planFor(planner: Planner, workspaceId: string): Promise<string> {
  return new Promise((done, fail) => {
    planner.once("plan", (p) => done(p.planId));
    planner.once("error", (e) => fail(new Error(e.message)));
    void planner.plan({ runtimeDir: RUNTIME_DIR, workspaceId, prompt: "a support bot" });
  });
}

process.env.JAROKU_PLAN_FIXTURE = FIXTURE;
check(readFileSync(FIXTURE, "utf8").length > 0, "the recorded plan fixture is there");

const planner = new Planner();

console.log("\na generation that fails validation gives the plan back");
{
  const planId = await planFor(planner, A);
  // What index.ts does when the build starts.
  const spent = planner.take(A, planId) as PendingPlan;
  check(spent?.planId === planId, "the build spent it");
  check(planner.peek(A) === null, "...so there is nothing to generate from while it runs");

  // And what it does now when the validator refuses the result.
  check(planner.restore(A, spent) === true, "the failure puts it back");
  check(planner.peek(A)?.planId === planId, "...and the card can be acted on again");
  // The retry is the same command with the same id — the whole point of restoring rather than
  // asking the user to describe the agent a second time.
  check(planner.take(A, planId)?.planId === planId, "...by the id the card already holds");
  planner.restore(A, spent);
}

console.log("\nthe approval that came back is the SAME approval");
{
  const rec = planner.peek(A);
  check(rec?.prompt === "a support bot", "the brief is the one that was reviewed", rec?.prompt);
  check(Boolean(rec?.plan?.raw), "...and the plan text came back with it");
  // A restored plan must not read as a fresh one: the revision is what the card's own heading and
  // the planner's supersede rule are both counted on.
  check(typeof rec?.revision === "number", "...carrying its revision", String(rec?.revision));
}

console.log("\nit is refused when the workspace has moved on");
{
  const stale = planner.take(A, planner.peek(A)!.planId) as PendingPlan;
  // Somebody described a different agent while the failing build was running.
  const newer = await planFor(planner, A);
  check(planner.peek(A)?.planId === newer, "a newer plan holds the slot");
  check(planner.restore(A, stale) === false, "the old one is NOT put back over it");
  check(planner.peek(A)?.planId === newer, "...and the newer card is untouched");
}

console.log("\nrestoring is scoped like everything else the slot does");
{
  const mine = planner.take(A, planner.peek(A)!.planId) as PendingPlan;
  check(planner.restore(B, mine) === true, "B's empty slot accepts a record handed to it");
  check(planner.peek(B)?.planId === mine.planId, "...into B, not into A");
  check(planner.peek(A) === null, "A's slot stays empty — restore never touches another tenant's");
  planner.take(B, mine.planId);
}

console.log("\na second restore of the same record cannot double-fill the slot");
{
  const planId = await planFor(planner, A);
  const spent = planner.take(A, planId) as PendingPlan;
  check(planner.restore(A, spent) === true, "the first restore takes");
  check(planner.restore(A, spent) === false, "the second is refused");
  check(planner.peek(A)?.planId === planId, "...and one plan is pending, not two");
  planner.take(A, planId);
}

console.log("\nand a plan that was DISCARDED stays discarded");
{
  const planId = await planFor(planner, A);
  planner.discard(A, planId);
  check(planner.peek(A) === null, "discarding empties the slot");
  // The client refuses this half too — `planRestored` only moves a turn out of `accepted` — but
  // the server is where a discarded plan must not become takeable again by a late failure event.
  check(planner.take(A, planId) === null, "...and the id is not spendable afterwards");
}

delete process.env.JAROKU_PLAN_FIXTURE;
console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
