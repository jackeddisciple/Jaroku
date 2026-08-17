// The thread store: what a row promises, and what it refuses.
//
// Three of these assertions are about things that must NOT happen, and those are the ones worth
// the file. A hard delete cannot be reached (§3.4). An auto-title cannot overwrite a name somebody
// typed (§5). An agent's deletion cannot take its threads or their names with it (§3.2). Each is a
// guarantee stated in prose in the spec, and prose does not fail a build.
//
// The fourth is tenancy. Every method takes a context and every statement carries the workspace in
// its WHERE, because on SQLite there is no second wall — so a thread id from another workspace is
// asserted here to resolve to nothing rather than to somebody else's session.
//
//   npm run test:threads

import { randomUUID } from "node:crypto";

import { openTestSqlite, testContext } from "./db/testDb.ts";
import { newRequestId, systemContextFor } from "./db/tenant.ts";
import { ThreadStore, TITLE_MAX, UNTITLED, isThreadStatus } from "./threadStore.ts";
import type { SqliteDb } from "./db/sqlite.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const ctx = testContext();

/** A second workspace, so the scoping assertions have somewhere to be scoped away from. */
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

/** An agent row, so the FK has something real to point at. Returns its uuid. */
async function seedAgent(db: SqliteDb, workspaceId: string, slug: string): Promise<string> {
  const id = randomUUID();
  await db.run(
    `INSERT INTO agents (id, workspace_id, slug, display_name, connectors, mcp_tools,
                         required_env, default_provider, created_at)
     VALUES (?, ?, ?, ?, '[]', '[]', '[]', 'fake', ?)`,
    [id, workspaceId, slug, slug, new Date().toISOString()],
  );
  return id;
}

// --- 1. a thread exists before an agent does ----------------------------------------------
{
  const db = await freshDb();
  const store = new ThreadStore(db);
  const t = await store.create(ctx);

  check("a thread with no agent is a real row", t.id.length > 0);
  check("...with no agent id", t.agent_id === null);
  check("...and no snapshot either, so 'never had one' is distinguishable from 'deleted'",
    t.agent_name_snapshot === null);
  check(`...titled ${JSON.stringify(UNTITLED)} until something is said`, t.title === UNTITLED);
  check("...not custom-titled", t.title_is_custom === false);
  check("...active", t.archived_at === null);
  check("...and idle, because nothing is outstanding", t.status === "idle");
  check("the status is one of the five", isThreadStatus(t.status));
  check("created_by comes off the context rather than a second argument",
    t.created_by === ctx.actorUserId);
}

// --- 2. one agent, many threads (§3.1) -----------------------------------------------------
{
  const db = await freshDb();
  const store = new ThreadStore(db);
  const agent = await seedAgent(db, ctx.workspaceId, "api_gateway");

  const a = await store.create(ctx, { agentId: agent, agentName: "api_gateway", title: "Rate limiting" });
  const b = await store.create(ctx, { agentId: agent, agentName: "api_gateway", title: "OAuth flow" });
  const c = await store.create(ctx, { agentId: agent, agentName: "api_gateway", title: "Fix the 429s" });

  const mine = await store.listForAgent(ctx, agent);
  check("one agent carries three independent threads", mine.length === 3, `${mine.length}`);
  check("...each with its own id", new Set([a.id, b.id, c.id]).size === 3);
  check("...and its own title",
    new Set(mine.map((t) => t.title)).size === 3, mine.map((t) => t.title).join(" / "));
  check("the name is snapshotted at creation, before any deletion can happen",
    mine.every((t) => t.agent_name_snapshot === "api_gateway"));
}

// --- 3. titles: auto never beats custom (§5) -----------------------------------------------
{
  const db = await freshDb();
  const store = new ThreadStore(db);
  const t = await store.create(ctx);

  await store.autoTitle(ctx, t.id, "add exponential backoff to the retry handler");
  check("the first message titles an untitled thread",
    (await store.get(ctx, t.id))?.title === "add exponential backoff to the retry handler");
  check("...without claiming somebody chose it",
    (await store.get(ctx, t.id))?.title_is_custom === false);

  await store.rename(ctx, t.id, "Stripe webhook retry logic");
  const renamed = await store.get(ctx, t.id);
  check("a rename takes", renamed?.title === "Stripe webhook retry logic");
  check("...and records that a person chose it", renamed?.title_is_custom === true);

  // THE ASSERTION THIS FILE EXISTS FOR. The guarantee is unconditional, so the check is in the
  // UPDATE's WHERE rather than in a branch above it — two clients in a Team workspace can rename
  // and send in the same millisecond, and a read-then-write loses that race silently.
  await store.autoTitle(ctx, t.id, "why is it 401ing on refresh?");
  check("auto-titling never overwrites a custom title afterwards",
    (await store.get(ctx, t.id))?.title === "Stripe webhook retry logic");

  await store.rename(ctx, t.id, "   ");
  check("a blank rename changes nothing rather than blanking the row",
    (await store.get(ctx, t.id))?.title === "Stripe webhook retry logic");

  // A column with no bound is a column somebody eventually fills, and this one is read back into
  // every snapshot and broadcast to every socket in the workspace on every state transition.
  await store.rename(ctx, t.id, "x".repeat(TITLE_MAX * 4));
  check("a title is capped rather than stored at whatever length arrived",
    (await store.get(ctx, t.id))?.title.length === TITLE_MAX,
    String((await store.get(ctx, t.id))?.title.length));

  const long = await store.create(ctx, { title: "y".repeat(TITLE_MAX * 2) });
  check("...at creation as well as at rename", long.title.length === TITLE_MAX, String(long.title.length));
}

// --- 3b. two first messages at once still title the thread (§5) -----------------------------
{
  // The caller used to insert the message, read the message COUNT back and title only when it was
  // exactly one — so two messages whose inserts both landed before either read both saw two,
  // NEITHER titled, and the count only grows afterwards: the row stayed `Untitled thread` for good.
  // A double-submit, two members of a Team workspace, or a plan followed straight away by an edit
  // all reach it. Titling from the first MESSAGE is idempotent, so both racers agree.
  const db = await freshDb();
  const store = new ThreadStore(db);
  const t = await store.create(ctx);

  await store.addItem(ctx, t.id, { kind: "message", role: "user", body: "add exponential backoff" });
  await store.addItem(ctx, t.id, { kind: "message", role: "user", body: "and cap it at five" });

  // Both writers now do what noteUserMessage does, in the order the race produces: read the first
  // message and title from it. Neither is "the message that made the count one".
  const first = await store.firstMessage(ctx, t.id);
  check("the first message is the one titling reads", first === "add exponential backoff", first ?? "null");
  await store.autoTitle(ctx, t.id, first!);
  await store.autoTitle(ctx, t.id, (await store.firstMessage(ctx, t.id))!);
  check("a thread with two near-simultaneous first messages is still titled",
    (await store.get(ctx, t.id))?.title === "add exponential backoff",
    (await store.get(ctx, t.id))?.title);
  check("...and the second writer agreed rather than fighting",
    (await store.get(ctx, t.id))?.title_is_custom === false);
}

// --- 4. a rename is not activity ----------------------------------------------------------
{
  const db = await freshDb();
  const store = new ThreadStore(db);
  const t = await store.create(ctx);
  const before = t.last_activity_at;

  await store.rename(ctx, t.id, "A better name");
  check("renaming does not move the sort key two sections are ordered by",
    (await store.get(ctx, t.id))?.last_activity_at === before);

  await store.touch(ctx, t.id, "2026-01-01T00:00:00.000Z");
  check("work happening does", (await store.get(ctx, t.id))?.last_activity_at === "2026-01-01T00:00:00.000Z");
}

// --- 5. archive and restore, and no third door (§3.4) --------------------------------------
{
  const db = await freshDb();
  const store = new ThreadStore(db);
  const t = await store.create(ctx, { title: "Old cleanup pass" });
  await store.setStatus(ctx, t.id, "needs_you");

  await store.archive(ctx, t.id, "2026-02-02T00:00:00.000Z");
  const archived = await store.get(ctx, t.id);
  check("archiving stamps a time", archived?.archived_at === "2026-02-02T00:00:00.000Z");
  check("...and the status says so", archived?.status === "archived");
  check("...and the row is still there, with its title", archived?.title === "Old cleanup pass");

  // §3.3 is the reason this is not "restore to what it was": what it was is a derivation over
  // facts that have since moved, and the deriver runs on the next read.
  await store.restore(ctx, t.id);
  const restored = await store.get(ctx, t.id);
  check("restore clears the timestamp", restored?.archived_at === null);
  check("...and hands the status back to the deriver rather than guessing", restored?.status === "idle");

  check("there is no hard-delete method on the store at all",
    !("delete" in store) && !("remove" in store) && !("destroy" in store));

  // `archived` is a timestamp's consequence, never something a caller sets — a row that read as
  // archived while sitting in the default list is the one inconsistency this refusal prevents.
  await store.setStatus(ctx, t.id, "archived");
  check("setStatus refuses to write 'archived' behind the timestamp's back",
    (await store.get(ctx, t.id))?.status === "idle");
  await store.setStatus(ctx, t.id, "running");
  check("...and takes the four it is for", (await store.get(ctx, t.id))?.status === "running");
}

// --- 6. an agent's deletion keeps its threads, named (§3.2) --------------------------------
{
  const db = await freshDb();
  const store = new ThreadStore(db);
  const agent = await seedAgent(db, ctx.workspaceId, "stripe_webhook");
  await store.create(ctx, { agentId: agent, agentName: "stripe_webhook", title: "retry logic" });
  await store.create(ctx, { agentId: agent, agentName: "stripe_webhook", title: "signature check" });

  const kept = await store.noteAgentDeleted(ctx, agent, "stripe_webhook");
  check("both threads survived the agent", kept === 2, `${kept}`);

  const rows = await store.list(ctx);
  // KEPT, not nulled. The deletion is soft and reverses itself when the directory comes back, so
  // the link has to survive it — `(deleted)` is derived from the agents table instead. Nulling it
  // was permanent, and a briefly-missing directory detached a live agent's sessions forever.
  check("...still pointing at the agent, because the deletion can be undone",
    rows.every((t) => t.agent_id === agent));
  check("...and the name they were linked to intact",
    rows.every((t) => t.agent_name_snapshot === "stripe_webhook"));
  check("...so the row can say stripe_webhook (deleted) rather than (agent deleted)",
    rows.length === 2);

  // Idempotent: a second sweep is handed a null name and must not erase the one it already holds.
  await store.noteAgentDeleted(ctx, agent, null);
  check("a second sweep does not erase the snapshot it already wrote",
    (await store.list(ctx)).every((t) => t.agent_name_snapshot === "stripe_webhook"));
}

// --- 7. every read is workspace-scoped (§6) ------------------------------------------------
{
  const db = await freshDb();
  const store = new ThreadStore(db);
  const mine = await store.create(ctx, { title: "mine" });
  const theirs = await store.create(otherCtx, { title: "theirs" });

  check("a list sees its own workspace only",
    (await store.list(ctx)).map((t) => t.title).join(",") === "mine");
  check("...and so does the other one",
    (await store.list(otherCtx)).map((t) => t.title).join(",") === "theirs");
  check("naming another workspace's thread by id resolves to nothing",
    (await store.get(ctx, theirs.id)) === undefined);

  // A mutation across the boundary has to be a no-op rather than an error, for the reason the
  // relay answers a refusal on the asking channel: the caller learns nothing about what exists.
  await store.rename(ctx, theirs.id, "renamed from the wrong workspace");
  check("...and renaming it changes nothing",
    (await store.get(otherCtx, theirs.id))?.title === "theirs");
  await store.archive(ctx, theirs.id);
  check("...nor does archiving it", (await store.get(otherCtx, theirs.id))?.archived_at === null);
  check("...and the caller's own thread is untouched by any of it",
    (await store.get(ctx, mine.id))?.title === "mine");
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
