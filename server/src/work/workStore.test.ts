// The work store, and the three claims §13 asks it to prove.
//
// INSERT AND READ UNDER A CONTEXT is the ordinary half and is here for the reason every store
// suite's happy path is: an assertion about isolation passes trivially against a store that
// returns nothing, so the boring reads have to be right before the interesting ones mean anything.
//
// THE created_seq TIE-BREAK ON A SAME-MILLISECOND PAIR is the one that would otherwise be found by
// somebody watching rows swap places while they read them. `created_at` is an ISO string with
// millisecond resolution on one driver and a `timestamptz` on the other, and two dispatches inside
// one millisecond is not hypothetical — it is a double-click, a retry loop, or a test. Without the
// tie-break "the most recent job" is whichever row the database happened to return first, and this
// list is ordered on every read the tab makes.
//
// THE INPUT CAP REFUSING AT 65,537 BYTES is §4's requirement stated to the byte, and the byte is
// the point: the cap exists because the value crosses an HTTP boundary into somebody's container,
// and a JavaScript string's `.length` is not what that boundary counts. A four-byte emoji is one
// character and four bytes, so a cap written in characters admits a body four times the size it
// meant to.
//
//   npm run test:work-store

import { randomUUID } from "node:crypto";

import { openTestSqlite, testContext } from "../db/testDb.ts";
import { AgentRepository } from "../db/repositories/agents.ts";
import { DeployStore } from "../deployStore.ts";
import { IdentityRepository } from "../db/repositories/identity.ts";
import { newRequestId, systemContext, type TenantContext } from "../db/tenant.ts";
import type { Db } from "../db/db.ts";
import {
  MAX_WORK_INPUT_BYTES, WorkInputTooLarge, WorkStore, WORK_PAGE, WORK_STATUSES,
  isWorkFailureKind, isWorkStatus,
} from "./workStore.ts";

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

/** An agent, a live deployment and a person, so the three foreign keys point at something real. */
async function fixture(db: Db): Promise<{ ctx: TenantContext; agentId: string; deploymentId: string }> {
  const base = testContext();
  const identity = new IdentityRepository(db);
  const agents = new AgentRepository(db);
  const deploys = new DeployStore(db);
  const suffix = randomUUID().slice(0, 8);
  const person = await identity.provisionUser(systemContext(newRequestId()), {
    externalId: `work-${suffix}`,
    email: `work-${suffix}@example.com`,
  });
  const ctx: TenantContext = { ...base, actorUserId: person.user.id };
  const agent = await agents.upsertFromDisk(ctx, { slug: `work_agent_${suffix}`, display_name: "work agent" });
  const deployment = await deploys.create(ctx, {
    agentId: agent.id, provider: "anthropic", model: "claude-haiku-4-5", envKeys: [],
  });
  return { ctx, agentId: agent.id, deploymentId: deployment.id };
}

// --- 1. the closed sets are closed --------------------------------------------------------------
//
// Pure, and first, because everything below reads a status out of a column. A guard that admitted
// anything would make the CHECK constraint in migration 063 the only thing between a typo and a row
// nothing can render, and a constraint violation surfaces as a driver error rather than a refusal.

console.log("\nthe two closed sets");
{
  check("six statuses and no seventh", WORK_STATUSES.length === 6, WORK_STATUSES.join(", "));
  check("every one of them is recognised", WORK_STATUSES.every(isWorkStatus));
  check("and nothing else is", !isWorkStatus("paused") && !isWorkStatus("") && !isWorkStatus(null));
  check(
    "a failure kind is recognised, and a status is not one",
    isWorkFailureKind("stopped_reporting") && !isWorkFailureKind("failed"),
  );
}

// --- 2. insert and read, under a context --------------------------------------------------------

console.log("\ninsert and read");
{
  const db = await openTestSqlite();
  const { ctx, agentId, deploymentId } = await fixture(db);
  const store = new WorkStore(db);

  const runId = randomUUID();
  const item = await store.create(ctx, {
    agentId, deploymentId, runId, input: "refund order 4471",
  });
  check("a new item is queued", item.status === "queued", item.status);
  check("...attributed to the context's own actor", item.created_by === ctx.actorUserId);
  check("...carrying the run id it was given, before anything was dispatched", item.run_id === runId);
  check("...and no ending of any kind", item.ended_at === null && item.failure_kind === null);

  const read = await store.get(ctx, item.id);
  check("it reads back by id", read?.id === item.id);
  check("...with its input intact", read?.input === "refund order 4471");
  check("and by run id, which is what a trace event carries", (await store.byRun(ctx, runId))?.id === item.id);
  check("an id nothing wrote resolves to undefined", (await store.get(ctx, randomUUID())) === undefined);

  const listed = await store.list(ctx, {});
  check("the default list is the actor's own", listed.items.length === 1 && listed.items[0]!.id === item.id);
  check("...and one page is not more than one page", listed.nextCursor === null);

  // A CONTEXT WITH NO ACTOR IS REFUSED RATHER THAN WRITTEN AS NULL. `created_by` is NOT NULL, so a
  // background context would fail at the driver with a constraint message about a column, at the
  // bottom of a stack, instead of a sentence naming what is actually wrong.
  let refusedActor = false;
  try {
    await store.create({ ...ctx, actorUserId: null }, { agentId, deploymentId, runId: randomUUID(), input: "x" });
  } catch (err) {
    refusedActor = /attributed to a person/.test((err as Error).message);
  }
  check("a request that names nobody cannot dispatch", refusedActor);

  await db.close();
}

// --- 3. the tie-break, on a pair that shares a millisecond ---------------------------------------

console.log("\ntwo jobs in one millisecond");
{
  const db = await openTestSqlite();
  const { ctx, agentId, deploymentId } = await fixture(db);
  const store = new WorkStore(db);

  // THE SAME INSTANT, PASSED IN, rather than two calls raced against the clock. A test that hoped
  // for a collision would pass on a slow machine by never producing one, which is the same as not
  // testing it — and `at` exists on `CreateWorkItem` for exactly this.
  const at = "2026-02-03T10:00:00.000Z";
  const first = await store.create(ctx, { agentId, deploymentId, runId: randomUUID(), input: "first", at });
  const second = await store.create(ctx, { agentId, deploymentId, runId: randomUUID(), input: "second", at });

  check("both rows carry the same created_at", first.created_at === second.created_at, at);
  check("...and different sequence numbers", second.created_seq === first.created_seq + 1);

  const page = await store.list(ctx, {});
  check("the newer of the two sorts first", page.items[0]!.id === second.id);
  check("...and the older second", page.items[1]!.id === first.id);

  // The cursor has to be able to sit BETWEEN them, which is the half a `created_at`-only cursor
  // cannot do: a page boundary on a shared millisecond either repeats a row or drops one.
  const onePage = await store.list(ctx, { limit: 1 });
  check("a page of one returns the newer", onePage.items[0]!.id === second.id);
  check("...and offers a cursor", typeof onePage.nextCursor === "string");
  const next = await store.list(ctx, { limit: 1, cursor: onePage.nextCursor });
  check("the next page is the older one, neither repeated nor skipped", next.items[0]!.id === first.id);
  check("...and there is nothing after it", next.nextCursor === null);

  // A cursor that is not one reads as the first page rather than raising. It arrives off the wire.
  const junk = await store.list(ctx, { cursor: "not-a-cursor" });
  check("a malformed cursor reads as the first page", junk.items.length === 2);

  await db.close();
}

// --- 4. the input cap, to the byte ---------------------------------------------------------------

console.log("\nthe input cap");
{
  const db = await openTestSqlite();
  const { ctx, agentId, deploymentId } = await fixture(db);
  const store = new WorkStore(db);

  const atLimit = "x".repeat(MAX_WORK_INPUT_BYTES);
  const accepted = await store.create(ctx, {
    agentId, deploymentId, runId: randomUUID(), input: atLimit,
  });
  check("65,536 bytes is accepted", accepted.input.length === MAX_WORK_INPUT_BYTES);

  let refused: unknown = null;
  try {
    await store.create(ctx, {
      agentId, deploymentId, runId: randomUUID(), input: "x".repeat(MAX_WORK_INPUT_BYTES + 1),
    });
  } catch (err) {
    refused = err;
  }
  check("65,537 is refused", refused instanceof WorkInputTooLarge);
  check(
    "...and the refusal names both figures, so it can be acted on",
    /65,537/.test((refused as Error)?.message ?? "") && /65,536/.test((refused as Error)?.message ?? ""),
  );

  // BYTES, NOT CHARACTERS, and this is the assertion that catches a cap written as `.length`.
  // 16,385 four-byte emoji is 65,540 bytes and 32,770 UTF-16 code units — over the limit either
  // way — so the pair that discriminates is the one just under in characters and just over in
  // bytes. A cap on `.length` would accept it and hand the container a body it refuses with a 413.
  const emoji = "🙂".repeat(MAX_WORK_INPUT_BYTES / 4 + 1);
  let refusedEmoji = false;
  try {
    await store.create(ctx, { agentId, deploymentId, runId: randomUUID(), input: emoji });
  } catch (err) {
    refusedEmoji = err instanceof WorkInputTooLarge;
  }
  check(
    "a string under the limit in characters and over it in bytes is refused",
    refusedEmoji && emoji.length < MAX_WORK_INPUT_BYTES,
    `${emoji.length} chars, ${Buffer.byteLength(emoji, "utf8")} bytes`,
  );

  // And the row that was refused does not exist. §6.2 writes the row before dispatching, so a cap
  // that refused after the insert would leave a job nobody can run and nobody asked to keep.
  const all = await store.list(ctx, { scope: "all" });
  check("nothing refused left a row behind", all.items.length === 1);

  await db.close();
}

// --- 5. the filters, the counts, and the transitions ---------------------------------------------

console.log("\nfilters, counts and transitions");
{
  const db = await openTestSqlite();
  const { ctx, agentId, deploymentId } = await fixture(db);
  const other = await fixture(db);
  const store = new WorkStore(db);

  const mine = await store.create(ctx, { agentId, deploymentId, runId: randomUUID(), input: "mine" });
  const theirs = await store.create(other.ctx, {
    agentId: other.agentId, deploymentId: other.deploymentId, runId: randomUUID(), input: "theirs",
  });

  // "MINE" IS A FILTER, NOT A PERMISSION — §8. Both people are in the same workspace here, which is
  // the case that matters: the toggle must show a colleague's job, because a member whose work was
  // refused has to see what it was refused behind.
  const onlyMine = await store.list(ctx, { scope: "mine" });
  check("mine shows only this actor's jobs", onlyMine.items.length === 1 && onlyMine.items[0]!.id === mine.id);
  const everyone = await store.list(ctx, { scope: "all" });
  check("all shows a colleague's too", everyone.items.some((i) => i.id === theirs.id));

  check("filtering by status finds the queued pair", (await store.list(ctx, { scope: "all", status: "queued" })).items.length === 2);
  check("...and by agent finds one of them", (await store.list(ctx, { scope: "all", agentId })).items.length === 1);

  check("two in flight", (await store.inFlight(ctx)) === 2);
  check("both queued", (await store.countsByStatus(ctx)).queued === 2);

  check("a queued item starts running", (await store.markRunning(ctx, mine.id)) === true);
  check("...and starting it twice is a no-op", (await store.markRunning(ctx, mine.id)) === false);
  const running = await store.get(ctx, mine.id);
  check("...with a started_at it did not have", running?.started_at !== null && running?.ended_at === null);

  check("a running item can park on a confirmation", (await store.markWaiting(ctx, mine.id)) === true);
  check("...and a queued one cannot", (await store.markWaiting(ctx, theirs.id)) === false);
  check("a waiting item is still in flight", (await store.inFlight(ctx)) === 2);
  check("...and is counted as waiting, which is what the badge reads", (await store.countsByStatus(ctx)).waiting === 1);
  check("answering moves it back to running", (await store.markResumed(ctx, mine.id)) === true);
  check("...and answering twice does not", (await store.markResumed(ctx, mine.id)) === false);

  const live = await store.liveByAgent(ctx);
  check("the live breakdown names both agents", new Set(live.map((r) => r.agent_id)).size === 2);

  check(
    "a run_end closes it",
    (await store.finish(ctx, mine.id, { status: "succeeded", output: "refunded" })) === true,
  );
  // IDEMPOTENT, because a cancelled run emits a run_end for the cancellation and both paths land
  // here for the same item. Returning false rather than throwing is what lets a caller broadcast
  // exactly once without the second call being an error in a log nobody reads.
  check("...and closing it again is a no-op rather than an error", (await store.finish(ctx, mine.id, { status: "failed" })) === false);
  const done = await store.get(ctx, mine.id);
  check("the outcome that stuck is the first one", done?.status === "succeeded" && done?.output === "refunded");
  check("...with an ended_at", done?.ended_at !== null);
  check("and it is no longer in flight", (await store.inFlight(ctx)) === 1);

  // A failure kind rides with a failure and never with anything else.
  await store.finish(ctx, theirs.id, {
    status: "failed", error: "the deployment refused Jaroku's credential", failureKind: "unauthorised",
  });
  check("a failed item carries its kind", (await store.get(ctx, theirs.id))?.failure_kind === "unauthorised");

  // `attachRun` only ever repoints a job that has not started. A guard that let it move a running
  // one would orphan a live trace, which is the failure nothing downstream could recover from.
  const requeued = await store.create(ctx, { agentId, deploymentId, runId: randomUUID(), input: "again" });
  const freshRun = randomUUID();
  check("a queued item can be repointed at a fresh run", (await store.attachRun(ctx, requeued.id, freshRun)) === true);
  check("...and reads back at it", (await store.get(ctx, requeued.id))?.run_id === freshRun);
  await store.markRunning(ctx, requeued.id);
  check("...but a running one cannot", (await store.attachRun(ctx, requeued.id, randomUUID())) === false);

  await db.close();
}

// --- 6. the page ceiling holds ------------------------------------------------------------------

console.log("\nthe page ceiling");
{
  const db = await openTestSqlite();
  const { ctx, agentId, deploymentId } = await fixture(db);
  const store = new WorkStore(db);

  // One more than a page, so "is there another page" is answered by the read rather than by a
  // second COUNT that can disagree with it — and so a caller asking for more than a page gets a
  // page. A list whose ceiling was advisory would be the slowest thing on the socket in a
  // workspace running agents on a schedule.
  const at = (n: number): string => new Date(Date.parse("2026-02-03T10:00:00.000Z") + n).toISOString();
  for (let i = 0; i <= WORK_PAGE; i++) {
    await store.create(ctx, { agentId, deploymentId, runId: randomUUID(), input: `job ${i}`, at: at(i) });
  }

  const asked = await store.list(ctx, { limit: 500 });
  check(`a limit above the ceiling is clamped to it (${asked.items.length})`, asked.items.length === WORK_PAGE);
  check("...and there is a cursor for the rest", asked.nextCursor !== null);
  const rest = await store.list(ctx, { cursor: asked.nextCursor });
  check("the last row is on the next page", rest.items.length === 1);
  check("...and nothing is on the one after it", rest.nextCursor === null);
  // No id appears twice across the two pages, which is the property a keyset cursor exists for and
  // an OFFSET loses the moment a row is inserted at the head.
  const seen = new Set([...asked.items, ...rest.items].map((i) => i.id));
  check("no row appears on both pages", seen.size === WORK_PAGE + 1);

  await db.close();
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
process.exitCode = failures === 0 ? 0 : 1;
