// Whose plan the pending slot holds.
//
// A plan is one slot in one process, and the two commands that reach it — `generate` with a
// `planId`, and `discardPlan` — carry an id and nothing else. So the slot answered to whoever
// held the id: another workspace could SPEND a plan it never wrote, building its own agent from
// somebody else's reviewed design and prompt, or DISCARD one between the user reading the card
// and pressing Generate.
//
// The scope check is what this suite is about; the parsing is planProtocol.test.ts's.
//
//   npm run test:plan

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { Planner } from "./planner.ts";

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
// Read once so a missing fixture is a clear failure rather than a live model call.
check(readFileSync(FIXTURE, "utf8").length > 0, "the recorded plan fixture is there");

const planner = new Planner();
const planId = await planFor(planner, A);

console.log("\nanother workspace holding the plan id");
{
  check(planner.peek(B) === null, "B cannot see A's pending plan");
  check(planner.peek(A)?.planId === planId, "...while A can");
  check(planner.take(B, planId) === null, "B cannot spend it");
  check(planner.peek(A)?.planId === planId, "...and it is still A's to spend afterwards");

  planner.discard(B, planId);
  check(planner.peek(A)?.planId === planId, "B discarding it does nothing");

  const taken = planner.take(A, planId);
  check(taken?.planId === planId, "A spends its own plan");
  check(taken?.prompt === "a support bot", "...getting the brief it approved back", taken?.prompt);
  check(planner.peek(A) === null, "...and the slot is empty afterwards");
}

console.log("\nrevising");
{
  const first = await planFor(planner, A);
  let refused = "";
  try {
    await new Promise((done, fail) => {
      planner.once("plan", () => done(null));
      planner.once("error", (e) => fail(new Error(e.message)));
      void planner.plan({
        runtimeDir: RUNTIME_DIR, workspaceId: B, prompt: "make it terser", revisePlanId: first,
      });
    });
  } catch (err) {
    refused = (err as Error).message;
  }
  check(
    refused.includes("no longer available"),
    "B cannot revise A's plan either — a revision reads the plan it revises",
    refused,
  );
}

delete process.env.JAROKU_PLAN_FIXTURE;
console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
