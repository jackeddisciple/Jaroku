// Deleting a workspace, and proving the parts that are easy to claim and hard to do.
//
// FOUR THINGS THIS SUITE IS ACTUALLY ABOUT:
//
//   The other workspace still has everything. A deletion that reaches one row too far is the
//   worst bug in this file, and it is invisible unless something checks.
//
//   The receipt survives the deletion. It goes into `audit_log`, whose workspace_id is nullable
//   and not a foreign key — so a receipt inside the thing being deleted is exactly what this
//   avoids.
//
//   A provider that could not be told leaves the failure NAMED in the receipt. A clean-looking
//   deletion with a standing grant at Google is the dishonest outcome.
//
//   An account's shared workspace is not taken with them. A team's data is not one member's to
//   delete on the way out.
//
//   npm run test:deletion

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTestSqlite } from "../db/testDb.ts";
import { IdentityRepository } from "../db/repositories/identity.ts";
import { newRequestId, systemContext, systemContextFor, type TenantContext } from "../db/tenant.ts";
import { FsObjectStore } from "../storage/fsObjectStore.ts";
import { FileCheckpointStore } from "../checkpoints/store.ts";
import { TraceStore } from "../store.ts";
import { agentVersionKey, workspacePrefix } from "../storage/keys.ts";
import { WorkspaceDeleter } from "./deletion.ts";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

const tmp = mkdtempSync(join(tmpdir(), "jaroku-deletion-"));
const db = await openTestSqlite();
const store = new TraceStore(db);
await store.init();
const identity = new IdentityRepository(db);
const objects = new FsObjectStore({ root: join(tmp, "objects"), signingKey: Buffer.alloc(32, 5) });
mkdirSync(join(tmp, "checkpoints"), { recursive: true });
const checkpoints = new FileCheckpointStore(join(tmp, "checkpoints"));
const sys = systemContext(newRequestId());

async function seed(name: string): Promise<{ ctx: TenantContext; runId: string; agentId: string }> {
  const id = randomUUID();
  await db.run(
    `INSERT INTO workspaces (id, slug, name, kind, plan, created_at) VALUES (?, ?, ?, 'team', 'free', ?)`,
    [id, `del-${id.slice(0, 8)}`, name, new Date().toISOString()],
  );
  const ctx = systemContextFor(id, newRequestId());
  const runId = randomUUID();
  await store.upsertRun(ctx, {
    id: runId, agent_id: "example_agent", provider: "fake", model: "fake", status: "completed",
    started_at: new Date().toISOString(), ended_at: new Date().toISOString(), cost: 0, tokens: 0, error: null,
  } as never);
  await store.insertStep(ctx, {
    id: randomUUID(), run_id: runId, seq: 1, type: "llm_call", name: "call", input: {}, output: {},
    state_before: {}, state_after: {}, tokens: 1, cost: 0, latency_ms: 1, error: null,
    parent_step_id: null, started_at: new Date().toISOString(),
  } as never);
  const agentId = randomUUID();
  await objects.put(agentVersionKey(id, agentId, 1, "agent.py"), `print('${name}')`);
  writeFileSync(join(tmp, "checkpoints", `${runId}.sqlite`), "cp");
  return { ctx, runId, agentId };
}

const doomed = await seed("doomed");
const bystander = await seed("bystander");

let purged = 0;
const deleter = new WorkspaceDeleter({
  db,
  identity,
  objects,
  checkpoints,
  endGrants: async () => ({ revoked: 2, failed: ["slack: the provider did not answer"], credentialsDeleted: 1 }),
  purgeQueue: async () => {
    purged++;
    return 3;
  },
  log: () => {},
});

console.log("\ndeleting a workspace");
const receipt = await deleter.deleteWorkspace(doomed.ctx);
{
  check(receipt.workspaceId === doomed.ctx.workspaceId, "the receipt names the workspace");
  check((receipt.rowsDeleted["runs"] ?? 0) === 1, "the run is gone");
  check((receipt.rowsDeleted["steps"] ?? 0) === 1, "...and its steps");
  check((receipt.rowsDeleted["workspaces"] ?? 0) === 1, "...and the workspace row itself");
  check(receipt.objectsDeleted >= 1, "its objects are gone");
  check(receipt.checkpointsSwept >= 1, "...and its checkpoints");
  check(purged === 1 && receipt.jobsPurged === 3, "...and whatever was still queued for it");
  check(!existsSync(join(tmp, "checkpoints", `${doomed.runId}.sqlite`)), "the checkpoint file is really gone");
  check((await objects.list(workspacePrefix(doomed.ctx.workspaceId))).length === 0, "no object is left under its prefix");
  check((await identity.workspaceById(sys, doomed.ctx.workspaceId)) === undefined, "the workspace no longer resolves");
}

console.log("\nthe grants");
{
  check(receipt.grantsRevoked === 2, "grants ended at the provider are counted");
  check(receipt.grantsFailed.length === 1, "...and one that could not be told is recorded");
  check(
    receipt.grantsFailed[0]!.includes("slack"),
    "...BY NAME, because a clean-looking deletion with a standing grant is the dishonest outcome",
  );
  check(receipt.credentialsDeleted === 1, "and the credentials that could only be deleted are counted separately");
}

console.log("\nthe bystander");
{
  const theirRuns = await store.listRuns(bystander.ctx, 100);
  check(theirRuns.length === 1, "the other workspace still has its run");
  check((await objects.head(agentVersionKey(bystander.ctx.workspaceId, bystander.agentId, 1, "agent.py"))) !== null, "...and its files");
  check(existsSync(join(tmp, "checkpoints", `${bystander.runId}.sqlite`)), "...and its checkpoints");
  check((await identity.workspaceById(sys, bystander.ctx.workspaceId)) !== undefined, "...and exists");
}

console.log("\nthe receipt outlives what it records");
{
  const rows = await db.all<{ action: string; target_id: string; metadata: string }>(
    `SELECT action, target_id, metadata FROM audit_log WHERE action = 'workspace.deleted'`,
  );
  check(rows.length === 1, "the deletion is in the audit log");
  check(rows[0]!.target_id === doomed.ctx.workspaceId, "...naming the workspace that is gone");
  check(String(rows[0]!.metadata).includes("grantsFailed"), "...and carrying the whole receipt, including what failed");
  const detail = JSON.parse(String(rows[0]!.metadata)) as { objectsDeleted?: number };
  check((detail.objectsDeleted ?? 0) >= 1, "...as numbers somebody could cite");
}

console.log("\nrunning it twice");
{
  // A deletion interrupted halfway has to be finishable. Idempotence is the property that
  // replaces the transaction this cannot be.
  const again = await deleter.deleteWorkspace(doomed.ctx);
  check(Object.keys(again.rowsDeleted).length === 0, "a second deletion finds nothing left");
  check(again.grantsFailed.length === 1, "...and is not an error");
}

console.log("\ndeleting an account");
{
  const person = randomUUID();
  const other = randomUUID();
  for (const [id, email] of [[person, "leaver@example.test"], [other, "stayer@example.test"]] as const) {
    await db.run(`INSERT INTO users (id, external_id, email, created_at) VALUES (?, ?, ?, ?)`, [
      id, `ext-${id}`, email, new Date().toISOString(),
    ]);
  }
  const personal = await identity.createWorkspace(sys, { name: "Theirs", kind: "personal", ownerUserId: person });
  const shared = await identity.createWorkspace(sys, { name: "Shared", kind: "team", ownerUserId: other });
  await identity.addMember(systemContextFor(shared.id, newRequestId()), person, "member");
  const soleOwned = await identity.createWorkspace(sys, { name: "Sole", kind: "team", ownerUserId: person });

  const { receipts, leftBehind } = await deleter.deleteAccount(sys, person);
  const deleted = receipts.map((r) => r.workspaceId);
  check(deleted.includes(personal.id), "their personal workspace is deleted");
  check(deleted.includes(soleOwned.id), "...and one where they were the last owner, which nobody else could administer");
  check(!deleted.includes(shared.id), "A TEAM'S WORKSPACE IS NOT THEIRS TO TAKE ON THE WAY OUT");
  check(leftBehind.includes(shared.id), "...they simply stop being a member of it");
  check((await identity.workspaceById(sys, shared.id)) !== undefined, "...and it still exists");
  check(
    (await identity.listMembers(systemContextFor(shared.id, newRequestId()))).every((m) => m.user_id !== person),
    "...without them in it",
  );

  const row = await db.get<{ email: string; external_id: string; deleted_at: string | null }>(
    `SELECT email, external_id, deleted_at FROM users WHERE id = ?`,
    [person],
  );
  check(row?.deleted_at !== null, "the person is marked deleted");
  check(!row?.email.includes("leaver"), "...their address is gone");
  check(row?.external_id.startsWith("deleted:") === true, "...and signing in again cannot reach the account");
  check(
    (await db.all(`SELECT 1 FROM audit_log WHERE action = 'account.deleted'`)).length === 1,
    "and the account deletion has a receipt of its own",
  );
}

await db.close();
rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
