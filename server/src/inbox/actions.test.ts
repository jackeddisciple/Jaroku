// Undo, bulk, and the two items a new workspace is given.
//
// UNDO IS WHY THERE ARE NO CONFIRMATION DIALOGS ON THIS SURFACE, so it has to actually work — and
// the assertions that matter are the ones where a naive implementation looks right:
//
//   Undoing a dismissal restores the PRIOR value, not null. An item dismissed last week and
//   dismissed again by a bulk action today has two dismissals and one column; clearing it would undo
//   both and put the card back on a board somebody had deliberately cleared.
//
//   A token works once. Pressing undo twice must not be a way to reopen something resolved since.
//
//   A token is scoped on redemption. A uuid is unguessable and "unguessable" is not a tenancy
//   boundary — nothing else in this codebase treats one as such, and this does not either.
//
//   The seeds are written once and never again. `record` re-opens a resolved row on the same key, so
//   a seed rule running every minute would resurrect "Add a provider key" the moment somebody removed
//   one — turning a one-time welcome into a permanent nag.
//
//   npm run test:inbox-actions

import { randomUUID } from "node:crypto";

import { openTestSqlite, testContext } from "../db/testDb.ts";
import { newRequestId, systemContextFor } from "../db/tenant.ts";
import { InboxStore } from "./inboxStore.ts";
import { UndoLedger, applyInboxAction, isInboxAction, seedOnboardingItems, undoInboxAction } from "./actions.ts";
import { inboxSnapshot, snoozeUntil } from "./snapshot.ts";
import { dedupeKey } from "./registry.ts";
import type { SqliteDb } from "../db/sqlite.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const ctx = testContext();
const OTHER = randomUUID();
const otherCtx = systemContextFor(OTHER, newRequestId());
const NOW = Date.parse("2026-08-19T16:00:00.000Z");
const AGENT = "11111111-1111-4111-8111-111111111111";

async function freshDb(): Promise<SqliteDb> {
  const db = await openTestSqlite();
  await db.run(
    `INSERT INTO workspaces (id, slug, name, kind, plan, created_at) VALUES (?, ?, ?, 'team', 'free', ?)`,
    [OTHER, `ws-${OTHER.slice(0, 8)}`, "Other", new Date().toISOString()],
  );
  return db;
}

async function seedUser(db: SqliteDb): Promise<string> {
  const id = randomUUID();
  await db.run(
    `INSERT INTO users (id, external_id, email, display_name, created_at) VALUES (?, ?, ?, ?, ?)`,
    [id, `ext-${id}`, `${id}@example.com`, "Tester", new Date().toISOString()],
  );
  return id;
}

async function drift(store: InboxStore, c = ctx, pair = "5-9"): Promise<string> {
  const item = await store.record(c, {
    type: "version_drift",
    subjectId: AGENT,
    dedupeKey: dedupeKey("version_drift", AGENT, pair),
    payload: { agent_name: "api_gateway", deployed: 5, current: 9 },
  });
  return item.id;
}

// --- 1. the three verbs, singly --------------------------------------------------------------

console.log("\neach verb does its own thing, and hands back one token");
{
  const db = await freshDb();
  const store = new InboxStore(db);
  const undo = new UndoLedger(() => NOW);
  const ada = await seedUser(db);

  const a = await drift(store, ctx, "5-9");
  const dismissed = await applyInboxAction(store, undo, ctx, ada, { action: "dismiss", itemIds: [a] }, NOW);
  check("dismissing changes one", dismissed.changed === 1);
  check("...and offers a token", typeof dismissed.undoToken === "string");
  check("...clearing it from this person's board", (await inboxSnapshot(store, ctx, ada, { team: false, now: NOW })).items.length === 0);
  check("...without resolving the row for anybody", (await store.get(ctx, a))?.state === "open");

  const b = await drift(store, ctx, "5-10");
  await applyInboxAction(store, undo, ctx, ada, { action: "snooze", itemIds: [b], duration: "tomorrow" }, NOW);
  const snap = await inboxSnapshot(store, ctx, ada, { team: false, now: NOW });
  check("snoozing moves it to the tray", snap.snoozed.length === 1);
  check("...until the duration says", snap.snoozed[0]?.snoozed_until === snoozeUntil("tomorrow", NOW));

  const c = await drift(store, ctx, "5-11");
  await applyInboxAction(store, undo, ctx, ada, { action: "resolve", itemIds: [c] }, NOW);
  check("resolving settles the SHARED row, because the problem is shared", (await store.get(ctx, c))?.state === "resolved");

  check("an action a client invented is not one of the three", !isInboxAction("archive"));
  await db.close();
}

// --- 2. a verb a type does not offer is refused ------------------------------------------------

console.log("\na card with no dismissal cannot be dismissed by a client that sends one anyway");
{
  const db = await freshDb();
  const store = new InboxStore(db);
  const undo = new UndoLedger(() => NOW);
  const ada = await seedUser(db);

  const item = await store.record(ctx, {
    type: "mcp_auth_required", subjectId: "linear", dedupeKey: dedupeKey("mcp_auth_required", "linear"),
    payload: { server_name: "Linear" },
  });
  const res = await applyInboxAction(store, undo, ctx, ada, { action: "dismiss", itemIds: [item.id] }, NOW);
  check("nothing changed", res.changed === 0);
  check("...and it is reported rather than silently swallowed", res.skipped.includes(item.id));
  check("...so the card is still there — a server that cannot authenticate still needs a credential",
    (await inboxSnapshot(store, ctx, ada, { team: false, now: NOW })).items.length === 1);
  check("...and there is nothing to undo", res.undoToken === null);

  await db.close();
}

// --- 3. bulk is the same path -------------------------------------------------------------------

console.log("\nforty at once is one action and one token");
{
  const db = await freshDb();
  const store = new InboxStore(db);
  const undo = new UndoLedger(() => NOW);
  const ada = await seedUser(db);

  const ids: string[] = [];
  for (let i = 0; i < 40; i++) ids.push(await drift(store, ctx, `${i}-99`));

  const res = await applyInboxAction(store, undo, ctx, ada, { action: "dismiss", itemIds: ids }, NOW);
  check("forty dismissed", res.changed === 40);
  check("...under ONE token, because one action produced them", typeof res.undoToken === "string");
  check("...clearing the board", (await inboxSnapshot(store, ctx, ada, { team: false, now: NOW })).items.length === 0);

  const back = await undoInboxAction(store, undo, ctx, ada, res.undoToken!);
  check("one press puts all forty back", back.restored === 40);
  check("...on the board", (await inboxSnapshot(store, ctx, ada, { team: false, now: NOW })).items.length === 40);

  await db.close();
}

// --- 4. undo restores the prior value, not null --------------------------------------------------

console.log("\nundo puts back what was there, which is not the same as clearing the column");
{
  const db = await freshDb();
  const store = new InboxStore(db);
  const undo = new UndoLedger(() => NOW);
  const ada = await seedUser(db);

  const item = await drift(store, ctx);
  // Dismissed last week, and dismissed again today by a bulk action.
  const lastWeek = new Date(NOW - 7 * 86_400_000).toISOString();
  await store.setUserState(ctx, item, ada, { dismissed_at: lastWeek });
  const res = await applyInboxAction(store, undo, ctx, ada, { action: "dismiss", itemIds: [item] }, NOW);
  await undoInboxAction(store, undo, ctx, ada, res.undoToken!);

  check(
    "the earlier dismissal survives, because undo takes back one action rather than the column",
    (await store.userState(ctx, item, ada)).dismissed_at === lastWeek,
  );
  check(
    "...so the card stays off a board somebody had deliberately cleared it from",
    (await inboxSnapshot(store, ctx, ada, { team: false, now: NOW })).items.length === 0,
  );

  // And only the column the action touched: undoing a dismissal must not resurrect a snooze that had
  // already been replaced.
  const other = await drift(store, ctx, "6-9");
  await store.setUserState(ctx, other, ada, { snoozed_until: snoozeUntil("week", NOW) });
  const d = await applyInboxAction(store, undo, ctx, ada, { action: "dismiss", itemIds: [other] }, NOW);
  await undoInboxAction(store, undo, ctx, ada, d.undoToken!);
  check(
    "undoing a dismissal leaves an existing snooze exactly as it was",
    (await store.userState(ctx, other, ada)).snoozed_until === snoozeUntil("week", NOW),
  );

  await db.close();
}

// --- 5. a token works once, and only for its owner -------------------------------------------------

console.log("\na token is single-use, and unguessable is not a tenancy boundary");
{
  const db = await freshDb();
  const store = new InboxStore(db);
  const undo = new UndoLedger(() => NOW);
  const ada = await seedUser(db);
  const bob = await seedUser(db);

  const item = await drift(store, ctx);
  const res = await applyInboxAction(store, undo, ctx, ada, { action: "resolve", itemIds: [item] }, NOW);

  check("the first press restores", (await undoInboxAction(store, undo, ctx, ada, res.undoToken!)).restored === 1);
  check(
    "the second does nothing, so undo is not a way to reopen something resolved since",
    (await undoInboxAction(store, undo, ctx, ada, res.undoToken!)).restored === 0,
  );

  const second = await applyInboxAction(store, undo, ctx, ada, { action: "resolve", itemIds: [item] }, NOW);
  check(
    "somebody else's token is refused even inside the same workspace",
    (await undoInboxAction(store, undo, ctx, bob, second.undoToken!)).restored === 0,
  );
  check(
    "...and another workspace's caller is refused too, with the same answer as a token that never existed",
    (await undoInboxAction(store, undo, otherCtx, ada, second.undoToken!)).restored === 0,
  );
  check("a token nobody minted is refused", (await undoInboxAction(store, undo, ctx, ada, randomUUID())).restored === 0);

  await db.close();
}

console.log("\nthe ledger is bounded, because a triage session is a hundred dismissals");
{
  const ledger = new UndoLedger(() => NOW);
  for (let i = 0; i < 700; i++) {
    ledger.put(ctx, "ada", "dismiss", [{ itemId: `i${i}`, dismissed_at: null, snoozed_until: null, wasOpen: true }]);
  }
  check("it stops growing", ledger.size() <= 500, `${ledger.size()}`);

  // And expiry: a token from an hour ago is gone, toast and all.
  let clock = NOW;
  const ageing = new UndoLedger(() => clock);
  const token = ageing.put(ctx, "ada", "dismiss", []);
  clock = NOW + 3_600_000;
  check("an hour-old token has expired", ageing.take(ctx, "ada", token) === null);
}

// --- 6. the two seeded items ----------------------------------------------------------------------

console.log("\ntwo real items for a new workspace, written once and never again");
{
  const db = await freshDb();
  const store = new InboxStore(db);
  const ada = await seedUser(db);

  const seeded = await seedOnboardingItems(store, ctx, async () => ({ hasProviderKey: false, agentCount: 0 }));
  check("a brand-new workspace is given both", seeded === 2);
  const snap = await inboxSnapshot(store, ctx, ada, { team: false, now: NOW });
  check("...so its Inbox is not empty, which the specification calls confusing rather than delightful",
    snap.items.length === 2);
  check("...one blocking and one proposal, because adding a key blocks and describing an agent does not",
    snap.counts.blocking === 1 && snap.counts.proposals === 1);

  check(
    "a second pass seeds nothing, because the rows exist",
    (await seedOnboardingItems(store, ctx, async () => ({ hasProviderKey: false, agentCount: 0 }))) === 0,
  );

  // THE ONE THAT MATTERS. The items resolve when the thing is done, and must NEVER be raised again —
  // `record` re-opens a resolved row on the same key, so a rule that ran unconditionally would turn a
  // one-time welcome into a nag the day somebody removed their last key.
  const key = await store.byKey(ctx, "setup_api_key:workspace");
  await store.resolve(ctx, [key!.id]);
  const afterResolution = await seedOnboardingItems(store, ctx, async () => ({ hasProviderKey: false, agentCount: 0 }));
  check("a resolved seed is never re-seeded, even with the condition true again", afterResolution === 0);
  check("...and stays resolved", (await store.byKey(ctx, "setup_api_key:workspace"))?.state === "resolved");

  check(
    "a workspace that already has a key and an agent is given nothing at all",
    (await seedOnboardingItems(store, otherCtx, async () => ({ hasProviderKey: true, agentCount: 3 }))) === 0,
  );

  await db.close();
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
if (fail > 0) process.exit(1);
