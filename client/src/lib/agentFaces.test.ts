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
//   EVERY PORTRAIT HAS ITS OWN BADGE AND ITS OWN BANNER. The three are one agent drawn three ways
//   and the surfaces stack them, so a set that has come apart is a portrait on somebody else's
//   colour, or Iris's face in a card beside Bruno's badge in the sidebar — the failure modes of this
//   feature that look deliberate.
//
//   AND THE SIZE DECIDES WHICH DRAWING IS USED. Dense rows get the ringed badge, real portraits get
//   the free-standing one; that is the product owner's split and `AgentFace` spells it as a single
//   threshold rather than a prop, so it is worth pinning that the threshold still falls between the
//   two groups of sizes.
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

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { FACE_SIZE } from "../components/AgentFace.tsx";
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

  // ALL THREE OF THE SET, because an agent now wears three pictures rather than two: the portrait
  // where there is room for a face, the ringed badge in dense rows, and the banner behind both.
  const named = [
    ...AGENT_FACE_FILES.map((f) => f.portrait),
    ...AGENT_FACE_FILES.map((f) => f.sidebar),
    ...AGENT_FACE_FILES.map((f) => f.banner),
  ].sort();
  check("the generated list matches the directory exactly",
    JSON.stringify(named) === JSON.stringify(onDisk),
    `module=${named.length} disk=${onDisk.length}`);

  // The ids are zero-padded precisely so that source order and sorted order are one sequence. A
  // list that merely happens to be in order today is a list somebody appends to tomorrow.
  const ids = AGENT_FACE_FILES.map((f) => f.id);
  check("...and the ids are in sorted order, because the order IS the mapping",
    JSON.stringify(ids) === JSON.stringify([...ids].sort()), ids.join(","));
  check("no id appears twice", new Set(ids).size === ids.length);

  // EACH OF THE THREE BELONGS TO THE SAME AGENT, which is the failure this feature has that still
  // renders: a portrait resolved from one place and a banner from another is Iris's face on Bruno's
  // green, and now a third way to get it wrong is Iris's face beside Bruno's badge in the sidebar.
  for (const face of AGENT_FACES) {
    check(`${face.id} has a portrait, a badge and a banner of its own`,
      face.portrait === `/agent-faces/${face.id}.png`
        && face.sidebar === `/agent-faces/${face.id}-sidebar.png`
        && face.banner === `/agent-faces/${face.id}-bg.jpg`,
      `${face.portrait} + ${face.sidebar} + ${face.banner}`);
  }

  check("every url points inside the served directory",
    AGENT_FACES.every((f) => f.portrait.startsWith("/agent-faces/")
      && f.sidebar.startsWith("/agent-faces/")
      && f.banner.startsWith("/agent-faces/")));
}

console.log("\nthe size a face is drawn at decides which of the two drawings it gets");
{
  const face = readFileSync(fileURLToPath(new URL("../components/AgentFace.tsx", import.meta.url)), "utf8");
  const body = face.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

  check("the badge is chosen by a threshold rather than a prop",
    /const badge = size <= BADGE_UPTO/.test(body) && !/variant\?:/.test(body));
  check("...and the threshold is the sidebar's own size",
    /const BADGE_UPTO = FACE_SIZE\.sidebar/.test(body));
  check("a badge draws the badge file and a portrait the portrait",
    /src=\{badge \? face\.sidebar : face\.portrait\}/.test(body));

  // THE BREAK HAS TO STAY BETWEEN THE TWO GROUPS, which is the thing a future size can quietly
  // move. `row` and `sidebar` are the dense rows; `compact`, `card` and `header` are the surfaces
  // with room for a face. A sixth size added between the two would land in the gap and pick a side
  // silently, so the gap itself is asserted.
  const dense = [FACE_SIZE.row, FACE_SIZE.sidebar];
  const portraits = [FACE_SIZE.compact, FACE_SIZE.card, FACE_SIZE.header];
  check("every dense-row size is at or under the threshold",
    dense.every((n) => n <= FACE_SIZE.sidebar), dense.join(","));
  check("every portrait size is over it",
    portraits.every((n) => n > FACE_SIZE.sidebar), portraits.join(","));

  // AND THE GAP IS MEASURED AGAINST THE LADDER RATHER THAN AGAINST A ROUND NUMBER, which is the
  // correction this check needed. It asked for 20px and the sidebar badge then went to 28 — a
  // deliberate, rendered, chosen size — leaving a 16px gap and a red suite over nothing. What makes
  // a gap wide enough is that it is no tighter than the tightest step the scale already takes
  // between two adjacent sizes, because a gap narrower than that would be the one place on the
  // ladder where two rungs are closer together than the rungs themselves.
  const rungs = [...dense, ...portraits].sort((a, b) => a - b);
  const tightest = Math.min(...rungs.slice(1).map((n, i) => n - rungs[i]!));
  check("...and nothing sits in the gap between them",
    Math.min(...portraits) - Math.max(...dense) >= tightest,
    `gap ${Math.min(...portraits) - Math.max(...dense)}, tightest step ${tightest}`);
}

console.log("\nevery face is named, and no two share a name");
{
  // THE FALLBACK IS THE ID, and this is the assertion that keeps it from being seen. `agentFaces.ts`
  // resolves a missing name to the id so a card still renders; a card reading "agent-04" is not a
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
  check("an unknown id is null", faceFor("agent-99") === null);
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
