// §8's release timeline, as claims.
//
// "INCLUDE FAILED DEPLOYS. A release log that only shows successes is a marketing page." That is the
// assertion this suite leads with, because it is the one a well-meaning implementation gets wrong:
// filtering to `status = 'live'` produces a timeline that looks tidier, reads as a record of what is
// running, and hides the Tuesday three agents went out and two of them failed — which is the exact
// view §8 says the per-agent Deploy panel cannot give you.
//
// AND THE URL IS ONLY ON WHAT IS ACTUALLY SERVING. A URL on a failed deploy links to nothing; one on
// a superseded deploy points at whatever is there now, which is a different release. The Agents card
// puts the same guard on its drift badge, for the same reason.
//
// AN EDIT IS NOT A RELEASE. It publishes a version and the feed shows it; putting every edit in the
// release log would bury the four things that shipped this week under forty that did not.
//
//   npm run test:activity-releases

import { randomUUID } from "node:crypto";

import { openTestSqlite } from "../db/testDb.ts";
import { IdentityRepository } from "../db/repositories/identity.ts";
import { AgentRepository } from "../db/repositories/agents.ts";
import { DeployStore } from "../deployStore.ts";
import { newRequestId, systemContext, systemContextFor, type TenantContext } from "../db/tenant.ts";
import { ActivityStore } from "./activityStore.ts";
import { resolveWindow } from "./range.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const NOW = new Date("2026-08-19T12:00:00.000Z");
const HOUR = 3_600_000;
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();
const w = resolveWindow("30d", NOW, null);

const db = await openTestSqlite();
const identity = new IdentityRepository(db);
const agents = new AgentRepository(db);
const deploys = new DeployStore(db);
const store = new ActivityStore(db);

async function workspace(name: string): Promise<TenantContext> {
  const ws = await identity.createWorkspaceUnowned(systemContext(newRequestId()), {
    name: `${name} ${randomUUID().slice(0, 6)}`,
  });
  return systemContextFor(ws.id, newRequestId());
}

async function version(
  ctx: TenantContext, agentUuid: string, n: number, source: string, at: string, by: string | null,
): Promise<void> {
  await db.forWorkspace(ctx.workspaceId).run(
    `INSERT INTO agent_versions (id, agent_id, version, manifest, source, created_by, created_at)
     VALUES (?, ?, ?, '{}', ?, ?, ?)`,
    [randomUUID(), agentUuid, n, source, by, at],
  );
}

async function deploy(
  ctx: TenantContext, agent: string, at: string, status: string, opts: { version?: number | null; url?: string | null } = {},
): Promise<string> {
  const d = await deploys.create(ctx, { agentId: agent, provider: "anthropic", model: "claude-haiku-4-5", envKeys: ["OPENAI_KEY"] });
  await db.forWorkspace(ctx.workspaceId).run(
    `UPDATE deployments SET created_at = ?, status = ?, version = ?, url = ? WHERE id = ?`,
    [at, status, opts.version ?? null, opts.url ?? null, d.id],
  );
  return d.id;
}

// --- a bad Tuesday --------------------------------------------------------------------------------

console.log("\nthree agents went out and two of them failed");
{
  const ctx = await workspace("tuesday");
  for (const slug of ["alpha", "beta", "gamma"]) {
    await agents.upsertFromDisk(ctx, { slug, display_name: `Agent ${slug}` });
  }
  await deploy(ctx, "alpha", ago(3 * HOUR), "live", { version: 4, url: "https://alpha.example" });
  await deploy(ctx, "beta", ago(2 * HOUR), "failed", { version: 2 });
  await deploy(ctx, "gamma", ago(HOUR), "failed", { version: 7 });

  const log = await store.releases(ctx, w);
  check("all three are in the log", log.filter((e) => e.kind === "deploy").length === 3);
  check("two of them are failures", log.filter((e) => e.outcome === "error").length === 2);
  // The whole point of §8, stated as the assertion: filtering to what is live would leave one row.
  check("...which a log of successes would have hidden", log.filter((e) => e.outcome === "ok").length === 1);
  check("each names its agent by display name", log.every((e) => e.agentName.startsWith("Agent ")));
  check("and carries the version it built from", log.find((e) => e.agentId === "gamma")?.version === 7);
}

// --- the URL is a link to something that exists --------------------------------------------------------

console.log("\na URL only appears on a deploy that is actually serving");
{
  const ctx = await workspace("urls");
  await agents.upsertFromDisk(ctx, { slug: "worker", display_name: "Worker" });
  await deploy(ctx, "worker", ago(4 * HOUR), "live", { version: 1, url: "https://live.example" });
  await deploy(ctx, "worker", ago(3 * HOUR), "failed", { version: 2, url: "https://never.example" });
  await deploy(ctx, "worker", ago(2 * HOUR), "superseded", { version: 3, url: "https://old.example" });
  await deploy(ctx, "worker", ago(HOUR), "building", { version: 4 });

  const log = await store.releases(ctx, w);
  const live = log.find((e) => e.outcome === "ok")!;
  check("the live one has its URL", live.url === "https://live.example");
  check("the failed one does not, because it links to nothing", log.find((e) => e.version === 2)?.url === null);
  check("nor does the superseded one, which would link to a different release", log.find((e) => e.version === 3)?.url === null);
  check("a deploy in flight reads as running", log.find((e) => e.version === 4)?.outcome === "running");
}

// --- an edit is not a release ---------------------------------------------------------------------------

console.log("\nan edit publishes a version and is not a release");
{
  const ctx = await workspace("edits");
  const agent = await agents.upsertFromDisk(ctx, { slug: "worker", display_name: "Worker" });
  await version(ctx, agent.id, 2, "generation", ago(5 * HOUR), null);
  for (let i = 0; i < 8; i++) await version(ctx, agent.id, 3 + i, "edit", ago((4 - i * 0.1) * HOUR), null);
  await version(ctx, agent.id, 20, "deploy", ago(HOUR), null);

  const log = await store.releases(ctx, w);
  check("the generation is a release", log.some((e) => e.detail === "generation"));
  check("the deploy build is a release", log.some((e) => e.detail === "deploy"));
  check("none of the eight edits is", !log.some((e) => e.detail === "edit"));
  // Which is the argument: the log would otherwise be eight-tenths edits.
  check("so the log is two rows rather than ten", log.length === 2, `${log.length}`);
}

// --- who published it ------------------------------------------------------------------------------------

console.log("\na publish records who, and a deploy records nobody");
{
  const ctx = await workspace("who");
  const user = await identity.provisionUser(systemContext(newRequestId()), {
    externalId: `rel-${randomUUID().slice(0, 8)}`,
    email: `rel-${randomUUID().slice(0, 8)}@example.com`,
  });
  const agent = await agents.upsertFromDisk(ctx, { slug: "worker", display_name: "Worker" });
  await version(ctx, agent.id, 2, "generation", ago(2 * HOUR), user.user.id);
  await deploy(ctx, "worker", ago(HOUR), "live", { version: 2, url: "https://x.example" });

  const log = await store.releases(ctx, w);
  check("the publish names its author", log.find((e) => e.kind === "version")?.actorUserId === user.user.id);
  // The honest gap: `deployments` carries no actor column, so the row says nothing rather than
  // attributing the deploy to whoever happened to be nearby.
  check("the deploy names nobody, because nothing recorded one", log.find((e) => e.kind === "deploy")?.actorUserId === null);
}

// --- one chronology, newest first, bounded -------------------------------------------------------------------

console.log("\none chronology across both kinds, newest first and bounded");
{
  const ctx = await workspace("order");
  const agent = await agents.upsertFromDisk(ctx, { slug: "worker", display_name: "Worker" });
  await version(ctx, agent.id, 2, "generation", ago(3 * HOUR), null);
  await deploy(ctx, "worker", ago(2 * HOUR), "live", { version: 2, url: "https://a.example" });
  await version(ctx, agent.id, 3, "generation", ago(HOUR), null);

  const log = await store.releases(ctx, w);
  check("both kinds are interleaved by time", log.map((e) => e.kind).join() === "version,deploy,version");
  const times = log.map((e) => e.at);
  check("newest first", times.every((t, i) => i === 0 || t <= times[i - 1]!));

  for (let i = 0; i < 20; i++) await version(ctx, agent.id, 10 + i, "generation", ago(HOUR + i * 60_000), null);
  const capped = await store.releases(ctx, w, 5);
  check("the log is bounded by the count it was asked for", capped.length === 5);
  check("...and the bound keeps the newest", capped[0]!.at === log[0]!.at);
}

// --- a range with no releases is empty ---------------------------------------------------------------------------

console.log("\na quiet range has an empty log, not a zeroed one");
{
  const ctx = await workspace("quiet");
  await agents.upsertFromDisk(ctx, { slug: "worker", display_name: "Worker" });
  check("nothing shipped, nothing shown", (await store.releases(ctx, w)).length === 0);
}

await db.close();
console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
