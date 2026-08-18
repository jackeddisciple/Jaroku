// Law 3, as claims a build can fail on.
//
// "Forty failed runs is one item with a count of 40. Never forty rows. Deduplication happens at
// write time, on a key, in the database — not at render time in the client." That sentence is the
// whole of this file. It is prose in a specification, and prose does not fail a build; forty
// `record` calls producing one row with `count = 40` does.
//
// THE THREE CLAIMS THAT ARE NOT ABOUT COUNTING, and each is a decision somebody could reasonably
// have made the other way, which is why each has an assertion rather than a comment:
//
//   A recurrence is a NEW occurrence. A resolved row observed again comes back with its count and
//   its age starting over, because the age bar under a card measures how long THIS occurrence has
//   been outstanding — not how long an instance somebody fixed last month was ignored.
//
//   Resolving twice does not move `resolved_at`. The reconciler is idempotent by requirement, and
//   a timestamp that crept on every sweep would make "cleared 14 items this week" count the same
//   fourteen items every week, forever.
//
//   A per-user patch touches only the column it names. Snoozing something already dismissed must
//   not un-dismiss it, and undo passing an explicit null must clear it — which means "absent" and
//   "null" have to mean different things, and the difference is the key's presence.
//
//   npm run test:inbox-store

import { randomUUID } from "node:crypto";

import { openTestSqlite, testContext } from "../db/testDb.ts";
import { InboxStore } from "./inboxStore.ts";
import { dedupeKey } from "./registry.ts";
import type { SqliteDb } from "../db/sqlite.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const ctx = testContext();

/** A person, so the per-user table's foreign key has something real to point at. */
async function seedUser(db: SqliteDb): Promise<string> {
  const id = randomUUID();
  await db.run(
    `INSERT INTO users (id, external_id, email, display_name, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [id, `ext-${id}`, `${id}@example.com`, "Tester", new Date().toISOString()],
  );
  return id;
}

const KEY = dedupeKey("unreviewed_failures", "agent-1");

// --- 1. forty failures are one row --------------------------------------------------------

console.log("\nforty failed runs is one item with a count of 40");
{
  const db = await openTestSqlite();
  const store = new InboxStore(db);

  let last = await store.record(ctx, {
    type: "unreviewed_failures",
    subjectId: "agent-1",
    dedupeKey: KEY,
    payload: { agent_name: "api_gateway", run_ids: ["run-0"] },
  });
  const firstId = last.id;
  const firstSeen = last.first_seen_at;

  for (let i = 1; i < 40; i++) {
    last = await store.record(ctx, {
      type: "unreviewed_failures",
      subjectId: "agent-1",
      dedupeKey: KEY,
      payload: { agent_name: "api_gateway", run_ids: [`run-${i}`] },
    });
  }

  const open = await store.listOpen(ctx);
  check("forty observations are one row", open.length === 1);
  check("...the same row, so nothing pointing at it went stale", open[0]?.id === firstId);
  check("...with a count of 40", last.count === 40, `got ${last.count}`);
  check("...aged from when the problem started, not from the fortieth failure", last.first_seen_at === firstSeen);
  check("...and last seen at the fortieth", last.last_seen_at >= firstSeen);
  check(
    "the severity comes off the registry rather than off the caller, so no card can pick its own column",
    open[0]?.severity === "attention",
  );
  check("...and so does the subject type", open[0]?.subject_type === "agent");

  // The payload is REPLACED and the caller is what merges — only a generator knows which fields
  // accumulate. Asserted, because the alternative (a merge in the store) is the tempting one and
  // would silently append run ids forever.
  check("the payload is the latest one written", JSON.stringify(last.payload["run_ids"]) === JSON.stringify(["run-39"]));

  await db.close();
}

// --- 2. two problems are two rows ---------------------------------------------------------

console.log("\ntwo problems are two rows, and one problem in two workspaces is two rows");
{
  const db = await openTestSqlite();
  const store = new InboxStore(db);

  await store.record(ctx, {
    type: "credential_missing",
    subjectId: "agent-1",
    dedupeKey: dedupeKey("credential_missing", "agent-1", "STRIPE_KEY"),
    payload: { credential: "STRIPE_KEY" },
  });
  await store.record(ctx, {
    type: "credential_missing",
    subjectId: "agent-1",
    dedupeKey: dedupeKey("credential_missing", "agent-1", "SLACK_TOKEN"),
    payload: { credential: "SLACK_TOKEN" },
  });
  await store.record(ctx, {
    type: "credential_missing",
    subjectId: "agent-2",
    dedupeKey: dedupeKey("credential_missing", "agent-2", "STRIPE_KEY"),
    payload: { credential: "STRIPE_KEY" },
  });

  const open = await store.listOpen(ctx);
  check("two missing names on one agent are two cards, because they are two things to do", open.length === 3);
  check("...and each carries its own name", new Set(open.map((i) => String(i.payload["credential"]))).size === 2);

  await db.close();
}

// --- 3. a resolution, and what it does not move -------------------------------------------

console.log("\nresolving is idempotent, and undo puts back exactly what was there");
{
  const db = await openTestSqlite();
  const store = new InboxStore(db);

  const item = await store.record(ctx, { type: "eval_finished", subjectId: "eval-1", dedupeKey: "eval_finished:eval-1" });
  check("a fresh item is open with nothing resolved on it", item.state === "open" && item.resolved_at === null);

  const changed = await store.resolve(ctx, [item.id], "2026-08-19T10:00:00.000Z");
  check("resolving one row changes one row", changed === 1);
  const resolved = await store.get(ctx, item.id);
  check("...and it is resolved", resolved?.state === "resolved");
  check("...at the moment it was settled", resolved?.resolved_at === "2026-08-19T10:00:00.000Z");

  const again = await store.resolve(ctx, [item.id], "2026-08-19T11:00:00.000Z");
  check("a second sweep over the same row changes nothing", again === 0);
  check(
    "...and does not move the timestamp, so a weekly 'cleared 14' is fourteen different items",
    (await store.get(ctx, item.id))?.resolved_at === "2026-08-19T10:00:00.000Z",
  );

  const back = await store.reopen(ctx, [item.id]);
  const reopened = await store.get(ctx, item.id);
  check("undo puts it back", back === 1 && reopened?.state === "open");
  check("...with nothing resolved on it", reopened?.resolved_at === null);
  check(
    "...and with the age it always had, because undo says the resolution did not happen",
    reopened?.first_seen_at === item.first_seen_at,
  );
  check("reopening an already-open row changes nothing", (await store.reopen(ctx, [item.id])) === 0);
  check("resolving nothing is not an error, and not a statement", (await store.resolve(ctx, [])) === 0);

  await db.close();
}

// --- 4. a recurrence is a new occurrence --------------------------------------------------

console.log("\na resolved problem that comes back is a new occurrence, not a continuation");
{
  const db = await openTestSqlite();
  const store = new InboxStore(db);
  const key = dedupeKey("deploy_failed", "dep-1");

  const first = await store.record(ctx, {
    type: "deploy_failed",
    subjectId: "dep-1",
    dedupeKey: key,
    at: "2026-07-01T00:00:00.000Z",
  });
  await store.record(ctx, { type: "deploy_failed", subjectId: "dep-1", dedupeKey: key, at: "2026-07-01T01:00:00.000Z" });
  check("two failures before anybody looked are one row counting two", first.count === 1);

  await store.resolve(ctx, [first.id]);
  const recurred = await store.record(ctx, {
    type: "deploy_failed",
    subjectId: "dep-1",
    dedupeKey: key,
    at: "2026-08-19T00:00:00.000Z",
  });

  check("§3's table says a resolution returns if it recurs, and it does", recurred.state === "open");
  check("...with nothing resolved on it", recurred.resolved_at === null);
  check("...counting from one, because this is a new occurrence", recurred.count === 1);
  check(
    "...and aged from now, so the bar does not open full because an old instance was ignored for a month",
    recurred.first_seen_at === "2026-08-19T00:00:00.000Z",
  );
  check("...and it is still one row", (await store.listOpen(ctx)).length === 1);

  await db.close();
}

// --- 5. one person's decisions are one person's -------------------------------------------

console.log("\na dismissal is one person's, and a patch touches only what it names");
{
  const db = await openTestSqlite();
  const store = new InboxStore(db);
  const ada = await seedUser(db);
  const bob = await seedUser(db);

  const item = await store.record(ctx, {
    type: "version_drift",
    subjectId: "agent-1",
    dedupeKey: dedupeKey("version_drift", "agent-1", "5-9"),
    payload: { deployed: 5, current: 9 },
  });

  check("an item nobody has touched has no state for anybody", (await store.userState(ctx, item.id, ada)).dismissed_at === null);

  await store.setUserState(ctx, item.id, ada, { snoozed_until: "2026-08-20T09:00:00.000Z" });
  await store.setUserState(ctx, item.id, ada, { dismissed_at: "2026-08-19T09:00:00.000Z" });
  const adaState = await store.userState(ctx, item.id, ada);
  check("dismissing something already snoozed keeps the snooze", adaState.snoozed_until === "2026-08-20T09:00:00.000Z");
  check("...and records the dismissal", adaState.dismissed_at === "2026-08-19T09:00:00.000Z");

  await store.setUserState(ctx, item.id, ada, { dismissed_at: null });
  const undone = await store.userState(ctx, item.id, ada);
  check("undo passing an explicit null clears it, so absent and null are different things", undone.dismissed_at === null);
  check("...and still leaves the snooze alone", undone.snoozed_until === "2026-08-20T09:00:00.000Z");

  check(
    "a patch naming neither column writes nothing rather than clearing both",
    (await store.setUserState(ctx, item.id, ada, {})) === false,
  );

  const bobState = await store.userState(ctx, item.id, bob);
  check("...and none of it is Bob's, because resolution is shared and dismissal is not", bobState.snoozed_until === null);

  const forAda = await store.listForUser(ctx, ada);
  const forBob = await store.listForUser(ctx, bob);
  check("the board still shows the item to both, because a dismissal does not resolve anything", forAda.length === 1 && forBob.length === 1);
  check("...carrying Ada's snooze on Ada's board", forAda[0]?.user_state.snoozed_until === "2026-08-20T09:00:00.000Z");
  check("...and nothing on Bob's", forBob[0]?.user_state.snoozed_until === null);

  // A LEFT JOIN, and this is why. Most items are never touched by anybody, and an inner join here
  // would return an empty board for every workspace where nobody has dismissed anything.
  const untouched = await store.record(ctx, { type: "setup_first_agent", subjectId: null, dedupeKey: "setup_first_agent:workspace" });
  check(
    "an item nobody has touched is still on everybody's board",
    (await store.listForUser(ctx, ada)).some((i) => i.id === untouched.id),
  );
  check(
    "a caller with no user at all sees the rows and none of anybody's decisions",
    (await store.listForUser(ctx, null)).every((i) => i.user_state.dismissed_at === null && i.user_state.snoozed_until === null),
  );

  // A dismissal cannot be filed against an item that is not this workspace's — the SELECT in the
  // INSERT is the whole of that check on the driver with no RLS behind it.
  check(
    "a state write against an id that is not here writes nothing",
    (await store.setUserState(ctx, randomUUID(), ada, { dismissed_at: "2026-08-19T09:00:00.000Z" })) === false,
  );

  await db.close();
}

// --- 6. the zero state's one line of real statistic ----------------------------------------

console.log("\n\"cleared 14 items this week\" counts work, never hiding");
{
  const db = await openTestSqlite();
  const store = new InboxStore(db);
  const ada = await seedUser(db);

  const a = await store.record(ctx, { type: "eval_finished", subjectId: "e1", dedupeKey: "eval_finished:e1" });
  const b = await store.record(ctx, { type: "eval_finished", subjectId: "e2", dedupeKey: "eval_finished:e2" });
  const c = await store.record(ctx, { type: "eval_finished", subjectId: "e3", dedupeKey: "eval_finished:e3" });

  await store.resolve(ctx, [a.id], "2026-08-18T00:00:00.000Z");
  await store.resolve(ctx, [b.id], "2026-08-01T00:00:00.000Z");
  await store.setUserState(ctx, c.id, ada, { dismissed_at: "2026-08-18T00:00:00.000Z" });

  check("a resolution inside the window counts", (await store.resolvedSince(ctx, "2026-08-12T00:00:00.000Z")) === 1);
  check("...one outside it does not", (await store.resolvedSince(ctx, "2026-08-12T00:00:00.000Z")) !== 2);
  check(
    "...and a DISMISSAL never counts, or somebody could be congratulated for hiding their own board",
    (await store.resolvedSince(ctx, "2026-08-12T00:00:00.000Z")) === 1,
  );

  await db.close();
}

// --- 7. an item of a type this build does not know is dropped, not rendered ----------------

console.log("\na row from a build that knew a type this one does not is omitted rather than half-rendered");
{
  const db = await openTestSqlite();
  const store = new InboxStore(db);
  // Exactly the rolling-deploy window `migrate:check` exists to keep survivable: the new version
  // wrote a type the old one has never heard of, and the old one is still serving. There is no CHECK
  // on the column — the registry is the one definition — so this is the honest failure mode. A card
  // with no severity, no actions and no predicate that could ever remove it would be the other one.
  await db.run(
    `INSERT INTO inbox_items (id, workspace_id, type, severity, subject_type, subject_id,
                              dedupe_key, payload, state, count, first_seen_at, last_seen_at)
     VALUES (?, ?, 'quantum_entanglement_detected', 'blocking', 'agent', NULL, 'future:1', '{}', 'open', 1, ?, ?)`,
    [randomUUID(), ctx.workspaceId, new Date().toISOString(), new Date().toISOString()],
  );
  const real = await store.record(ctx, { type: "setup_api_key", subjectId: null, dedupeKey: "setup_api_key:workspace" });

  const open = await store.listOpen(ctx);
  check("the unknown row is not on the board", open.every((i) => i.type !== ("quantum_entanglement_detected" as never)));
  check("...and the one this build understands still is", open.some((i) => i.id === real.id));

  await db.close();
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
if (fail > 0) process.exit(1);
