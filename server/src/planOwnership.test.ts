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
import { emptyUsage } from "./claude.ts";

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

console.log("\nanother workspace planning beside yours");
{
  // The slot used to be one per PROCESS, and `plan()` cleared whatever was in it. So B asking for a
  // plan destroyed A's — A's Generate answered "that plan is no longer available" with no
  // explanation, and the `discarded` event naming A's plan id went out on B's scope.
  const mine = await planFor(planner, A);
  const discards: { planId: string; workspaceId: string }[] = [];
  planner.on("discarded", (e) => discards.push(e));

  const theirs = await planFor(planner, B);
  check(planner.peek(A)?.planId === mine, "B planning leaves A's card alone", planner.peek(A)?.planId ?? "gone");
  check(planner.peek(B)?.planId === theirs, "...and B has its own");
  check(discards.length === 0, "nothing was discarded to make room", JSON.stringify(discards));

  // Superseding is still real — scoped to the asker, which is the only session the argument for it
  // was ever about.
  const second = await planFor(planner, A);
  check(planner.peek(A)?.planId === second, "A's second plan replaces A's first");
  check(discards.length === 1 && discards[0]?.planId === mine, "...and the first was discarded");
  check(discards[0]?.workspaceId === A, "...with its OWN workspace on the event, not the planner's scope",
    discards[0]?.workspaceId);
  check(planner.peek(B)?.planId === theirs, "...while B's is untouched throughout");
}

delete process.env.JAROKU_PLAN_FIXTURE;

// A deployment with no ANTHROPIC_API_KEY refused every plan with "planning needs the same key
// generation does", although the plan was thinking on the user's own subscription and never read one.
console.log("\na plan on the subscription, on a server with no key");
{
  const savedKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  let asked = 0;
  const onSubscription = new Planner();
  const outcome = await new Promise<{ planId?: string; error?: string }>((done) => {
    onSubscription.once("plan", (p) => done({ planId: p.planId }));
    onSubscription.once("error", (e) => done({ error: e.message }));
    void onSubscription.plan({
      runtimeDir: RUNTIME_DIR,
      workspaceId: A,
      prompt: "a support bot",
      ask: async () => {
        asked++;
        return { raw: readFileSync(FIXTURE, "utf8"), usage: emptyUsage() };
      },
    });
  });
  check(outcome.error === undefined, "the plan is not refused for want of a key", outcome.error);
  check(typeof outcome.planId === "string", "...a plan arrives");
  check(asked === 1, "...and the subscription answered it", `${asked} asks`);
  if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
}

console.log("\nthe planning slot is one per workspace, not one for the server");
{
  const slots = new Planner();
  check(slots.tryClaim("ws-a"), "workspace A can claim a plan slot");
  check(slots.tryClaim("ws-b"), "...and workspace B can claim its own while A's is held");
  check(!slots.tryClaim("ws-a"), "...but A cannot claim a second");
  slots.releaseClaim("ws-b");
  check(slots.inFlight("ws-a") && !slots.inFlight("ws-b"), "B's release leaves A's slot in flight");
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
