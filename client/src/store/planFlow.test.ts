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
// Second, TURN LIFECYCLE. A plan turn and the generation turn it authorises share one SESSION,
// and the handoff between them is where a double-echoed prompt or an orphaned card shows up.
//
//   npm run test:plan-flow

import { classifyIntent, routeLabel } from "../lib/intent.ts";
import { isPlanning, pendingPlanId, threadFor, useChatStore, type PlanTurn } from "./chatStore.ts";
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

/** A plan costs a fraction of a generation — that ratio is the point of the gate. */
const PLAN_USAGE: GenUsage = {
  input_tokens: 1410, output_tokens: 480,
  cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cost_usd: 0.0038,
};

/** The one session everything below happens in. Conversations are keyed by thread, not agent. */
const T = "th-1";

const store = () => useChatStore.getState();
const reset = () =>
  useChatStore.setState({ threads: {}, pending: [], streamingAgentId: null, streamingThreadId: null });
const turns = () => threadFor(store(), T);
const planTurns = () => turns().filter((t): t is PlanTurn => t.role === "jaroku" && t.kind === "plan");
const userTexts = () => turns().filter((t) => t.role === "user").map((t) => (t as { text: string }).text);

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

// 4b — the composer must be able to state where a message will go on the new-agent path.
//      Both of these route with agentId === null, which is exactly the case the composer's
//      routing hint used to skip, so the label was unreachable in the UI.
{
  const fresh = classifyIntent("a support agent", { agentId: null });
  const revise = classifyIntent("drop the summariser", { agentId: null, pendingPlanId: "p1" });
  check("both new-agent intents produce a distinct, showable label",
    routeLabel(fresh) !== routeLabel(revise) && routeLabel(fresh).length > 0 && routeLabel(revise).length > 0,
    [routeLabel(fresh), routeLabel(revise)]);
}

// --- turn lifecycle -------------------------------------------------------------------
//
// Every one of these runs inside ONE session, because that is what a conversation is now (§3.1):
// the plan, the generation it authorises and everything after it share a thread id, and the store
// files them by that rather than by the agent the generation happens to produce.

// 5 — a plan streams, settles, and is takeable.
{
  reset();
  store().planStarted({ threadId: T, input: "a support agent that looks up orders", revision: 1 });
  check("planStarted appends the user's message", userTexts().join("|") === "a support agent that looks up orders", userTexts());
  check("planStarted opens a streaming plan turn", planTurns()[0]?.status === "streaming");
  check("isPlanning true while streaming", isPlanning(turns()) === true);
  check("no plan id to act on yet", pendingPlanId(turns()) === null);

  store().planDelta({ threadId: T, text: "<<<PLAN sec" });
  store().planDelta({ threadId: T, text: "tion=\"tools\">>>" });
  check("deltas accumulate for live display", planTurns()[0]?.raw === "<<<PLAN section=\"tools\">>>", planTurns()[0]?.raw);

  store().planReady({ threadId: T, planId: "p1", prompt: "a support agent that looks up orders", plan: PLAN, warnings: ["postgres is selected but unused"], usage: USAGE, revision: 1 });
  check("settles in place — one plan turn, not two", planTurns().length === 1, planTurns().length);
  check("settled status is pending", planTurns()[0]?.status === "pending");
  check("isPlanning false once settled", isPlanning(turns()) === false);
  check("plan id now available to the composer", pendingPlanId(turns()) === "p1");
  check("warnings kept", planTurns()[0]?.warnings.length === 1);
  check("raw replaced by the settled plan", planTurns()[0]?.raw === PLAN.raw);
}

// 6 — confirming: the generation must not echo the user's prompt a second time.
{
  store().genStarted({ threadId: T, prompt: "a support agent that looks up orders" });
  check("no duplicate user turn on confirm", userTexts().length === 1, userTexts());
  check("plan marked accepted, not left pending", planTurns()[0]?.status === "accepted");
  check("accepted plan is no longer actionable", pendingPlanId(turns()) === null);
  check("a generation turn was appended", turns().some((t) => t.role === "jaroku" && t.kind === "gen"));
}

// 7 — the plan and the agent it produced are the SAME session, so nothing has to be moved anywhere
//     on genDone. The server resolves a planned generation's thread from the plan's own id, which
//     is what makes that true on the wire as well as here.
{
  store().genDone({ threadId: T, agentId: "support_bot", files: ["agent.py"], usage: USAGE, planUsage: PLAN_USAGE });
  check("nothing was filed under no session", store().pending.length === 0);
  const gen = turns().find((t) => t.role === "jaroku" && t.kind === "gen") as
    { usage: GenUsage | null; planUsage: GenUsage | null; agentId: string | null } | undefined;
  check("both halves of the cost survive on the turn",
    gen?.usage?.cost_usd === USAGE.cost_usd && gen?.planUsage?.cost_usd === PLAN_USAGE.cost_usd,
    { usage: gen?.usage?.cost_usd, plan: gen?.planUsage?.cost_usd });
  check("the turn learns which agent it built", gen?.agentId === "support_bot");
  check("plan and generation are in one session",
    turns().some((t) => t.role === "jaroku" && t.kind === "plan"),
    turns().map((t) => (t.role === "user" ? "user" : t.kind)));
  check("and nowhere else", store().threads["support_bot"] === undefined);
}

// 7b — THE POINT OF THE RE-KEY: two sessions on one agent are two conversations. Keyed by agent id
//      these were the same array, so opening either showed the other's work.
{
  reset();
  store().editStarted({ threadId: "th-a", agentId: "support_bot", instruction: "rate limiting" });
  store().editStarted({ threadId: "th-b", agentId: "support_bot", instruction: "oauth flow" });
  const a = threadFor(store(), "th-a").filter((t) => t.role === "user").map((t) => (t as { text: string }).text);
  const b = threadFor(store(), "th-b").filter((t) => t.role === "user").map((t) => (t as { text: string }).text);
  check("each session holds only its own instruction",
    a.join("|") === "rate limiting" && b.join("|") === "oauth flow", { a, b });
}

// 7c — reopening a thread rebuilds it from what the server kept (§4.5).
{
  reset();
  store().hydrate(T, [
    { id: "item-1", kind: "message", role: "user", body: "why is it 401ing?", ref_id: null, created_at: "2026-08-17T00:00:00.000Z" },
    { id: "item-2", kind: "proposal", role: null, body: null, ref_id: "prop-1", created_at: "2026-08-17T00:00:01.000Z" },
  ]);
  const texts = turns().map((t) => (t.role === "user" ? t.text : (t as { text?: string }).text));
  check("the user's own turn comes back", texts[0] === "why is it 401ing?", texts);
  check("and what it caused, as a note rather than a revived card", texts[1] === "Proposed an edit.", texts);
  check("a hydrate is a replace", turns().length === 2, turns().length);
  // THE DURABLE ID SURVIVES, which is what §7's notes, pins, feedback and attachments key on. It
  // used to be dropped here, so a hydrated turn's only id was a local counter that changed on every
  // reload — and a note filed against one would have moved to a different turn the next time the
  // thread was opened.
  const anchors = turns().map((t) => (t as { itemId?: string }).itemId);
  check("each turn keeps the row id the server knows it by", anchors.join("|") === "item-1|item-2", anchors);
}

// 8 — an UNPLANNED generation still appends its own user turn (the pre-gate behaviour, which
//     the fixtures and any direct client still rely on).
{
  reset();
  store().genStarted({ threadId: T, prompt: "built without a plan" });
  check("unplanned generation still echoes the prompt", userTexts().join("|") === "built without a plan", userTexts());
}

// 9 — discard: only a plan still awaiting a decision can be discarded.
{
  reset();
  store().planStarted({ threadId: T, input: "x", revision: 1 });
  store().planReady({ threadId: T, planId: "p1", prompt: "x", plan: PLAN, warnings: [], usage: USAGE, revision: 1 });
  store().planDiscarded({ threadId: T, planId: "p1" });
  check("discarded plan is marked, not removed", planTurns()[0]?.status === "discarded");
  check("discarded plan is not actionable", pendingPlanId(turns()) === null);

  store().planStarted({ threadId: T, input: "y", revision: 1 });
  store().planReady({ threadId: T, planId: "p2", prompt: "y", plan: PLAN, warnings: [], usage: USAGE, revision: 1 });
  store().genStarted({ threadId: T, prompt: "y" });
  store().planDiscarded({ threadId: T, planId: "p2" });
  check("an accepted plan cannot be un-accepted by a late discard", planTurns()[1]?.status === "accepted", planTurns()[1]?.status);
}

// 9b — a revision supersedes its predecessor. The server takes the old plan's slot when it
//      re-plans, so a card left showing Generate would hold an id that can only be refused.
//      Found in the browser: the old card sat there looking perfectly clickable.
{
  reset();
  store().planStarted({ threadId: T, input: "a support agent", revision: 1 });
  store().planReady({ threadId: T, planId: "p1", prompt: "a support agent", plan: PLAN, warnings: [], usage: USAGE, revision: 1 });
  store().planStarted({ threadId: T, input: "drop the summariser", revision: 2 });
  check("predecessor marked superseded", planTurns()[0]?.status === "superseded", planTurns()[0]?.status);
  check("superseded plan is not actionable", pendingPlanId(turns()) === null);

  store().planReady({ threadId: T, planId: "p2", prompt: "a support agent", plan: PLAN, warnings: [], usage: USAGE, revision: 2 });
  check("only the revision is actionable", pendingPlanId(turns()) === "p2");
  check("revision number carried", planTurns()[1]?.revision === 2);
}

// 10 — staleness greys the plan without destroying it. A stale cost estimate gets blanked;
//      a plan is prose the user may be mid-read, so it stays legible and only loses Generate.
{
  reset();
  store().planStarted({ threadId: T, input: "x", revision: 1 });
  store().planReady({ threadId: T, planId: "p1", prompt: "x", plan: PLAN, warnings: [], usage: USAGE, revision: 1 });
  store().planStale(T, true);
  check("stale status set", planTurns()[0]?.status === "stale");
  check("stale plan keeps its content", planTurns()[0]?.plan?.tools.length === 1);
  check("stale plan still resolves an id (so it can be re-planned)", pendingPlanId(turns()) === "p1");

  // Putting the selection back must undo it. Staleness is a comparison, not a latch: the fix for
  // a mis-clicked connector must not cost another plan.
  store().planStale(T, false);
  check("restoring the selection un-stales the plan", planTurns()[0]?.status === "pending");
  check("un-staled plan keeps its content", planTurns()[0]?.plan?.tools.length === 1);
}

// 11 — a plan error lands on the streaming turn, not as a generation failure.
{
  reset();
  store().planStarted({ threadId: T, input: "x", revision: 1 });
  store().planError({ threadId: T, message: "the model produced no plan" });
  check("error attaches to the open plan turn", planTurns()[0]?.status === "error");
  check("error message kept", planTurns()[0]?.error === "the model produced no plan");
}

// 12 — a plan error with nothing streaming (a refused confirm, a stale card in another tab)
//      becomes a conversation note rather than a silent drop. A refusal carries no session, so it
//      lands in `pending`: filing another tab's refusal into whatever this one has open is how a
//      conversation acquires turns that were never part of it.
{
  reset();
  store().planError({ message: "that plan is no longer available — describe the agent again" });
  const note = store().pending.find((t) => t.role === "jaroku" && t.kind === "info");
  check("orphan plan error becomes an info turn", Boolean(note), store().pending);
  check("it belongs to no session", threadFor(store(), T).length === 0);
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
