// The sweep: Law 2, made a claim rather than a promise.
//
// §9's hardest requirement is that every item type's resolve condition is tested by ACTUALLY
// RESOLVING IT EXTERNALLY — setting the credential somewhere else and asserting the item disappears
// without a dismissal. The registry suite covers the decision half of that for all sixteen types;
// this covers the half that is a database: the item is a real row, nobody touches it, the world
// changes, and the row settles.
//
// AND THE FOUR PROPERTIES §6.2 NAMES:
//
//   Idempotent. A second pass changes nothing, and — the part a naive implementation gets wrong —
//   does not move `resolved_at`, or every week's "cleared 14 items" is the same fourteen items.
//
//   Constant in the number of agents. The statement count for a workspace with forty items equals
//   the count for one with two. An N+1 here is invisible in review and instantly visible in a real
//   workspace, which is the same argument the Agents grid's own suite makes.
//
//   Safe against concurrent replicas. Two sweeps racing produce one sweep, not two — and the loser
//   skips rather than queueing, because a queued loser runs the identical pass against facts that
//   have not moved.
//
//   Cross-workspace isolation, in BOTH directions. §6.3 asks for exactly this: an item generated for
//   A is invisible to B, and a pass for A cannot resolve an item in B.
//
//   npm run test:inbox-reconciler

import { randomUUID } from "node:crypto";

import type { Db, Queryable, WriteResult } from "../db/db.ts";
import { openTestSqlite, testContext } from "../db/testDb.ts";
import { newRequestId, systemContextFor, type TenantContext } from "../db/tenant.ts";
import { InboxStore } from "./inboxStore.ts";
import { InboxReconciler, describeReconcile, type ReconcilerDeps } from "./reconciler.ts";
import { dedupeKey, type InboxFacts } from "./registry.ts";
import type { SqliteDb } from "../db/sqlite.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const ctx = testContext();

/** A second workspace, so the isolation assertions have somewhere to be isolated from. */
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

/** A `Db` that counts the statements through it — the Agents grid's own helper, same shape. */
function counting(db: Db): { db: Db; count: () => number; reset: () => void } {
  let n = 0;
  const wrapQ = (q: Queryable): Queryable => ({
    // Forwarded rather than omitted: a hydrator reads it to decide how to parse a json column, and
    // a counter that changed how rows are READ would be measuring a different query.
    dialect: q.dialect,
    get: <T>(sql: string, params?: readonly unknown[]) => { n++; return q.get<T>(sql, params); },
    all: <T>(sql: string, params?: readonly unknown[]) => { n++; return q.all<T>(sql, params); },
    run: (sql: string, params?: readonly unknown[]): Promise<WriteResult> => { n++; return q.run(sql, params); },
    exec: (sql: string) => { n++; return q.exec(sql); },
  });
  const wrapped = {
    ...db,
    dialect: db.dialect,
    get: <T>(sql: string, params?: readonly unknown[]) => { n++; return db.get<T>(sql, params); },
    all: <T>(sql: string, params?: readonly unknown[]) => { n++; return db.all<T>(sql, params); },
    run: (sql: string, params?: readonly unknown[]) => { n++; return db.run(sql, params); },
    exec: (sql: string) => { n++; return db.exec(sql); },
    forWorkspace: (workspaceId: string) => wrapQ(db.forWorkspace(workspaceId)),
    scoped: <T>(workspaceId: string, fn: (tx: Queryable) => Promise<T>) =>
      db.scoped(workspaceId, (tx) => fn(wrapQ(tx))),
  } as unknown as Db;
  return { db: wrapped, count: () => n, reset: () => { n = 0; } };
}

const NOW = Date.parse("2026-08-19T12:00:00.000Z");

function facts(over: Partial<InboxFacts> = {}): InboxFacts {
  return {
    now: NOW,
    configuredSecrets: new Set(),
    agents: new Map(),
    mcpServers: new Map(),
    spendCeilingUsd: null,
    pendingInvites: new Set(),
    memberIds: new Set(),
    hasProviderKey: false,
    agentCount: 0,
    team: false,
    ...over,
  };
}

/** A reconciler over one set of facts, with the lock a no-op. */
function reconciler(
  inbox: InboxStore,
  workspaces: { id: string }[],
  factsFor: (ctx: TenantContext) => InboxFacts,
  over: Partial<ReconcilerDeps> = {},
): InboxReconciler {
  return new InboxReconciler({
    inbox,
    workspaces: async () => workspaces,
    factsFor: async (c) => factsFor(c),
    withLock: (fn) => fn(),
    now: () => NOW,
    log: () => {},
    ...over,
  });
}

/** A missing credential, as a real row. The type §9 uses as its worked example. */
async function seedMissingCredential(inbox: InboxStore, c: TenantContext, name: string): Promise<string> {
  const item = await inbox.record(c, {
    type: "credential_missing",
    subjectId: null,
    dedupeKey: dedupeKey("credential_missing", "agent-1", name),
    payload: { credential: name, agent_name: "api_gateway" },
  });
  return item.id;
}

// --- 1. resolved externally, with nothing dismissed ----------------------------------------

console.log("\nsetting the credential elsewhere removes the card, and nobody dismissed anything");
{
  const db = await freshDb();
  const inbox = new InboxStore(db);
  const id = await seedMissingCredential(inbox, ctx, "STRIPE_KEY");

  const nothingConfigured = reconciler(inbox, [{ id: ctx.workspaceId }], () => facts());
  const first = await nothingConfigured.sweep();
  check("a sweep with the problem still true resolves nothing", first.workspaces[0]?.resolved === 0);
  check("...and examined the row rather than skipping it", first.workspaces[0]?.examined === 1);
  check("...so the card is still on the board", (await inbox.listOpen(ctx)).length === 1);

  // THE CREDENTIAL IS SET SOMEWHERE ELSE ENTIRELY — the Agents tab, a thread, a script. Nothing in
  // this test touches the item, which is the whole assertion.
  const fixed = reconciler(inbox, [{ id: ctx.workspaceId }], () =>
    facts({ configuredSecrets: new Set(["STRIPE_KEY"]) }));
  const second = await fixed.sweep();
  check("setting it resolves the card", second.workspaces[0]?.resolved === 1);
  check("...and it leaves the board", (await inbox.listOpen(ctx)).length === 0);
  check("...as resolved rather than deleted, because undo has to have something to put back",
    (await inbox.get(ctx, id))?.state === "resolved");
  check("...with nobody having dismissed it",
    (await inbox.userState(ctx, id, randomUUID())).dismissed_at === null);

  await db.close();
}

// --- 2. idempotency ------------------------------------------------------------------------

console.log("\nrunning it twice changes nothing the second time");
{
  const db = await freshDb();
  const inbox = new InboxStore(db);
  const id = await seedMissingCredential(inbox, ctx, "STRIPE_KEY");
  const r = reconciler(inbox, [{ id: ctx.workspaceId }], () => facts({ configuredSecrets: new Set(["STRIPE_KEY"]) }));

  const first = await r.sweep();
  const stamp = (await inbox.get(ctx, id))?.resolved_at;
  const second = await r.sweep();

  check("the first pass resolves it", first.workspaces[0]?.resolved === 1);
  check("the second resolves nothing", second.workspaces[0]?.resolved === 0);
  check("...and examines nothing, because the row is no longer open", second.workspaces[0]?.examined === 0);
  check(
    "...and does not move `resolved_at`, or every week clears the same fourteen items",
    (await inbox.get(ctx, id))?.resolved_at === stamp,
  );
  check("a sweep that did nothing says nothing", describeReconcile(second) === null);
  check("...and one that did says how much", describeReconcile(first)?.includes("1 item(s) resolved") === true);

  await db.close();
}

// --- 3. constant in the number of agents ----------------------------------------------------

console.log("\nthe sweep costs the same for forty items as for two");
{
  const db = await freshDb();
  const meter = counting(db);
  const inbox = new InboxStore(meter.db);

  for (let i = 0; i < 2; i++) await seedMissingCredential(inbox, ctx, `KEY_${i}`);
  const r = reconciler(inbox, [{ id: ctx.workspaceId }], () => facts({ configuredSecrets: new Set(["KEY_0", "KEY_1"]) }));
  meter.reset();
  await r.sweep();
  const two = meter.count();

  for (let i = 0; i < 40; i++) await seedMissingCredential(inbox, ctx, `BIG_${i}`);
  const big = new Set(Array.from({ length: 40 }, (_, i) => `BIG_${i}`));
  const r2 = reconciler(inbox, [{ id: ctx.workspaceId }], () => facts({ configuredSecrets: big }));
  meter.reset();
  await r2.sweep();
  const forty = meter.count();

  check("a sweep over two items is a bounded number of statements", two > 0 && two < 10, `${two}`);
  check(
    "...and forty items cost exactly the same, because the settle is one batched UPDATE",
    forty === two,
    `two=${two} forty=${forty}`,
  );

  await db.close();
}

// --- 4. concurrent replicas -----------------------------------------------------------------

console.log("\ntwo replicas waking on the same minute produce one sweep, and the loser skips");
{
  const db = await freshDb();
  const inbox = new InboxStore(db);
  await seedMissingCredential(inbox, ctx, "STRIPE_KEY");

  // One lock between them, and it does NOT queue — the loser answers null, which is what
  // `pg_try_advisory_lock` does and what a periodic sweep wants. A loser that waited would run the
  // identical pass a second later against facts that have not moved.
  let held = false;
  const shared = async <T>(fn: () => Promise<T>): Promise<T | null> => {
    if (held) return null;
    held = true;
    try {
      return await fn();
    } finally {
      held = false;
    }
  };

  let passes = 0;
  const make = (): InboxReconciler =>
    reconciler(inbox, [{ id: ctx.workspaceId }], () => {
      passes++;
      return facts({ configuredSecrets: new Set(["STRIPE_KEY"]) });
    }, { withLock: shared });

  const [a, b] = await Promise.all([make().sweep(), make().sweep()]);
  check("exactly one of them swept", a.skipped !== b.skipped, `a=${a.skipped} b=${b.skipped}`);
  check("...and the aggregate pass ran once, not twice", passes === 1, `${passes}`);
  check("a skipped tick reports no workspaces rather than pretending it swept them",
    (a.skipped ? a.workspaces.length : b.workspaces.length) === 0);
  check("...and logs nothing, because a line per replica per tick says only how many replicas there are",
    describeReconcile(a.skipped ? a : b) === null);

  await db.close();
}

// --- 5. cross-workspace isolation, in both directions ----------------------------------------

console.log("\na pass for A cannot see, resolve or count anything in B");
{
  const db = await freshDb();
  const inbox = new InboxStore(db);
  const inA = await seedMissingCredential(inbox, ctx, "SHARED_KEY");
  const inB = await seedMissingCredential(inbox, otherCtx, "SHARED_KEY");

  // A's world says the credential is set. B's says it is not. Both items share a dedupe key,
  // because two tenants missing the same credential produce the same string.
  const r = reconciler(
    inbox,
    [{ id: ctx.workspaceId }],
    (c) => (c.workspaceId === ctx.workspaceId ? facts({ configuredSecrets: new Set(["SHARED_KEY"]) }) : facts()),
  );
  const report = await r.sweep();

  check("A's pass resolved A's item", report.workspaces[0]?.resolved === 1);
  check("...and examined exactly one, so B's row was never in the read", report.workspaces[0]?.examined === 1);
  check("...leaving B's item open", (await inbox.get(otherCtx, inB))?.state === "open");
  check("...and A's resolved", (await inbox.get(ctx, inA))?.state === "resolved");
  check("B's board still shows its own", (await inbox.listOpen(otherCtx)).length === 1);

  // And the other direction: B's pass, with facts that would resolve A's, leaves A's alone.
  await inbox.reopen(ctx, [inA]);
  const rb = reconciler(inbox, [{ id: OTHER }], () => facts({ configuredSecrets: new Set(["SHARED_KEY"]) }));
  await rb.sweep();
  check("a pass for B resolves B's item", (await inbox.get(otherCtx, inB))?.state === "resolved");
  check("...and cannot touch A's, which is §6.3's second sentence", (await inbox.get(ctx, inA))?.state === "open");

  await db.close();
}

// --- 6. one workspace failing does not stop the others ---------------------------------------

console.log("\none workspace's bad afternoon does not stop everybody else's Inbox resolving");
{
  const db = await freshDb();
  const inbox = new InboxStore(db);
  await seedMissingCredential(inbox, ctx, "STRIPE_KEY");

  const r = reconciler(
    inbox,
    [{ id: OTHER }, { id: ctx.workspaceId }],
    (c) => {
      if (c.workspaceId === OTHER) throw new Error("an MCP server had a bad afternoon");
      return facts({ configuredSecrets: new Set(["STRIPE_KEY"]) });
    },
  );
  const report = await r.sweep();

  check("the workspace that threw is absent from the report rather than reported as swept", report.workspaces.length === 1);
  check("...and the one after it still swept", report.workspaces[0]?.resolved === 1);
  check("...so its card is gone", (await inbox.listOpen(ctx)).length === 0);

  await db.close();
}

// --- 7. deriving happens before settling, over the same facts --------------------------------

console.log("\nderiving runs first and over the same facts, or a sweep raises and clears in one tick");
{
  const db = await freshDb();
  const inbox = new InboxStore(db);

  const order: string[] = [];
  const r = reconciler(
    inbox,
    [{ id: ctx.workspaceId }],
    () => { order.push("facts"); return facts({ configuredSecrets: new Set(["STRIPE_KEY"]) }); },
    {
      derive: async (c) => {
        order.push("derive");
        // A card that is ALREADY fixed by the facts this pass is holding. Written by the derived
        // half, it must still be examined by the settle half in the same pass — otherwise it sits
        // on the board until the next tick, which for a problem that came and went inside one
        // interval means a card nothing ever asked the predicate about.
        await seedMissingCredential(inbox, c, "STRIPE_KEY");
        return 1;
      },
    },
  );
  const report = await r.sweep();

  check("the aggregate pass runs before the derived generators", order.join(">") === "facts>derive");
  check("...and what they wrote is examined in the same pass", report.workspaces[0]?.examined === 1);
  check("...and settled in it", report.workspaces[0]?.resolved === 1);
  check("...so nothing is left on the board", (await inbox.listOpen(ctx)).length === 0);
  check("the report says both halves did something", describeReconcile(report)?.includes("1 derived") === true);

  await db.close();
}

// --- 8. what a resolution announces --------------------------------------------------------

console.log("\na resolution names the card, because the board is not what re-renders");
{
  const db = await freshDb();
  const inbox = new InboxStore(db);
  const a = await seedMissingCredential(inbox, ctx, "STRIPE_KEY");
  const b = await seedMissingCredential(inbox, ctx, "SLACK_TOKEN");

  const changes: { resolvedIds: string[]; derived: number }[] = [];
  const r = reconciler(
    inbox,
    [{ id: ctx.workspaceId }],
    () => facts({ configuredSecrets: new Set(["STRIPE_KEY", "SLACK_TOKEN"]) }),
    { onChanged: (_c, change) => changes.push(change) },
  );
  const report = await r.sweep();

  check("both resolved", report.workspaces[0]?.resolved === 2);
  check(
    "...and the sweep names WHICH, because §5.6 asks for the affected card and not the board",
    report.workspaces[0]?.resolvedIds.length === 2,
  );
  check(
    "...the two that actually settled",
    [a, b].every((id) => report.workspaces[0]?.resolvedIds.includes(id)),
  );
  check("one change is reported for the workspace, not one per row", changes.length === 1);
  check("...carrying the ids rather than a count", changes[0]?.resolvedIds.length === 2);
  check("...and nothing derived, so no snapshot is asked for", changes[0]?.derived === 0);

  // A SECOND SWEEP ANNOUNCES NOTHING. `resolve` counts rows it changed and skips what is already
  // settled, so a card another replica beat this pass to is not announced twice — and a client that
  // received two resolutions for one card would decrement its column count twice.
  await r.sweep();
  check("a second pass announces nothing at all", changes.length === 1);

  await db.close();
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
if (fail > 0) process.exit(1);
