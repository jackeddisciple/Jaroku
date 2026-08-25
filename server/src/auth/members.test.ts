// Membership: invite, accept, change role, remove.
//
// The mutations here are the ones that decide who can see a workspace's data at all, so every
// one of them writes an audit row inside the same transaction as the change — and this file
// asserts that, not just the change.
//
// The invite design is the part worth reading. The token is `<workspace_id>.<secret>`, and the
// workspace id in it authorises nothing: it selects which rows to search so the query can be
// SCOPED, which is what lets `workspace_invites` keep an RLS policy even though the person
// redeeming an invite is by definition not a member. The 256-bit secret is the whole proof.
//
//   npm run test:members
//   JAROKU_PG_URL=postgres://… npm run test:members    # runs it twice

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
import { newRequestId, systemContext, systemContextFor, type TenantContext } from "../db/tenant.ts";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

const MIGRATIONS = join(fileURLToPath(new URL("../..", import.meta.url)), "migrations");

async function suite(driver: string, db: Db): Promise<void> {
  console.log(`\n${driver}`);
  const label = driver.toLowerCase();
  const identity = new IdentityRepository(db);
  const sys = systemContext(newRequestId());

  const ada = await identity.provisionUser(sys, { externalId: `m-ada-${label}`, email: `m-ada-${label}@example.com` });
  const bob = await identity.provisionUser(sys, { externalId: `m-bob-${label}`, email: `m-bob-${label}@example.com` });
  const cat = await identity.provisionUser(sys, { externalId: `m-cat-${label}`, email: `m-cat-${label}@example.com` });
  const team = await identity.createWorkspace(sys, { name: `team ${label}`, ownerUserId: ada.user.id });
  const owner: TenantContext = { ...systemContextFor(team.id, newRequestId()), role: "owner", actorUserId: ada.user.id };

  const auditFor = async (action: string): Promise<boolean> =>
    (await identity.listAudit(owner, 200)).some((r) => r.action === action);

  console.log("  · inviting");
  {
    const created = await identity.createInvite(owner, { email: bob.user.email, role: "member" });
    check("token" in created, "an invite is created");
    if (!("token" in created)) return;
    check(created.token.startsWith(`${team.id}.`), "the token carries the workspace id, so the lookup can be SCOPED");
    check(created.token.length > 50, "...and a real secret after it");
    check(await auditFor("invite.created"), "creating an invite writes an audit row");

    const stored = await db.all<{ token_hash: string }>(`SELECT token_hash FROM workspace_invites`);
    check(
      stored.every((r) => !created.token.includes(r.token_hash) && !r.token_hash.includes(created.token.split(".")[1]!)),
      "only a HASH is stored — a copy of the table is not a set of usable invitations",
    );

    const listed = await identity.listInvites(owner);
    check(listed.some((i) => i.email === bob.user.email), "a pending invite is listed");

    const already = await identity.createInvite(owner, { email: ada.user.email, role: "member" });
    check("error" in already, "inviting somebody who is already a member is refused");
    check(
      "error" in already && /already a member/.test(already.error),
      "...with a message that says so rather than an invite that silently does nothing",
    );

    const nonsense = await identity.createInvite(owner, { email: "not-an-address", role: "member" });
    check("error" in nonsense, "an invite to something that is not an address is refused");

    // Re-inviting replaces rather than duplicating: the partial unique index forbids two live
    // ones, and "invite again" almost always means "the first link got lost".
    const second = await identity.createInvite(owner, { email: bob.user.email, role: "admin" });
    check("token" in second, "re-inviting the same address succeeds");
    const pending = (await identity.listInvites(owner)).filter((i) => i.email === bob.user.email);
    check(pending.length === 1, `...leaving exactly one live invite (${pending.length})`);
    if ("token" in created) {
      const stale = await identity.acceptInvite(sys, created.token, bob.user);
      check(!stale.ok, "...and the superseded link no longer works");
    }
  }

  console.log("  · accepting");
  {
    const invite = await identity.createInvite(owner, { email: cat.user.email, role: "member" });
    if (!("token" in invite)) return check(false, "could not create an invite to accept");

    const wrongPerson = await identity.acceptInvite(sys, invite.token, bob.user);
    check(!wrongPerson.ok, "accepting with the wrong account is refused");
    check(
      !wrongPerson.ok && /was sent to/.test(wrongPerson.reason),
      "...and this one refusal SAYS why — somebody signed in as the wrong account can fix that",
    );

    const accepted = await identity.acceptInvite(sys, invite.token, cat.user);
    check(accepted.ok, "the invited address accepts");
    check(accepted.ok && accepted.role === "member", "...at the role it was sent for");
    check(await auditFor("invite.accepted"), "...and it is audited");

    const twice = await identity.acceptInvite(sys, invite.token, cat.user);
    check(!twice.ok, "an accepted invite cannot be accepted again");

    const memberships = await identity.workspacesForUser(sys, cat.user.id);
    check(memberships.some((w) => w.id === team.id), "the accepter is now a member");
  }

  console.log("  · what cannot be redeemed");
  {
    const forged = await identity.acceptInvite(sys, `${team.id}.${"a".repeat(43)}`, bob.user);
    check(!forged.ok, "a made-up secret against a real workspace is refused");

    const noDot = await identity.acceptInvite(sys, "no-dot-here", bob.user);
    check(!noDot.ok, "a token with no workspace id is refused");

    const empty = await identity.acceptInvite(sys, "", bob.user);
    check(!empty.ok, "an empty token is refused");

    const short = await identity.acceptInvite(sys, `${team.id}.abc`, bob.user);
    check(!short.ok, "a short secret is refused before it reaches a query");

    // The workspace id in the token chooses the SCOPE, not the permission. Pointing a valid
    // secret at a different workspace must find nothing rather than join that one.
    const other = await identity.createWorkspace(sys, { name: `other ${label}`, ownerUserId: bob.user.id });
    const real = await identity.createInvite(owner, { email: `swap-${label}@example.com`, role: "member" });
    if ("token" in real) {
      const swapped = `${other.id}.${real.token.split(".")[1]}`;
      const result = await identity.acceptInvite(sys, swapped, {
        id: bob.user.id,
        email: `swap-${label}@example.com`,
      });
      check(!result.ok, "a real secret pointed at ANOTHER workspace joins nothing");
      const theirs = await identity.listMembers({ ...owner, workspaceId: other.id });
      check(theirs.length === 1, `...and that workspace still has only its owner (${theirs.length})`);
    }

    const expired = await identity.createInvite(owner, {
      email: `stale-${label}@example.com`,
      role: "member",
      ttlHours: -1,
    });
    if ("token" in expired) {
      const dead = await identity.acceptInvite(sys, expired.token, { id: bob.user.id, email: `stale-${label}@example.com` });
      check(!dead.ok, "an expired invite is refused");
    }

    const revocable = await identity.createInvite(owner, { email: `gone-${label}@example.com`, role: "member" });
    if ("token" in revocable) {
      check(await identity.revokeInvite(owner, revocable.invite.id), "an invite can be revoked");
      check(await auditFor("invite.revoked"), "...which is audited");
      const dead = await identity.acceptInvite(sys, revocable.token, { id: bob.user.id, email: `gone-${label}@example.com` });
      check(!dead.ok, "...and the link stops working");
      check(!(await identity.revokeInvite(owner, revocable.invite.id)), "revoking twice reports nothing to do");
    }

    check(!(await identity.revokeInvite(owner, randomUUID())), "revoking an invite that does not exist is refused");
  }

  console.log("  · roles");
  {
    const promoted = await identity.setMemberRole(owner, cat.user.id, "admin");
    check(promoted.ok, "a member can be promoted");
    check(await auditFor("member.role_changed"), "...which is audited");
    const listed = await identity.listMembers(owner);
    check(listed.find((m) => m.user_id === cat.user.id)?.role === "admin", "...and the row says so");

    const stranger = await identity.setMemberRole(owner, randomUUID(), "admin");
    check(!stranger.ok, "promoting a non-member is refused");

    // The guard that keeps a workspace administrable. The last person able to fix it is the
    // one about to demote themselves.
    const selfDemote = await identity.setMemberRole(owner, ada.user.id, "member");
    check(!selfDemote.ok, "the LAST owner cannot demote themselves");
    check(
      !selfDemote.ok && /at least one owner/.test(selfDemote.reason ?? ""),
      "...with a message that says why",
    );

    await identity.setMemberRole(owner, cat.user.id, "owner");
    const nowFine = await identity.setMemberRole(owner, ada.user.id, "member");
    check(nowFine.ok, "...but they can once there is a second owner — that is stepping back, not locking the door");
    await identity.setMemberRole({ ...owner, actorUserId: cat.user.id }, ada.user.id, "owner");
  }

  console.log("  · removal");
  {
    const removed = await identity.removeMember(owner, cat.user.id);
    check(removed.ok, "a member can be removed");
    check(await auditFor("member.removed"), "...which is audited");
    check(
      !(await identity.workspacesForUser(sys, cat.user.id)).some((w) => w.id === team.id),
      "...and they no longer belong to the workspace",
    );
    const again = await identity.removeMember(owner, cat.user.id);
    check(!again.ok, "removing them twice reports nothing to do");
  }

  // §13.3 — leaving under your own steam, which is the same DELETE as removal and a different
  // operation. Three claims are worth making about it and only one is about the row disappearing.
  console.log("  · leaving");
  {
    // A SECOND WORKSPACE, and this is the assertion the suite exists for rather than a fixture.
    // `leaveWorkspace` takes no user id — the row it deletes is the CONTEXT's own — which makes
    // the WHERE the only thing standing between "leave this workspace" and "leave every workspace
    // I am in", and a one-workspace test cannot tell those apart.
    const other = await identity.createWorkspace(sys, { name: `other ${label}`, ownerUserId: ada.user.id });
    await identity.addMember(owner, bob.user.id, "member");
    await identity.addMember(
      { ...systemContextFor(other.id, newRequestId()), role: "owner", actorUserId: ada.user.id },
      bob.user.id,
      "member",
    );
    const bobHere: TenantContext = { ...systemContextFor(team.id, newRequestId()), role: "member", actorUserId: bob.user.id };

    const left = await identity.leaveWorkspace(bobHere);
    check(left.ok, "a member can leave");
    check(await auditFor("member.left"), "...recorded as leaving rather than as being removed");
    const bobsWorkspaces = await identity.workspacesForUser(sys, bob.user.id);
    check(!bobsWorkspaces.some((w) => w.id === team.id), "...and they are out of the workspace they left");
    check(bobsWorkspaces.some((w) => w.id === other.id), "...and still in the one they did not");

    const twice = await identity.leaveWorkspace(bobHere);
    check(!twice.ok, "leaving twice reports nothing to do");

    // THE OWNER'S REFUSAL IS UNCONDITIONAL, not `removeMember`'s last-owner rule. Ada is the only
    // owner here, so both guards would refuse her — which is exactly why the interesting half is
    // below, with a second owner present.
    const adaLeaves = await identity.leaveWorkspace(owner);
    check(!adaLeaves.ok, "an owner cannot leave");
    check(/transfer ownership/i.test(adaLeaves.reason ?? ""), "...and is told to hand it over first");

    await identity.addMember(owner, cat.user.id, "owner");
    const stillRefused = await identity.leaveWorkspace(owner);
    check(
      !stillRefused.ok,
      "...even with a second owner, which is where this differs from removeMember's last-owner rule",
    );
    check(
      (await identity.workspacesForUser(sys, ada.user.id)).some((w) => w.id === team.id),
      "...so the workspace still has the owner who tried to walk out of it",
    );

    // THE ROLE IS READ FROM THE ROW, NEVER FROM THE CONTEXT. A context is resolved when a socket
    // opens and refreshed once a minute, so a stale one is the ordinary case rather than the
    // exotic one — and believing it would let somebody demoted a moment ago leave as the owner
    // they no longer are, or refuse an owner whose tab still says "member".
    const catLyingAboutBeingAMember: TenantContext = {
      ...systemContextFor(team.id, newRequestId()),
      role: "member",
      actorUserId: cat.user.id,
    };
    const lied = await identity.leaveWorkspace(catLyingAboutBeingAMember);
    check(!lied.ok, "a stale context claiming `member` does not let an owner leave");
  }
}

const tmp = mkdtempSync(join(tmpdir(), "jaroku-members-"));
{
  const db = new SqliteDb(join(tmp, "members.db"));
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
