// The eleven faces are real files, paired, named, and handed out so the first eleven agents differ.
//
// WHAT IS ACTUALLY BEING ASSERTED, and why each half matters:
//
//   THE LIST MATCHES THE DIRECTORY, IN BOTH DIRECTIONS. A module naming a file that is not there is
//   a broken image on a card; a file the module does not name is a picture nobody will ever be
//   given. This reads the real directory rather than trusting the generated module, because
//   directory iteration order is not stable across platforms and that is exactly the class of bug
//   the generator's zero-padding exists to rule out.
//
//   EVERY PORTRAIT HAS ITS OWN BANNER. The two are crops of one palette and the card stacks them,
//   so a pair that has come apart is a portrait on somebody else's colour — the one failure mode of
//   this feature that looks deliberate.
//
//   EVERY FACE HAS A NAME, AND NO TWO SHARE ONE. `agentFaces.ts` falls back to the id when a name is
//   missing, which keeps a card rendering; this is what stops that fallback being something anybody
//   sees, and it is the only reason the fallback is allowed to be quiet.
//
//   THE ASSIGNMENT CYCLES AND THE FIRST ELEVEN ARE DISTINCT. That is the property the whole move
//   from a hash to a position was made for — see `agentFaces.ts` for the birthday-bound argument —
//   and it is the one a reviewer cannot check by looking at a screenshot of one workspace.
//
//   npm run test:agent-faces

import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { AGENT_FACE_COUNT, AGENT_FACES, faceAt, faceFor } from "./agentFaces.ts";
import { AGENT_FACE_FILES } from "./agentFaceFiles.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

// RESOLVED FROM THIS FILE'S OWN URL rather than from a working directory, so the suite passes when
// it is run from the repository root and when it is run from `client/` — the same reason
// `agentArt.test.ts` does it this way.
const FACE_DIR = fileURLToPath(new URL("../../public/agent-faces", import.meta.url));

console.log("\nthe pairs are real files, and the module and the directory agree");
{
  const onDisk = readdirSync(FACE_DIR).filter((f) => /\.(png|jpg)$/.test(f)).sort();

  check("there are faces to assign at all", AGENT_FACE_COUNT > 0, String(AGENT_FACE_COUNT));

  // ELEVEN, AND THE NUMBER IS ASSERTED. Not because eleven is load-bearing arithmetic — `faceAt`
  // wraps at whatever the length is — but because the names are written by hand against the
  // pictures, so a twelfth pair arriving without a twelfth name is a thing to be told about.
  check("there are eleven of them", AGENT_FACE_COUNT === 11, String(AGENT_FACE_COUNT));

  const named = [...AGENT_FACE_FILES.map((f) => f.portrait), ...AGENT_FACE_FILES.map((f) => f.banner)].sort();
  check("the generated list matches the directory exactly",
    JSON.stringify(named) === JSON.stringify(onDisk),
    `module=${named.length} disk=${onDisk.length}`);

  // The ids are zero-padded precisely so that source order and sorted order are one sequence. A
  // list that merely happens to be in order today is a list somebody appends to tomorrow.
  const ids = AGENT_FACE_FILES.map((f) => f.id);
  check("...and the ids are in sorted order, because the order IS the mapping",
    JSON.stringify(ids) === JSON.stringify([...ids].sort()), ids.join(","));
  check("no id appears twice", new Set(ids).size === ids.length);

  for (const face of AGENT_FACES) {
    check(`${face.id} has a portrait and a banner of its own`,
      face.portrait === `/agent-faces/${face.id}.png` && face.banner === `/agent-faces/${face.id}-bg.jpg`,
      `${face.portrait} + ${face.banner}`);
  }

  check("every url points inside the served directory",
    AGENT_FACES.every((f) => f.portrait.startsWith("/agent-faces/") && f.banner.startsWith("/agent-faces/")));
}

console.log("\nevery face is named, and no two share a name");
{
  // THE FALLBACK IS THE ID, and this is the assertion that keeps it from being seen. `agentFaces.ts`
  // resolves a missing name to the id so a card still renders; a card reading "avatar-04" is not a
  // state worth shipping, so the quiet fallback is paid for here.
  const unnamed = AGENT_FACES.filter((f) => f.name === f.id).map((f) => f.id);
  check("no face fell back to its id for a name", unnamed.length === 0, unnamed.join(","));

  const names = AGENT_FACES.map((f) => f.name);
  check("every name is distinct", new Set(names).size === names.length, names.join(","));
  check("every name is a name rather than a slug",
    names.every((n) => /^[A-Z][a-zé]{1,11}$/.test(n)), names.join(","));
}

console.log("\nthe lookup answers the id it was given, and null for anything else");
{
  for (const face of AGENT_FACES) {
    check(`${face.id} resolves to itself`, faceFor(face.id) === face);
  }
  // NULL IS A REAL ANSWER — a row written before migration 079, or one naming a pair that has been
  // removed. Every render site handles it, and a fabricated face would be worse than none.
  check("an unknown id is null", faceFor("avatar-99") === null);
  check("null is null", faceFor(null) === null);
  check("undefined is null", faceFor(undefined) === null);
  check("the empty string is null", faceFor("") === null);
}

console.log("\nthe first eleven agents in a workspace all look different");
{
  // THE PROPERTY THE POSITION EXISTS FOR. A hash over eleven buckets would collide on agent four or
  // five more often than not; this is what a position guarantees and a hash cannot.
  const first = Array.from({ length: AGENT_FACE_COUNT }, (_, i) => faceAt(i));
  check("eleven positions give eleven different faces",
    new Set(first.map((f) => f.id)).size === AGENT_FACE_COUNT,
    first.map((f) => f.id).join(","));
  check("...and eleven different names",
    new Set(first.map((f) => f.name)).size === AGENT_FACE_COUNT);
  check("position 0 is the first entry", faceAt(0) === AGENT_FACES[0]);

  // AND THEN IT STARTS AGAIN, which is the asked-for behaviour rather than a fallback.
  check("the twelfth agent takes the first face again", faceAt(AGENT_FACE_COUNT) === faceAt(0));
  check("the twenty-third too", faceAt(AGENT_FACE_COUNT * 2) === faceAt(0));
  check("and a long way out", faceAt(1000) === faceAt(1000 % AGENT_FACE_COUNT));

  // A CONFUSED INDEX STILL ANSWERS A REAL FACE. There is no state of this product in which the right
  // response to a bad position is an agent with no picture.
  check("a negative position is still a real face", AGENT_FACES.includes(faceAt(-1)), faceAt(-1).id);
  check("...and wraps from the end", faceAt(-1) === AGENT_FACES[AGENT_FACE_COUNT - 1]);
  check("a fractional position is floored", faceAt(2.9) === faceAt(2));
  check("NaN is the first entry rather than a throw", faceAt(Number.NaN) === AGENT_FACES[0]);
  check("Infinity is a real face", AGENT_FACES.includes(faceAt(Number.POSITIVE_INFINITY)));
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
