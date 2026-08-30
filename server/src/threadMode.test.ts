// Which kinds may be written into which mode, asked of the store rather than of a comment.
//
// §4 IS THE WHOLE OF THIS SUITE: "A thread's mode decides which item kinds may be written into it,
// and that is enforced by the store rather than by a comment. An operate thread must never be able
// to show Apply or Undo — someone running real work must not be one mis-click from rewriting the
// agent's code — and someone building must not have a real job appear mid-diff."
//
// WHY IT IS ASSERTED AT THE STORE AND NOT AT THE COMPOSER. The composer is where a mis-route would
// come from, and it is also the thing a socket goes around: `addItem` is reachable from every
// command that starts work, and a rule enforced only at the surface is a rule that holds for the
// client somebody happened to test with. The same argument `MAX_WORK_INPUT_BYTES` makes about its
// own cap, one layer down.
//
// THE NEGATIVE ASSERTIONS ARE THE POINT AND THEY ARE ASYMMETRIC. A `work` item leaking into a build
// thread is a real job appearing in a surface whose vocabulary is "nothing has happened yet". A
// `proposal` leaking into an operate thread is worse: the client renders one as a diff card with
// Apply on it, so the row itself would put a code-rewriting control in front of somebody who came
// to answer a question about a live container.
//
//   npm run test:thread-mode

import { openTestSqlite, testContext } from "./db/testDb.ts";
import {
  KINDS_BY_MODE, ThreadModeRefusal, ThreadStore,
  type ThreadItemKind, type ThreadMode,
} from "./threadStore.ts";
import type { SqliteDb } from "./db/sqlite.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const ctx = testContext();

/** Every kind the table admits, so the loops below cannot quietly stop covering one. */
const ALL_KINDS: readonly ThreadItemKind[] = [
  "message", "plan", "generation", "proposal", "run", "eval", "work",
];

/** What `addItem` did: the id it wrote, or the refusal it threw. */
async function write(
  threads: ThreadStore,
  threadId: string,
  kind: ThreadItemKind,
): Promise<{ ok: true } | { ok: false; refusal: ThreadModeRefusal | null; message: string }> {
  try {
    await threads.addItem(ctx, threadId, {
      kind,
      refId: kind === "message" ? null : `ref-${kind}`,
      role: kind === "message" ? "user" : null,
      body: kind === "message" ? "did that mail go out?" : null,
    });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      refusal: err instanceof ThreadModeRefusal ? err : null,
      message: (err as Error).message,
    };
  }
}

async function harness(): Promise<{ db: SqliteDb; threads: ThreadStore }> {
  const db = await openTestSqlite();
  return { db, threads: new ThreadStore(db) };
}

console.log("\nthe default");
{
  const { db, threads } = await harness();
  // MIGRATION 065'S DEFAULT, SEEN FROM THE STORE. Every caller that predates Part 3 calls `create`
  // with no mode, and what it gets has to be the mode those callers' items are legal in — otherwise
  // this feature breaks generation on the day it ships rather than on the day somebody notices.
  const t = await threads.create(ctx, { title: "a build session" });
  check("a thread created without a mode is a build thread", t.mode === "build", `got ${t.mode}`);
  const read = await threads.get(ctx, t.id);
  check("and the mode survives the round trip", read?.mode === "build", `got ${read?.mode}`);
  const op = await threads.create(ctx, { title: "operating tracey", mode: "operate" });
  check("an operate thread is created as one", op.mode === "operate", `got ${op.mode}`);
  await db.close();
}

console.log("\nwhat a build thread admits");
{
  const { db, threads } = await harness();
  for (const kind of ALL_KINDS) {
    // A THREAD PER KIND, so a refusal cannot be an artefact of what the previous write left behind.
    const t = await threads.create(ctx, { title: `build/${kind}` });
    const out = await write(threads, t.id, kind);
    const admitted = KINDS_BY_MODE.build.has(kind);
    if (admitted) {
      check(`a build thread accepts a ${kind}`, out.ok, out.ok ? "" : out.message);
    } else {
      check(`a build thread refuses a ${kind}`, !out.ok && out.refusal !== null,
        out.ok ? "it was written" : "the error was not a ThreadModeRefusal");
      if (!out.ok && out.refusal) {
        check(`  and the refusal names both the mode and the kind`,
          out.refusal.mode === "build" && out.refusal.kind === kind,
          `${out.refusal.mode}/${out.refusal.kind}`);
      }
    }
  }
  await db.close();
}

console.log("\nwhat an operate thread admits");
{
  const { db, threads } = await harness();
  for (const kind of ALL_KINDS) {
    const t = await threads.create(ctx, { title: `operate/${kind}`, mode: "operate" });
    const out = await write(threads, t.id, kind);
    const admitted = KINDS_BY_MODE.operate.has(kind);
    if (admitted) {
      check(`an operate thread accepts a ${kind}`, out.ok, out.ok ? "" : out.message);
    } else {
      check(`an operate thread refuses a ${kind}`, !out.ok && out.refusal !== null,
        out.ok ? "it was written" : "the error was not a ThreadModeRefusal");
    }
  }
  await db.close();
}

console.log("\nthe three §4 names by hand");
{
  const { db, threads } = await harness();
  const build = await threads.create(ctx, { title: "building" });
  const operate = await threads.create(ctx, { title: "operating", mode: "operate" });

  // THE THREE §13 ASKS FOR, WRITTEN OUT RATHER THAN LOOPED. The loops above prove the table; these
  // three prove the sentences the table was built from, and they are the ones that would have to be
  // deleted by hand if somebody widened `KINDS_BY_MODE` to make a failing test pass.
  for (const kind of ["plan", "generation", "proposal"] as const) {
    const out = await write(threads, operate.id, kind);
    check(`§4: an operate thread refuses a ${kind} item at the store`, !out.ok && out.refusal !== null);
  }
  const work = await write(threads, build.id, "work");
  check("§4: a build thread refuses a work item at the store", !work.ok && work.refusal !== null);

  // AND NOTHING WAS WRITTEN BY A REFUSAL. A store that threw AFTER the insert would pass every
  // assertion above and still put the diff card on screen.
  const buildItems = await threads.itemsFor(ctx, build.id);
  const operateItems = await threads.itemsFor(ctx, operate.id);
  check("a refused write leaves no row behind in the build thread", buildItems.length === 0,
    `${buildItems.length} item(s)`);
  check("a refused write leaves no row behind in the operate thread", operateItems.length === 0,
    `${operateItems.length} item(s)`);

  // AND THE ACTIVITY CLOCK DID NOT MOVE. `addItem` touches the thread, so a refusal that ran the
  // touch anyway would sort a conversation nothing happened in to the top of the list.
  const after = await threads.get(ctx, operate.id);
  check("and a refused write does not move last_activity_at",
    after?.last_activity_at === operate.last_activity_at,
    `${operate.last_activity_at} -> ${after?.last_activity_at}`);
  await db.close();
}

console.log("\nthe pair that is legal in both");
{
  const { db, threads } = await harness();
  // `message` AND `run` ARE DELIBERATELY IN BOTH SETS, and this is the assertion that says so out
  // loud: a reading of §4 that made operate mode a strictly smaller build mode would break the one
  // thing every conversation has, which is somebody having said something.
  for (const mode of ["build", "operate"] as const) {
    const t = await threads.create(ctx, { title: `both/${mode}`, mode });
    const msg = await write(threads, t.id, "message");
    const run = await write(threads, t.id, "run");
    check(`a ${mode} thread accepts a message`, msg.ok);
    check(`a ${mode} thread accepts a run`, run.ok);
  }
  await db.close();
}

console.log("\nand the modes do not overlap where they must not");
{
  // A PROPERTY OF THE TABLE, checked without a database, because this is the thing a future edit
  // would get wrong: widening `operate` by one word is a one-character diff and the consequence is
  // a diff card on the surface that commands live containers.
  const overlap = [...KINDS_BY_MODE.operate].filter((k) => k === "plan" || k === "generation" || k === "proposal");
  check("operate mode admits no build affordance", overlap.length === 0, overlap.join(", "));
  check("build mode admits no work item", !KINDS_BY_MODE.build.has("work"));
  const modes: ThreadMode[] = ["build", "operate"];
  for (const m of modes) {
    check(`${m} mode admits a message`, KINDS_BY_MODE[m].has("message"));
  }
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
