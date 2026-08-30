// §7.4's mechanism, and §13's two claims about it: every claim carries a resolvable
// `work_items.id`, and a citation to another workspace's item is impossible.
//
// THE SECOND CLAIM IS THE ONE WORTH BEING CAREFUL ABOUT, because "impossible" is a strong word and
// the way it is achieved matters. There is no cross-workspace CHECK anywhere in this path — nothing
// takes an id and asks whether it belongs to somebody else. What there is instead is a resolver
// whose entire vocabulary is the fact pack, and a fact pack that came out of a scoped read. So an
// id from workspace B fails to resolve in workspace A for exactly the same reason a made-up one
// does: it is not in the material. This suite drives that end to end — a real pack from a real
// database in one workspace, and an answer citing a real job in the other.
//
// AND THE FIRST CLAIM HAS A SHAPE THAT LOOKS LIKE THE SECOND AND IS NOT. An INVENTED id is not
// silently removed from the answer; it is reported and left on screen as bare text. A filter that
// stripped it would leave a fluent sentence with no visible defect, which is precisely the failure
// §7.4 exists to make visible.
//
//   npm run test:convo-citations

import { randomUUID } from "node:crypto";

import { openTestSqlite, testContext } from "../db/testDb.ts";
import { newRequestId, systemContextFor } from "../db/tenant.ts";
import { buildFactPack, type PackDeps } from "./factPack.ts";
import { citableFrom, citedIds, resolveCitations } from "./citations.ts";
import type { Db } from "../db/db.ts";
import type { TenantContext } from "../db/tenant.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const A = testContext();
const B = systemContextFor("33333333-3333-4333-8333-333333333333", newRequestId());
const USER: Record<string, string> = {
  [A.workspaceId]: "aaaaaaaa-0000-4000-8000-0000000000ca",
  [B.workspaceId]: "bbbbbbbb-0000-4000-8000-0000000000cb",
};
const deploymentFor = (ctx: TenantContext): string => `dep-${ctx.workspaceId.slice(0, 8)}`;

const deps: PackDeps = {
  modelByDeployment: async (ctx) => new Map([[deploymentFor(ctx), "fake-scripted"]]),
  unreviewedRunIds: async () => new Set<string>(),
};

async function seed(db: Db, ctx: TenantContext, slug: string): Promise<{ agentId: string; jobId: string }> {
  const at = "2026-01-01T00:00:00.000Z";
  const user = USER[ctx.workspaceId]!;
  await db.run(
    `INSERT OR IGNORE INTO workspaces (id, slug, name, kind, plan, created_at)
     VALUES (?, ?, ?, 'personal', 'free', ?)`,
    [ctx.workspaceId, `ws-${ctx.workspaceId.slice(0, 8)}`, "Seeded", at],
  );
  await db.run(
    `INSERT OR IGNORE INTO users (id, external_id, email, created_at) VALUES (?, ?, ?, ?)`,
    [user, `ext-${user}`, `${user}@example.com`, at],
  );
  const agentId = randomUUID();
  await db.run(
    `INSERT INTO agents (id, workspace_id, slug, display_name, connectors, mcp_tools,
                         required_env, default_provider, created_at)
     VALUES (?, ?, ?, ?, '[]', '[]', '[]', 'fake', ?)`,
    [agentId, ctx.workspaceId, slug, slug, at],
  );
  await db.run(
    `INSERT INTO deployments (id, workspace_id, agent_id, target, status, provider, model,
                              env_keys, created_at, updated_at, created_seq)
     VALUES (?, ?, ?, 'railway', 'live', 'fake', 'fake-scripted', '[]', ?, ?, 1)`,
    [deploymentFor(ctx), ctx.workspaceId, agentId, at, at],
  );
  const jobId = randomUUID();
  await db.run(
    `INSERT INTO work_items (id, workspace_id, agent_id, deployment_id, run_id, created_by,
                             input, status, output, error, failure_kind,
                             created_at, started_at, ended_at, created_seq)
     VALUES (?, ?, ?, ?, ?, ?, 'send the invoice', 'succeeded', 'sent', NULL, NULL, ?, ?, ?, 0)`,
    [jobId, ctx.workspaceId, agentId, deploymentFor(ctx), randomUUID(), user, at, at, at],
  );
  return { agentId, jobId };
}

console.log("\nfinding the markers");
{
  const id = "0189d0d4-1c2a-4a1b-8c1e-6f6b1f5a0aa1";
  check("a marker is found", citedIds(`Yes — sent at 10:04 [work:${id}].`)[0] === id);
  check("...twice is once", citedIds(`[work:${id}] and again [work:${id}]`).length === 1);
  check("...in the order they appear",
    citedIds(`[work:${id}] then [work:0189d0d4-1c2a-4a1b-8c1e-6f6b1f5a0aa2]`)[0] === id);
  // THE PATTERN IS NARROW ON PURPOSE. Anything-between-brackets would make `[work:the invoice one]`
  // a citation-shaped thing the resolver then has to reject by a second rule — and a second rule is
  // a second place for the two definitions of "a citation" to disagree.
  check("prose between the brackets is not a citation", citedIds("[work:the invoice one]").length === 0);
  check("a truncated uuid is not a citation", citedIds("[work:0189d0d4-1c2a]").length === 0);
  check("a bare uuid in the text is not a citation", citedIds(id).length === 0);
  check("nothing in a plain sentence", citedIds("I have no record of that.").length === 0);

  // A GLOBAL REGEX AT MODULE SCOPE CARRIES `lastIndex`, and two calls sharing it would each start
  // where the other stopped. The bug that produces is a citation resolving in one answer and not in
  // the next, with nothing different about either — so it is asserted rather than reasoned about.
  const twice = [citedIds(`[work:${id}]`), citedIds(`[work:${id}]`)];
  check("two calls in a row see the same thing", twice[0]!.length === 1 && twice[1]!.length === 1,
    `${twice[0]!.length} then ${twice[1]!.length}`);
}

console.log("\nresolving them against the pack");
{
  const db = await openTestSqlite();
  const mine = await seed(db, A, "tracey");
  const pack = await buildFactPack(A, db.forWorkspace(A.workspaceId), deps,
    { agents: [{ id: mine.agentId, name: "Tracey" }] });
  const citable = citableFrom(pack.items);

  const good = resolveCitations(`Yes — sent at 10:04 [work:${mine.jobId}].`, citable);
  check("§13: a claim citing a job in the pack resolves", good.cited.length === 1);
  check("...and the chip carries a label without a second read",
    good.cited[0]?.agent_name === "Tracey" && good.cited[0]?.status === "succeeded",
    JSON.stringify(good.cited[0]));
  check("...and nothing was invented", good.invented.length === 0);

  // AN ID THAT LOOKS EXACTLY RIGHT AND IS NOT IN THE PACK. This is the case the whole mechanism is
  // for: a model producing a plausible uuid is not an unusual event, it is the ordinary one.
  const madeUp = randomUUID();
  const bad = resolveCitations(`It went out on Tuesday [work:${madeUp}].`, citable);
  check("a plausible uuid that was not in the pack does not resolve", bad.cited.length === 0);
  check("...and is reported rather than silently dropped",
    bad.invented.length === 1 && bad.invented[0] === madeUp, bad.invented.join(","));
  await db.close();
}

console.log("\nand the negative direction");
{
  const db = await openTestSqlite();
  const mine = await seed(db, A, "tracey");
  const theirs = await seed(db, B, "tracey");

  const pack = await buildFactPack(A, db.forWorkspace(A.workspaceId), deps,
    { agents: [{ id: mine.agentId, name: "Tracey" }] });
  const citable = citableFrom(pack.items);

  // §13: A CITATION TO ANOTHER WORKSPACE'S ITEM IS IMPOSSIBLE. The id is real, the row exists, and
  // it still does not resolve — because the pack it is being resolved against came out of a scoped
  // read and never contained it. There is no cross-tenant check anywhere in this path to forget.
  const across = resolveCitations(`I sent it [work:${theirs.jobId}].`, citable);
  check("§13: another workspace's real job id does not resolve", across.cited.length === 0,
    JSON.stringify(across.cited));
  check("...and is indistinguishable from an invented one",
    across.invented.length === 1 && across.invented[0] === theirs.jobId);

  // AND THE SAME ID IN THE OTHER WORKSPACE'S OWN PACK DOES resolve, which is what makes the
  // assertion above about SCOPE rather than about the id being malformed.
  const theirPack = await buildFactPack(B, db.forWorkspace(B.workspaceId), deps,
    { agents: [{ id: theirs.agentId, name: "Tracey" }] });
  const theirsOk = resolveCitations(`I sent it [work:${theirs.jobId}].`, citableFrom(theirPack.items));
  check("...while the same id resolves in its own workspace", theirsOk.cited.length === 1);

  // AND NAMING THE OTHER WORKSPACE'S AGENT FROM HERE STILL CITES NOTHING, which closes the other
  // route in: a caller that passed a foreign agent id would get an empty pack, so there would be
  // no citable ids at all rather than somebody else's.
  const foreignPack = await buildFactPack(A, db.forWorkspace(A.workspaceId), deps,
    { agents: [{ id: theirs.agentId, name: "Tracey" }] });
  check("a pack built from another workspace's agent id can cite nothing",
    citableFrom(foreignPack.items).size === 0);
  await db.close();
}

console.log("\ncase and duplication");
{
  const db = await openTestSqlite();
  const mine = await seed(db, A, "tracey");
  const pack = await buildFactPack(A, db.forWorkspace(A.workspaceId), deps,
    { agents: [{ id: mine.agentId, name: "Tracey" }] });
  const citable = citableFrom(pack.items);

  // A UUID IS CASE-INSENSITIVE and a model will sometimes upper-case one. Resolving that as a
  // different id would be a real citation rendered as an invented one — the honest mechanism
  // failing in the direction that makes it look like the model lied.
  const upper = resolveCitations(`Done [work:${mine.jobId.toUpperCase()}].`, citable);
  check("an upper-cased id still resolves", upper.cited.length === 1, JSON.stringify(upper));

  // ONE CHIP PER JOB, however often the answer names it. Three mentions of one job is one thing to
  // open, and three identical chips is a row of noise.
  const thrice = resolveCitations(
    `It ran [work:${mine.jobId}], succeeded [work:${mine.jobId}], and cost nothing [work:${mine.jobId}].`,
    citable,
  );
  check("a job cited three times is one chip", thrice.cited.length === 1, String(thrice.cited.length));
  await db.close();
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
