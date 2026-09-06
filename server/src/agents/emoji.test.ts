// §8: every agent has exactly one mark, no two agents in a workspace share one at creation, and a
// fork never inherits its parent's.
//
// THE ASSIGNMENT IS THE PART THAT LOOKS OBVIOUSLY RIGHT AND IS NOT. A hash into a sixty-four entry
// palette is deterministic, testable and stable — and with twenty agents the birthday paradox puts
// a duplicate at better than ninety-five percent. Two agents both showing the tractor defeats the
// only purpose the feature has, which is that the eye finds a shape in a sidebar faster than it
// reads a truncated name. So the hash gives a STARTING INDEX and the assignment probes forward,
// which makes the result depend on what the workspace already holds — and that, in turn, is why the
// value is written at creation rather than derived at read.
//
// D7 IS A PALETTE RULE AND IS ASSERTED AS ONE. This is a Tauri desktop app; a Linux box without
// Noto Color Emoji renders tofu boxes, which is worse than no feature. Bundling the font would free
// the palette and cost ten megabytes, a new asset and an untested loading path; restricting the
// palette costs nothing and can be CHECKED, which is what the three mechanical rules below do.
//
// AND THE LIST IS WRITTEN TWICE, ON PURPOSE. The client cannot import from the server and the
// server cannot import from the client, so the palette exists in both and the DRIFT is what gets
// tested — the same arrangement `test:egress-connectors` uses to hold two private-range block lists
// to each other across TypeScript and Python.
//
//   npm run test:agent-emoji

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { EMOJI_PALETTE, assignEmoji, hash32 } from "./emojiPalette.ts";
import { openTestSqlite, testContext } from "../db/testDb.ts";
import { AgentRepository } from "../db/repositories/agents.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

// --- 1. the palette ------------------------------------------------------------------------------

console.log("\nsixty-four marks, explicitly sorted");
{
  check("the palette has 64 entries", EMOJI_PALETTE.length === 64, `${EMOJI_PALETTE.length}`);
  check("no duplicates", new Set(EMOJI_PALETTE).size === EMOJI_PALETTE.length);

  // THE SORT IS THE MAPPING. `assignEmoji` indexes this array, so the ORDER is load-bearing in
  // exactly the way `agentArtFiles.ts`'s is — reorder it and every agent in every workspace changes
  // its mark on the next deploy. Asserted as a sort somebody can re-derive rather than as an order
  // somebody typed, because directory and object iteration order are not stable across platforms
  // and this codebase has been bitten by a platform-dependent path once already.
  const sorted = [...EMOJI_PALETTE].sort((a, b) => a.codePointAt(0)! - b.codePointAt(0)!);
  check("it is sorted by code point", JSON.stringify(sorted) === JSON.stringify([...EMOJI_PALETTE]),
    sorted.join(""));

  // D7'S THREE MECHANICAL RULES. Each of these is a class of emoji a font may not have, or may have
  // and render as two glyphs, and each is the shape the mistake actually arrives in.
  const multi = EMOJI_PALETTE.filter((e) => [...e].length !== 1);
  check("every mark is a single code point", multi.length === 0, multi.join(" "));
  const vs = EMOJI_PALETTE.filter((e) => /[︎️]/.test(e));
  check("none carries a variation selector", vs.length === 0, vs.join(" "));
  const zwj = EMOJI_PALETTE.filter((e) => e.includes("‍"));
  check("none is a zero-width-joiner sequence", zwj.length === 0, zwj.join(" "));
  const tone = EMOJI_PALETTE.filter((e) => /[\u{1F3FB}-\u{1F3FF}]/u.test(e));
  check("none carries a skin tone", tone.length === 0, tone.join(" "));
  // POST-UNICODE-12 RENDERS AS TOFU on older Linux font packages. The block Unicode 13 opened for
  // emoji starts at U+1FA70; nothing in the palette may be in it or above.
  const late = EMOJI_PALETTE.filter((e) => e.codePointAt(0)! >= 0x1FA70);
  check("nothing was added after Unicode 12", late.length === 0, late.join(" "));

  // §8.3'S EXCLUSIONS, spelled out rather than derived — a table that checked itself would pass just
  // as happily with a row deleted. Status-shaped marks compete directly with the Pattern 1 glyph;
  // an amber-dominant one reads as permanently running; a face reads as a human collaborator and
  // collides with the member avatars; a flag is an argument a workspace does not need.
  const EXCLUDED = [
    "✅", "❌", "⚠️", "⚠", "🔴", "🟢", "🟡", "🟠", "⏸", "▶", "⏹", "✔️", "✖️",
    "🟧", "🍊", "🔶", "🧡", "🔥", "🍋", "🥕", "🧀", "👑", "🍁",
    "😀", "🙂", "😐", "👤", "👥", "🧑", "👩", "👨", "🤖",
    "🏳", "🏴", "🚩",
  ];
  const present = EMOJI_PALETTE.filter((e) => EXCLUDED.includes(e));
  check("no status-shaped, amber-dominant, face or flag mark", present.length === 0, present.join(" "));
  // AND NOTHING IN THE REGIONAL-INDICATOR BLOCK, which is what every country flag is built from.
  const flags = EMOJI_PALETTE.filter((e) => /[\u{1F1E6}-\u{1F1FF}]/u.test(e));
  check("nothing is a regional indicator", flags.length === 0, flags.join(" "));
}

// --- 2. the two copies agree ----------------------------------------------------------------------

console.log("\nthe client's copy and the server's are the same list");
{
  // READ AS TEXT, from the other package's SOURCE. A drift here is two agents wearing different
  // marks in the sidebar and in the picker that sets them, which looks like a bug in neither file.
  const entries = (path: string): string[] =>
    [...readFileSync(path, "utf8").matchAll(/^  "(.+?)", \/\/ U\+/gm)].map((m) => m[1]!);
  const client = entries("../client/src/lib/emojiPalette.ts");
  const server = entries("src/agents/emojiPalette.ts");
  check("the client's palette was actually read", client.length === 64, `${client.length}`);
  check("the two lists are identical", JSON.stringify(client) === JSON.stringify(server),
    `${client.length} vs ${server.length}`);
  // AND THE HASH IS THE SAME FUNCTION, which matters as much as the list: the same uuid must reach
  // the same starting index in the browser as it does here, or the picker's shuffle proposes a mark
  // the server would not have chosen.
  const clientHash = readFileSync("../client/src/lib/emojiPalette.ts", "utf8");
  check("the client uses the same FNV-1a", clientHash.includes("0x811c9dc5") && clientHash.includes("h << 24"));
  check("...and so does the gradient it borrows it from",
    readFileSync("../client/src/lib/agentArt.ts", "utf8").includes("0x811c9dc5"));
}

// --- 3. assignment ---------------------------------------------------------------------------------

console.log("\nderived, then stored — and never the same twice in one workspace");
{
  // DETERMINISTIC FOR A FIXED WORKSPACE, which is the property a random pick cannot have: it changes
  // on reload, differs between replicas, and cannot be tested.
  const id = "6f1c2a5e-0000-4000-8000-000000000001";
  check("the same id and the same workspace answer the same mark",
    assignEmoji(id, []) === assignEmoji(id, []));
  check("the mark is from the palette", EMOJI_PALETTE.includes(assignEmoji(id, [])));
  check("the hash is stable", hash32("abc") === hash32("abc") && hash32("abc") !== hash32("abd"));

  // THE PROBE. With the hashed entry taken, the answer moves on rather than colliding.
  const first = assignEmoji(id, []);
  const second = assignEmoji(id, [first]);
  check("a taken mark is stepped over", second !== first, `${first} then ${second}`);
  check("...to the next one in the palette",
    second === EMOJI_PALETTE[(EMOJI_PALETTE.indexOf(first) + 1) % EMOJI_PALETTE.length],
    `${first} -> ${second}`);

  // TWENTY AGENTS, NO DUPLICATE — which is the number §8.1 does the birthday arithmetic for, and the
  // number the sidebar is the reason for. A hash without the probe fails this better than nineteen
  // times in twenty.
  const taken: string[] = [];
  for (let i = 0; i < 20; i++) taken.push(assignEmoji(randomUUID(), taken));
  check("twenty agents get twenty different marks", new Set(taken).size === 20, taken.join(""));

  // AND SIXTY-FOUR EXHAUSTS IT EXACTLY, with the sixty-fifth falling back rather than failing: a
  // workspace that cannot create its sixty-fifth agent is a worse outcome than one where two of them
  // share a mark.
  const all: string[] = [];
  for (let i = 0; i < 64; i++) all.push(assignEmoji(randomUUID(), all));
  check("sixty-four exhaust the palette", new Set(all).size === 64);
  const overflow = assignEmoji(randomUUID(), all);
  check("the sixty-fifth still gets one", EMOJI_PALETTE.includes(overflow), overflow);
}

// --- 4. what the database actually holds -----------------------------------------------------------

console.log("\nevery agent is written with one, and a fork never inherits");
{
  const db = await openTestSqlite();
  const ctx = testContext();
  const repo = new AgentRepository(db);

  const made: string[] = [];
  for (let i = 0; i < 12; i++) {
    const a = await repo.create(ctx, { id: randomUUID(), slug: `agent_${i}`, hand_written: false });
    made.push(a.emoji ?? "");
  }
  check("every created agent has a mark", made.every((e) => e.length > 0), made.join("|"));
  check("...from the palette", made.every((e) => EMOJI_PALETTE.includes(e)), made.join(""));
  check("...and no two are the same", new Set(made).size === made.length, made.join(""));

  // A FORK IS AN ORDINARY CREATE with `forkedFrom` set, so this is the same probe — but it is the
  // case §8.2 names by name, because fork and parent sit ADJACENT in the sidebar and are the two
  // agents you most need to tell apart.
  const parent = await repo.create(ctx, { id: randomUUID(), slug: "parent_agent", hand_written: false });
  const fork = await repo.create(ctx, {
    // `forked_from` REFERENCES agents(id), not the slug — migration 049. The Agents grid renders
    // the parent's slug and the column holds its uuid, which is the pair a test is most likely to
    // get the wrong way round.
    id: randomUUID(), slug: "parent_agent_copy", hand_written: false, forkedFrom: parent.id,
  });
  check("a fork gets a fresh mark", fork.emoji !== parent.emoji, `${parent.emoji} vs ${fork.emoji}`);
  check("...and still records its parent", fork.forked_from === parent.id);

  // THE DISK PATH TOO. `upsertFromDisk` is the other insert, and an agent that arrived by
  // reconciliation rather than by generation is still an agent in the sidebar.
  const fromDisk = await repo.upsertFromDisk(ctx, { slug: "disk_agent", hand_written: true });
  check("an agent from disk gets one too", Boolean(fromDisk.emoji) && EMOJI_PALETTE.includes(fromDisk.emoji!),
    String(fromDisk.emoji));
  // AND A RE-SYNC DOES NOT RESHUFFLE IT. A reconciliation runs on every boot; an identity mark
  // rewritten by one would change for a reason nobody could see.
  const again = await repo.upsertFromDisk(ctx, { slug: "disk_agent", hand_written: true });
  check("a re-sync leaves it alone", again.emoji === fromDisk.emoji, `${fromDisk.emoji} vs ${again.emoji}`);

  // THE PICKER'S WRITE, and §8.5's rule: a duplicate is ALLOWED. The store writes it; the command
  // warns. A store that refused would make a cosmetic choice a failure.
  await repo.setEmoji(ctx, fork.id, parent.emoji!);
  const clashed = await repo.byId(ctx, fork.id);
  check("a duplicate the user chose is written", clashed?.emoji === parent.emoji, String(clashed?.emoji));

  // ARCHIVED AGENTS KEEP THEIRS, and their mark stays out of the pool — a restore that found its
  // mark taken would be an agent whose identity changed while it was put away.
  await repo.setArchived(ctx, parent.id, true);
  const archived = await repo.byId(ctx, parent.id);
  check("an archived agent keeps its mark", archived?.emoji === parent.emoji, String(archived?.emoji));
  const after = await repo.create(ctx, { id: randomUUID(), slug: "after_archive", hand_written: false });
  const live = (await repo.list(ctx, { includeArchived: true })).map((a) => a.emoji);
  check("...and a new agent does not take it",
    after.emoji !== parent.emoji, `${after.emoji} vs ${parent.emoji}`);
  check("the pool counted the archived one", live.includes(parent.emoji!));

  await db.close?.();
}

// --- 5. the write path is the constraint ------------------------------------------------------------

console.log("\nthe column is nullable and the write path is not");
{
  // MIGRATION 067 EXPLAINS WHY THE COLUMN IS NOT `NOT NULL`: this repository's own expand/contract
  // gate refuses `ADD COLUMN ... NOT NULL` without a default, because the version still serving does
  // not name the column in its INSERTs. So the guarantee §8.2 actually wants — "no row exists
  // without going through assignment" — is enforced here, by reading the repository's source.
  const repo = readFileSync("src/db/repositories/agents.ts", "utf8");
  const inserts = [...repo.matchAll(/INSERT INTO agents \(([^)]*)\)/g)].map((m) => m[1]!);
  check("both insert paths were found", inserts.length === 2, `${inserts.length}`);
  check("every insert names the column", inserts.every((cols) => /\bemoji\b/.test(cols)),
    inserts.map((c) => c.replace(/\s+/g, " ")).join(" | "));
  check("...and every one of them calls the assignment",
    (repo.match(/assignEmoji\(/g) ?? []).length === 2, String((repo.match(/assignEmoji\(/g) ?? []).length));

  // AND THE MIGRATION CARRIES NO DEFAULT, which is §8.2's actual requirement: a default would let a
  // row exist without going through assignment, which is how duplicates get in.
  for (const dialect of ["sqlite", "postgres"]) {
    const sql = readFileSync(`migrations/${dialect}/067_agent_emoji.sql`, "utf8");
    const add = sql.split("\n").filter((l) => /ALTER TABLE agents ADD COLUMN/.test(l)).join(" ");
    check(`${dialect}'s column has no default`, add.length > 0 && !/DEFAULT/i.test(add), add);
    check(`${dialect} backfills the rows that exist`, /UPDATE agents/.test(sql));
  }

  // THE EXPORT CARRIES IT — §8.2: "It is the workspace's own record of how its members recognise
  // their agents." It falls out of `SELECT *` over an exported table, so what is asserted is that
  // `agents` is still on the exported list rather than that a column was named somewhere.
  const exp = readFileSync("src/lifecycle/export.ts", "utf8");
  check("agents are still exported", /EXPORTED_TABLES = \[\s*\n\s*"agents"/.test(exp));
  check("...as whole rows", exp.includes("SELECT * FROM ${table}"));
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
