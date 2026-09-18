// The six empty-state badges are real files, in source order, actually transparent, and actually
// drawn on the screen they were made for.
//
// WHAT IS ACTUALLY BEING ASSERTED, and why each half matters:
//
//   THE LIST MATCHES THE DIRECTORY, IN BOTH DIRECTIONS. A module naming a file that is not there is
//   a gap in the row; a file the module does not name is a badge nobody will ever see. This reads
//   the real directory rather than trusting the generated module, because directory iteration order
//   is not stable across platforms and that is the class of bug the zero-padding exists to rule out.
//
//   THE ORDER IS img1 THROUGH img6 AND NOTHING SHUFFLES IT. Asked for by name, and the thing this
//   row replaced DID shuffle — a rotating emoji, a new one every second — so "six pictures on a
//   screen" is a shape somebody will reach for a `sort` or a `Math.random` on sooner or later.
//   Checked against the ids and against the component's source.
//
//   THE HOVER TWIST IS CSS AND HOLDS NO STATE. Hovering a badge turns it six degrees clockwise and
//   the one before it unwinds — which `:hover` gives for nothing, because a pointer is in exactly
//   one place and the two badges change in the same frame. Written as `useState` and a pair of
//   mouse handlers it would look identical in the markup and stutter by a render on every handoff,
//   which is the one thing the behaviour was asked not to do.
//
//   AND THE PIXELS ARE NOT CHECKED HERE, WHICH IS A DECISION RATHER THAN AN OVERSIGHT. The thing
//   the generator exists for is the cut — four of the six sources are opaque, three of those carry
//   a grey checkerboard painted into their pixels, and one sits on a black square — so the
//   regression worth catching is a regenerate that leaves a badge in a chequered tile. A version of
//   this suite that caught it was written and thrown away: it needed a PNG inflater and a defilter
//   loop, `Buffer` and `node:zlib` added to `node-shims.d.ts` — whose header says in as many words
//   that adding to it should feel like a decision — and after all that it still could not see the
//   second failure, a radius measured short enough to eat the coloured rim, because a clipped badge
//   fills its own crop box exactly as a correct one does.
//
//   SO THE CUT IS VERIFIED WHERE IT CAN BE SEEN. `gen-empty-faces.mjs` prints the centre, radius
//   and box it measured for each source, and both failures above were found by compositing the
//   output over a colour nothing in the artwork contains and looking at it. `menuClip.test.ts`
//   makes the same call about rectangles and says so; this is that, about pixels.
//
//   npm run test:empty-faces

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { EMPTY_FACE_FILES } from "./emptyFaceFiles.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

// RESOLVED FROM THIS FILE'S OWN URL rather than from a working directory, so the suite passes when
// it is run from the repository root and when it is run from `client/` — `agentFaces.test.ts`'s
// reason, one asset set over.
const DIR = fileURLToPath(new URL("../../public/empty-faces", import.meta.url));
const ROW = fileURLToPath(new URL("../components/EmptyFaceRow.tsx", import.meta.url));
const PANE = fileURLToPath(new URL("../components/BuildPane.tsx", import.meta.url));

console.log("\nsix badges, and the list is the directory");
{
  check("there are six", EMPTY_FACE_FILES.length === 6, `${EMPTY_FACE_FILES.length}`);
  const onDisk = readdirSync(DIR).filter((f) => f.endsWith(".png")).sort();
  const named = EMPTY_FACE_FILES.map((f) => f.file).sort();
  check("every file the module names is on disk",
    named.every((f) => onDisk.includes(f)), named.filter((f) => !onDisk.includes(f)).join(", "));
  check("...and every file on disk is named",
    onDisk.every((f) => named.includes(f)), onDisk.filter((f) => !named.includes(f)).join(", "));

  // THE ORDER, WHICH IS THE DESIGN. img1 through img6, and the ids carry it.
  check("the ids run 01 to 06 in order",
    EMPTY_FACE_FILES.map((f) => f.id).join(",") ===
      "empty-01,empty-02,empty-03,empty-04,empty-05,empty-06",
    EMPTY_FACE_FILES.map((f) => f.id).join(","));
  check("...and each file is its own id",
    EMPTY_FACE_FILES.every((f) => f.file === `${f.id}.png`));
}

console.log("\nthe row draws them in that order and does nothing else to it");
{
  const row = readFileSync(ROW, "utf8");
  check("it maps the generated list", row.includes("EMPTY_FACE_FILES.map("));
  // NOTHING REORDERS. `sort`, `reverse` and `random` are the three ways a fixed order stops being
  // one, and the emoji this replaced rotated on a timer — so a timer counts too.
  const body = row.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  for (const banned of [".sort(", ".reverse(", "Math.random", "setInterval", "setTimeout"]) {
    check(`it never calls ${banned}`, !body.includes(banned));
  }
}

console.log("\nthe hover twist is CSS, so the handoff between two badges cannot stutter");
{
  const row = readFileSync(ROW, "utf8");
  const body = row.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

  check("a badge twists clockwise on hover", /\bhover:rotate-6\b/.test(body), body.match(/hover:rotate-[^\s"]*/)?.[0] ?? "");
  check("...on a transition of its own", /\btransition-transform\b/.test(body));
  // THE TWO SLOWEST TOKENS THE SYSTEM HAS, and the pair is the "very smooth" that was asked for.
  // `duration-fast` here would read as a flick and `ease-state` covers the distance immediately.
  check("...at the collapse duration", /\bduration-collapse\b/.test(body));
  check("...on the curve that glides rather than pops", /\bease-smooth\b/.test(body));

  // THE ASSERTION THIS BLOCK EXISTS FOR. "The previous badge returns to its place when you hover
  // another" is free in CSS — a pointer is in one place, so one badge stops matching `:hover` in
  // the same frame the next starts — and it is the obvious thing to rewrite as `useState` plus
  // `onMouseEnter` later. Held in state the two badges are a render apart and the handoff stutters,
  // which is precisely what was asked not to happen, and nothing about the markup would look wrong.
  for (const banned of ["useState", "onMouseEnter", "onMouseLeave", "onPointerEnter"]) {
    check(`it holds no hover state of its own: no ${banned}`, !body.includes(banned));
  }

  // AND IT STOPS FOR SOMEBODY WHO HAS ASKED FOR LESS MOVEMENT. The hover is neutralised, not just
  // the transition — killing the transition alone leaves the badge snapping to six degrees.
  check("reduced motion drops the transition", /motion-reduce:transition-none/.test(body));
  check("...and the rotation with it", /motion-reduce:hover:rotate-0/.test(body));
}

console.log("\nthe empty state wears the row, and neither of the marks it replaced");
{
  const pane = readFileSync(PANE, "utf8");
  check("BuildPane draws the row above its question", /<EmptyFaceRow \/>[\s\S]{0,2000}What are we working on today/.test(pane));
  // THE TWO THINGS THAT WENT, asserted by their absence. Both were in this one place and nowhere
  // else, so an import that came back would be a mark drawn twice on one screen.
  check("the brand mark is gone from it", !pane.includes("JarokuGlyph"));
  check("the rotating emoji is gone from it", !pane.includes("GreetingEmoji"));
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
