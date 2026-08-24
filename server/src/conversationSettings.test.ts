// Per-conversation settings, and the three things that go wrong when the fallback is written twice.
//
// The behaviour under test is §7's refusal to backfill: a conversation with no row inherits the
// workspace default, and the workspace default is what changes when an admin changes their mind.
// Every failure mode here is silent. A conversation frozen at the default it happened to have on
// the day somebody touched an unrelated setting still WORKS — it just stops following the
// workspace, and nobody finds out until an admin changes the default and half the threads ignore
// it.
//
// It also holds §3.2's pin, which is a security-shaped rule wearing a settings-shaped hat: "A
// workspace admin can pin the default and disallow Fast." A pin a conversation can opt out of is
// a suggestion, and the control renders read-only precisely because it is not one.
//
//   npm run test:conversation-settings

import { randomUUID } from "node:crypto";

import { ConversationSettingsStore, DEFAULT_PERMISSION_MODE, PERMISSION_MODES, isPermissionMode } from "./conversationSettings.ts";
import { DEFAULT_EFFORT } from "./effort.ts";
import { openTestSqlite, testContext } from "./db/testDb.ts";
import { newRequestId, systemContextFor } from "./db/tenant.ts";
import type { SqliteDb } from "./db/sqlite.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const ctx = testContext();
const OTHER = randomUUID();
const otherCtx = systemContextFor(OTHER, newRequestId());

async function freshDb(): Promise<SqliteDb> {
  const db = await openTestSqlite();
  await db.run(
    `INSERT INTO workspaces (id, slug, name, kind, plan, created_at)
     VALUES (?, ?, ?, 'team', 'free', ?)`,
    [OTHER, `ws-${OTHER.slice(0, 8)}`, "Other", new Date().toISOString()],
  );
  return db;
}

/** A thread, so the composite foreign key has something real to point at. */
async function seedThread(db: SqliteDb, workspaceId: string): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO threads (id, workspace_id, title, title_is_custom, created_at, last_activity_at, status)
     VALUES (?, ?, 'A thread', 0, ?, ?, 'idle')`,
    [id, workspaceId, now, now],
  );
  return id;
}

console.log("\nthe closed set is closed");
{
  check("three modes, and there is no fourth", PERMISSION_MODES.length === 3);
  check("...strict, smart, fast", PERMISSION_MODES.join(",") === "strict,smart,fast");
  // §3.2: "There is no 'approve everything' mode, and adding one later is a product decision, not
  // an implementation shortcut." The guard is the shortcut being refused in code as well as schema.
  check("nothing approves everything", !isPermissionMode("all") && !isPermissionMode("auto") && !isPermissionMode(""));
  check("the default is the middle one", DEFAULT_PERMISSION_MODE === "smart");
}

console.log("\n§7 — a conversation nobody has touched has no row, and inherits");
{
  const db = await freshDb();
  const store = new ConversationSettingsStore(db);
  const thread = await seedThread(db, ctx.workspaceId);

  const before = await store.effective(ctx, thread);
  check("effort falls back to Jaroku's default", before.effort === DEFAULT_EFFORT, before.effort);
  check("the mode falls back to Smart", before.permissionMode === "smart", before.permissionMode);
  check("and neither is recorded as explicit", !before.explicit.effort && !before.explicit.permissionMode);

  // THE ASSERTION §7 IS ACTUALLY ABOUT. Reading must not create a row — a lazily-created row on
  // read would make every conversation somebody opened permanently opinionated.
  const rows = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM conversation_settings`);
  check("reading created nothing", Number(rows?.n ?? -1) === 0, String(rows?.n));

  // ...and the workspace default is what moves it, precisely because there is no row.
  await store.setWorkspaceDefaults(ctx, { effort: "high" });
  const after = await store.effective(ctx, thread);
  check("changing the workspace default moves an untouched conversation", after.effort === "high", after.effort);
  await db.close();
}

console.log("\nsetting one field does not silently freeze the other");
{
  // The failure this guards: PATCHing only the permission mode writes 'medium' into the effort
  // column because that is what the resolver returned, and the conversation stops following the
  // workspace forever — while continuing to behave exactly as expected that afternoon.
  const db = await freshDb();
  const store = new ConversationSettingsStore(db);
  const thread = await seedThread(db, ctx.workspaceId);

  await store.set(ctx, thread, { permissionMode: "strict" }, null);
  const row = await db.get<Record<string, unknown>>(
    `SELECT reasoning_effort, permission_mode FROM conversation_settings WHERE conversation_id = ?`,
    [thread],
  );
  check("the row exists now", row !== undefined);
  check("the mode was written", row?.permission_mode === "strict");
  check("the effort column is still NULL", row?.reasoning_effort === null, JSON.stringify(row?.reasoning_effort));

  await store.setWorkspaceDefaults(ctx, { effort: "xhigh" });
  const eff = await store.effective(ctx, thread);
  check("so the conversation still follows the workspace on effort", eff.effort === "xhigh", eff.effort);
  check("...while keeping its own mode", eff.permissionMode === "strict");
  check("...and reports which of the two is explicit", !eff.explicit.effort && eff.explicit.permissionMode);
  await db.close();
}

console.log("\nnull means go back to inheriting, which is not the same as leaving it alone");
{
  const db = await freshDb();
  const store = new ConversationSettingsStore(db);
  const thread = await seedThread(db, ctx.workspaceId);

  await store.set(ctx, thread, { effort: "low" }, null);
  check("it took the override", (await store.effective(ctx, thread)).effort === "low");

  // `undefined` leaves it; `null` clears it. Collapsing the two would leave no way to say "go back
  // to the workspace default" short of guessing what that default currently is and writing it in —
  // which is the frozen-conversation bug again, wearing a different hat.
  await store.set(ctx, thread, { permissionMode: "fast" }, null);
  check("an unrelated patch leaves the override alone", (await store.effective(ctx, thread)).effort === "low");

  await store.set(ctx, thread, { effort: null }, null);
  const back = await store.effective(ctx, thread);
  check("null clears it back to the workspace default", back.effort === DEFAULT_EFFORT, back.effort);
  check("...and it is no longer explicit", !back.explicit.effort);
  await db.close();
}

console.log("\n§3.2 — a pinned workspace overrides the conversation, not the other way round");
{
  const db = await freshDb();
  const store = new ConversationSettingsStore(db);
  const thread = await seedThread(db, ctx.workspaceId);

  await store.set(ctx, thread, { permissionMode: "fast" }, null);
  check("the conversation chose Fast", (await store.effective(ctx, thread)).permissionMode === "fast");

  await store.setWorkspaceDefaults(ctx, { permissionMode: "strict", pinned: true });
  const pinned = await store.effective(ctx, thread);
  check("the pin wins over the stored choice", pinned.permissionMode === "strict", pinned.permissionMode);
  check("...and the client is told it is pinned, so the control renders read-only", pinned.pinned);

  // Un-pinning gives the conversation its own choice back rather than discarding it. A pin that
  // destroyed the value would make an admin's temporary policy permanent for everybody.
  await store.setWorkspaceDefaults(ctx, { pinned: false });
  check("un-pinning restores what the conversation had chosen",
    (await store.effective(ctx, thread)).permissionMode === "fast");
  await db.close();
}

console.log("\n...and disallowing Fast refuses it even where a row already says Fast");
{
  const db = await freshDb();
  const store = new ConversationSettingsStore(db);
  const thread = await seedThread(db, ctx.workspaceId);

  await store.set(ctx, thread, { permissionMode: "fast" }, null);
  await store.setWorkspaceDefaults(ctx, { fastDisallowed: true });

  const e = await store.effective(ctx, thread);
  // The order matters: an admin disallows Fast AFTER people have already chosen it, so a resolver
  // that trusted the stored column would leave exactly the conversations the policy was aimed at
  // running in the mode it was meant to stop.
  check("a stored Fast is not honoured once Fast is disallowed", e.permissionMode !== "fast", e.permissionMode);
  check("...it falls back to the workspace default", e.permissionMode === DEFAULT_PERMISSION_MODE, e.permissionMode);
  check("...and the client is told, so the option renders disabled rather than missing", e.fastDisallowed);

  // The contradictory configuration a UI should prevent and a resolver must survive.
  await store.setWorkspaceDefaults(ctx, { permissionMode: "fast" });
  const contradictory = await store.effective(ctx, thread);
  check("a workspace default of Fast cannot smuggle Fast back in",
    contradictory.permissionMode === "smart", contradictory.permissionMode);
  await db.close();
}

console.log("\ntenancy: another workspace's conversation id resolves to nothing of ours");
{
  const db = await freshDb();
  const store = new ConversationSettingsStore(db);
  const mine = await seedThread(db, ctx.workspaceId);
  const theirs = await seedThread(db, OTHER);

  await store.set(ctx, mine, { effort: "xhigh" }, null);
  await store.set(otherCtx, theirs, { effort: "low" }, null);

  // On SQLite the repository's WHERE is the whole of the enforcement — migration 009 grants this
  // driver no RLS at all — so this is the assertion that the WHERE is actually there.
  const crossed = await store.effective(ctx, theirs);
  check("reading their conversation from our context sees our defaults, not their row",
    crossed.effort === DEFAULT_EFFORT && !crossed.explicit.effort, crossed.effort);
  check("and each workspace still sees its own",
    (await store.effective(ctx, mine)).effort === "xhigh"
    && (await store.effective(otherCtx, theirs)).effort === "low");

  // A write scoped to the wrong workspace is REFUSED OUTRIGHT, and by the database rather than by
  // the store. This is the composite foreign key from migration 054 earning its place: the pair
  // (our workspace, their thread) does not exist in `threads`, so the INSERT cannot be written at
  // all. A single-column FK on `threads(id)` would have accepted it — the id is real, it just
  // belongs to somebody else — and left a row in our workspace shadowing their conversation.
  //
  // That is the exact class of bug §7 names: "a bare agent FK is satisfiable by any tenant's
  // agent, which is precisely the class of bug the earlier tenancy hunt turned up."
  let refused = false;
  try {
    await store.set(ctx, theirs, { effort: "high" }, null);
  } catch {
    refused = true;
  }
  check("a cross-workspace write is refused by the composite key", refused);
  check("...and their row is untouched", (await store.effective(otherCtx, theirs)).effort === "low");
  await db.close();
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exitCode = fail === 0 ? 0 : 1;
