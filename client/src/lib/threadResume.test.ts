// §4.5: what the hover promises, and where the conversation actually opens.
//
// The two have to agree. A hover that says "resume at pending diff · +42−11" and then lands at the
// bottom of the conversation is worse than no hover at all — it teaches somebody that the affordance
// lies, and they stop reading it. So the hint is derived from the row's own fragment and the anchor
// from the turns' own statuses, and both are asserted here against the same shapes.
//
//   npm run test:thread-resume

import { firstUnresolvedTurnId, resumeHint } from "./threadResume.ts";
import type { ChatTurn } from "../store/chatStore.ts";
import type { ThreadStatus, ThreadView } from "../types.ts";

let fail = 0;
const eq = (name: string, got: unknown, want: unknown): void => {
  if (got === want) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`); }
};

const row = (status: ThreadStatus, fragment: string | null, archived = false): ThreadView => ({
  id: "t1",
  agent_id: "api_gateway",
  agent_name: "api_gateway",
  agent_deleted: false,
  title: "Stripe webhook retry logic",
  title_is_custom: false,
  created_by: "u1",
  created_at: "2026-08-01T00:00:00.000Z",
  last_activity_at: "2026-08-01T00:00:00.000Z",
  archived_at: archived ? "2026-08-02T00:00:00.000Z" : null,
  status,
  fragment,
  cost_usd: null,
  cost_known: true,
  preview: null,
  live_run_ids: [],
  live_eval_ids: [],
  eval_progress: null,
  agent_active: 1,
  cost_share_high: false,
});

// --- 1. the hint names the destination AND its shape ------------------------------------------
eq("a pending diff, with the numbers the row already shows",
  resumeHint(row("needs_you", "diff pending +42−11")),
  "↵ resume at pending diff · +42−11");
eq("...and the word 'diff' is not said twice",
  (resumeHint(row("needs_you", "diff pending +42−11")) ?? "").split("diff").length - 1,
  1);
eq("a plan awaiting a decision", resumeHint(row("needs_you", "plan awaiting")), "↵ resume at the plan");
eq("a confirmation halting a graph",
  resumeHint(row("needs_you", "confirmation waiting")), "↵ resume at the confirmation");
eq("a refused generation",
  resumeHint(row("needs_you", "generation rejected")), "↵ resume at the refused generation");
eq("a thread that stopped, with how much went wrong",
  resumeHint(row("errored", "3 failed steps")), "↵ resume at the failure · 3 failed steps");
eq("failed steps in a thread that did not stop",
  resumeHint(row("needs_you", "2 failed steps")), "↵ resume at the failure · 2 failed steps");

// --- 2. nothing outstanding means no promise ---------------------------------------------------
eq("an idle thread gets no affordance — the click already means open",
  resumeHint(row("idle", null)), null);
eq("a deployed idle thread likewise", resumeHint(row("idle", "deployed")), null);
eq("a running thread has nothing waiting on a person",
  resumeHint(row("running", "eval 34/120")), null);
eq("an archived one is not resumed, it is restored",
  resumeHint(row("archived", "diff pending +1−1", true)), null);

// --- 3. the anchor: the first unresolved turn, and the fallback --------------------------------
const user = (id: string): ChatTurn => ({ id, role: "user", text: "add exponential backoff" });
const proposal = (id: string, status: "pending" | "applied" | "error"): ChatTurn => ({
  id, role: "jaroku", kind: "proposal", status, agentId: "api_gateway", proposalId: id,
  summary: null, files: [], streaming: [], usage: null,
});
const plan = (id: string, status: "pending" | "accepted" | "error"): ChatTurn => ({
  id, role: "jaroku", kind: "plan", status, planId: id, revision: 1, prompt: "", raw: "",
  plan: null, warnings: [], usage: null,
});
const gen = (id: string, status: "done" | "error"): ChatTurn => ({
  id, role: "jaroku", kind: "gen", status, agentId: "api_gateway", files: [], usage: null, planUsage: null,
});

eq("an empty conversation has no anchor", firstUnresolvedTurnId([]), null);
eq("a finished one has none either",
  firstUnresolvedTurnId([user("u1"), plan("p1", "accepted"), gen("g1", "done"), proposal("d1", "applied")]),
  null);
eq("a pending diff is the anchor",
  firstUnresolvedTurnId([user("u1"), proposal("d1", "applied"), user("u2"), proposal("d2", "pending")]),
  "d2");
eq("THE FIRST one, not the last — where the trouble started is where you read from",
  firstUnresolvedTurnId([proposal("d1", "pending"), proposal("d2", "pending")]),
  "d1");
eq("a plan awaiting a decision is an anchor",
  firstUnresolvedTurnId([user("u1"), plan("p1", "pending")]), "p1");
eq("a refused generation is an anchor",
  firstUnresolvedTurnId([user("u1"), gen("g1", "error")]), "g1");
eq("a failed proposal is an anchor too",
  firstUnresolvedTurnId([proposal("d1", "error")]), "d1");
eq("a user turn is never an anchor — it is not waiting on anybody",
  firstUnresolvedTurnId([user("u1"), user("u2")]), null);

// The pair that matters: a row promising a pending diff has a turn to land on.
{
  const turns = [user("u1"), plan("p1", "accepted"), gen("g1", "done"), proposal("d1", "pending")];
  const hinted = resumeHint(row("needs_you", "diff pending +42−11")) !== null;
  eq("what the hover promises, the conversation can deliver",
    hinted && firstUnresolvedTurnId(turns) === "d1", true);
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
