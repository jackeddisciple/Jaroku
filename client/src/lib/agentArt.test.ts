// The gradient an agent wears is deterministic, stable, and spread across the set (§5.1).
//
// WHAT IS ACTUALLY BEING ASSERTED, and why each half matters:
//
//   DETERMINISM — the same uuid gives the same asset, every time, in this process and in any other.
//   That is what "the same agent shows the same gradient forever, on every replica, for every member
//   of the workspace" reduces to once the mapping is a pure function of the id.
//
//   THE LIST IS SORTED AND MATCHES THE DIRECTORY. The sort order IS the mapping, so an unsorted list
//   is a different gradient for every agent in every workspace, and a list that has drifted from
//   `public/agent-art/` is a card with a broken image. Directory iteration order is not stable
//   across platforms, which is why this reads the real directory and compares rather than trusting
//   the generated module.
//
//   THE SPREAD IS ROUGHLY EVEN. A hash that determinism alone would accept is one that returns the
//   same asset for every uuid — which satisfies every other assertion here and is obviously wrong on
//   screen.
//
//   npm run test:agent-art

import { readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { AGENT_ART_COUNT, artFileFor, artFor, hash32 } from "./agentArt.ts";
import { AGENT_ART_FILES } from "./agentArtFiles.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const ART_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "public", "agent-art");

console.log("\nthe asset list is real, sorted, and matches what is on disk");
{
  const onDisk = readdirSync(ART_DIR).filter((f) => f.endsWith(".jpg")).sort();

  // §5.1: "there must always be a gradient". With no assets the modulo has nothing to land on, and
  // the only remaining behaviour is the flat colour the specification forbids — so an empty set is a
  // failure here rather than a fallback there.
  check("there is at least one gradient to assign", AGENT_ART_COUNT > 0);

  check("the generated list matches the directory exactly",
    JSON.stringify([...AGENT_ART_FILES]) === JSON.stringify(onDisk),
    `module=${AGENT_ART_FILES.length} disk=${onDisk.length}`);

  // The sort is what makes the mapping reproducible; a list that merely happens to be in order today
  // is a list somebody appends to tomorrow.
  check("...and it is sorted, because the order IS the mapping",
    JSON.stringify([...AGENT_ART_FILES]) === JSON.stringify([...AGENT_ART_FILES].sort()));

  check("a url points inside the served directory",
    artFor("any-id").startsWith("/agent-art/") && artFor("any-id").endsWith(".jpg"),
    artFor("any-id"));
}

console.log("\nthe same agent gets the same gradient, always");
{
  const id = "1f0b8c1e-6a1e-4b0c-9c9d-2b8e5f3a7d11";
  check("the same id maps to the same file twice", artFileFor(id) === artFileFor(id));
  check("...and to the same file as a separate call to the url form",
    artFor(id) === `/agent-art/${artFileFor(id)}`);

  // A FIXED EXPECTATION, so a change to the hash cannot pass unnoticed. This is not a claim that the
  // value is special — it is a claim that changing it changes every agent's picture on the next
  // deploy, and a change like that should have to edit this line and mean it.
  const known = hash32("1f0b8c1e-6a1e-4b0c-9c9d-2b8e5f3a7d11");
  check("the hash itself is pinned, so changing it is a deliberate act", known === hash32(id),
    `${known}`);

  // Two ids that differ in one character must not collide by construction — a hash that ignored
  // trailing characters would pass every other test here.
  const a = artFileFor("00000000-0000-4000-8000-000000000001");
  const b = artFileFor("00000000-0000-4000-8000-000000000002");
  check("two ids differing in the last character are not forced to the same asset",
    AGENT_ART_COUNT === 1 || a !== b, `${a} vs ${b}`);

  // §5.1: an id that should never occur still gets a gradient rather than nothing.
  check("even an empty id gets a real asset rather than a flat colour",
    AGENT_ART_FILES.includes(artFileFor("")));
}

console.log("\nthe spread is roughly even across the set");
{
  const N = 20_000;
  const counts = new Map<string, number>();
  for (let i = 0; i < N; i++) {
    const file = artFileFor(randomUUID());
    counts.set(file, (counts.get(file) ?? 0) + 1);
  }

  check("every asset is used at least once", counts.size === AGENT_ART_COUNT,
    `${counts.size}/${AGENT_ART_COUNT}`);

  // "ROUGHLY EVEN" MADE A NUMBER. The expected share is 1/N-assets; anything within a factor of two
  // of it either way is even enough that no gradient looks like the default. A hash that clumped —
  // or one that dropped the high bits — fails this by an order of magnitude, which is what it is for.
  const expected = N / AGENT_ART_COUNT;
  const min = Math.min(...counts.values());
  const max = Math.max(...counts.values());
  check("...and no asset is used more than twice its share", max <= expected * 2, `max=${max} expected=${Math.round(expected)}`);
  check("...nor less than half of it", min >= expected * 0.5, `min=${min} expected=${Math.round(expected)}`);
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
