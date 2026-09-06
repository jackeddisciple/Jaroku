// §8's `test:agent-avatar`: the backfill is deterministic, a fork differs from its parent, and both
// columns round-trip through export.
//
// THE LIST IS WRITTEN TWICE AND THE DRIFT IS WHAT GETS TESTED — the same arrangement
// `test:agent-emoji` uses for the emoji palette, and for the same reason: the client cannot import
// from the server and the server cannot import from the client. A drift here is an agent whose row
// names an avatar the renderer has never heard of, which draws NOTHING, on the one feature whose
// entire purpose is that something is drawn.
//
// AND THE SORT IS THE MAPPING, on both sides. Migration 068's backfill indexes the roster by
// position, so a reordering moves every backfilled agent to a different face with nothing in the
// diff to say so.
//
//   npm run test:agent-avatar

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { AVATAR_IDS, UNCATEGORIZED, avatarIdFor, hash32 } from "./avatarRoster.ts";
import { openTestSqlite, testContext } from "../db/testDb.ts";
import { AgentRepository } from "../db/repositories/agents.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

// --- 1. the two copies agree -----------------------------------------------------------------------

console.log("\nthe client's roster and the server's list are the same, in the same order");
{
  // READ AS TEXT, from the other package's SOURCE. The client's file is the roster with its recipes;
  // what has to match is the ids and their ORDER, because that is what both sides index.
  const clientSource = readFileSync("../client/src/lib/gloss/roster.ts", "utf8");
  const client = [...clientSource.matchAll(/^ {2}\{ id: "([a-z0-9-]+)",/gm)].map((m) => m[1]!);
  check("the client's roster was actually read", client.length > 0, `${client.length}`);
  check("the two lists are identical", JSON.stringify(client) === JSON.stringify([...AVATAR_IDS]),
    `${client.length} vs ${AVATAR_IDS.length}`);
  check("it is sorted by id",
    JSON.stringify([...AVATAR_IDS].sort()) === JSON.stringify([...AVATAR_IDS]), AVATAR_IDS.join(","));
  check("no duplicates", new Set(AVATAR_IDS).size === AVATAR_IDS.length);
  // §3'S SIZE BAND, asserted on this side too. The client asserts it of the recipes; this asserts it
  // of the list the database maps into, and the two are only the same number while they agree.
  check("the roster is in §3's 24–40 band",
    AVATAR_IDS.length >= 24 && AVATAR_IDS.length <= 40, `${AVATAR_IDS.length}`);

  // THE SAME FNV-1a AS THE EMOJI AND THE GRADIENT. Three copies of one hash in one product, on
  // purpose: two hashes is two answers to "which list does this agent map into", and the day
  // somebody improves one of them is the day half the identities in every workspace move.
  check("the hash is the same FNV-1a the emoji assignment uses",
    readFileSync("src/agents/emojiPalette.ts", "utf8").includes("0x811c9dc5") &&
    readFileSync("src/agents/avatarRoster.ts", "utf8").includes("0x811c9dc5"));
  check("the hash is stable", hash32("abc") === hash32("abc") && hash32("abc") !== hash32("abd"));
}

// --- 2. the assignment ------------------------------------------------------------------------------

console.log("\nderived from the uuid, and the same answer every time");
{
  const id = "6f1c2a5e-0000-4000-8000-000000000001";
  check("the same id answers the same avatar", avatarIdFor(id) === avatarIdFor(id), avatarIdFor(id));
  check("the answer is on the roster", AVATAR_IDS.includes(avatarIdFor(id)), avatarIdFor(id));

  // IT DOES NOT PROBE BY DEFAULT, and that is the difference from `assignEmoji`. §6: taking an
  // avatar another agent already uses is ALLOWED and warned. A probe here would be the store
  // enforcing a rule the picker deliberately does not.
  const spread = new Set(Array.from({ length: 200 }, () => avatarIdFor(randomUUID())));
  check("two hundred agents cover most of the roster", spread.size > AVATAR_IDS.length * 0.6,
    `${spread.size}/${AVATAR_IDS.length}`);

  // `avoid` IS THE FORK CASE AND ONLY THAT. It walks forward rather than refusing.
  const first = avatarIdFor(id);
  const second = avatarIdFor(id, [first]);
  check("an avoided avatar is stepped over", second !== first, `${first} then ${second}`);
  check("...to the next one on the roster",
    second === AVATAR_IDS[(AVATAR_IDS.indexOf(first) + 1) % AVATAR_IDS.length], `${first} -> ${second}`);
  // AND IT STILL ANSWERS when everything is avoided, rather than throwing. A workspace that cannot
  // fork its twenty-ninth agent is a worse outcome than two of them sharing a face.
  check("avoiding everything still answers",
    AVATAR_IDS.includes(avatarIdFor(id, [...AVATAR_IDS])), avatarIdFor(id, [...AVATAR_IDS]));
}

// --- 3. what the database holds ----------------------------------------------------------------------

console.log("\nevery agent is written with both, and a fork differs from its parent");
{
  const db = await openTestSqlite();
  const ctx = testContext();
  const repo = new AgentRepository(db);

  const made = [];
  for (let i = 0; i < 12; i++) {
    made.push(await repo.create(ctx, { id: randomUUID(), slug: `agent_${i}`, hand_written: false }));
  }
  check("every created agent has an avatar",
    made.every((a) => a.avatar_id !== null && AVATAR_IDS.includes(a.avatar_id)),
    made.map((a) => a.avatar_id).join(","));
  // NOT GUESSED FROM THE NAME. §5.1 rules that out, and the neutral value is what an agent nobody
  // has categorised actually is.
  check("...and the neutral category", made.every((a) => a.category === UNCATEGORIZED),
    made.map((a) => a.category).join(","));

  // DETERMINISTIC FROM THE UUID, which is the property §5.1 asks for and the one a random pick
  // cannot have: it changes on reload, differs between replicas, and cannot be tested.
  check("the avatar is the hash of the row's own uuid",
    made.every((a) => a.avatar_id === avatarIdFor(a.id)),
    made.map((a) => `${a.avatar_id ?? "-"}/${avatarIdFor(a.id)}`).join(" "));

  // A CHOSEN ONE WINS. §6's picker writes through this, and an agent created with the avatar step
  // skipped falls back to the hash — which is what makes the step skippable at all.
  const chosen = await repo.create(ctx, {
    id: randomUUID(), slug: "chosen_one", hand_written: false,
    category: "Billing", avatarId: AVATAR_IDS[5]!,
  });
  check("a chosen avatar is kept", chosen.avatar_id === AVATAR_IDS[5], String(chosen.avatar_id));
  check("a chosen category is kept", chosen.category === "Billing", chosen.category);

  // CUSTOM TEXT IS THE SAME COLUMN. I6: twenty-five presets plus "name your own", stored identically.
  const custom = await repo.create(ctx, {
    id: randomUUID(), slug: "custom_cat", hand_written: false, category: "  Vendor chasing  ",
  });
  check("a typed category round-trips, trimmed", custom.category === "Vendor chasing", custom.category);
  const blank = await repo.create(ctx, {
    id: randomUUID(), slug: "blank_cat", hand_written: false, category: "   ",
  });
  check("an empty one becomes the neutral value", blank.category === UNCATEGORIZED, blank.category);

  // THE PAIR §5.1 NAMES BY NAME. Fork and parent sit adjacent in the grid, so the fork takes the
  // category — a copy of the billing agent is still a billing agent — and must not take the face.
  const parent = await repo.create(ctx, {
    id: randomUUID(), slug: "parent_agent", hand_written: false, category: "Support",
  });
  const fork = await repo.create(ctx, {
    id: randomUUID(), slug: "parent_agent_copy", hand_written: false,
    forkedFrom: parent.id, category: parent.category, avoidAvatar: parent.avatar_id,
  });
  check("a fork gets a different avatar", fork.avatar_id !== parent.avatar_id,
    `${parent.avatar_id} vs ${fork.avatar_id}`);
  check("...and inherits the category", fork.category === "Support", fork.category);
  check("...and still records its parent", fork.forked_from === parent.id);

  // A FORK WHOSE OWN HASH ALREADY MISSES ITS PARENT must not be moved off it — `avoid` walks only
  // when it has to, or a fork's face would depend on whether it happened to collide.
  const clear = await repo.create(ctx, {
    id: randomUUID(), slug: "clear_fork", hand_written: false, avoidAvatar: "no-such-avatar",
  });
  check("avoiding something it was never going to pick changes nothing",
    clear.avatar_id === avatarIdFor(clear.id), String(clear.avatar_id));

  // THE DISK PATH. An agent that arrived by reconciliation is still an agent on the grid.
  const fromDisk = await repo.upsertFromDisk(ctx, { slug: "disk_agent", hand_written: true });
  check("an agent from disk gets both",
    Boolean(fromDisk.avatar_id) && fromDisk.category === UNCATEGORIZED,
    `${fromDisk.avatar_id} / ${fromDisk.category}`);

  // AND A RE-SYNC LEAVES THEM ALONE. A reconciliation runs on every boot; a face or a category
  // rewritten by one would change for a reason nobody could see.
  await repo.setAvatar(ctx, fromDisk.id, AVATAR_IDS[9]!);
  await repo.setCategory(ctx, fromDisk.id, "Research");
  const again = await repo.upsertFromDisk(ctx, { slug: "disk_agent", hand_written: true });
  check("a re-sync does not rewrite the avatar", again.avatar_id === AVATAR_IDS[9], String(again.avatar_id));
  check("...nor the category", again.category === "Research", again.category);

  // A DUPLICATE THE USER CHOSE IS WRITTEN. §6: allowed and warned, and the warning is the picker's.
  await repo.setAvatar(ctx, fork.id, parent.avatar_id!);
  const clashed = await repo.byId(ctx, fork.id);
  check("a duplicate avatar is not refused", clashed?.avatar_id === parent.avatar_id,
    String(clashed?.avatar_id));

  await db.close?.();
}

// --- 4. the write path, the migration, and the export -------------------------------------------------

console.log("\nthe columns, the backfill and what leaves in an export");
{
  const repo = readFileSync("src/db/repositories/agents.ts", "utf8");
  const inserts = [...repo.matchAll(/INSERT INTO agents \(([^)]*)\)/g)].map((m) => m[1]!);
  check("both insert paths were found", inserts.length === 2, `${inserts.length}`);
  // THE GUARANTEE THE SCHEMA CANNOT MAKE. `avatar_id` is nullable because a DEFAULT would be a NAMED
  // CHARACTER — a wrong identity rather than a missing one on every row an older version wrote
  // mid-deploy. So "no row exists without an avatar" is enforced here, by reading the source.
  check("every insert names both columns",
    inserts.every((cols) => /\bcategory\b/.test(cols) && /\bavatar_id\b/.test(cols)),
    inserts.map((c) => c.replace(/\s+/g, " ")).join(" | "));
  check("...and every one of them calls the assignment",
    (repo.match(/avatarIdFor\(/g) ?? []).length === 2,
    String((repo.match(/avatarIdFor\(/g) ?? []).length));

  for (const dialect of ["sqlite", "postgres"]) {
    const sql = readFileSync(`migrations/${dialect}/068_agent_identity.sql`, "utf8");
    const lines = sql.split("\n").filter((l) => /^ALTER TABLE agents ADD COLUMN/.test(l));
    const category = lines.find((l) => /category/.test(l)) ?? "";
    const avatar = lines.find((l) => /avatar_id/.test(l)) ?? "";
    // I6: TEXT, NEVER AN ENUM. The list will change, and a migration to add a word is absurd.
    check(`${dialect}: category is TEXT NOT NULL with a default`,
      /\bTEXT\b/.test(category) && /NOT NULL/.test(category) && /DEFAULT/i.test(category), category);
    check(`${dialect}: category is not an enum`,
      !/\bENUM\b|CHECK\s*\(/i.test(category) && !/CREATE TYPE/i.test(sql), category);
    check(`${dialect}: avatar_id is nullable with no default`,
      /\bTEXT\b/.test(avatar) && !/NOT NULL/.test(avatar) && !/DEFAULT/i.test(avatar), avatar);
    // THE BACKFILL IS IN SQL, because a migration that needs the application running is a migration
    // that runs twice. Every roster id has to be reachable from it, or some agents backfill to
    // nothing.
    check(`${dialect} backfills the rows that exist`, /UPDATE agents/.test(sql));
    const named = AVATAR_IDS.filter((id) => sql.includes(`'${id}'`));
    check(`${dialect}'s backfill names every roster entry`, named.length === AVATAR_IDS.length,
      `${named.length}/${AVATAR_IDS.length}`);
    check(`${dialect}'s backfill wraps at the roster's length`, sql.includes(`% ${AVATAR_IDS.length}`));
  }

  // BOTH COLUMNS GO INTO WORKSPACE EXPORT — §5.1. It falls out of `SELECT *` over an exported table,
  // so what is asserted is that `agents` is still exported as whole rows.
  const exp = readFileSync("src/lifecycle/export.ts", "utf8");
  check("agents are still exported", /EXPORTED_TABLES = \[\s*\n\s*"agents"/.test(exp));
  check("...as whole rows", exp.includes("SELECT * FROM ${table}"));
}

// --- 4. the row onboarding writes, and what building into it may do ---------------------------------

console.log("\na draft is an identity with no code, and a build fills it in without touching it");
{
  const db = await openTestSqlite();
  const ctx = testContext();
  const repo = new AgentRepository(db);

  // WHAT `createDraftAgent` LEAVES BEHIND: a name, a face, a category, and nothing a generation
  // would produce. It is in the Agents tab from that moment, which is the whole point of writing it.
  const draft = await repo.create(ctx, {
    id: randomUUID(), slug: "tracey", display_name: "Tracey", hand_written: false,
    category: "Content", avatarId: AVATAR_IDS[3]!,
  });
  check("a draft carries the identity somebody chose",
    draft.display_name === "Tracey" && draft.category === "Content" && draft.avatar_id === AVATAR_IDS[3],
    `${draft.display_name}/${draft.category}/${draft.avatar_id}`);
  check("...and nothing a generation would have written",
    draft.description === null && draft.connectors.length === 0 && draft.creation_cost === null,
    `${draft.description}/${draft.connectors.length}/${draft.creation_cost}`);
  // THE TEST THE GENERATOR USES, and the reason it is `<= 1` rather than a column of its own: a
  // fresh row claims version 1 with no version rows behind it, so the first publish is v2. Anything
  // that has ever been built is at 2 or above. Asserted here because the guard is only as good as
  // this number, and this number is set by `create`.
  check("a fresh row is at version 1, which is what identifies it as a draft",
    draft.current_version === 1, String(draft.current_version));

  await repo.adopt(ctx, draft.id, {
    description: "drafts release notes from merged pull requests",
    connectors: ["github"], mcp_tools: ["linear/issues"], required_env: ["GITHUB_TOKEN"],
    creation_cost: 0.0413,
  });
  const filled = (await repo.bySlug(ctx, "tracey"))!;
  check("a build writes what it produced",
    filled.description === "drafts release notes from merged pull requests"
      && filled.connectors.join() === "github" && filled.required_env.join() === "GITHUB_TOKEN"
      && filled.creation_cost === 0.0413,
    JSON.stringify({ d: filled.description, c: filled.connectors, e: filled.required_env }));
  // THE HALF THAT MATTERS. A person picked the name, the face and the category; a build that
  // overwrote any of them would throw away the only part of the agent that existed before it.
  check("...and leaves every chosen thing alone",
    filled.id === draft.id && filled.slug === "tracey" && filled.display_name === "Tracey"
      && filled.category === "Content" && filled.avatar_id === draft.avatar_id
      && filled.emoji === draft.emoji,
    `${filled.display_name}/${filled.category}/${filled.avatar_id}/${filled.emoji}`);
  check("...on the same row, rather than beside it",
    (await repo.list(ctx, { includeArchived: true })).filter((a) => a.slug === "tracey").length === 1);

  // AND THE GUARD, read from the source: an id that names a REAL agent must fall through to
  // creating one. Without it a stale or hand-edited id would let a generate replace a working
  // agent's description and publish over it — an edit, through a path with no diff and no Apply.
  const gen = readFileSync("src/generator.ts", "utf8");
  check("the generator only adopts a row that is still a draft",
    /current_version <= 1 \? named : undefined/.test(gen), "generator.ts");
  // AND IT LOOKS THE ROW UP RATHER THAN TRUSTING THE ID, which is what makes the workspace scoping
  // free: `bySlug` filters on `workspace_id`.
  check("...looked up workspace-scoped rather than trusted",
    /await agents\.bySlug\(ctx, opts\.intoAgentId\)/.test(gen), "generator.ts");
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
