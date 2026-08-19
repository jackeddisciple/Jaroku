// §10's Team pulse and personal summary, as claims.
//
// THE HONEST HALF FIRST. §10 asks for "agents created, edits applied, deploys, runs, spend
// attributed" per member. Three of those five are attributable in this schema and two are not:
// `deployments`, `eval_runs` and `runs` carry no actor column, so nothing anywhere says who started
// a run or who pressed deploy — and `runs` is part of the frozen event schema, which §5.1 says this
// tab does not touch. Spend is attributed THROUGH runs, so it inherits the same silence.
//
// So the card shows what is recorded and says what is not, and this suite asserts the absence
// deliberately rather than leaving it to be discovered. A "0 deploys" beside somebody's name is a
// claim about that person; an absent column is a claim about the schema, which is the true one.
//
// AND THE STREAK, whose two easy mistakes are both here: it must END TODAY, or it is a count of
// active days wearing the wrong word, and it must be measured against the WINDOW rather than the
// clock, or it is the one figure on the page answering a different question.
//
//   npm run test:activity-team

import { randomUUID } from "node:crypto";

import { openTestSqlite } from "../db/testDb.ts";
import { IdentityRepository } from "../db/repositories/identity.ts";
import { AgentRepository } from "../db/repositories/agents.ts";
import { BillingRepository } from "../db/repositories/billing.ts";
import { ThreadStore } from "../threadStore.ts";
import { TraceStore } from "../store.ts";
import { newRequestId, systemContext, systemContextFor, type TenantContext } from "../db/tenant.ts";
import type { Run } from "../types.ts";
import { ActivityStore } from "./activityStore.ts";
import { resolveWindow } from "./range.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const NOW = new Date("2026-08-19T12:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();
const month = resolveWindow("30d", NOW, null);

const db = await openTestSqlite();
const identity = new IdentityRepository(db);
const agents = new AgentRepository(db);
const billing = new BillingRepository(db);
const threads = new ThreadStore(db);
const trace = new TraceStore(db);
const store = new ActivityStore(db);

async function workspace(name: string): Promise<TenantContext> {
  const ws = await identity.createWorkspaceUnowned(systemContext(newRequestId()), {
    name: `${name} ${randomUUID().slice(0, 6)}`,
  });
  return systemContextFor(ws.id, newRequestId());
}

async function person(label: string): Promise<string> {
  const u = await identity.provisionUser(systemContext(newRequestId()), {
    externalId: `${label}-${randomUUID().slice(0, 8)}`,
    email: `${label}-${randomUUID().slice(0, 8)}@example.com`,
  });
  return u.user.id;
}

async function agentBy(ctx: TenantContext, slug: string, by: string | null, at: string): Promise<string> {
  const a = await agents.upsertFromDisk(ctx, { slug, display_name: `Agent ${slug}` });
  await db.forWorkspace(ctx.workspaceId).run(
    `UPDATE agents SET created_by = ?, created_at = ? WHERE id = ?`, [by, at, a.id],
  );
  return a.id;
}

async function versionBy(
  ctx: TenantContext, agentUuid: string, n: number, source: string, by: string | null, at: string,
): Promise<void> {
  await db.forWorkspace(ctx.workspaceId).run(
    `INSERT INTO agent_versions (id, agent_id, version, manifest, source, created_by, created_at)
     VALUES (?, ?, ?, '{}', ?, ?, ?)`,
    [randomUUID(), agentUuid, n, source, by, at],
  );
}

async function runAt(ctx: TenantContext, agent: string, at: string, usd = 0.05): Promise<void> {
  const id = randomUUID();
  await trace.upsertRun(ctx, {
    id, agent_id: agent, provider: "anthropic", model: "claude-haiku-4-5",
    status: "completed", started_at: at, ended_at: at, cost: 0, tokens: 0, error: null,
  } as Run);
  await billing.record(ctx, {
    kind: "llm.provider", idempotencyKey: `team-${id}`, runId: id,
    provider: "anthropic", model: "claude-haiku-4-5", totalTokens: 100, costUsd: usd, occurredAt: at,
  });
}

// --- what a member's contribution is, and what it is not -------------------------------------------

console.log("\nper-member contribution, over what is actually recorded");
{
  const ctx = await workspace("team");
  const ada = await person("ada");
  const bob = await person("bob");

  const a1 = await agentBy(ctx, "alpha", ada, ago(5 * DAY));
  await agentBy(ctx, "beta", bob, ago(4 * DAY));
  await versionBy(ctx, a1, 2, "edit", ada, ago(3 * DAY));
  await versionBy(ctx, a1, 3, "edit", ada, ago(2 * DAY));
  await versionBy(ctx, a1, 4, "generation", bob, ago(DAY));
  await threads.create(ctx, { agentId: null, title: "a session", createdBy: ada });

  const pulse = await store.teamPulse(ctx, month);
  const adaRow = pulse.find((m) => m.userId === ada)!;
  const bobRow = pulse.find((m) => m.userId === bob)!;

  check("both members have a row", pulse.length === 2);
  check("Ada created one agent", adaRow.agentsCreated === 1);
  check("...applied two edits", adaRow.editsApplied === 2, `${adaRow.editsApplied}`);
  check("...and started a thread", adaRow.threadsStarted === 1);
  check("Bob created one agent and published a version", bobRow.agentsCreated === 1 && bobRow.versionsPublished === 1);
  check("...and applied no edits", bobRow.editsApplied === 0);
  // The generation Bob published is not an edit, and Ada's edits are not publishes. Folding the two
  // would make "edits applied" a count of every version anybody wrote.
  check("a generation is not an edit", adaRow.versionsPublished === 0);
  check("the busiest contributor leads", pulse[0]!.userId === ada);

  // THE ABSENCE, ASSERTED. There is no `deploys` and no `runs` on this shape, because there is no
  // column anywhere that could fill one. The card says so rather than showing a zero.
  check(
    "there is no deploy or run column to be wrong about",
    !("deploys" in adaRow) && !("runs" in adaRow) && !("usd" in adaRow),
    Object.keys(adaRow).join(", "),
  );
}

// --- a member who did nothing is absent -----------------------------------------------------------------

console.log("\na member with nothing to show has no row");
{
  const ctx = await workspace("quiet member");
  const ada = await person("ada");
  await person("bob");
  await agentBy(ctx, "alpha", ada, ago(DAY));

  const pulse = await store.teamPulse(ctx, month);
  check("only the contributor appears", pulse.length === 1 && pulse[0]!.userId === ada);
  // §3.5 as a whole row: "0 / 0 / 0" beside somebody's name is a statement about that person.
  check("a row of zeros is not manufactured for the other", !pulse.some((m) => m.agentsCreated === 0));
}

// --- the window bounds the pulse ---------------------------------------------------------------------------

console.log("\ncontribution is inside the range, like every other figure");
{
  const ctx = await workspace("bounded pulse");
  const ada = await person("ada");
  await agentBy(ctx, "old", ada, ago(45 * DAY));
  await agentBy(ctx, "new", ada, ago(2 * DAY));

  const inMonth = await store.teamPulse(ctx, month);
  check("only the agent created inside the range counts", inMonth[0]?.agentsCreated === 1);
  const inDay = await store.teamPulse(ctx, resolveWindow("24h", NOW, null));
  check("and a 24-hour range counts neither", inDay.length === 0);
}

// --- the personal summary --------------------------------------------------------------------------------------

console.log("\nthe personal summary, for a workspace of one");
{
  const ctx = await workspace("personal");
  await agents.upsertFromDisk(ctx, { slug: "busy", display_name: "Busy One" });
  await agents.upsertFromDisk(ctx, { slug: "idle", display_name: "Idle One" });
  for (let i = 0; i < 5; i++) await runAt(ctx, "busy", ago(2 * HOUR + i * 60_000), 0.10);
  await runAt(ctx, "idle", ago(3 * HOUR), 0.10);

  const me = await store.personalSummary(ctx, month);
  check("the most active agent is the one that ran most", me.mostActiveAgent?.agentId === "busy");
  check("...named, not slugged", me.mostActiveAgent?.name === "Busy One");
  check("...with its count", me.mostActiveAgent?.runs === 5);
  check("the run total is every run", me.runs === 6);
  check("the spend is the workspace's own rollup", Math.round(me.usd * 100) === 60, `$${me.usd}`);
  check("and it is complete", me.costKnown);
}

// --- the streak ---------------------------------------------------------------------------------------------------

console.log("\na streak ends today, or it is a count of active days wearing the wrong word");
{
  const ctx = await workspace("streak");
  await agents.upsertFromDisk(ctx, { slug: "daily", display_name: "Daily" });
  // Four days in a row, ending on the window's last day.
  for (let d = 0; d < 4; d++) await runAt(ctx, "daily", ago(d * DAY + HOUR));

  const me = await store.personalSummary(ctx, month);
  check("four consecutive days is a streak of four", me.streakDays === 4, `${me.streakDays}`);

  // A gap ends it. Runs on days 6, 7 and 8 do not extend a streak that broke on day 5.
  const ctx2 = await workspace("broken streak");
  await agents.upsertFromDisk(ctx2, { slug: "daily", display_name: "Daily" });
  for (const d of [0, 1, 2, 4, 5, 6, 7]) await runAt(ctx2, "daily", ago(d * DAY + HOUR));
  const broken = await store.personalSummary(ctx2, month);
  check("a gap ends it at three, not seven", broken.streakDays === 3, `${broken.streakDays}`);

  // AND IT ENDS TODAY. A workspace busy last week and quiet since has no streak at all — which is
  // the whole point of the word, and the thing a count of active days would get wrong.
  const ctx3 = await workspace("stale streak");
  await agents.upsertFromDisk(ctx3, { slug: "daily", display_name: "Daily" });
  for (const d of [3, 4, 5, 6, 7]) await runAt(ctx3, "daily", ago(d * DAY + HOUR));
  const stale = await store.personalSummary(ctx3, month);
  check("five days last week with nothing since is a streak of zero", stale.streakDays === 0, `${stale.streakDays}`);
  check("...though the runs are still counted", stale.runs === 5);
}

// --- an empty workspace ---------------------------------------------------------------------------------------------

console.log("\na workspace that has done nothing says so rather than showing zeros");
{
  const ctx = await workspace("brand new");
  const me = await store.personalSummary(ctx, month);
  check("no most-active agent, rather than one with zero runs", me.mostActiveAgent === null);
  check("no runs", me.runs === 0);
  check("no streak", me.streakDays === 0);
  check("and a complete cost, because nothing is missing from nothing", me.costKnown);

  const pulse = await store.teamPulse(ctx, month);
  check("and an empty team pulse", pulse.length === 0);
}

await db.close();
console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
