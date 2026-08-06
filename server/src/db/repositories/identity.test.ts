// The root of the tenancy tree: users, workspaces, memberships, audit.
//
// Run against both drivers when a Postgres is reachable, because the identity tables are the
// first ones written from scratch in two dialects and the ways they can differ are the usual
// quiet ones — a case-insensitive unique index that isn't, a timestamp that comes back as a
// Date on one side, a counter that returns a string.
//
//   npm run test:identity
//   JAROKU_PG_URL=postgres://… npm run test:identity     # runs it twice

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Db } from "../db.ts";
import { migrate } from "../migrate.ts";
import { SqliteDb } from "../sqlite.ts";
import { PostgresDb } from "../postgres.ts";
import { PG_URL_ENV } from "../open.ts";
import { IdentityRepository, slugify } from "./identity.ts";
import { newRequestId, systemContext, systemContextFor } from "../tenant.ts";

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  if (ok) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
};

const MIGRATIONS = join(new URL("../../..", import.meta.url).pathname, "migrations");

console.log("\nslugs");
check(slugify("Ada's Team") === "ada-s-team", `a name becomes a url-safe slug (${slugify("Ada's Team")})`);
check(/^[a-z]/.test(slugify("2fa crew")), "a leading digit is made legal");
check(slugify("   ") === "workspace", "an empty name still produces a slug");
check(slugify("Ünïcödé Wörk") === "unicode-work", `accents fold (${slugify("Ünïcödé Wörk")})`);

async function suite(label: string, db: Db): Promise<void> {
  console.log(`\n${label}`);
  const repo = new IdentityRepository(db);
  const sys = systemContext(newRequestId());

  // --- provisioning ----------------------------------------------------------

  const first = await repo.provisionUser(sys, {
    externalId: "clerk_user_aaa",
    email: "Ada@Example.com",
    displayName: "Ada Lovelace",
  });
  check(first.created, "a new external id provisions a user");
  check(first.workspace.kind === "personal", "...with a personal workspace");

  const owner = await repo.membership(sys, first.workspace.id, first.user.id);
  check(owner?.role === "owner", "...and they own it");

  // The race the transaction exists for: two tabs, two first requests.
  const again = await repo.provisionUser(sys, { externalId: "clerk_user_aaa", email: "Ada@Example.com" });
  check(!again.created && again.user.id === first.user.id, "provisioning twice returns the same user");
  check(again.workspace.id === first.workspace.id, "...and does not make a second personal workspace");

  const concurrent = await Promise.all(
    [1, 2, 3].map(() =>
      repo.provisionUser(sys, { externalId: "clerk_user_race", email: "race@example.com" }),
    ),
  );
  const ids = new Set(concurrent.map((r) => r.user.id));
  check(ids.size === 1, `three simultaneous first requests make one user (${ids.size})`);
  const wsIds = new Set(concurrent.map((r) => r.workspace.id));
  check(wsIds.size === 1, `...and one workspace (${wsIds.size})`);

  // --- case-insensitive identity ---------------------------------------------

  // Nobody believes Ada@example.com and ada@example.com are two people, and a UNIQUE over
  // plain text lets both sign up. citext on one driver, COLLATE NOCASE on the other.
  let duplicateRejected = false;
  try {
    await db.run(
      `INSERT INTO users (id, external_id, email, created_at) VALUES (?, ?, ?, ?)`,
      ["11111111-1111-4111-8111-111111111111", "clerk_other", "ada@example.com", new Date().toISOString()],
    );
  } catch {
    duplicateRejected = true;
  }
  check(duplicateRejected, "the same email in different case cannot sign up twice");

  // --- workspaces --------------------------------------------------------------

  const team = await repo.createWorkspace(sys, { name: "Ada's Team", ownerUserId: first.user.id });
  check(team.kind === "team" && team.slug === "ada-s-team", `a team workspace is created (${team.slug})`);

  const twin = await repo.createWorkspace(sys, { name: "Ada's Team", ownerUserId: first.user.id });
  check(twin.slug !== team.slug, `a colliding name gets a distinct slug (${twin.slug})`);
  check((await repo.workspaceBySlug(sys, team.slug))?.id === team.id, "a workspace is findable by slug");
  check(
    (await repo.workspaceBySlug(sys, team.slug.toUpperCase()))?.id === team.id,
    "...case-insensitively, because it is a URL",
  );

  const mine = await repo.workspacesForUser(sys, first.user.id);
  check(mine.length === 3, `the user's workspaces are listed (${mine.length})`);
  check(mine.every((w) => w.role === "owner"), "...each with the role they hold");

  // --- membership -------------------------------------------------------------

  const ctx = systemContextFor(team.id, newRequestId());
  const bob = await repo.provisionUser(sys, { externalId: "clerk_bob", email: "bob@example.com" });

  await repo.addMember(ctx, bob.user.id, "member");
  check((await repo.membership(ctx, team.id, bob.user.id))?.role === "member", "a member is added");
  check(
    (await repo.membership(ctx, first.workspace.id, bob.user.id)) === undefined,
    "...and is NOT a member of the owner's personal workspace",
  );

  await repo.addMember(ctx, bob.user.id, "admin");
  check((await repo.membership(ctx, team.id, bob.user.id))?.role === "admin", "re-adding changes the role");

  const members = await repo.listMembers(ctx);
  check(members.length === 2, `the member list is scoped to the workspace (${members.length})`);
  check(members.some((m) => m.email === "bob@example.com"), "...and carries the user's email");

  // A workspace with no owner cannot be billed, renamed or deleted, and nobody left in it
  // can fix that.
  const removeOwner = await repo.removeMember(ctx, first.user.id);
  check(!removeOwner.ok && /at least one owner/.test(removeOwner.reason ?? ""), "the last owner cannot be removed");

  await repo.addMember(ctx, bob.user.id, "owner");
  const nowRemovable = await repo.removeMember(ctx, first.user.id);
  check(nowRemovable.ok, "...but an owner can leave once there is a second one");
  check((await repo.listMembers(ctx)).length === 1, "and the list reflects it");

  const absent = await repo.removeMember(ctx, "22222222-2222-4222-8222-222222222222");
  check(!absent.ok, "removing a non-member is refused, not silently fine");

  // --- audit --------------------------------------------------------------------

  const entries = await repo.listAudit(ctx);
  const actions = entries.map((e) => e.action);
  check(actions.includes("workspace.created"), "creating a workspace is audited");
  check(actions.includes("member.added") && actions.includes("member.removed"), "membership changes are audited");
  check(
    entries.every((e) => e.workspace_id === team.id),
    "the audit list is scoped to one workspace",
  );
  check(
    entries.every((e) => typeof e.metadata === "object" && e.metadata !== null),
    "metadata comes back as an object on both drivers",
  );
  check(
    entries.every((e) => typeof (e.metadata as { requestId?: unknown }).requestId === "string"),
    "...carrying the request id that produced it",
  );
  check(entries.every((e) => Number.isInteger(e.id)), "the audit id is a number, not a bigint string");

  // A denied cross-tenant attempt is the row this table most needs, and the one least likely
  // to have a valid workspace to hang off.
  await repo.appendAudit(sys, {
    workspaceId: "33333333-3333-4333-8333-333333333333",
    action: "tenant.denied",
    targetType: "workspace",
    targetId: "33333333-3333-4333-8333-333333333333",
  });
  check(true, "an audit row about a workspace that does not exist is accepted");

  // --- shapes ---------------------------------------------------------------------

  check(
    typeof first.user.created_at === "string" && first.user.created_at.endsWith("Z"),
    `timestamps are ISO-8601 UTC strings on both drivers (${JSON.stringify(first.user.created_at)})`,
  );
  check(first.user.deleted_at === null, "a nullable timestamp is null, not undefined");
}

// --- run it ------------------------------------------------------------------------

const tmp = mkdtempSync(join(tmpdir(), "jaroku-identity-"));
{
  const db = new SqliteDb(join(tmp, "identity.db"));
  await migrate(db.migrationTarget(), join(MIGRATIONS, "sqlite"), () => {});
  try {
    await suite("SqliteDb", db);
  } finally {
    await db.close();
  }
}
rmSync(tmp, { recursive: true, force: true });

const url = process.env[PG_URL_ENV];
if (!url) {
  console.log(`\n(skipping Postgres: no ${PG_URL_ENV})`);
} else {
  const db = new PostgresDb({ url });
  let reachable = true;
  try {
    await db.ping();
  } catch (err) {
    reachable = false;
    console.log(`\n(skipping Postgres: ${(err as Error).message})`);
  }
  if (reachable) {
    // A schema of its own, dropped afterwards, so the suite never disturbs a real database
    // and two runs cannot collide.
    const schema = `identity_${Math.random().toString(36).slice(2, 8)}`;
    await db.exec(`CREATE SCHEMA ${schema}`);
    // `public` stays on the search_path behind the scratch schema. Extensions are installed
    // once per DATABASE, so `CREATE EXTENSION IF NOT EXISTS citext` is a no-op when a real
    // migration already put citext in public — and the type would then be unreachable from a
    // schema that had excluded it, which reads as "type citext does not exist".
    const scoped = new PostgresDb({
      url: `${url}${url.includes("?") ? "&" : "?"}options=-csearch_path%3D${schema},public`,
    });
    try {
      const target = scoped.migrationTarget();
      await target.withLock(async () => {
        await target.exec(`CREATE EXTENSION IF NOT EXISTS citext`);
        await target.exec(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
      });
      const { readFileSync } = await import("node:fs");
      await scoped.exec(readFileSync(join(MIGRATIONS, "postgres", "003_identity.sql"), "utf8"));
      await suite("PostgresDb", scoped);
    } finally {
      await scoped.close();
      await db.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    }
  }
  await db.close();
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
