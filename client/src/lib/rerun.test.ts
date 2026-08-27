// WHETHER THE ⟳ RENDERS AT ALL, which is the half of §5.4 nothing was checking.
//
// `test:dead-controls` fails a `<button>` with no handler, and it passed this one the whole time —
// the handler was present and did nothing. That is the failure shape the suite documents it cannot
// see, and it is why this predicate is a module with a suite rather than a condition written inline
// in the JSX: the rule "a control that does nothing is worse than no control" is only worth what it
// can be broken by, and what breaks it is a fifth turn kind added a year from now by somebody who
// reads the row and reasonably assumes the row knows.
//
// THE LOAD-BEARING ASSERTION IS THE NEGATIVE ONE. Every check below that a plan, a generation or a
// proposal is NOT re-runnable corresponds to a control that shipped, rendered, promised a re-run in
// its tooltip and sent no frame. A predicate stuck at `true` passes the reply case above it and
// puts all three back.
//
//   npm run test:rerun

import { canRerunTurn } from "./rerun.ts";
import type { ChatTurn } from "../store/chatStore.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const reply = (over: Partial<Extract<ChatTurn, { kind: "reply" }>> = {}): ChatTurn => ({
  id: "t1", role: "jaroku", kind: "reply", status: "done",
  agentId: "example_agent", text: "because the router classified it as a refund",
  itemId: "item-1", ...over,
}) as ChatTurn;

const plan = (over: Record<string, unknown> = {}): ChatTurn => ({
  id: "t2", role: "jaroku", kind: "plan", status: "pending", planId: "plan-1", revision: 1,
  prompt: "a support agent that looks up orders in Postgres", raw: "# Plan", plan: null,
  warnings: [], usage: null, itemId: "item-2", ...over,
}) as ChatTurn;

const gen = (over: Record<string, unknown> = {}): ChatTurn => ({
  id: "t3", role: "jaroku", kind: "gen", status: "done", agentId: "support_bot",
  files: ["agent.py"], usage: null, planUsage: null, itemId: "item-3", ...over,
}) as ChatTurn;

const proposal = (over: Record<string, unknown> = {}): ChatTurn => ({
  id: "t4", role: "jaroku", kind: "proposal", status: "pending", agentId: "support_bot",
  proposalId: "prop-1", summary: "widen the retry window", files: [], streaming: [],
  usage: null, itemId: "item-4", ...over,
}) as ChatTurn;

console.log("\n§5.4 — a reply is the one kind that re-runs as a variant");
{
  check("a filed reply is re-runnable", canRerunTurn(reply()) === true);
  check("...whatever its agent", canRerunTurn(reply({ agentId: "other_agent" })) === true);
  // A reply mid-stream is already covered by the row's own `streaming` disable; this is the other
  // half — the server has not filed the row the second answer would be recorded against.
  check("an unfiled reply is not", canRerunTurn(reply({ itemId: undefined })) === false);
  check("...nor one with an empty id", canRerunTurn(reply({ itemId: "" })) === false);
}

console.log("\nthe three kinds whose ⟳ was inert — each of these is a control that shipped");
{
  check("a plan is not re-runnable", canRerunTurn(plan()) === false);
  check("...not even a settled one", canRerunTurn(plan({ status: "accepted" })) === false);
  check("a generation is not re-runnable", canRerunTurn(gen()) === false);
  check("...not even a failed one", canRerunTurn(gen({ status: "error", error: "validation" })) === false);
  check("an edit proposal is not re-runnable", canRerunTurn(proposal()) === false);
  check("...not even an applied one", canRerunTurn(proposal({ status: "applied" })) === false);
}

console.log("\nthe kinds that carry no response at all");
{
  const user = { id: "t5", role: "user", text: "make it terser" } as unknown as ChatTurn;
  const info = { id: "t6", role: "jaroku", kind: "info", text: "connectors changed", tone: "muted" } as unknown as ChatTurn;
  check("a user turn is not re-runnable", canRerunTurn(user) === false);
  check("an info note is not re-runnable", canRerunTurn(info) === false);
}

console.log("\nthe predicate is not stuck at a constant");
{
  // Both verdicts are reachable from the same shape by changing one field, which is what makes the
  // two blocks above claims rather than a function that returns the same thing twelve times.
  const kinds = [reply(), plan(), gen(), proposal()].map(canRerunTurn);
  check("it says yes to something", kinds.some((v) => v === true));
  check("and no to something", kinds.some((v) => v === false));
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
