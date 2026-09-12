// §2's chat route, in the router.
//
// WHAT THIS SUITE IS FOR, AND WHAT IT MUST NOT BECOME. §2.4 asks for two properties and they pull
// in opposite directions: `chat` has to exist and claim what belongs to it, and the five routes
// that were here before have to be BYTE-UNCHANGED. A suite that only asserted the first would pass
// happily on a router that had quietly swallowed the edit loop.
//
// So the second half is written as a regression table over the routes that existed before this
// commit, driven through the same `classifyIntent` — and `test:plan-flow`, the router's original
// suite, stays untouched and must still pass. Two suites over one function is deliberate here: one
// says what the router learned, the other says what it must not have forgotten.
//
// §3.5'S FORTY-MESSAGE FIXTURE TABLE LANDS IN THIS FILE, in the commit that inverts the default.
// This commit's table is the social subset — the messages no other route can want — because that
// is what this commit actually changed.
//
//   npm run test:chat-route

import { classifyIntent, routeLabel, type ComposerContext } from "./intent.ts";
import type { Step } from "../types.ts";

let fail = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) console.log(`  ok   ${name}`);
  else {
    fail++;
    console.log(`  FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail));
  }
}

/** A failed step, for the selection-aware cases. Only the fields the router reads matter. */
const FAILED: Step = {
  id: "s7", run_id: "r1", seq: 7, type: "tool_call", name: "get_weather",
  input: {}, output: null, state_before: null, state_after: null,
  tokens: null, cost: null, latency_ms: 120, error: "TimeoutError", parent_step_id: null,
  started_at: "2026-09-12T10:00:00.000Z",
};

const OK_STEP: Step = { ...FAILED, id: "s3", seq: 3, error: null };

const route = (text: string, ctx: ComposerContext = { agentId: null }): string =>
  classifyIntent(text, ctx).kind;

// --- the intent exists, and says what it does rather than what it is called ------------------

console.log("\nthe intent");
{
  const i = classifyIntent("hi", { agentId: null });
  check("a social message routes to chat", i.kind === "chat", i);
  // NOT "chat". Every other label in `routeLabel` says what will happen in the words a person
  // would use, and a preview reading the name of a route teaches nobody anything.
  const label = routeLabel(i);
  check("the route label is a sentence, not the mechanism's name", label !== "chat" && label.length > 0, label);
  check("...and it says nothing is built", /build|answer/i.test(label), label);
}

// --- §0's opening example: the greeting that used to cost a plan ------------------------------
//
// EVERY ONE OF THESE ROUTED TO `generate` BEFORE THIS COMMIT, with no agent selected — which is
// the defect §0 opens with: "Hi" produced a plan card, an expensive, visually heavy, multi-step
// artefact, in the first ten seconds of somebody's first session.

console.log("\nsocial messages, with nothing selected");
for (const text of [
  "hi", "hii", "hey", "hello", "Hello!", "hey there", "yo", "howdy", "good morning",
  "thanks", "thank you", "thanks so much", "thx", "ty", "cheers",
  "ok", "okay", "cool", "nice", "great", "perfect", "got it", "sounds good",
  "nvm", "never mind", "bye", "see ya", "test", "ping",
]) {
  check(`"${text}" → chat`, route(text) === "chat", route(text));
}

// --- ...and with an agent selected, where they used to become an EDIT -------------------------
//
// THE OTHER HALF OF THE SAME DEFECT, and the less obvious one. With an agent on screen the
// router's default was `edit`, so "thanks" asked a model to rewrite somebody's agent.

console.log("\nsocial messages, with an agent selected");
for (const text of ["hi", "thanks", "ok", "cool", "bye"]) {
  check(`"${text}" with an agent → chat`, route(text, { agentId: "weather_agent" }) === "chat", route(text, { agentId: "weather_agent" }));
}

// --- the anchors, which are what stop this rule eating real requests -------------------------
//
// `^…$` IS THE WHOLE SAFETY PROPERTY. A rule that matched "thanks" anywhere in a message would
// send "thanks, now fix the retry logic" to a route that cannot edit anything — and the person
// would watch their request produce a pleasantry.

console.log("\na social opener on a real request is still the real request");
{
  const ctx: ComposerContext = { agentId: "weather_agent" };
  check('"thanks, now add a retry" → edit', route("thanks, now add a retry", ctx) === "edit", route("thanks, now add a retry", ctx));
  check('"hi, can you explain the graph" → explain', route("hi, can you explain the graph", ctx) === "explain", route("hi, can you explain the graph", ctx));
  check('"ok so the webhook is wrong" → edit', route("ok so the webhook is wrong", ctx) === "edit", route("ok so the webhook is wrong", ctx));
  // A BUILD REQUEST THAT OPENS WITH A GREETING IS STILL A BUILD REQUEST.
  check('"hey, build me an inbox watcher" → generate', route("hey, build me an inbox watcher", { agentId: null }) === "generate",
    route("hey, build me an inbox watcher", { agentId: null }));
  // AND A WORD INSIDE ANOTHER WORD IS NOT THE WORD.
  check('"testing the retry path against staging" → edit', route("testing the retry path against staging", ctx) === "edit",
    route("testing the retry path against staging", ctx));
}

// --- §2.4: the five routes that were here before, unchanged ----------------------------------
//
// DRIVEN AS A TABLE rather than as prose, because what matters is that NONE of them moved. Each
// row is a route that existed before `chat` did, with the context that claims it.

console.log("\nthe five existing routes are unchanged");
{
  const rows: { text: string; ctx: ComposerContext; want: string; why: string }[] = [
    { text: "an agent that triages support email", ctx: { agentId: null }, want: "generate",
      why: "a description with no agent is still a plan" },
    { text: "drop the summariser", ctx: { agentId: null, pendingPlanId: "p1" }, want: "replan",
      why: "a plan on screen still takes feedback" },
    { text: "when a customer emails, reply with the policy", ctx: { agentId: "draft_1", agentIsDraft: true }, want: "generate",
      why: "a draft still short-circuits to a build into that row" },
    { text: "add a LIMIT clause", ctx: { agentId: "weather_agent" }, want: "edit",
      why: "the default with an agent selected is still an edit" },
    { text: "why did this fail?", ctx: { agentId: "weather_agent", step: FAILED }, want: "explain",
      why: "a question with a step selected still explains it" },
    { text: "what does this node do", ctx: { agentId: "weather_agent", nodeId: "router" }, want: "explain",
      why: "a node still wins over a step for explain" },
    { text: "re-run from here", ctx: { agentId: "weather_agent", step: OK_STEP }, want: "rerun",
      why: "re-run still needs a step and still gets one" },
    { text: "fix this", ctx: { agentId: "weather_agent", step: FAILED }, want: "fix",
      why: "fix still needs a FAILED step" },
    { text: "fix this", ctx: { agentId: "weather_agent", step: OK_STEP }, want: "edit",
      why: "...and a passing step still falls through to edit" },
    { text: "make the tone warmer", ctx: { agentId: "weather_agent", hasReviewComment: true }, want: "edit",
      why: "a review comment still lands on edit" },
  ];
  for (const r of rows) {
    const got = route(r.text, r.ctx);
    check(`${r.want}: ${r.why}`, got === r.want, { text: r.text, got, want: r.want });
  }
}

// --- §2.2: the route carries nothing to write with -------------------------------------------
//
// ASSERTED ON THE SHAPE, which is the only place it can be asserted in a pure function: every
// other intent names the thing it acts on — a plan id, an agent to build into, a step to fix — and
// this one names nothing, so there is nothing for a dispatch to act on even by mistake.

console.log("\nthe chat intent carries nothing actionable");
{
  const i = classifyIntent("hi", { agentId: "weather_agent", pendingPlanId: "p1", step: FAILED });
  check("chat wins over every selection", i.kind === "chat", i);
  check("...and has exactly one field", Object.keys(i).join(",") === "kind", Object.keys(i));
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
