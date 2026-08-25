// §19.1's `test:access-denied` — the row that is the only evidence a grant is wrong.
//
// A SUITE OF ITS OWN FOR ONE EVENT, and it earns that. Every other row the Access tab writes
// records something somebody DID: a grant made, a grant revoked, a session ended. `access.denied`
// records something the system REFUSED, and it is the only signal that a permission is
// misconfigured — because the person on the wrong end of it does not file a ticket saying "my
// capability is misconfigured". They try, fail, try again tomorrow, and eventually ask a colleague
// to do it for them, which is the exact outcome per-agent access exists to prevent.
//
// SO THE FAILURE THIS GUARDS IS SILENCE. A refusal that writes no row leaves the History section
// showing a tidy list of deliberate changes and nothing at all about the wall somebody has been
// walking into every Tuesday. Nothing errors, nothing looks wrong, and the feature that was
// supposed to make access legible is quietly the reason nobody can see the problem.
//
// AND ONE ABSENCE IS ASSERTED AS HARD AS THE PRESENCE: a cross-workspace agent id writes NOTHING.
// That branch is reachable by anybody who can open a socket, at whatever rate they choose, and a
// row per attempt would let an outsider fill this workspace's audit log with entries about agents
// it does not have.
//
//   npm run test:access-denied

import { randomUUID } from "node:crypto";

import { openTestSqlite } from "./db/testDb.ts";
import { newRequestId, systemContextFor, type Role, type TenantContext } from "./db/tenant.ts";
import { IdentityRepository } from "./db/repositories/identity.ts";
import { AgentGrantRepository } from "./db/repositories/agentGrants.ts";
import { holds, resolveCapabilities, type AgentCapability } from "./auth/capabilities.ts";

let failures = 0;
const check = (ok: boolean, msg: string, detail = ""): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}${detail ? ` — ${detail}` : ""}`);
  }
};

const db = await openTestSqlite();
const identity = new IdentityRepository(db);
const grants = new AgentGrantRepository(db);

const now = new Date().toISOString();
const WS = randomUUID();
const OTHER = randomUUID();
for (const [id, slug] of [[WS, "acme"], [OTHER, "other"]] as const) {
  await db.run(
    `INSERT INTO workspaces (id, slug, name, kind, plan, created_at) VALUES (?, ?, ?, 'team', 'free', ?)`,
    [id, slug, slug, now],
  );
}
const USER = randomUUID();
await db.run(
  `INSERT INTO users (id, external_id, email, created_at) VALUES (?, ?, ?, ?)`,
  [USER, `ext-${USER}`, "sam@acme.test", now],
);
await db.run(
  `INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)`,
  [WS, USER, now],
);
const AGENT = randomUUID();
const THEIR_AGENT = randomUUID();
await db.run(
  `INSERT INTO agents (id, workspace_id, slug, current_version, created_at) VALUES (?, ?, 'billing_bot', 1, ?)`,
  [AGENT, WS, now],
);
await db.run(
  `INSERT INTO agents (id, workspace_id, slug, current_version, created_at) VALUES (?, ?, 'theirs', 1, ?)`,
  [THEIR_AGENT, OTHER, now],
);

const ctx = (role: Role = "member"): TenantContext => ({
  workspaceId: WS,
  actorUserId: USER,
  role,
  requestId: newRequestId(),
});

/**
 * The refusal path from `index.ts`, restated here.
 *
 * A COPY RATHER THAN AN IMPORT, because importing `index.ts` starts a server — the same reason
 * `test:capabilities` reads it as text rather than loading it. What keeps the copy honest is the
 * last block in this file, which reads the real one and fails if it stops writing the row.
 */
async function refusalFor(
  c: TenantContext,
  agentId: string,
  capability: AgentCapability,
  cmd: string,
): Promise<{ message: string; absent: boolean } | null> {
  const agent = await db.get<{ id: string; slug: string }>(
    `SELECT id, slug FROM agents WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL`,
    [c.workspaceId, agentId],
  );
  if (!agent) return { message: `there is no agent "${agentId}" in this workspace`, absent: true };
  const resolved = await resolveCapabilities(c, agent.id, grants);
  if (holds(resolved, capability)) return null;
  await identity.appendAudit(c, {
    action: "access.denied",
    targetType: "agent",
    targetId: agent.id,
    metadata: { agent: agent.slug, cmd, capability },
  });
  return { message: `you do not have "${capability}" on ${agent.slug}`, absent: false };
}

const denials = async (): Promise<Record<string, unknown>[]> =>
  (await identity.listAudit(ctx(), 200)).filter((r) => r.action === "access.denied") as unknown as Record<
    string,
    unknown
  >[];

console.log("\na real command refused for a real capability writes a row");
{
  await grants.upsert(ctx("admin"), {
    agentId: AGENT,
    userId: USER,
    capabilities: ["view"],
    grantedBy: USER,
  });

  const refusal = await refusalFor(ctx(), AGENT, "deploy", "deploy");
  check(refusal !== null && !refusal.absent, "a member with a view-only grant is refused deploy");

  const rows = await denials();
  check(rows.length === 1, `...and exactly one access.denied row is written (${rows.length})`);

  const row = rows[0] as { metadata: Record<string, unknown>; target_id: string; actor_user_id: string };
  // THE THREE FIELDS THAT MAKE THE ROW ACTIONABLE. Without the capability it is "something was
  // refused", which is not a thing anybody can fix; with it, the answer is a grant somebody can
  // write in thirty seconds.
  check(row.metadata["capability"] === "deploy", "the row names the capability that was missing");
  check(row.metadata["cmd"] === "deploy", "...and the command that needed it");
  check(row.target_id === AGENT, "...and which agent it was about");
  check(row.actor_user_id === USER, "...and who hit the wall");

  // WHAT THE ROW DELIBERATELY DOES NOT CARRY: the person's effective set. That is a fact about a
  // moment, `loadAccess` answers it live, and a copy in the row would be stale by the time anybody
  // read it — which is worse than absent, because it looks authoritative.
  check(
    !("capabilities" in row.metadata) && !("effective" in row.metadata),
    "and it does not record what they DID have, which would be stale by the time anybody read it",
  );
}

console.log("\nrepeatedly hitting the same wall is repeatedly visible");
{
  // THE PATTERN IS THE SIGNAL, which is why this is not deduplicated. §4.3: "a member repeatedly
  // hitting a wall is either a misconfigured grant or something worth investigating" — and a row
  // written once with a counter would answer "has this ever happened" while losing "is it still
  // happening", which is the question an administrator actually opens the section with.
  await refusalFor(ctx(), AGENT, "deploy", "deploy");
  await refusalFor(ctx(), AGENT, "edit", "edit");
  const rows = await denials();
  check(rows.length === 3, `three refusals are three rows (${rows.length})`);
  const caps = rows.map((r) => (r["metadata"] as Record<string, unknown>)["capability"]).sort();
  check(caps.join(",") === "deploy,deploy,edit", `...each naming what it needed (${caps.join(", ")})`);
}

console.log("\nan allowed command writes nothing");
{
  const before = (await denials()).length;
  const refusal = await refusalFor(ctx(), AGENT, "view", "loadAgentDetail");
  check(refusal === null, "a command the grant permits is allowed");
  check((await denials()).length === before, "...and writes no denial row");
}

console.log("\na cross-workspace id writes nothing at all");
{
  // THE ABSENCE IS ASSERTED AS HARD AS THE PRESENCE ABOVE. This branch is reachable by anybody who
  // can open a socket, at whatever rate they choose; a row per attempt would let an outsider fill
  // this workspace's audit log with entries about agents it does not have. It is also not the
  // event `access.denied` is for — that one exists to make a MISCONFIGURED GRANT visible, and an id
  // from another tenant is a scan or a stale tab rather than a permission anybody can fix.
  const before = (await denials()).length;
  const refusal = await refusalFor(ctx(), THEIR_AGENT, "deploy", "deploy");
  check(refusal?.absent === true, "another tenant's agent reads as absent");
  check((await denials()).length === before, "...and writes no row in this workspace");

  // ...and none in theirs either, which is the half somebody would forget: a row written under the
  // OTHER workspace's id would be this tenant telling that one it had been probed.
  const theirs = (await identity.listAudit(systemContextFor(OTHER, newRequestId()), 200)).filter(
    (r) => r.action === "access.denied",
  );
  check(theirs.length === 0, "...nor one in the workspace whose agent was named");
}

console.log("\nthe real refusal path still writes it");
{
  // THE COPY ABOVE IS ONLY WORTH ANYTHING IF THE ORIGINAL DOES THE SAME THING, and the original
  // cannot be imported — `index.ts` starts a server. So it is read as text, the same technique
  // `test:capabilities` uses against the relay's command surface.
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { join, dirname } = await import("node:path");
  const here = dirname(fileURLToPath(import.meta.url));
  const app = readFileSync(join(here, "index.ts"), "utf8");

  const at = app.indexOf("async function agentAccessRefusalFor");
  check(at > 0, "the refusal path was found in index.ts");
  const body = app.slice(at, at + 3000);

  check(/"access\.denied"/.test(body), "...and it writes access.denied");
  check(/capability/.test(body) && /cmd/.test(body), "...naming the capability and the command");
  // THE ORDERING THAT MATTERS: the absent branch returns BEFORE the audit write. A row written
  // above that return would be the cross-tenant flood this file's fourth block asserts against.
  const absentAt = body.indexOf("absent: true");
  const auditAt = body.indexOf('"access.denied"');
  check(
    absentAt > 0 && auditAt > absentAt,
    "...and returns for an absent agent BEFORE writing anything",
  );
  // AWAITED RATHER THAN FIRED AND FORGOTTEN. A refusal is not a hot path — it happens when
  // something is already wrong — and a row written after the refusal has been sent is one a process
  // that exits in between loses, at precisely the moment it mattered.
  check(/await identityRepo\s*\n?\s*\.appendAudit/.test(body), "...and awaits the write rather than dropping it");
}

await db.close();

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
