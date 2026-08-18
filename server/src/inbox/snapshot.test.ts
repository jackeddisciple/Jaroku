// Three verbs, and what each of them does to what somebody sees.
//
// THE ASSERTIONS THAT MATTER ARE ABOUT THE DIFFERENCES BETWEEN THEM, because collapsing any two is
// the failure the specification spends §3 preventing:
//
//   A dismissal is one person's. Ada dismissing something must not clear it from Bob's board, and
//   must not resolve it for anybody — resolution is shared and dismissal is not.
//
//   A snooze RETURNS, and is visible while it waits. Snoozed work that vanished would make snooze a
//   slower dismissal, which is the exact thing §3 says makes people dismiss what they care about.
//
//   A snooze that has fired is simply back, evaluated at read time. There is no job to run, so
//   there is nothing that can fail to run and leave an item away forever.
//
// AND THE BADGE, WHICH IS A PRODUCT DECISION WITH A WARNING ATTACHED: blocking plus proposals only.
// "If the badge counts everything it will never reach zero, and a badge that is never zero is a
// badge people train themselves to ignore. This is a product decision, not an oversight — do not
// fix it." So there is a test that fails if somebody does.
//
//   npm run test:inbox-snapshot

import { randomUUID } from "node:crypto";

import { openTestSqlite, testContext } from "../db/testDb.ts";
import { InboxStore } from "./inboxStore.ts";
import { CLEARED_WINDOW_MS, RAIL_AGENT_LIMIT, inboxSnapshot, isSnoozeDuration, snoozeUntil } from "./snapshot.ts";
import { dedupeKey } from "./registry.ts";
import type { SqliteDb } from "../db/sqlite.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const ctx = testContext();
const NOW = Date.parse("2026-08-19T16:00:00.000Z");
const HOUR = 3_600_000;

async function seedUser(db: SqliteDb): Promise<string> {
  const id = randomUUID();
  await db.run(
    `INSERT INTO users (id, external_id, email, display_name, created_at) VALUES (?, ?, ?, ?, ?)`,
    [id, `ext-${id}`, `${id}@example.com`, "Tester", new Date().toISOString()],
  );
  return id;
}

const AGENT_A = "11111111-1111-4111-8111-111111111111";
const AGENT_B = "22222222-2222-4222-8222-222222222222";

// --- 1. the snooze durations ----------------------------------------------------------------

console.log("\nthree durations, and tomorrow is a time of day rather than an offset");
{
  check("an hour is an hour", snoozeUntil("hour", NOW) === new Date(NOW + HOUR).toISOString());
  check("a week is seven days", snoozeUntil("week", NOW) === new Date(NOW + 7 * 86_400_000).toISOString());
  check(
    "tomorrow from four in the afternoon is nine the next morning, not four the next afternoon",
    snoozeUntil("tomorrow", NOW) === "2026-08-20T09:00:00.000Z",
    snoozeUntil("tomorrow", NOW),
  );
  const threeAm = Date.parse("2026-08-19T03:00:00.000Z");
  check(
    "...and tomorrow from three in the morning is not six hours later, which is not tomorrow by any reading",
    snoozeUntil("tomorrow", threeAm) === "2026-08-20T09:00:00.000Z",
    snoozeUntil("tomorrow", threeAm),
  );
  check("a duration a client invented is not one of the three", !isSnoozeDuration("forever"));
}

// --- 2. dismissal is one person's -------------------------------------------------------------

console.log("\na dismissal clears one board and resolves nothing");
{
  const db = await openTestSqlite();
  const store = new InboxStore(db);
  const ada = await seedUser(db);
  const bob = await seedUser(db);

  const item = await store.record(ctx, {
    type: "version_drift",
    subjectId: AGENT_A,
    dedupeKey: dedupeKey("version_drift", AGENT_A, "5-9"),
    payload: { agent_name: "api_gateway", deployed: 5, current: 9 },
  });

  await store.setUserState(ctx, item.id, ada, { dismissed_at: new Date(NOW).toISOString() });

  const forAda = await inboxSnapshot(store, ctx, ada, { team: false, now: NOW });
  const forBob = await inboxSnapshot(store, ctx, bob, { team: false, now: NOW });

  check("Ada's board is empty", forAda.items.length === 0 && forAda.counts.all === 0);
  check("...and Bob's is not, because a dismissal is a judgement and not a fix", forBob.items.length === 1);
  check("...and the row is still open, so the sweep will still resolve it when it is fixed",
    (await store.get(ctx, item.id))?.state === "open");
  check("a dismissed item is not in the tray either — it is not waiting for anything", forAda.snoozed.length === 0);

  await db.close();
}

// --- 3. a snooze returns, and is visible while it waits ---------------------------------------

console.log("\na snooze stays visible, and comes back on its own");
{
  const db = await openTestSqlite();
  const store = new InboxStore(db);
  const ada = await seedUser(db);

  const item = await store.record(ctx, {
    type: "eval_finished", subjectId: "ev-1", dedupeKey: dedupeKey("eval_finished", "ev-1"),
    payload: { dataset_name: "regression" },
  });
  await store.setUserState(ctx, item.id, ada, { snoozed_until: snoozeUntil("hour", NOW) });

  const during = await inboxSnapshot(store, ctx, ada, { team: false, now: NOW });
  check("it is off the board", during.items.length === 0);
  check("...and in the tray, because snoozed work that vanished would make snooze a slower dismissal",
    during.snoozed.length === 1);
  check("...counted as snoozed", during.counts.snoozed === 1);
  check("...and not counted in `all`, or a chip would send somebody looking for a card in the tray",
    during.counts.all === 0);
  check("...carrying when it returns, which is what the tray's own line reads", during.snoozed[0]?.snoozed_until !== null);

  // NOTHING RUNS IN BETWEEN. The timer firing is not a job; it is a comparison at read time, so
  // there is nothing that can fail to run and leave an item away forever.
  const after = await inboxSnapshot(store, ctx, ada, { team: false, now: NOW + HOUR + 1000 });
  check("across the timer it is simply back", after.items.length === 1);
  check("...out of the tray", after.snoozed.length === 0);
  check("...and the snooze column is still set, because nothing had to clear it", after.items[0]?.snoozed_until !== null);

  await db.close();
}

// --- 4. the badge, and the product decision behind it -----------------------------------------

console.log("\nthe badge counts blocking plus proposals, and Attention is deliberately not in it");
{
  const db = await openTestSqlite();
  const store = new InboxStore(db);
  const ada = await seedUser(db);

  await store.record(ctx, { type: "credential_missing", subjectId: AGENT_A, dedupeKey: "b1", payload: { credential: "K" } });
  await store.record(ctx, { type: "deploy_failed", subjectId: "d1", dedupeKey: "b2", payload: {} });
  await store.record(ctx, { type: "eval_finished", subjectId: "e1", dedupeKey: "a1", payload: {} });
  await store.record(ctx, { type: "version_drift", subjectId: AGENT_A, dedupeKey: "a2", payload: {} });
  await store.record(ctx, { type: "unreviewed_failures", subjectId: AGENT_A, dedupeKey: "a3", payload: {} });
  await store.record(ctx, { type: "memory_proposal", subjectId: AGENT_A, dedupeKey: "p1", payload: {} });

  const snap = await inboxSnapshot(store, ctx, ada, { team: false, now: NOW });
  check("two blocking", snap.counts.blocking === 2, `${snap.counts.blocking}`);
  check("three attention", snap.counts.attention === 3, `${snap.counts.attention}`);
  check("one proposal", snap.counts.proposals === 1, `${snap.counts.proposals}`);
  check("six in all", snap.counts.all === 6);
  check(
    "AND THE BADGE IS THREE, NOT SIX — a badge that counts everything never reaches zero and is a badge people ignore",
    snap.counts.badge === 3,
    `${snap.counts.badge}`,
  );
  check(
    "...which is exactly blocking plus proposals",
    snap.counts.badge === snap.counts.blocking + snap.counts.proposals,
  );

  // §4.2's order: severity, then age. The user does not choose it.
  check("blocking cards come first", snap.items.slice(0, 2).every((i) => i.severity === "blocking"));
  check("...then attention", snap.items.slice(2, 5).every((i) => i.severity === "attention"));
  check("...then proposals", snap.items[5]?.severity === "proposal");

  await db.close();
}

// --- 5. team items exist only in a Team workspace ----------------------------------------------

console.log("\nteam items are absent in Personal, not greyed and not empty");
{
  const db = await openTestSqlite();
  const store = new InboxStore(db);
  const ada = await seedUser(db);

  await store.record(ctx, { type: "invite_pending", subjectId: "inv-1", dedupeKey: "t1", payload: { email: "sam@example.com" } });
  await store.record(ctx, { type: "eval_finished", subjectId: "ev-1", dedupeKey: "a1", payload: {} });

  const personal = await inboxSnapshot(store, ctx, ada, { team: false, now: NOW });
  check("a Personal workspace sees only the one that applies to it", personal.counts.all === 1);
  check("...and its team count is zero rather than hidden-but-counted", personal.counts.team === 0);

  const team = await inboxSnapshot(store, ctx, ada, { team: true, now: NOW });
  check("a Team workspace sees both", team.counts.all === 2);
  check("...with the team filter counting the one that is one", team.counts.team === 1);

  await db.close();
}

// --- 6. the left rail's per-agent breakdown ----------------------------------------------------

console.log("\nthe rail names the top five agents, by name and by count");
{
  const db = await openTestSqlite();
  const store = new InboxStore(db);
  const ada = await seedUser(db);

  for (let i = 0; i < 3; i++) {
    await store.record(ctx, { type: "credential_missing", subjectId: AGENT_A, dedupeKey: `a${i}`, payload: { credential: `K${i}` } });
  }
  await store.record(ctx, { type: "credential_missing", subjectId: AGENT_B, dedupeKey: "b0", payload: { credential: "K" } });
  // Not about an agent at all — the onboarding items are about the workspace, and must not become a
  // row in a breakdown of agents.
  await store.record(ctx, { type: "setup_api_key", subjectId: null, dedupeKey: "setup_api_key:workspace", payload: {} });

  const names = new Map([[AGENT_A, "api_gateway"], [AGENT_B, "billing"]]);
  const snap = await inboxSnapshot(store, ctx, ada, { team: false, agentNames: names, now: NOW });

  check("two agents are named", snap.agents.length === 2);
  check("...most first", snap.agents[0]?.agent_id === AGENT_A && snap.agents[0]?.count === 3);
  check("...by the name somebody recognises rather than a uuid", snap.agents[0]?.name === "api_gateway");
  check("...and the workspace-subject item is not one of them", snap.agents.every((a) => a.agent_id !== null));
  check(`the rail stops at ${RAIL_AGENT_LIMIT}`, snap.agents.length <= RAIL_AGENT_LIMIT);

  await db.close();
}

// --- 7. the zero state's statistic --------------------------------------------------------------

console.log("\n\"cleared 14 items this week\" is work done, never things hidden");
{
  const db = await openTestSqlite();
  const store = new InboxStore(db);
  const ada = await seedUser(db);

  const a = await store.record(ctx, { type: "eval_finished", subjectId: "e1", dedupeKey: "k1", payload: {} });
  const b = await store.record(ctx, { type: "eval_finished", subjectId: "e2", dedupeKey: "k2", payload: {} });
  const c = await store.record(ctx, { type: "eval_finished", subjectId: "e3", dedupeKey: "k3", payload: {} });

  await store.resolve(ctx, [a.id], new Date(NOW - HOUR).toISOString());
  await store.resolve(ctx, [b.id], new Date(NOW - CLEARED_WINDOW_MS - HOUR).toISOString());
  await store.setUserState(ctx, c.id, ada, { dismissed_at: new Date(NOW).toISOString() });

  const snap = await inboxSnapshot(store, ctx, ada, { team: false, now: NOW });
  check("one resolution inside the week counts", snap.cleared_this_week === 1, `${snap.cleared_this_week}`);
  check("...and the board is empty, which is the state the statistic is rendered under", snap.items.length === 0);

  await db.close();
}

// --- 8. a card carries what the registry says, not what the column happens to hold ---------------

console.log("\nseverity and actions come off the registry, so an old row cannot land in the wrong column");
{
  const db = await openTestSqlite();
  const store = new InboxStore(db);
  const ada = await seedUser(db);

  const item = await store.record(ctx, {
    type: "credential_missing", subjectId: AGENT_A,
    dedupeKey: dedupeKey("credential_missing", AGENT_A, "STRIPE_KEY"),
    payload: { credential: "STRIPE_KEY", agent_name: "api_gateway" },
  });
  // A row whose stored severity disagrees with what the registry says the type means today — which
  // is what a build that changed a type's severity leaves behind.
  await db.run(`UPDATE inbox_items SET severity = 'proposal' WHERE id = ?`, [item.id]);

  const snap = await inboxSnapshot(store, ctx, ada, { team: false, now: NOW });
  check("the card is Blocking, because that is what the type means", snap.items[0]?.severity === "blocking");
  check("...and the count agrees with the card rather than with the column", snap.counts.blocking === 1);
  check("its actions are the registry's, primary first", snap.items[0]?.actions[0] === "set_secret");
  check("...and the subject line is the server's sentence, not a template the client filled in",
    snap.items[0]?.subject.includes("STRIPE_KEY") === true, snap.items[0]?.subject);

  await db.close();
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
if (fail > 0) process.exit(1);
