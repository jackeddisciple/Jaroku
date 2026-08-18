// An agent can be put away, brought back, and renamed — and none of it destroys anything.
//
// WHAT THIS IS FOR. The product's central object had no lifecycle operation of any kind: no delete,
// no archive, no rename, in any layer. Every other resource had one, and the Threads specification
// devoted a section to what happens when an agent is deleted while using that deletion as the reason
// not to build a thread-delete confirmation. This is the operation that was missing, and these are
// the three claims it makes.
//
//   ARCHIVING REMOVES IT FROM THE LISTS THAT OFFER WORK AND FROM NOTHING ELSE. `list()` excludes it,
//   which is what the sidebar, the eval picker, the composer's targets and every sweep read — and its
//   versions, its runs and its threads are all exactly where they were. That is the difference
//   between this and a delete, and it is the whole reason it is safe to offer at all.
//
//   IT IS REVERSIBLE, AND A SECOND PRESS IS NOT A SECOND ARCHIVE. Archiving twice would move
//   `archived_at` forward and make "when was this put away" a lie about the second click.
//
//   A RENAME SURVIVES THE DISK SYNC. `upsertFromDisk` overwrites `display_name` from `jaroku.json`
//   on every reconciliation, so a rename with nothing to stop it lasts until the next boot that
//   materialises the project. That is the trap `threads.title` was in, and `display_name_is_custom`
//   is the same answer `title_is_custom` was — this is the assertion that holds it.
//
//   npm run test:agent-lifecycle

import { randomUUID } from "node:crypto";

import { openTestSqlite, testContext, withScratchPostgres } from "./db/testDb.ts";
import { AgentRepository } from "./db/repositories/agents.ts";
import { ThreadStore } from "./threadStore.ts";
import type { Db } from "./db/db.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const ctx = testContext();

async function suite(driver: string, db: Db): Promise<void> {
  console.log(`\n${driver}`);
  const agents = new AgentRepository(db);
  const threads = new ThreadStore(db);

  const onDisk = {
    slug: "weather_agent",
    display_name: "weather_agent",
    description: "reads a forecast",
    connectors: [],
    mcp_tools: [],
    required_env: [],
    default_provider: "fake",
  };
  const agent = await agents.upsertFromDisk(ctx, onDisk);
  // A THREAD, ON THIS DRIVER, AT ALL — and this line is load-bearing beyond what it looks like.
  //
  // Every thread suite in the repository opens SQLite, so `ThreadStore.create` had never run against
  // Postgres, and it wrote `title_is_custom` as an inline `0` into a `boolean` column: it threw on
  // every call against the production driver, which took `ensureForAgent` and every run, generation
  // and edit that resolves a session with it. This suite is the first thing to have created one on
  // both drivers, which is how that was found — so the assertion is stated rather than left implied,
  // and it stays here to keep it stated.
  const thread = await threads.create(ctx, {
    agentId: agent.id,
    agentName: agent.slug,
    title: "Rate limiting",
  });
  check("a thread can be created on this driver at all", thread.id.length > 0);
  check("...with the title it was opened with, and not marked as one somebody typed",
    thread.title === "Rate limiting" && thread.title_is_custom === false,
    `title=${thread.title} custom=${String(thread.title_is_custom)}`);

  console.log("  · archiving");
  {
    check("the agent is in the default list to begin with",
      (await agents.list(ctx)).some((a) => a.id === agent.id));

    check("archiving reports that it did something", await agents.setArchived(ctx, agent.id, true));
    check("...and it leaves the list every picker reads",
      !(await agents.list(ctx)).some((a) => a.id === agent.id));
    check("...while staying available to the view that shows what was put away",
      (await agents.list(ctx, { includeArchived: true })).some((a) => a.id === agent.id));

    // THE POINT OF ARCHIVE RATHER THAN DELETE. `byId` still resolves it, so every row that points at
    // this agent — runs, evals, deployments, versions — still resolves too, and the thread is still
    // attached rather than reading `(deleted)`.
    const still = await agents.byId(ctx, agent.id);
    check("it is still there by id, so nothing that points at it is dangling", still !== undefined);
    check("...and it says when it was put away", Boolean(still?.archived_at));
    const kept = await threads.get(ctx, thread.id);
    check("its thread is untouched and still attached", kept?.agent_id === agent.id,
      `agent_id=${kept?.agent_id ?? "null"}`);

    // A SECOND PRESS IS NOT A SECOND ARCHIVE. Two tabs, or one impatient click.
    const stamp = still?.archived_at;
    check("archiving again does nothing", !(await agents.setArchived(ctx, agent.id, true)));
    check("...and does not restamp when it happened",
      (await agents.list(ctx, { includeArchived: true })).find((a) => a.id === agent.id)?.archived_at === stamp);
  }

  console.log("  · restoring");
  {
    check("restoring reports that it did something", await agents.setArchived(ctx, agent.id, false));
    check("...and the agent is back in the default list",
      (await agents.list(ctx)).some((a) => a.id === agent.id));
    check("restoring again does nothing", !(await agents.setArchived(ctx, agent.id, false)));
  }

  console.log("  · renaming");
  {
    check("renaming reports that it did something", await agents.rename(ctx, agent.id, "Weather, hourly"));
    const renamed = await agents.byId(ctx, agent.id);
    check("the display name is what was asked for", renamed?.display_name === "Weather, hourly");
    check("...and it is marked as a name somebody chose", renamed?.display_name_is_custom === true);
    // THE IDENTITY DOES NOT MOVE. The slug is the directory on disk, the key `datasets.agent_id` and
    // `eval_runs.agent_id` hold, and the id every past run row names.
    check("the slug is unchanged, so nothing that names it is orphaned", renamed?.slug === "weather_agent");

    // THE ASSERTION THIS FILE EXISTS FOR. A sync reads `jaroku.json` again and must not undo it.
    await agents.upsertFromDisk(ctx, onDisk);
    check(
      "a disk sync does NOT overwrite a name a person chose",
      (await agents.byId(ctx, agent.id))?.display_name === "Weather, hourly",
      (await agents.byId(ctx, agent.id))?.display_name ?? "null",
    );

    // ...and an agent nobody has renamed still tracks the file, which is the behaviour the flag is
    // narrowing rather than replacing: a hand-edited `jaroku.json` is still how you rename by hand.
    const tracked = await agents.upsertFromDisk(ctx, { ...onDisk, slug: "tracks_disk", display_name: "First" });
    await agents.upsertFromDisk(ctx, { ...onDisk, slug: "tracks_disk", display_name: "Second" });
    check("an agent with no custom name still follows the file",
      (await agents.byId(ctx, tracked.id))?.display_name === "Second");
  }

  console.log("  · the sweep and the archive are different facts");
  {
    // `syncFromDisk` soft-deletes rows whose directory has gone. An archived agent is not on disk
    // either — but it is not a mirror of a missing directory, it is a decision — and the sweep reads
    // the DEFAULT list, which excludes it. So it is not swept, and `deleted_at` stays null: the two
    // columns never write over each other.
    const put = await agents.upsertFromDisk(ctx, { ...onDisk, slug: "put_away" });
    await agents.setArchived(ctx, put.id, true);
    await agents.syncFromDisk(ctx, []);
    const after = (await agents.list(ctx, { includeArchived: true })).find((a) => a.id === put.id);
    check("an archived agent is not swept by an empty directory", after !== undefined);
    check("...and is still archived rather than deleted", Boolean(after?.archived_at));
  }
}

{
  const db = await openTestSqlite();
  try {
    await suite("SqliteDb", db);
  } finally {
    await db.close();
  }
}

await withScratchPostgres(async (db) => {
  await suite("PostgresDb", db);
});

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
