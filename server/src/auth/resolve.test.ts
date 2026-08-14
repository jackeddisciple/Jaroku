// Resolving a scope, and refusing to.
//
// Every FAIL here is somebody acting inside a workspace they do not belong to, which is the
// single failure this whole session exists to prevent. The suite is deliberately paranoid
// about the CACHE in particular: a membership cache is the one component here that can be
// correct on the day it is written and wrong the day somebody's access is revoked.
//
//   npm run test:resolve
//   JAROKU_PG_URL=postgres://… npm run test:resolve    # runs it twice

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import type { Db } from "../db/db.ts";
import { migrate } from "../db/migrate.ts";
import { SqliteDb } from "../db/sqlite.ts";
import { withScratchPostgres } from "../db/testDb.ts";
import { IdentityRepository } from "../db/repositories/identity.ts";
import { newRequestId, systemContext } from "../db/tenant.ts";
import { ContextResolver, memoryMembershipCache } from "./resolve.ts";
import type { AuthContext } from "./verifier.ts";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

const MIGRATIONS = join(fileURLToPath(new URL("../..", import.meta.url)), "migrations");

const authFor = (sub: string): AuthContext => ({
  subject: sub,
  email: `${sub}@example.com`,
  displayName: null,
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
  issuer: "urn:jaroku:local",
  authenticatedAt: Math.floor(Date.now() / 1000),
});

const refused = async (p: Promise<unknown>): Promise<{ status?: number; message: string } | null> =>
  p.then(() => null).catch((e) => ({ status: (e as { status?: number }).status, message: (e as Error).message }));

async function suite(driver: string, db: Db): Promise<void> {
  console.log(`\n${driver}`);
  const label = driver.toLowerCase();
  const identity = new IdentityRepository(db);
  const sys = systemContext(newRequestId());
  const logged: string[] = [];
  const resolver = new ContextResolver({ identity, log: (m) => logged.push(m) });

  // Ada owns her personal workspace and is a member of a team; Bob owns his own and is in
  // neither of hers.
  const ada = await identity.provisionUser(sys, { externalId: `ada-${label}`, email: `ada-${label}@example.com` });
  const bob = await identity.provisionUser(sys, { externalId: `bob-${label}`, email: `bob-${label}@example.com` });
  const team = await identity.createWorkspace(sys, { name: `team ${label}`, ownerUserId: ada.user.id });
  await identity.addMember({ ...sys, workspaceId: team.id, role: "owner" } as never, bob.user.id, "member");

  console.log("  · the happy path");
  {
    const own = await resolver.resolve(authFor(`ada-${label}`), ada.workspace.id, newRequestId());
    check(own.context.workspaceId === ada.workspace.id, "a member resolves to the workspace they asked for");
    check(own.context.actorUserId === ada.user.id, "...with their internal user id, not their sub");
    check(own.role === "owner", "...and the role their membership row says");

    const none = await resolver.resolve(authFor(`ada-${label}`), null, newRequestId());
    check(none.context.workspaceId === ada.workspace.id, "asking for no workspace lands in the personal one");

    const asMember = await resolver.resolve(authFor(`bob-${label}`), team.id, newRequestId());
    check(asMember.role === "member", "a member of a team resolves at THEIR role, not the owner's");
  }

  console.log("  · refusal");
  {
    const other = await refused(resolver.resolve(authFor(`bob-${label}`), ada.workspace.id, newRequestId()));
    check(other?.status === 403, "asking for a workspace you are not in is refused");
    check(
      !/exist/i.test(other?.message ?? ""),
      "...with a message that is not an existence oracle over workspace ids",
    );

    const nonsense = await refused(resolver.resolve(authFor(`bob-${label}`), randomUUID(), newRequestId()));
    check(nonsense?.status === 403, "...as is a workspace id that does not exist at all");
    check(nonsense?.message === other?.message, "...and identically, so the two cannot be told apart");

    const stranger = await refused(resolver.resolve(authFor("never-signed-in"), team.id, newRequestId()));
    check(
      stranger?.status === 401,
      "a verified token with no user row is 401 — sign in again — not 403",
    );
  }

  console.log("  · a denial is a security event");
  {
    const before = (await identity.listAudit({ ...sys, workspaceId: team.id, role: "system" }, 100)).length;
    const fresh = new ContextResolver({ identity, log: () => {} });
    await refused(fresh.resolve(authFor(`ada-${label}`), team.id, newRequestId())); // she IS a member; no row
    const carol = await identity.provisionUser(sys, {
      externalId: `carol-${label}`,
      email: `carol-${label}@example.com`,
    });
    await refused(fresh.resolve(authFor(`carol-${label}`), team.id, newRequestId(), "10.0.0.7"));
    const rows = await identity.listAudit({ ...sys, workspaceId: team.id, role: "system" }, 100);
    const denial = rows.find((r) => r.action === "workspace.access_denied");
    check(rows.length > before && !!denial, "a denied cross-tenant attempt writes an audit row");
    check(denial?.actor_user_id === carol.user.id, "...naming who tried");
    check(denial?.ip === "10.0.0.7", "...and from where");

    // A scan of random uuids must not be an unbounded write against the table whose job is
    // recording the attempts that matter.
    const beforeScan = (await db.all(`SELECT id FROM audit_log`)).length;
    for (let i = 0; i < 25; i++) {
      await refused(fresh.resolve(authFor(`carol-${label}`), randomUUID(), newRequestId()));
    }
    const afterScan = (await db.all(`SELECT id FROM audit_log`)).length;
    check(
      afterScan === beforeScan,
      `scanning 25 nonexistent workspace ids writes NO audit rows (${afterScan - beforeScan})`,
    );
  }

  console.log("  · what is counted, and what is written down");
  {
    // THE COUNTER AND THE AUDIT ROW ARE NOT THE SAME PROMISE, and they used to share a gate.
    // A negative membership decision is cached for thirty seconds, and BOTH were skipped for a
    // cached refusal — so a session probing one workspace produced one counted denial per
    // window however hard it probed. index.ts calls this counter "the part that accumulates, so
    // a single probe is visible as a probe and a hundred of them is visible as an attack"; the
    // cache collapsed the hundred to one, and the alert kept firing, so what was wrong was the
    // number an operator reads while deciding how bad it is.
    const attempts: string[] = [];
    const recorded: string[] = [];
    const dave = await identity.provisionUser(sys, {
      externalId: `dave-${label}`,
      email: `dave-${label}@example.com`,
    });
    const counting = new ContextResolver({
      identity,
      log: () => {},
      onCrossTenantAttempt: ({ workspaceId }) => attempts.push(workspaceId),
      onCrossTenantDenial: ({ workspaceId }) => recorded.push(workspaceId),
    });

    const beforeRows = (await db.all(`SELECT id FROM audit_log`)).length;
    for (let i = 0; i < 10; i++) {
      await refused(counting.resolve(authFor(`dave-${label}`), team.id, newRequestId()));
    }
    const afterRows = (await db.all(`SELECT id FROM audit_log`)).length;

    check(attempts.length === 10, `ten probes are ten counted attempts (${attempts.length})`);
    check(recorded.length === 1, `...and one recorded denial, because nine were cached (${recorded.length})`);
    check(afterRows - beforeRows === 1, `...and one audit row, not ten (${afterRows - beforeRows})`);

    // The existence condition survives the change, and it is the one an outsider could otherwise
    // lean on: an alert somebody can drive by naming ids that do not exist is an alert that gets
    // muted. Probing the SAME nonexistent id is the case that matters — the second and later
    // attempts are served from the membership cache, which is exactly where a naive "count every
    // refusal" would start counting.
    const ghost = randomUUID();
    attempts.length = 0;
    for (let i = 0; i < 10; i++) {
      await refused(counting.resolve(authFor(`dave-${label}`), ghost, newRequestId()));
    }
    check(attempts.length === 0, `probing a workspace that does not exist counts nothing (${attempts.length})`);
    check(dave.user.id.length > 0, "...and the prober is a real, authenticated user, which is the point");
  }

  console.log("  · the cache, and what it must not outlive");
  {
    let clock = 1_000_000;
    const cache = memoryMembershipCache(30_000, () => clock);
    const cached = new ContextResolver({ identity, cache, log: () => {} });

    const dave = await identity.provisionUser(sys, { externalId: `dave-${label}`, email: `dave-${label}@example.com` });
    const ctx = { ...sys, workspaceId: team.id, role: "owner" as const, actorUserId: ada.user.id };
    await identity.addMember(ctx, dave.user.id, "member");

    const first = await cached.resolve(authFor(`dave-${label}`), team.id, newRequestId());
    check(first.role === "member", "a first resolve reads the membership row");

    // Revoked in the database, still in the cache. This is the staleness window, and it is a
    // real security property rather than an implementation detail — so it gets an assertion
    // that says out loud what it is.
    await identity.removeMember(ctx, dave.user.id);
    const stale = await cached.resolve(authFor(`dave-${label}`), team.id, newRequestId());
    check(stale.role === "member", "a revoked member is STILL admitted inside the TTL — the documented window");

    clock += 31_000;
    const expired = await refused(cached.resolve(authFor(`dave-${label}`), team.id, newRequestId()));
    check(expired?.status === 403, "...and refused once the TTL passes, with no invalidation at all");

    // ...which is why every membership mutation calls invalidate(), making it exact here.
    await identity.addMember(ctx, dave.user.id, "member");
    cached.invalidate(team.id, dave.user.id);
    const readmitted = await cached.resolve(authFor(`dave-${label}`), team.id, newRequestId());
    check(readmitted.role === "member", "an explicit invalidation admits a re-added member immediately");

    await identity.removeMember(ctx, dave.user.id);
    cached.invalidate(team.id, dave.user.id);
    const gone = await refused(cached.resolve(authFor(`dave-${label}`), team.id, newRequestId()));
    check(gone?.status === 403, "...and refuses a removed one immediately");

    // A negative is cached too, or guessing ids is a database round trip per guess.
    const nonMember = authFor(`bob-${label}`);
    await refused(cached.resolve(nonMember, ada.workspace.id, newRequestId()));
    check(cache.get(ada.workspace.id, bob.user.id) === null, "a refusal is cached as a known non-membership");

    cache.invalidate(ada.workspace.id);
    check(cache.get(ada.workspace.id, bob.user.id) === undefined, "invalidating a workspace drops every entry for it");
  }

  console.log("  · revalidation sees past the cache");
  {
    const cache = memoryMembershipCache();
    const live = new ContextResolver({ identity, cache, log: () => {} });
    const erin = await identity.provisionUser(sys, { externalId: `erin-${label}`, email: `erin-${label}@example.com` });
    const ctx = { ...sys, workspaceId: team.id, role: "owner" as const, actorUserId: ada.user.id };
    await identity.addMember(ctx, erin.user.id, "member");

    const session = await live.resolve(authFor(`erin-${label}`), team.id, newRequestId());
    await identity.removeMember(ctx, erin.user.id);

    // No invalidate() call: this is the cross-replica case, where the removal happened
    // somewhere else. A socket open for eight hours must not outlive the membership.
    const still = await live.stillAMember(session.context, newRequestId());
    check(still === null, "stillAMember goes around the cache and sees the revocation");
    const after = await refused(live.resolve(authFor(`erin-${label}`), team.id, newRequestId()));
    check(after?.status === 403, "...and leaves the cache correct for the next ordinary request");
  }
}

const tmp = mkdtempSync(join(tmpdir(), "jaroku-resolve-"));
{
  const db = new SqliteDb(join(tmp, "resolve.db"));
  await migrate(db.migrationTarget(), join(MIGRATIONS, "sqlite"), () => {});
  try {
    await suite("SqliteDb", db);
  } finally {
    await db.close();
  }
}
rmSync(tmp, { recursive: true, force: true });

await withScratchPostgres(async (db) => {
  await suite("PostgresDb", db);
});

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
