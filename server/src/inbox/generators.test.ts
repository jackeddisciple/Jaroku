// The event-driven generators: what counts as one problem, and what a card is allowed to claim.
//
// THE ASSERTIONS THAT ARE ABOUT SOMETHING NOT HAPPENING are the ones worth the file, because each is
// a card that would look right in a screenshot and be wrong:
//
//   Opening a trace must not bump the failure count. The tempting implementation writes the review
//   stamp through `record`, and `record` means "this happened again" — so reading nine failures
//   would report a tenth and the badge would say ×10.
//
//   A cancelled eval raises nothing. Somebody stopped it on purpose; there is no decision left, and
//   a card asking them to read results they chose not to produce is the second-activity-feed failure
//   §1 warns about.
//
//   An eval's failed runs raise no `unreviewed_failures`. An eval exists to show which target
//   failed — that IS its result — and one card per failed job would bury the single item that
//   matters.
//
//   The run-id list is bounded. It is the only payload field in the feature that grows, and it is
//   broadcast to every socket in the workspace on every failure.
//
//   npm run test:inbox-generators

import { randomUUID } from "node:crypto";

import { openTestSqlite, testContext } from "../db/testDb.ts";
import { InboxStore } from "./inboxStore.ts";
import {
  RUN_IDS_MAX,
  noteDeployFailed,
  noteEvalFinished,
  noteEvalResultsOpened,
  noteMcpStatus,
  noteMemoryDecision,
  noteMemoryProposal,
  noteRunFailed,
  noteTraceOpened,
  type GeneratorDeps,
} from "./generators.ts";
import { isResolved, type InboxFacts } from "./registry.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const ctx = testContext();

/** Enough facts for the two predicates this file drives. The registry's suite covers the rest. */
function facts(): InboxFacts {
  return {
    now: Date.now(),
    configuredSecrets: new Set(),
    agents: new Map(),
    mcpServers: new Map(),
    spendCeilingUsd: null,
    pendingInvites: new Set(),
    memberIds: new Set(),
    hasProviderKey: true,
    agentCount: 1,
    team: false,
  };
}

async function fresh(): Promise<{ deps: GeneratorDeps; inbox: InboxStore; close: () => Promise<void> }> {
  const db = await openTestSqlite();
  const inbox = new InboxStore(db);
  return { deps: { inbox }, inbox, close: () => db.close() };
}

const AGENT = "11111111-1111-4111-8111-111111111111";

// --- 1. failures collapse, and the list they carry is bounded ------------------------------

console.log("\nnine failures of one agent are one card that says nine");
{
  const { deps, inbox, close } = await fresh();

  for (let i = 0; i < 9; i++) {
    await noteRunFailed(deps, ctx, { runId: `run-${i}`, agentUuid: AGENT, agentName: "api_gateway" });
  }
  const open = await inbox.listOpen(ctx);
  check("one row", open.length === 1);
  check("...counting nine", open[0]?.count === 9, `got ${open[0]?.count}`);
  check("...at Attention, because a failure nobody has read is not work that is stopped", open[0]?.severity === "attention");
  check(
    "...keyed by the agent's uuid rather than its slug, so a rename does not orphan the card",
    open[0]?.subject_id === AGENT,
  );

  const ids = open[0]?.payload["run_ids"] as string[];
  check("the newest failure is first, because that is the one somebody will open", ids[0] === "run-8");

  // A second agent is a second problem, however similar it looks.
  await noteRunFailed(deps, ctx, { runId: "run-x", agentUuid: randomUUID(), agentName: "billing" });
  check("a second agent failing is a second card", (await inbox.listOpen(ctx)).length === 2);

  await close();
}

console.log("\nthe one payload field that grows is the one with a cap on it");
{
  const { deps, inbox, close } = await fresh();
  for (let i = 0; i < RUN_IDS_MAX + 15; i++) {
    await noteRunFailed(deps, ctx, { runId: `run-${i}`, agentUuid: AGENT, agentName: "api_gateway" });
  }
  const item = (await inbox.listOpen(ctx))[0]!;
  const ids = item.payload["run_ids"] as string[];
  check(`the list stops at ${RUN_IDS_MAX}`, ids.length === RUN_IDS_MAX, `got ${ids.length}`);
  check("...keeping the newest", ids[0] === `run-${RUN_IDS_MAX + 14}`);
  check(
    "...while the count is the honest total, which is what the badge reads",
    item.count === RUN_IDS_MAX + 15,
    `got ${item.count}`,
  );
  await close();
}

// --- 2. opening a trace resolves it, and does not inflate it -------------------------------

console.log("\nopening a trace is not a tenth failure");
{
  const { deps, inbox, close } = await fresh();
  for (let i = 0; i < 9; i++) {
    await noteRunFailed(deps, ctx, { runId: `run-${i}`, agentUuid: AGENT, agentName: "api_gateway" });
  }
  const before = (await inbox.listOpen(ctx))[0]!;
  check("the predicate says the card is still unresolved", !isResolved(before, facts()));

  const hit = await noteTraceOpened(deps, ctx, "run-4", "2026-08-19T12:00:00.000Z");
  const after = (await inbox.listOpen(ctx))[0]!;
  check("opening one of its traces is recorded", hit);
  check(
    "...and the count is still nine, because reading a failure is not another failure",
    after.count === 9,
    `got ${after.count}`,
  );
  check("...and `last_seen_at` did not move either", after.last_seen_at === before.last_seen_at);
  check("...but the predicate now says resolved, with nothing pressed on the card", isResolved(after, facts()));

  check(
    "opening a trace no card mentions is a no-op rather than an error",
    (await noteTraceOpened(deps, ctx, "run-nobody-has")) === false,
  );
  await close();
}

// --- 3. a deploy that failed --------------------------------------------------------------

console.log("\na failed deploy is Blocking, and two attempts are two cards");
{
  const { deps, inbox, close } = await fresh();

  await noteDeployFailed(deps, ctx, {
    deploymentId: "dep-1", agentUuid: AGENT, agentName: "api_gateway", error: "image build failed",
  });
  await noteDeployFailed(deps, ctx, {
    deploymentId: "dep-2", agentUuid: AGENT, agentName: "api_gateway", error: "health gate timed out",
  });

  const open = await inbox.listOpen(ctx);
  check("two attempts are two cards, because each has its own build log to open", open.length === 2);
  check("...both Blocking, because the deploy did not happen", open.every((i) => i.severity === "blocking"));
  check(
    "...carrying the agent's uuid so the card can name it and the predicate can find it",
    open.every((i) => i.payload["agent_uuid"] === AGENT),
  );

  // The same attempt reported twice is still one card. A retry is a NEW deployment row, so this
  // only happens on a redelivery — and a redelivery must not put a second card on the board.
  await noteDeployFailed(deps, ctx, { deploymentId: "dep-1", agentUuid: AGENT, agentName: "api_gateway" });
  check("...and the same attempt reported twice is still one", (await inbox.listOpen(ctx)).length === 2);

  await close();
}

// --- 4. an eval that finished --------------------------------------------------------------

console.log("\nan eval that finished, one that was stopped, and one somebody cancelled");
{
  const { deps, inbox, close } = await fresh();

  await noteEvalFinished(deps, ctx, { evalId: "ev-1", datasetName: "regression", status: "completed" });
  check("a completed eval raises one card", (await inbox.listOpen(ctx)).length === 1);
  check("...at Attention: there is something to read, not something that is stopped",
    (await inbox.listOpen(ctx))[0]?.severity === "attention");

  await noteEvalFinished(deps, ctx, {
    evalId: "ev-2", datasetName: "pricing", status: "aborted_over_budget", ceilingUsd: 25,
  });
  const types = (await inbox.listOpen(ctx)).map((i) => i.type).sort();
  check(
    "an eval that crossed its ceiling raises TWO, because it is both stopped and readable",
    types.filter((t) => t === "budget_ceiling_hit").length === 1 && types.filter((t) => t === "eval_finished").length === 2,
    types.join(","),
  );
  const ceiling = (await inbox.listOpen(ctx)).find((i) => i.type === "budget_ceiling_hit")!;
  check("...and the ceiling card names the number it was measured against", ceiling.payload["ceiling_usd"] === 25);
  check("...at Blocking", ceiling.severity === "blocking");

  const before = (await inbox.listOpen(ctx)).length;
  await noteEvalFinished(deps, ctx, { evalId: "ev-3", datasetName: "smoke", status: "cancelled" });
  check(
    "an eval somebody cancelled raises nothing, because there is no decision left to make",
    (await inbox.listOpen(ctx)).length === before,
  );

  // §2.2's resolve condition, arriving from the Evals tab rather than from the card.
  const opened = await noteEvalResultsOpened(deps, ctx, "ev-1", "2026-08-19T12:00:00.000Z");
  const card = (await inbox.listOpen(ctx)).find((i) => i.type === "eval_finished" && i.subject_id === "ev-1")!;
  check("opening the comparison is recorded", opened);
  check("...and the predicate says resolved, with nothing pressed on the card", isResolved(card, facts()));
  check(
    "...while the OTHER eval's card is untouched",
    !isResolved((await inbox.listOpen(ctx)).find((i) => i.type === "eval_finished" && i.subject_id === "ev-2")!, facts()),
  );

  await close();
}

// --- 5. a recurrence does not inherit reviewed ids ------------------------------------------

console.log("\na card that comes back does not inherit the batch somebody already read");
{
  const { deps, inbox, close } = await fresh();
  await noteRunFailed(deps, ctx, { runId: "run-old", agentUuid: AGENT, agentName: "api_gateway" });
  await noteTraceOpened(deps, ctx, "run-old");
  const settled = (await inbox.listOpen(ctx))[0]!;
  await inbox.resolve(ctx, [settled.id]);

  await noteRunFailed(deps, ctx, { runId: "run-new", agentUuid: AGENT, agentName: "api_gateway" });
  const back = (await inbox.listOpen(ctx))[0]!;
  const ids = back.payload["run_ids"] as string[];
  check("the new failure is the only one on it", ids.length === 1 && ids[0] === "run-new");
  check(
    "...and the review stamp did not carry over, so a fresh failure is not born already read",
    !isResolved(back, facts()),
  );
  check("...counting from one", back.count === 1);

  await close();
}

// --- 6. an MCP server that cannot authenticate ---------------------------------------------

console.log("\nonly a server asking for a credential is an event; unreachable is a duration");
{
  const { deps, inbox, close } = await fresh();

  check(
    "a connected server raises nothing",
    (await noteMcpStatus(deps, ctx, { id: "linear", label: "linear", status: "connected" })) === null,
  );
  check(
    "an unreachable one raises nothing HERE, because §2.2's trigger is a day of it and only the sweep can time that",
    (await noteMcpStatus(deps, ctx, { id: "linear", label: "linear", status: "unreachable" })) === null,
  );
  check("...so the board is still empty", (await inbox.listOpen(ctx)).length === 0);

  const raised = await noteMcpStatus(deps, ctx, {
    id: "linear", label: "linear", server_name: "Linear MCP", status: "auth_required",
  });
  check("a server asking for a credential is Blocking", raised?.severity === "blocking");
  check(
    "...named by what it calls itself, falling back to the label this workspace gave it",
    raised?.payload["server_name"] === "Linear MCP",
  );
  check(
    "...keyed by the server, so a second discovery is not a second card",
    (await noteMcpStatus(deps, ctx, { id: "linear", label: "linear", status: "auth_required" })) !== null &&
      (await inbox.listOpen(ctx)).length === 1,
  );

  await close();
}

// --- 7. the triple, and nothing weaker -----------------------------------------------------

console.log("\na memory is proposed from a failure, a fix and a pass — and from nothing else");
{
  const { deps, inbox, close } = await fresh();
  const edit = { version: 4, created_at: "2026-08-18T10:00:00.000Z", instruction: "retry the 429s" };
  const failure = { id: "run-failed", started_at: "2026-08-18T09:00:00.000Z" };
  const base = { agentUuid: AGENT, agentSlug: "api_gateway", agentName: "API Gateway", passingRunId: "run-passed" };

  check(
    "a pass with no edit behind it proposes nothing",
    (await noteMemoryProposal(deps, ctx, { ...base, edit: null, failure })) === null,
  );
  check(
    "an edit with no failure behind it proposes nothing either — that is somebody changing their mind",
    (await noteMemoryProposal(deps, ctx, { ...base, edit, failure: null })) === null,
  );
  check("...so the board is still empty", (await inbox.listOpen(ctx)).length === 0);

  const proposed = await noteMemoryProposal(deps, ctx, { ...base, edit, failure });
  check("all three legs propose one", proposed !== null);
  check("...as a Proposal rather than something blocking anybody", proposed?.severity === "proposal");
  check(
    "...naming all three pieces of evidence, because a memory that cannot name what produced it must not exist",
    proposed?.payload["failed_run_id"] === "run-failed" &&
      proposed?.payload["passing_run_id"] === "run-passed" &&
      proposed?.payload["version"] === 4,
  );

  await noteMemoryProposal(deps, ctx, { ...base, edit, failure, passingRunId: "run-passed-2" });
  const after = await inbox.listOpen(ctx);
  check("ten runs passing after one fix are one proposal, not ten", after.length === 1);
  check("...counting the passes", after[0]?.count === 2);

  const later = { version: 5, created_at: "2026-08-19T10:00:00.000Z", instruction: "and the 500s" };
  await noteMemoryProposal(deps, ctx, { ...base, edit: later, failure });
  check("a SECOND fix is a second proposal, because it is different evidence", (await inbox.listOpen(ctx)).length === 2);

  // §2.3's resolve condition is the one in the feature that IS the action — stated rather than
  // hidden, and still routed through the predicate so nothing grows a second resolution path.
  const answered = await noteMemoryDecision(deps, ctx, proposed!.id, "rejected");
  const card = (await inbox.listOpen(ctx)).find((i) => i.id === proposed!.id)!;
  check("rejecting it is recorded", answered);
  check("...and the predicate says resolved", isResolved(card, facts()));

  await close();
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
if (fail > 0) process.exit(1);
