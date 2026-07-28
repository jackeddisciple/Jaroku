// The pre-generation gate's client-side state machine.
//
// Two things are worth pinning down here, and neither is visible from the server side.
//
// First, ROUTING. With no agent selected the composer used to have exactly one destination,
// so classifyIntent could return "generate" unconditionally. Now a typed message means one of
// two different things depending on whether a plan is on screen, and getting that backwards
// either strands the user (their correction starts a fresh plan and loses the old one) or
// silently re-plans when they meant to start over.
//
// Second, TURN LIFECYCLE. Plan turns and generation turns share the `pending` thread, and the
// handoff between them is where a double-echoed prompt or an orphaned card would show up.
//
//   npm run test:plan-flow

import { classifyIntent, routeLabel } from "../lib/intent.ts";
import { isPlanning, pendingPlanId, useChatStore, type PlanTurn } from "./chatStore.ts";
import type { AgentPlan, GenUsage } from "../types.ts";

let fail = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) console.log(`  ok   ${name}`);
  else {
    fail++;
    console.log(`  FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail));
  }
}

const PLAN: AgentPlan = {
  tools: [{ name: "pg_query", origin: "connector", connectorId: "postgres", summary: "" }],
  state: [{ name: "messages", type: "MessagesState", purpose: "the conversation" }],
  graph: ["agent → tools → agent"],
  notes: [],
  raw: "<<<PLAN section=\"tools\">>>\n- pg_query — reviewed connector template (postgres)\n<<<ENDPLAN>>>",
  complete: true,
};
const USAGE: GenUsage = {
  input_tokens: 1200, output_tokens: 300,
  cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cost_usd: 0.0027,
};

const store = () => useChatStore.getState();
const reset = () => useChatStore.setState({ threads: {}, pending: [], streamingAgentId: null });
const planTurns = () => store().pending.filter((t): t is PlanTurn => t.role === "jaroku" && t.kind === "plan");
const userTexts = () => store().pending.filter((t) => t.role === "user").map((t) => (t as { text: string }).text);

// --- routing --------------------------------------------------------------------------

// 1 — no agent, no plan: a message asks for a plan, never a generation.
{
  const i = classifyIntent("a support agent", { agentId: null });
  check("no agent, no plan -> generate (the plan gate)", i.kind === "generate", i);
  check("routing hint names the plan, not the build", routeLabel(i) === "plan a new agent", routeLabel(i));
}

// 2 — no agent, plan awaiting a decision: a message revises THAT plan.
{
  const i = classifyIntent("drop the drafting", { agentId: null, pendingPlanId: "p1" });
  check("plan pending -> replan", i.kind === "replan" && i.planId === "p1", i);
  check("routing hint says revise", routeLabel(i) === "revise the plan", routeLabel(i));
}

// 3 — a pending plan must not hijack routing once an agent is selected. Selecting an agent is
//     an unambiguous change of subject, and the edit/explain paths have to keep working.
{
  const i = classifyIntent("add a LIMIT clause", { agentId: "support_bot", pendingPlanId: "p1" });
  check("agent selected beats a pending plan", i.kind === "edit", i);
}

// 4 — question phrasing still routes to explain with an agent selected, plan or no plan.
{
  const i = classifyIntent("why did this fail?", { agentId: "support_bot", pendingPlanId: "p1" });
  check("explain still reachable with a plan pending", i.kind === "explain", i);
}

// --- turn lifecycle -------------------------------------------------------------------

// 5 — a plan streams, settles, and is takeable.
{
  reset();
  store().planStarted("a support agent that looks up orders", 1);
  check("planStarted appends the user's message", userTexts().join("|") === "a support agent that looks up orders", userTexts());
  check("planStarted opens a streaming plan turn", planTurns()[0]?.status === "streaming");
  check("isPlanning true while streaming", isPlanning({ pending: store().pending }) === true);
  check("no plan id to act on yet", pendingPlanId({ pending: store().pending }) === null);

  store().planDelta("<<<PLAN sec");
  store().planDelta("tion=\"tools\">>>");
  check("deltas accumulate for live display", planTurns()[0]?.raw === "<<<PLAN section=\"tools\">>>", planTurns()[0]?.raw);

  store().planReady({ planId: "p1", prompt: "a support agent that looks up orders", plan: PLAN, warnings: ["postgres is selected but unused"], usage: USAGE, revision: 1 });
  check("settles in place — one plan turn, not two", planTurns().length === 1, planTurns().length);
  check("settled status is pending", planTurns()[0]?.status === "pending");
  check("isPlanning false once settled", isPlanning({ pending: store().pending }) === false);
  check("plan id now available to the composer", pendingPlanId({ pending: store().pending }) === "p1");
  check("warnings kept", planTurns()[0]?.warnings.length === 1);
  check("raw replaced by the settled plan", planTurns()[0]?.raw === PLAN.raw);
}

// 6 — confirming: the generation must not echo the user's prompt a second time.
{
  store().genStarted("a support agent that looks up orders");
  check("no duplicate user turn on confirm", userTexts().length === 1, userTexts());
  check("plan marked accepted, not left pending", planTurns()[0]?.status === "accepted");
  check("accepted plan is no longer actionable", pendingPlanId({ pending: store().pending }) === null);
  check("a generation turn was appended", store().pending.some((t) => t.role === "jaroku" && t.kind === "gen"));
}

// 7 — the plan travels with the agent: genDone moves the whole pending thread, so the new
//     agent's conversation opens with the plan that authorised it.
{
  store().genDone("support_bot", ["agent.py"], USAGE);
  check("pending thread drained", store().pending.length === 0);
  const thread = store().threads["support_bot"] ?? [];
  check("plan landed in the agent's thread", thread.some((t) => t.role === "jaroku" && t.kind === "plan"), thread.map((t) => (t.role === "user" ? "user" : t.kind)));
}

// 8 — an UNPLANNED generation still appends its own user turn (the pre-gate behaviour, which
//     the fixtures and any direct client still rely on).
{
  reset();
  store().genStarted("built without a plan");
  check("unplanned generation still echoes the prompt", userTexts().join("|") === "built without a plan", userTexts());
}

// 9 — discard: only a plan still awaiting a decision can be discarded.
{
  reset();
  store().planStarted("x", 1);
  store().planReady({ planId: "p1", prompt: "x", plan: PLAN, warnings: [], usage: USAGE, revision: 1 });
  store().planDiscarded("p1");
  check("discarded plan is marked, not removed", planTurns()[0]?.status === "discarded");
  check("discarded plan is not actionable", pendingPlanId({ pending: store().pending }) === null);

  store().planStarted("y", 1);
  store().planReady({ planId: "p2", prompt: "y", plan: PLAN, warnings: [], usage: USAGE, revision: 1 });
  store().genStarted("y");
  store().planDiscarded("p2");
  check("an accepted plan cannot be un-accepted by a late discard", planTurns()[1]?.status === "accepted", planTurns()[1]?.status);
}

// 10 — staleness greys the plan without destroying it. A stale cost estimate gets blanked;
//      a plan is prose the user may be mid-read, so it stays legible and only loses Generate.
{
  reset();
  store().planStarted("x", 1);
  store().planReady({ planId: "p1", prompt: "x", plan: PLAN, warnings: [], usage: USAGE, revision: 1 });
  store().planStale();
  check("stale status set", planTurns()[0]?.status === "stale");
  check("stale plan keeps its content", planTurns()[0]?.plan?.tools.length === 1);
  check("stale plan still resolves an id (so it can be re-planned)", pendingPlanId({ pending: store().pending }) === "p1");
}

// 11 — a plan error lands on the streaming turn, not as a generation failure.
{
  reset();
  store().planStarted("x", 1);
  store().planError("the model produced no plan");
  check("error attaches to the open plan turn", planTurns()[0]?.status === "error");
  check("error message kept", planTurns()[0]?.error === "the model produced no plan");
}

// 12 — a plan error with nothing streaming (a refused confirm, a stale card in another tab)
//      becomes a conversation note rather than a silent drop.
{
  reset();
  store().planError("that plan is no longer available — describe the agent again");
  const note = store().pending.find((t) => t.role === "jaroku" && t.kind === "info");
  check("orphan plan error becomes an info turn", Boolean(note), store().pending);
  check("no phantom plan turn invented", planTurns().length === 0);
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
