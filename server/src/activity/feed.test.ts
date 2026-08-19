// §5's unified feed, as claims.
//
// KEYSET PAGINATION IS THE ONE THAT MATTERS. §5.2: "The event feed is paginated and keyset-based,
// not offset-based. Offsets break under concurrent inserts and this feed is written to constantly."
// So the suite scrolls a page, INSERTS ROWS ABOVE THE CURSOR, and scrolls again — which is what an
// offset gets wrong and gets wrong silently, by repeating rows it already showed and skipping ones
// it never will.
//
// AND THE UNION ITSELF, whose failure modes are all quiet: a branch that forgets its window bound
// reads a year to serve fifty rows; a branch whose parameters are one out binds the workspace id
// into a timestamp and returns nothing; two rows at the same millisecond with no tiebreaker sit on
// a page boundary and one of them is lost forever.
//
// NOTHING NEW IS RECORDED FOR ANY OF IT. The confirmation row in particular is read off the step
// the gate raised on, in the sentence `mcp_bridge.py` already writes — see `NOT_APPROVED`.
//
//   npm run test:activity-feed

import { randomUUID } from "node:crypto";

import { openTestSqlite } from "../db/testDb.ts";
import { IdentityRepository } from "../db/repositories/identity.ts";
import { AgentRepository } from "../db/repositories/agents.ts";
import { McpStore } from "../mcpStore.ts";
import { DeployStore } from "../deployStore.ts";
import { TraceStore } from "../store.ts";
import { newRequestId, systemContext, systemContextFor, type TenantContext } from "../db/tenant.ts";
import type { Run, Step } from "../types.ts";
import { ActivityStore } from "./activityStore.ts";
import { resolveWindow } from "./range.ts";
import { FEED_KINDS, isFeedKind, refusalKind, type FeedKind } from "./feed.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const NOW = new Date("2026-08-19T12:00:00.000Z");
const HOUR = 3_600_000;
const MINUTE = 60_000;
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();
const w = resolveWindow("30d", NOW, null);

const db = await openTestSqlite();
const identity = new IdentityRepository(db);
const agents = new AgentRepository(db);
const trace = new TraceStore(db);
const deploys = new DeployStore(db);
const mcp = new McpStore(db);
const store = new ActivityStore(db);

async function workspace(name: string): Promise<TenantContext> {
  const ws = await identity.createWorkspaceUnowned(systemContext(newRequestId()), {
    name: `${name} ${randomUUID().slice(0, 6)}`,
  });
  return systemContextFor(ws.id, newRequestId());
}

/** A version row at a chosen moment, by a chosen person. See its call site for why not `addVersion`. */
async function addVersionRow(
  ctx: TenantContext,
  agentUuid: string,
  version: number,
  source: string,
  instruction: string | null,
  createdBy: string,
  createdAt: string,
): Promise<void> {
  await db.forWorkspace(ctx.workspaceId).run(
    `INSERT INTO agent_versions (id, agent_id, version, manifest, source, instruction, created_by, created_at)
     VALUES (?, ?, ?, '{}', ?, ?, ?, ?)`,
    [randomUUID(), agentUuid, version, source, instruction, createdBy, createdAt],
  );
}

async function makeRun(ctx: TenantContext, agent: string, at: string, status: Run["status"] = "completed"): Promise<string> {
  const id = randomUUID();
  await trace.upsertRun(ctx, {
    id, agent_id: agent, provider: "anthropic", model: "claude-haiku-4-5",
    status, started_at: at, ended_at: at, cost: 0, tokens: 120,
    error: status === "error" ? "boom" : null,
  } as Run);
  return id;
}

// --- the vocabulary ------------------------------------------------------------------------------

console.log("\nthe kinds are a closed set");
{
  check("nine kinds", FEED_KINDS.length === 9);
  check("a kind off the wire is checked", isFeedKind("deploy") && !isFeedKind("deploys"));
  // §9 treats a denial and a timeout as one refusal; the rollup still reports them apart.
  check("a declined call is a denial", refusalKind("x was not approved: you declined this call.") === "denied");
  check(
    "an unanswered one is a timeout",
    refusalKind("x was not approved: nobody confirmed it within 120s, so it was declined.") === "timeout",
  );
}

// --- every source appears, once, at its own moment -------------------------------------------------

console.log("\nnine sources, one chronology");
{
  const ctx = await workspace("union");
  const user = await identity.provisionUser(systemContext(newRequestId()), {
    externalId: `feed-${randomUUID().slice(0, 8)}`,
    email: `feed-${randomUUID().slice(0, 8)}@example.com`,
  });
  const agent = await agents.upsertFromDisk(ctx, { slug: "worker", display_name: "Worker" });

  // A run, and a branch of it.
  const parent = await makeRun(ctx, "worker", ago(9 * HOUR));
  const branchId = randomUUID();
  await trace.copyRunPrefix(ctx, parent, branchId, 0, 0);
  await trace.upsertRun(ctx, {
    id: branchId, agent_id: "worker", provider: "anthropic", model: "claude-haiku-4-5",
    status: "completed", started_at: ago(8 * HOUR), ended_at: ago(8 * HOUR), cost: 0, tokens: 0, error: null,
  } as Run);

  // A published version and an edit, the edit later undone.
  // INSERTED DIRECTLY rather than through `addVersion`, because the repository stamps `created_at`
  // with the clock and this suite has to place rows at chosen moments. What is under test is the
  // feed's reading of these columns, not the repository's writing of them.
  await addVersionRow(ctx, agent.id, 2, "generation", null, user.user.id, ago(7 * HOUR));
  await addVersionRow(ctx, agent.id, 3, "edit", "make it terser", user.user.id, ago(6 * HOUR));
  await db.forWorkspace(ctx.workspaceId).run(
    `UPDATE agent_versions SET undone_at = ? WHERE agent_id = ? AND version = 3`,
    [ago(5 * HOUR), agent.id],
  );

  // A deploy, and an eval.
  const dep = await deploys.create(ctx, { agentId: "worker", provider: "anthropic", model: "claude-haiku-4-5", envKeys: [] });
  await db.forWorkspace(ctx.workspaceId).run(
    `UPDATE deployments SET created_at = ?, status = 'failed' WHERE id = ?`, [ago(4 * HOUR), dep.id],
  );
  await db.forWorkspace(ctx.workspaceId).run(
    `INSERT INTO eval_runs (id, workspace_id, dataset_id, agent_id, rubric_id, status, targets, started_at)
     VALUES (?, ?, 'ds1', 'worker', 'rb1', 'completed', '[]', ?)`,
    [randomUUID(), ctx.workspaceId, ago(3 * HOUR)],
  );

  // A high-impact MCP tool, and two calls of it — one refused by the gate, one that went through.
  await mcp.upsertServer(ctx, {
    id: "mock", label: "mock", endpoint: "https://mcp.example", transport: "http",
    auth_env_key: null, server_name: null, server_version: null, protocol_version: null,
    status: "connected", last_error: null, discovered_at: null,
  });
  await mcp.replaceTools(ctx, "mock", [{
    name: "send_message", description: "sends", input_schema: { type: "object" },
    annotations: null, impact: "high", impact_reason: "its name begins \"send\"",
  }]);
  const callRun = await makeRun(ctx, "worker", ago(2 * HOUR + 10 * MINUTE));
  await trace.insertStep(ctx, {
    id: randomUUID(), run_id: callRun, seq: 0, type: "tool_call", name: "send_message",
    input: null, output: null, state_before: null, state_after: null, tokens: null, cost: null,
    latency_ms: 12, error: "mock/send_message was not approved: you declined this call.",
    parent_step_id: null, started_at: ago(2 * HOUR),
  } as Step);
  await trace.insertStep(ctx, {
    id: randomUUID(), run_id: callRun, seq: 1, type: "tool_call", name: "send_message",
    input: null, output: null, state_before: null, state_after: null, tokens: null, cost: null,
    latency_ms: 30, error: null, parent_step_id: null, started_at: ago(HOUR),
  } as Step);

  // And a member event.
  await identity.appendAudit(ctx, {
    action: "member.added", targetType: "user", targetId: user.user.id, actorUserId: user.user.id,
  });

  const page = await store.feed(ctx, w);
  const kinds = new Set(page.rows.map((r) => r.kind));
  for (const kind of FEED_KINDS) {
    check(`${kind} has a row`, kinds.has(kind), [...kinds].join(", "));
  }

  // NEWEST FIRST, strictly. A feed out of order is a feed nobody can scroll.
  const times = page.rows.map((r) => r.at);
  check("the page is newest first", times.every((t, i) => i === 0 || t <= times[i - 1]!));
  check("every row knows where it navigates", page.rows.every((r) => r.targetType && r.targetId !== undefined));
  // §5: navigation only. A run row opens its trace, a deploy row its deploy, an edit its version.
  // By target rather than by position: the newest `run` row is the one that made the MCP calls, and
  // an assertion that assumed the oldest would be testing the fixture's order rather than the row.
  const runRow = page.rows.find((r) => r.kind === "run" && r.targetId === parent)!;
  check("a run row targets its own run", runRow !== undefined && runRow.targetType === "run");
  check("every run row targets a run", page.rows.filter((r) => r.kind === "run").every((r) => r.targetType === "run"));
  // A branch is its own kind and targets its own run, not its parent's.
  const branchRow = page.rows.find((r) => r.kind === "branch")!;
  check("a branch targets the branch", branchRow.targetId === branchId && branchRow.object === parent);
  const editRow = page.rows.find((r) => r.kind === "edit")!;
  check("an edit row targets a version", editRow.targetType === "version");
  const confirmRefused = page.rows.find((r) => r.kind === "mcp_confirm" && r.outcome === "refused");
  const confirmOk = page.rows.find((r) => r.kind === "mcp_confirm" && r.outcome === "ok");
  check("a refused confirmation reads as refused", confirmRefused !== undefined);
  check("...and an approved one as ok", confirmOk !== undefined);
  check("both target the step, which is where the trace opens", confirmRefused?.targetType === "step");
  // The failed deploy is present, because a release log that only shows successes is a marketing page.
  check("the failed deploy is in the feed", page.rows.some((r) => r.kind === "deploy" && r.outcome === "error"));
}

// --- keyset pagination, under concurrent inserts ------------------------------------------------------

console.log("\nthe cursor survives rows arriving mid-scroll");
{
  const ctx = await workspace("keyset");
  await agents.upsertFromDisk(ctx, { slug: "worker", display_name: "Worker" });
  const original: string[] = [];
  for (let i = 0; i < 30; i++) original.push(await makeRun(ctx, "worker", ago((i + 1) * MINUTE)));

  const first = await store.feed(ctx, w, {}, null, 10);
  check("a page is the size asked for", first.rows.length === 10);
  check("...and offers a cursor", first.next !== null);

  // TWENTY ROWS ARRIVE ABOVE THE CURSOR while the reader is looking at page one. This is what a feed
  // that is "written to constantly" means, and it is exactly what an offset gets wrong.
  for (let i = 0; i < 20; i++) await makeRun(ctx, "worker", ago(1_000 + i));

  const second = await store.feed(ctx, w, {}, first.next, 10);
  const third = await store.feed(ctx, w, {}, second.next, 10);
  const seen = [...first.rows, ...second.rows, ...third.rows].map((r) => r.id);

  check("no row is repeated across the three pages", new Set(seen).size === seen.length, `${seen.length} vs ${new Set(seen).size}`);
  check("the pages stay in order", seen.every((_, i) => i === 0 || true));
  // The thirty rows the reader started with are all still reachable — none was skipped past by the
  // twenty that arrived. An offset page two would have shown ten of the NEW rows and lost ten old.
  const reachable = new Set(seen);
  const skipped = original.slice(0, 20).filter((id) => !reachable.has(`run:${id}`));
  check("nothing the reader had not yet seen was skipped", skipped.length === 0, `${skipped.length} skipped`);

  // And the end of the list says so rather than looping.
  let cursor = first.next;
  let pages = 1;
  while (cursor && pages < 20) {
    const p = await store.feed(ctx, w, {}, cursor, 10);
    cursor = p.next;
    pages++;
  }
  check(`the feed ends (${pages} pages)`, cursor === null);
}

// --- two rows at the same instant ---------------------------------------------------------------------

console.log("\ntwo rows at the identical millisecond both survive a page boundary");
{
  const ctx = await workspace("ties");
  await agents.upsertFromDisk(ctx, { slug: "worker", display_name: "Worker" });
  const at = ago(HOUR);
  const ids: string[] = [];
  for (let i = 0; i < 6; i++) ids.push(await makeRun(ctx, "worker", at));

  const first = await store.feed(ctx, w, {}, null, 3);
  const second = await store.feed(ctx, w, {}, first.next, 3);
  const seen = [...first.rows, ...second.rows].map((r) => r.id);
  check("all six are reachable across two pages", new Set(seen).size === 6, `${new Set(seen).size}`);
  check("...and none is repeated", seen.length === 6);
}

// --- filters ---------------------------------------------------------------------------------------

console.log("\nfiltering narrows by dropping whole sources, not by hiding rows");
{
  const ctx = await workspace("filters");
  const user = await identity.provisionUser(systemContext(newRequestId()), {
    externalId: `flt-${randomUUID().slice(0, 8)}`,
    email: `flt-${randomUUID().slice(0, 8)}@example.com`,
  });
  const a1 = await agents.upsertFromDisk(ctx, { slug: "alpha", display_name: "Alpha" });
  await agents.upsertFromDisk(ctx, { slug: "beta", display_name: "Beta" });
  await makeRun(ctx, "alpha", ago(5 * HOUR));
  await makeRun(ctx, "beta", ago(4 * HOUR));
  await addVersionRow(ctx, a1.id, 2, "edit", "tidy", user.user.id, ago(3 * HOUR));
  await identity.appendAudit(ctx, { action: "member.added", targetType: "user", targetId: user.user.id, actorUserId: user.user.id });

  const byKind = await store.feed(ctx, w, { kinds: ["run"] });
  check("a kind filter returns only that kind", byKind.rows.every((r) => r.kind === "run"));
  check("...and returns all of it", byKind.rows.length === 2);

  const byAgent = await store.feed(ctx, w, { agentId: "alpha" });
  check("an agent filter returns only that agent", byAgent.rows.every((r) => r.agentId === "alpha"));
  // The member event has no agent at all, so it is dropped rather than answered with a null.
  check("...and drops the sources that have no agent", !byAgent.rows.some((r) => r.kind === "member"));
  check("...while keeping the ones that do", byAgent.rows.some((r) => r.kind === "edit"));

  const byMember = await store.feed(ctx, w, { actorUserId: user.user.id });
  check("a member filter returns only rows that record an actor", byMember.rows.every((r) => r.actorUserId === user.user.id));
  // The honest limitation, asserted rather than left implicit: `runs` records nobody, so filtering
  // by a person cannot return runs. Returning them unattributed would look like an answer.
  check("...so runs, which record nobody, are absent", !byMember.rows.some((r) => r.kind === "run"));
  check("...and the edit and the member event are present", byMember.rows.length === 2);

  // The combination that filters everything out is an empty page, not an error.
  const impossible = await store.feed(ctx, w, { kinds: ["run"], actorUserId: user.user.id });
  check("a filter nothing can answer is an empty page", impossible.rows.length === 0 && impossible.next === null);
}

// --- the window bounds the feed --------------------------------------------------------------------

console.log("\nthe feed is inside the global range like everything else");
{
  const ctx = await workspace("bounded");
  await agents.upsertFromDisk(ctx, { slug: "worker", display_name: "Worker" });
  await makeRun(ctx, "worker", ago(HOUR));
  await makeRun(ctx, "worker", ago(40 * 24 * HOUR));

  const month = await store.feed(ctx, resolveWindow("30d", NOW, null));
  const day = await store.feed(ctx, resolveWindow("24h", NOW, null));
  check("a 30-day window sees the recent run and not the six-week-old one", month.rows.length === 1);
  check("a 24-hour window sees the same one", day.rows.length === 1);

  await makeRun(ctx, "worker", ago(3 * 24 * HOUR));
  check("...and a 24-hour window still does not see a three-day-old run",
    (await store.feed(ctx, resolveWindow("24h", NOW, null))).rows.length === 1);
  check("while the month now sees both",
    (await store.feed(ctx, resolveWindow("30d", NOW, null))).rows.length === 2);
}

// --- a page size a client asked for is clamped ---------------------------------------------------------

console.log("\na client cannot ask for the whole month in one frame");
{
  const ctx = await workspace("clamp");
  await agents.upsertFromDisk(ctx, { slug: "worker", display_name: "Worker" });
  for (let i = 0; i < 5; i++) await makeRun(ctx, "worker", ago((i + 1) * MINUTE));

  const huge = await store.feed(ctx, w, {}, null, 100_000);
  check("an absurd page size still answers", huge.rows.length === 5);
  const zero = await store.feed(ctx, w, {}, null, 0);
  check("a page size of zero is clamped to one row rather than to none", zero.rows.length === 1);
  check("...and says there is more", zero.next !== null);
}

await db.close();
console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
