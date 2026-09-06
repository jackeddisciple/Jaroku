// I2: geometry carries the state, and colour only reinforces it.
//
// THE ONLY HONEST VERSION OF THIS TEST STRIPS THE COLOUR. A status vocabulary is never wrong in a
// way a per-case assertion catches — every phase returns a mark, every mark renders, and a
// screenshot of any one of them looks right. What goes wrong is that two of them are the same shape
// in two colours, which passes every assertion about either one and fails for about one man in
// twelve, at 14px, and in every greyscale screenshot anybody takes of this product.
//
// So the property here is PAIRWISE, over markup with every colour removed: seven phases, seven
// distinct geometries, and the failure names the pair that collapsed. `test:work-glyphs` is the
// same shape of suite over the Cockpit's six statuses and for the same reason — that one records
// the sidebar shipping `paused` as the completed tick, twice.
//
// AND THE RAMP IS ONE FAMILY, which is the other half of §2.1 and the half a distinctness check
// cannot see: seven marks that are all different is not the same as seven marks that are all
// variations on one circle. A vocabulary of a circle, a triangle and a square is perfectly
// distinguishable and completely unscannable, so the base circle is asserted directly.
//
//   npm run test:status-glyph

import { createElement } from "react";

import { markup } from "../lib/testRender.ts";
import { PHASES, PHASE_COLOUR, PHASE_WORD, type Phase } from "../lib/statusPhase.ts";
import { ICON } from "../lib/tokens.ts";
import { StatusGlyph } from "./StatusGlyph.tsx";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const drawn = new Map<Phase, string>(
  PHASES.map((phase) => [phase, markup(createElement(StatusGlyph, { phase }))]),
);
const of = (phase: Phase): string => drawn.get(phase)!;

/**
 * The mark as somebody with no colour vision sees it, and as a greyscale screenshot prints it.
 *
 * BOTH SPELLINGS OF A COLOUR GO. The wrapper carries the phase's colour as an inline `color`, and a
 * fill or a stroke inside the svg could carry a literal — stripping only one of the two would let a
 * pair separated by a hard-coded fill pass a test whose whole subject is that colour is absent.
 */
const greyscale = (m: string): string =>
  m
    .replace(/style="[^"]*"/g, "")
    .replace(/#[0-9a-fA-F]{3,8}/g, "")
    .replace(/(fill|stroke)="(?!none|currentColor)[^"]*"/g, "");

// --- 1. all seven render, and none of them is empty -------------------------------------------

console.log("\nseven phases, seven marks");
{
  check("the ramp has exactly seven phases", PHASES.length === 7, `${PHASES.length}`);
  check("every phase draws something", PHASES.every((p) => of(p).includes("<svg")), 
    PHASES.filter((p) => !of(p).includes("<svg")).join(", "));
  // A MARK WITH NO GEOMETRY IN IT is what a missing switch arm renders as, and an empty `<svg>` is
  // indistinguishable from a correct one in every check that only asks whether something came back.
  const hollow = PHASES.filter((p) => !/<(circle|path)\b/.test(of(p)));
  check("every mark has geometry in it", hollow.length === 0, hollow.join(", "));
}

// --- 2. the assertion this suite exists for ----------------------------------------------------

console.log("\nevery pair survives the colour being stripped");
{
  const grey = new Map<Phase, string>(PHASES.map((p) => [p, greyscale(of(p))]));

  // PAIRWISE, AND NAMING THE PAIR. A `new Set(...).size === 7` fails identically for every possible
  // collapse and tells whoever is reading the log nothing about which two.
  const collapsed: string[] = [];
  for (let i = 0; i < PHASES.length; i++) {
    for (let j = i + 1; j < PHASES.length; j++) {
      if (grey.get(PHASES[i]!) === grey.get(PHASES[j]!)) collapsed.push(`${PHASES[i]} = ${PHASES[j]}`);
    }
  }
  check("no two phases are the same shape", collapsed.length === 0, collapsed.join("; "));

  // THE PAIRS §2.1 IS MOST EXPOSED ON, asserted on their own so a regression reads as itself. Each
  // of these three is two phases that share everything but one piece of geometry, which is exactly
  // the difference somebody removes while tidying.
  check("pending's dashed ring is not ready's hollow one",
    grey.get("pending") !== grey.get("ready"));
  check("done's fill is not halted's fill", grey.get("done") !== grey.get("halted"));
  check("active's arc is not ready's bare ring", grey.get("active") !== grey.get("ready"));

  // AND THE COLOUR IS GENUINELY THE THING THAT WAS STRIPPED — a `greyscale` that silently matched
  // nothing would make every assertion above pass for the wrong reason.
  check("the colour was actually removed",
    PHASES.every((p) => of(p).includes(PHASE_COLOUR[p]) && !grey.get(p)!.includes(PHASE_COLOUR[p])));
}

// --- 3. one family, not seven unrelated marks --------------------------------------------------

console.log("\nall seven are variations on one circle");
{
  // §2.1: "They are siblings, not seven unrelated marks — that is what makes the ramp readable at a
  // glance in a column." Distinctness alone does not give that; a shared base does.
  const RING = /r="?10"?/;
  const ringed = PHASES.filter((p) => RING.test(of(p)));
  const filled = PHASES.filter((p) => of(p).includes("fillRule") || of(p).includes("fill-rule"));
  check("five phases are drawn as the ring", ringed.length === 5, ringed.join(", "));
  check("...and the other two are the same circle filled", filled.length === 2, filled.join(", "));
  check("every phase is one or the other",
    PHASES.every((p) => ringed.includes(p) || filled.includes(p)));

  // THE FILLED PAIR IS THE RING'S OUTER EDGE, not its centreline — a disc at the centreline is
  // visibly smaller than a ring stroked around it, and a column with both is where that shows.
  const outer = String(10 + ICON.strokeWidth / 2);
  check("the filled discs match the ring's outer edge",
    filled.every((p) => of(p).includes(outer)), outer);

  // ONE GRID. A mark on its own viewBox sits a different weight from every other icon in the app.
  check("every mark is on the shared 24-unit grid",
    PHASES.every((p) => of(p).includes('viewBox="0 0 24 24"')));
  // AND AT THE ONE STROKE WEIGHT, from the token rather than from a number beside the shape.
  check("every mark draws at ICON.strokeWidth",
    PHASES.every((p) => of(p).includes(`stroke-width="${ICON.strokeWidth}"`)));
}

// --- 4. motion says one thing ------------------------------------------------------------------

console.log("\nthe active arc does not spin");
{
  const moves = (p: Phase): boolean => /animate-(spin|stream-pulse)/.test(of(p));
  const moving = PHASES.filter(moves);
  // §2.1: forty running rows with forty spinners is a seizure risk and a paint-cost problem.
  check("nothing spins", !PHASES.some((p) => /animate-spin/.test(of(p))),
    PHASES.filter((p) => /animate-spin/.test(of(p))).join(", "));
  check("exactly one phase moves", moving.length === 1, moving.join(", "));
  check("...and it is the one that is happening right now", moving[0] === "active", String(moving[0]));
  // §2.1: "never `animate-pulse`". Tailwind's own is a different curve and is what somebody reaches
  // for without knowing this app has its own.
  check("it uses stream-pulse rather than Tailwind's own",
    /animate-stream-pulse/.test(of("active")) && !/animate-pulse\b/.test(of("active")));
  check("and it drops entirely under prefers-reduced-motion",
    /motion-reduce:animate-none/.test(of("active")), of("active"));
}

// --- 5. colour is never the only signal --------------------------------------------------------

console.log("\nevery mark carries its word");
{
  // I8's half that applies to the glyph itself. A shape somebody has not learned yet is a shape
  // with a tooltip, and a screen reader has nothing else to go on.
  for (const phase of PHASES) {
    check(`${phase} carries its word`, of(phase).includes(`title="${PHASE_WORD[phase]}"`), of(phase));
    check(`${phase} is announced`, of(phase).includes(`aria-label="${PHASE_WORD[phase]}"`));
  }
  // AND A SURFACE WITH A BETTER SENTENCE CAN SAY IT — D2's whole resolution rests on this: an MCP
  // server that is unreachable and one that errored share a shape and must not share a sentence.
  const custom = markup(createElement(StatusGlyph, { phase: "failed", title: "unreachable" }));
  check("a caller's own sentence wins", custom.includes('title="unreachable"'));
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
