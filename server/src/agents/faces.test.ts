// The eleven faces are the same eleven on both sides, and every agent is written with one.
//
// THE LIST IS WRITTEN TWICE AND THE DRIFT IS WHAT GETS TESTED — the arrangement `test:agent-emoji`
// and `test:agent-avatar` use beside it, and for the same reason: the client cannot import from the
// server and the server cannot import from the client. A drift here is an agent whose row names a
// picture the client has never heard of, which draws the agent's initial instead, on the one feature
// whose entire purpose is that a face is drawn.
//
// AND BOTH HALVES DRIFT SEPARATELY, which is what this suite has that its two predecessors did not.
// A face is a portrait AND a name, so there are two ways for the copies to disagree: the server can
// hand out a picture the client cannot draw, or it can hand out "Stacey" over a portrait the client
// draws as Iris. The second is worse, because everything renders and the product just quietly
// mislabels its own agents.
//
// THE ORDER IS THE MAPPING ON BOTH SIDES. An agent takes the entry at its own POSITION in its
// workspace's creation order, so a reordering moves every agent in every workspace to a different
// face with nothing in the diff to say so.
//
//   npm run test:agent-picture

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { AGENT_FACE_IDS, AGENT_FACES, faceAt } from "./faces.ts";
import { UNCATEGORIZED } from "./avatarRoster.ts";
import { openTestSqlite, testContext } from "../db/testDb.ts";
import { AgentRepository } from "../db/repositories/agents.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

// --- 1. the two copies agree, on both halves --------------------------------------------------------

console.log("\nthe client's faces and the server's are the same eleven, in the same order");
{
  // READ AS TEXT, from the other package's SOURCE. The ids are in the generated half of the client's
  // pair, because that is the half the directory dictates; the names are in the hand-written half.
  const files = readFileSync("../client/src/lib/agentFaceFiles.ts", "utf8");
  const clientIds = [...files.matchAll(/\{ id: "([a-z0-9-]+)",/g)].map((m) => m[1]!);
  check("the client's id list was actually read", clientIds.length > 0, `${clientIds.length}`);
  check("the two id lists are identical",
    JSON.stringify(clientIds) === JSON.stringify([...AGENT_FACE_IDS]),
    `client=${clientIds.length} server=${AGENT_FACE_IDS.length}`);

  const faces = readFileSync("../client/src/lib/agentFaces.ts", "utf8");
  const clientNames = [...faces.matchAll(/^ {2}"([a-z0-9-]+)": "([A-Za-zé]+)",$/gm)]
    .map(([, id, name]) => ({ id: id!, name: name! }));
  check("the client's name table was actually read", clientNames.length > 0, `${clientNames.length}`);
  // THE PAIRING, NOT JUST THE TWO SETS. Two lists holding the same names against different pictures
  // would pass a set comparison and be exactly the failure this half exists for.
  check("every face is paired with the same name on both sides",
    JSON.stringify(clientNames) === JSON.stringify(AGENT_FACES.map((f) => ({ id: f.id, name: f.name }))),
    clientNames.map((c) => `${c.id}=${c.name}`).join(" "));

  // THE IDS ARE ZERO-PADDED precisely so source order and sorted order are one sequence on every
  // platform. A list that merely happens to be in order today is a list somebody appends to.
  check("it is sorted, because the order IS the mapping",
    JSON.stringify([...AGENT_FACE_IDS].sort()) === JSON.stringify([...AGENT_FACE_IDS]),
    AGENT_FACE_IDS.join(","));
  check("no duplicate ids", new Set(AGENT_FACE_IDS).size === AGENT_FACE_IDS.length);
  check("no duplicate names",
    new Set(AGENT_FACES.map((f) => f.name)).size === AGENT_FACES.length,
    AGENT_FACES.map((f) => f.name).join(","));
  check("there are eleven of them", AGENT_FACES.length === 11, String(AGENT_FACES.length));

  // AND NO HASH IS LEFT IN THIS FEATURE. The gradient, the emoji and the avatar all hashed the uuid
  // and this deliberately does not — see `faces.ts` for the birthday-bound argument. An FNV-1a
  // constant appearing in here again would be that decision being quietly undone.
  check("the assignment does not hash",
    !readFileSync("src/agents/faces.ts", "utf8").includes("0x811c9dc5"));
}

// --- 2. the assignment ------------------------------------------------------------------------------

console.log("\na position picks a face, the first eleven differ, and the twelfth starts again");
{
  const first = Array.from({ length: AGENT_FACES.length }, (_, i) => faceAt(i));
  // THE PROPERTY THE POSITION EXISTS FOR, and the one a hash cannot have: over eleven buckets a hash
  // collides on the fourth or fifth agent more often than not.
  check("eleven positions give eleven different faces",
    new Set(first.map((f) => f.id)).size === AGENT_FACES.length,
    first.map((f) => f.id).join(","));
  check("...and eleven different names",
    new Set(first.map((f) => f.name)).size === AGENT_FACES.length);
  check("position 0 is the first entry", faceAt(0) === AGENT_FACES[0]);
  check("the twelfth takes the first face again", faceAt(AGENT_FACES.length) === faceAt(0));
  check("and a long way out", faceAt(1000) === faceAt(1000 % AGENT_FACES.length));

  // A CONFUSED COUNT STILL ANSWERS A REAL FACE. The input is a `COUNT(*)`, which cannot sensibly be
  // either of these — and an agent with no picture is a worse answer than a wrapped one.
  check("a negative position is still a real face", AGENT_FACES.includes(faceAt(-1)), faceAt(-1).id);
  check("NaN is the first entry rather than a throw", faceAt(Number.NaN) === AGENT_FACES[0]);
}

// --- 3. what the database holds ---------------------------------------------------------------------

console.log("\nevery agent is written with a picture, and a workspace's first eleven differ");
{
  const db = await openTestSqlite();
  const ctx = testContext();
  const repo = new AgentRepository(db);

  const made = [];
  for (let i = 0; i < 12; i++) {
    made.push(await repo.create(ctx, { id: randomUUID(), slug: `agent_${i}`, hand_written: false }));
  }
  check("every created agent has a picture",
    made.every((a) => a.picture !== null && AGENT_FACE_IDS.includes(a.picture)),
    made.map((a) => a.picture).join(","));

  // THE WHOLE POINT, AT THE GRAIN A WORKSPACE ACTUALLY SEES. Not "the function cycles" — that is
  // section 2 — but "eleven agents made one after another in one workspace wear eleven faces",
  // which is the claim the position was chosen to be able to make.
  const eleven = made.slice(0, 11).map((a) => a.picture);
  check("a workspace's first eleven agents all look different",
    new Set(eleven).size === 11, eleven.join(","));
  check("...in the list's own order", JSON.stringify(eleven) === JSON.stringify([...AGENT_FACE_IDS]),
    eleven.join(","));
  check("...and the twelfth starts the list again", made[11]!.picture === AGENT_FACE_IDS[0],
    String(made[11]!.picture));

  // A CALLER THAT ALREADY ASKED PASSES WHAT IT WAS GIVEN. `createDraftAgent` needs the NAME before
  // the row exists — it goes into the slug — so it asks `nextFace` and hands the id back here.
  const chosen = await repo.create(ctx, {
    id: randomUUID(), slug: "chosen_one", hand_written: false, picture: AGENT_FACE_IDS[5]!,
  });
  check("a supplied picture is kept", chosen.picture === AGENT_FACE_IDS[5], String(chosen.picture));

  // THE COUNT IS UNFILTERED, which is what makes the sequence a counter rather than a census: a
  // workspace that archived an agent should not hand its face out again next.
  const before = await repo.nextFace(ctx);
  await repo.setArchived(ctx, made[0]!.id, true);
  check("archiving an agent does not rewind the sequence",
    (await repo.nextFace(ctx)).id === before.id, `${before.id} then ${(await repo.nextFace(ctx)).id}`);

  // THE DISK PATH. An agent that arrived by reconciliation is still an agent on the grid, and still
  // needs something drawn on its card.
  const fromDisk = await repo.upsertFromDisk(ctx, { slug: "disk_agent", hand_written: true });
  check("an agent from disk gets a picture",
    fromDisk.picture !== null && AGENT_FACE_IDS.includes(fromDisk.picture),
    String(fromDisk.picture));
  check("...and the neutral category", fromDisk.category === UNCATEGORIZED, fromDisk.category);

  // AND A RE-SYNC LEAVES IT ALONE. A reconciliation runs on every boot; a face rewritten by one
  // would change for a reason nobody could see — the trap `display_name_is_custom` closed.
  const again = await repo.upsertFromDisk(ctx, { slug: "disk_agent", hand_written: true });
  check("a re-sync does not rewrite the picture", again.picture === fromDisk.picture,
    `${fromDisk.picture} then ${again.picture}`);

  await db.close?.();
}

// --- 4. the write path and the migration ------------------------------------------------------------

console.log("\nthe column, every insert path, and the backfill");
{
  const repo = readFileSync("src/db/repositories/agents.ts", "utf8");
  const inserts = [...repo.matchAll(/INSERT INTO agents \(([^)]*)\)/g)].map((m) => m[1]!);
  check("both insert paths were found", inserts.length === 2, `${inserts.length}`);
  // THE GUARANTEE THE SCHEMA CANNOT MAKE. `picture` is nullable because a DEFAULT would be a NAMED
  // PORTRAIT — a wrong identity rather than a missing one on every row an older version wrote
  // mid-deploy. So "no row exists without a picture" is enforced here, by reading the source.
  check("every insert names the column",
    inserts.every((cols) => /\bpicture\b/.test(cols)),
    inserts.map((c) => c.replace(/\s+/g, " ")).join(" | "));

  for (const dialect of ["sqlite", "postgres"]) {
    const sql = readFileSync(`migrations/${dialect}/079_agent_picture.sql`, "utf8");
    const add = sql.split("\n").filter((l) => /^ALTER TABLE agents ADD COLUMN/.test(l)).join("");
    check(`${dialect}: picture is nullable with no default`,
      /\bpicture\b/.test(add) && /\bTEXT\b/.test(add) && !/NOT NULL/.test(add) && !/DEFAULT/i.test(add),
      add);
    // IT IS AN EXPAND STEP AND NOTHING ELSE. `emoji` and `avatar_id` are dropped in a LATER
    // migration, once no running version reads them — and a drop smuggled in here would break the
    // version still serving during the deploy that applies it.
    //
    // THE COMMENTS ARE STRIPPED FIRST, because this file's header spends a paragraph explaining why
    // it is NOT a rename and what will be dropped later. A check that read the prose would fail on a
    // migration for saying what it does not do, which is the one thing worse than not checking.
    const statements = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    check(`${dialect}: nothing is dropped or renamed here`,
      !/\bDROP\b|\bRENAME\b/i.test(statements), statements.replace(/\s+/g, " ").slice(0, 80));

    // THE BACKFILL IS IN SQL, because a migration that needs the application running is a migration
    // that runs twice. Every id has to be reachable from it, or some rows backfill to nothing.
    check(`${dialect} backfills the rows that exist`, /UPDATE agents/.test(sql));
    const named = AGENT_FACE_IDS.filter((id) => sql.includes(`'${id}'`));
    check(`${dialect}'s backfill names every face`, named.length === AGENT_FACE_IDS.length,
      `${named.length}/${AGENT_FACE_IDS.length}`);
    check(`${dialect}'s backfill wraps at the list's length`, sql.includes(`% ${AGENT_FACE_IDS.length}`));
    // A POSITION, NOT A HASH, IN THE MIGRATION TOO — the same decision `faces.ts` makes, so a
    // backfilled workspace and a freshly-created one hand out faces the same way.
    check(`${dialect}'s backfill counts earlier rows rather than hashing`,
      /SELECT COUNT\(\*\) FROM agents AS earlier/.test(sql) && !sql.includes("0x811c9dc5"));
  }

  // THE COLUMN GOES INTO WORKSPACE EXPORT, which falls out of `SELECT *` over an exported table — so
  // what is asserted is that `agents` is still exported as whole rows.
  const exp = readFileSync("src/lifecycle/export.ts", "utf8");
  check("agents are still exported", /EXPORTED_TABLES = \[\s*\n\s*"agents"/.test(exp));
  check("...as whole rows", exp.includes("SELECT * FROM ${table}"));
}

// --- 5. it reaches the wire -------------------------------------------------------------------------

console.log("\nand it travels, on both payloads the client draws agents from");
{
  // DERIVING IT IN THE BROWSER IS NOT AN OPTION, which is why this is asserted rather than assumed:
  // the assignment is a position in the workspace's creation order, and a client holding a filtered
  // list of agents cannot know it. Both payloads carry the column.
  const relay = readFileSync("src/wsRelay.ts", "utf8");
  check("the agent card shape declares it", /^ {2}picture: string \| null;$/m.test(relay));

  const index = readFileSync("src/index.ts", "utf8");
  const assignments = (index.match(/^\s*picture: a\.picture,$/gm) ?? []).length;
  check("both payload builders send it", assignments === 2, String(assignments));
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
