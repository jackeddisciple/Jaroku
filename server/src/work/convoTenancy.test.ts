// The negative direction: a pass for A cannot read, ask in, or dispatch from a thread in B.
//
// §13 ASKS FOR THE THREE VERBS BY NAME and they fail in three different places, which is why one
// suite covers all three rather than trusting that scoping one implies the others:
//
//   READ    the fact pack is `WHERE workspace_id = ?`, so naming B's agent from A answers with
//           nothing — the same shape `WorkStore`'s header describes, where a foreign id reads as
//           ABSENT and never as forbidden.
//
//   ASK IN  a question is written into a thread as a message, and `thread_items.thread_id`
//           references `threads(id)` — the id ALONE. So the foreign key does NOT stop A writing
//           into B's thread, and the store has to. This is the one that was open.
//
//   DISPATCH a job is bound to its conversation by the same write, so the same refusal covers it —
//           and the dispatch itself is `WorkDispatcher`'s business, which `test:work-tenancy`
//           already holds to the same line.
//
// AND ONE SENTENCE FOR "GONE" AND "NOT YOURS", asserted rather than assumed: a refusal that told
// them apart would confirm that an id exists somewhere, which is an enumeration oracle on a socket
// anybody with an account can open.
//
//   npm run test:convo-tenancy

import { randomUUID } from "node:crypto";

import { openTestSqlite, testContext } from "../db/testDb.ts";
import { newRequestId, systemContextFor } from "../db/tenant.ts";
import { ThreadNotHere, ThreadModeRefusal, ThreadStore } from "../threadStore.ts";
import { buildFactPack, type PackDeps } from "./factPack.ts";
import { citableFrom, resolveCitations } from "./citations.ts";
import type { Db } from "../db/db.ts";
import type { TenantContext } from "../db/tenant.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const A = testContext();
const B = systemContextFor("44444444-4444-4444-8444-444444444444", newRequestId());
const USER: Record<string, string> = {
  [A.workspaceId]: "aaaaaaaa-0000-4000-8000-0000000000ta",
  [B.workspaceId]: "bbbbbbbb-0000-4000-8000-0000000000tb",
};
const deploymentFor = (ctx: TenantContext): string => `dep-${ctx.workspaceId.slice(0, 8)}`;

const deps: PackDeps = {
  modelByDeployment: async (ctx) => new Map([[deploymentFor(ctx), "fake-scripted"]]),
  unreviewedRunIds: async () => new Set<string>(),
};

interface Tenant { agentId: string; jobId: string; threadId: string }

async function seed(db: Db, ctx: TenantContext, threads: ThreadStore, input: string): Promise<Tenant> {
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
     VALUES (?, ?, 'tracey', 'Tracey', '[]', '[]', '[]', 'fake', ?)`,
    [agentId, ctx.workspaceId, at],
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
     VALUES (?, ?, ?, ?, ?, ?, ?, 'succeeded', 'done', NULL, NULL, ?, ?, ?, 0)`,
    [jobId, ctx.workspaceId, agentId, deploymentFor(ctx), randomUUID(), user, input, at, at, at],
  );
  const thread = await threads.create(ctx, { agentId, agentName: "Tracey", title: "ops", mode: "operate" });
  await threads.addItem(ctx, thread.id, { kind: "work", refId: jobId });
  return { agentId, jobId, threadId: thread.id };
}

const db = await openTestSqlite();
const threads = new ThreadStore(db);
const mine = await seed(db, A, threads, "mine — refund order 1");
const theirs = await seed(db, B, threads, "theirs — refund order 2");

console.log("\nREAD: what the record answers with");
{
  // A's OWN AGENT reads A's own jobs, so the assertions below are about scope rather than about
  // everything being empty.
  const ok = await buildFactPack(A, db.forWorkspace(A.workspaceId), deps,
    { agents: [{ id: mine.agentId, name: "Tracey" }] });
  check("a pass for A reads A's own record", ok.items.length === 1 && ok.items[0]?.input === "mine — refund order 1");

  const across = await buildFactPack(A, db.forWorkspace(A.workspaceId), deps,
    { agents: [{ id: theirs.agentId, name: "Tracey" }] });
  check("§13: a pass for A cannot read B's record", across.items.length === 0,
    across.items.map((i) => i.input).join("|"));
  // ABSENT, NOT FORBIDDEN. There is no error to catch here and that is the design: an id from
  // another workspace answers the same way a deleted one does.
  check("...and it reads as empty rather than as a refusal", across.truncation.total === 0);

  // BOTH AGENTS AT ONCE, which is the shape §12 leaves the door open for and the one where a
  // scoping bug would be least visible: the pack is not empty, so nothing looks wrong.
  const mixed = await buildFactPack(A, db.forWorkspace(A.workspaceId), deps, {
    agents: [{ id: mine.agentId, name: "Tracey" }, { id: theirs.agentId, name: "Tracey" }],
  });
  check("naming both agents returns only this workspace's", mixed.items.length === 1,
    mixed.items.map((i) => i.input).join("|"));

  // AND NOTHING OF B'S IS CITABLE FROM A, which is what makes a claim about B's work unprovable
  // rather than merely unlikely.
  const citable = citableFrom(mixed.items);
  check("§13: B's job id cannot be cited from A",
    resolveCitations(`done [work:${theirs.jobId}]`, citable).cited.length === 0);
}

console.log("\nASK IN: writing a question into somebody else's conversation");
{
  // THE ONE THE FOREIGN KEY DOES NOT COVER. `thread_items.thread_id` references `threads(id)` — the
  // id alone, globally unique — so this insert satisfies the constraint and the store is the only
  // thing that can refuse it.
  let refusal: Error | null = null;
  try {
    await threads.addItem(A, theirs.threadId, {
      kind: "message", role: "user", body: "did you send that mail?",
    });
  } catch (err) { refusal = err as Error; }
  check("§13: a pass for A cannot ask in a thread in B", refusal instanceof ThreadNotHere,
    refusal ? refusal.name : "it was written");

  // AND NOTHING LANDED, from either side. B's thread must not have grown a message, and A must not
  // be holding a row that points into B.
  const theirItems = await threads.itemsFor(B, theirs.threadId);
  check("...and B's conversation did not grow a turn",
    theirItems.filter((i) => i.kind === "message").length === 0, String(theirItems.length));
  const strays = await threads.allItems(A);
  check("...and A holds no row pointing at B's thread",
    strays.every((i) => i.thread_id !== theirs.threadId), String(strays.length));

  // THE SAME SENTENCE FOR "GONE". A thread id that never existed anywhere is refused identically,
  // which is what stops the refusal being an oracle for whether an id is real.
  let missing: Error | null = null;
  try {
    await threads.addItem(A, randomUUID(), { kind: "message", role: "user", body: "hello?" });
  } catch (err) { missing = err as Error; }
  check("a thread that exists nowhere is refused the same way", missing instanceof ThreadNotHere);
  check("...with the same sentence, so the refusal names nothing",
    missing?.message === refusal?.message, `${missing?.message} vs ${refusal?.message}`);
}

console.log("\nDISPATCH: binding a job into somebody else's conversation");
{
  // A DISPATCH IS BOUND BY THE SAME WRITE, so the same refusal covers it — asserted separately
  // because it is a different kind and §13 names the verb.
  let refusal: Error | null = null;
  try {
    await threads.addItem(A, theirs.threadId, { kind: "work", refId: mine.jobId });
  } catch (err) { refusal = err as Error; }
  check("§13: a pass for A cannot dispatch into a thread in B", refusal instanceof ThreadNotHere);

  // AND B CANNOT BIND A's JOB INTO ITS OWN THREAD EITHER. This one is NOT refused by the thread
  // check — the thread is B's — so what stops it is the work item being invisible to B: the
  // reference is written and resolves to nothing, exactly as a swept job does, and the derivation
  // reports no work at all rather than somebody else's.
  await threads.addItem(B, theirs.threadId, { kind: "work", refId: mine.jobId });
  const pack = await buildFactPack(B, db.forWorkspace(B.workspaceId), deps,
    { agents: [{ id: theirs.agentId, name: "Tracey" }] });
  check("a reference to another workspace's job resolves to nothing",
    pack.items.every((i) => i.id !== mine.jobId), pack.items.map((i) => i.id).join("|"));
}

console.log("\nand the mode rule still bites inside a workspace");
{
  // THE TWO REFUSALS ARE DIFFERENT AND HAVE TO STAY DIFFERENT. A cross-tenant id is `ThreadNotHere`
  // and a wrong kind in your OWN thread is `ThreadModeRefusal` — collapsing them would make the
  // tenancy refusal describable as a mode problem, which is a sentence that tells a caller their id
  // was recognised.
  const build = await threads.create(A, { title: "building" });
  let refusal: Error | null = null;
  try {
    await threads.addItem(A, build.id, { kind: "work", refId: mine.jobId });
  } catch (err) { refusal = err as Error; }
  check("a work item in your own build thread is a MODE refusal",
    refusal instanceof ThreadModeRefusal, refusal?.name);
  check("...and not the tenancy one", !(refusal instanceof ThreadNotHere));
}

await db.close();
console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
