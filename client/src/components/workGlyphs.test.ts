// §24's `test:work-glyphs`: "six statuses, six distinct marks — the test that fails if two collapse
// onto one".
//
// THAT SENTENCE IS THE WHOLE SUITE. A glyph function is never wrong in a way a per-case assertion
// catches — every branch returns a mark, every mark renders, and a screenshot of any one of them
// looks right. What goes wrong is that two of them return the SAME mark, which no assertion about
// either one can see. So the property here is pairwise: six markups, six distinct strings, and the
// failure message names the pair that collapsed.
//
// IT IS THE MISTAKE THE SIDEBAR ALREADY MADE, twice, which is why §9 points at that file rather
// than describing the rule abstractly. `paused` fell through to the completed tick, so a run halted
// mid-graph wore the same green as one that finished; and `running`/`deploying` were both a pulsing
// amber dot while `deployed`/`ran` were both a static green one, so two of four live states were
// distinguishable only by hovering. Both shipped. Both looked fine.
//
// THREE AXES, NOT ONE. §9's table gives each status a colour role, a mark and a motion, and two
// statuses may legitimately share any ONE of the three — `running` and `waiting` share amber by
// design, `queued` and `cancelled` share neutral. What may never happen is two sharing all three,
// so the suite checks the whole rendering and then checks each axis behaves as the table says.
//
//   npm run test:work-glyphs

import { createElement } from "react";

import { STATUS_WORD } from "../lib/cockpitCopy.ts";
import { markup } from "../lib/testRender.ts";
import { STATUS } from "../lib/tokens.ts";
import { WORK_STATUS_ORDER } from "../store/workStore.ts";
import type { WorkStatus } from "../types.ts";
import { WorkGlyph } from "./WorkGlyph.tsx";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const STATUSES: WorkStatus[] = ["queued", "running", "waiting", "succeeded", "failed", "cancelled"];
const drawn = new Map<WorkStatus, string>(
  STATUSES.map((status) => [status, markup(createElement(WorkGlyph, { status }))]),
);
const of = (status: WorkStatus): string => drawn.get(status)!;

// --- 1. six statuses, six distinct marks -----------------------------------------------------------

console.log("\nthe test that fails if two collapse onto one");
{
  check("every status draws something", STATUSES.every((s) => of(s).length > 0));

  // PAIRWISE, AND NAMING THE PAIR. A `new Set(...).size === 6` fails identically for every possible
  // collapse and tells whoever is reading the log nothing about which two.
  const collapsed: string[] = [];
  for (let i = 0; i < STATUSES.length; i++) {
    for (let j = i + 1; j < STATUSES.length; j++) {
      if (of(STATUSES[i]!) === of(STATUSES[j]!)) collapsed.push(`${STATUSES[i]} = ${STATUSES[j]}`);
    }
  }
  check("no two statuses render the same mark", collapsed.length === 0, collapsed.join("; "));

  // THE PAIR §9 CALLS OUT BY NAME, asserted on its own so a regression reads as itself: "a static
  // mark distinct from `succeeded`'s".
  check("queued is not succeeded's tick", of("queued") !== of("succeeded"));
  // AND THE PAIR THE OLD BUILD ACTUALLY HAD TROUBLE WITH — `cancelled` reading as `failed`, which
  // would file an operational decision under "something went wrong".
  check("cancelled is not failed's cross", of("cancelled") !== of("failed"));
  // AND THE ONE §9 IS MOST WORRIED ABOUT, since these two share a colour on purpose.
  check("waiting is not running's loader", of("waiting") !== of("running"));
}

// --- 2. the colour column of §9's table ------------------------------------------------------------

console.log("\namber means in flight, and only in flight");
{
  const has = (status: WorkStatus, colour: string): boolean => of(status).includes(colour);

  // §9: "`running` and `waiting` share amber because both are genuinely in flight — one on the
  // machine, one on a person — and they are separated by mark and by motion, never by inventing a
  // seventh colour." This build changed its mind here: `waiting` was the `warn` blue.
  check("running is amber", has("running", STATUS.pending), of("running"));
  check("waiting is amber too", has("waiting", STATUS.pending), of("waiting"));
  check("...and not the caution blue", !has("waiting", STATUS.warn), of("waiting"));

  check("succeeded is the ok green", has("succeeded", STATUS.ok));
  check("failed is the error red", has("failed", STATUS.error));

  // NEITHER OF THE SETTLED-BUT-UNREMARKABLE STATES BORROWS A STATUS COLOUR. §9 gives both
  // `STATUS.neutral`, which recedes rather than signals.
  check("queued is neutral", has("queued", STATUS.neutral));
  check("cancelled is neutral", has("cancelled", STATUS.neutral));

  // AND NOTHING OUTSIDE THE FOUR IS USED. A seventh colour is exactly what §9 forbids, and the way
  // it arrives is somebody reaching for a hex to separate two statuses that share a hue.
  const KNOWN = [STATUS.ok, STATUS.pending, STATUS.error, STATUS.warn, STATUS.neutral];
  for (const status of STATUSES) {
    const hexes = of(status).match(/#[0-9a-fA-F]{3,8}/g) ?? [];
    const stray = hexes.filter((h) => !KNOWN.some((k) => k.toLowerCase() === h.toLowerCase()));
    check(`${status} invents no colour of its own`, stray.length === 0, stray.join(", "));
  }
}

// --- 3. the motion column ---------------------------------------------------------------------------

console.log("\nmotion means this is changing right now, and nothing else");
{
  const moves = (status: WorkStatus): boolean => /animate-(spin|stream-pulse)/.test(of(status));

  // §9: "Two of six statuses move." Exactly two, which is the assertion that fails if somebody
  // makes `queued` pulse to look busier.
  const moving = STATUSES.filter(moves);
  check(`exactly two statuses move (${moving.join(", ")})`, moving.length === 2, moving.join(", "));
  check("...and they are the two that are in flight",
    moving.includes("running") && moving.includes("waiting"), moving.join(", "));

  // THE TWO MOVE DIFFERENTLY, which is half of what separates them given a shared colour.
  check("running turns", /animate-spin/.test(of("running")));
  check("waiting pulses rather than turning", /animate-stream-pulse/.test(of("waiting")) && !/animate-spin/.test(of("waiting")));

  // §9: "`stream-pulse`, never `animate-pulse`." Tailwind's own pulse is a different curve and is
  // the one somebody reaches for without knowing this app has its own.
  check("nothing uses Tailwind's own pulse",
    !STATUSES.some((s) => /animate-pulse\b/.test(of(s))),
    STATUSES.filter((s) => /animate-pulse\b/.test(of(s))).join(", "));

  // §9 AND §11: "Everything honours `motion-reduce`."
  for (const status of moving) {
    check(`${status} honours motion-reduce`, /motion-reduce:animate-none/.test(of(status)), of(status));
  }
}

// --- 4. colour is never the only signal ------------------------------------------------------------

console.log("\nevery mark carries a word");
{
  // §9's closing rule and §12's: "Every status mark has a `title`, as `StatusGlyph` already does."
  // A colour-only mark is unreadable to a screen reader and to about one man in twelve.
  for (const status of STATUSES) {
    check(`${status} carries its word`, of(status).includes(`title="${STATUS_WORD[status]}"`), of(status));
  }

  // AND THE WORD IS THE STRINGS MODULE'S, not one written beside the glyph. §16 puts every
  // user-facing string of this tab in one file so the voice can be reviewed as prose.
  check("waiting says who is blocking", of("waiting").includes("waiting on you"), of("waiting"));
}

// --- 5. the store's order covers every status -------------------------------------------------------

console.log("\nthe closed set stays closed");
{
  // A SEVENTH STATUS IS A COMPILE ERROR IN `WorkGlyph` and would be a silent omission here, so the
  // two lists are checked against each other: the suite's own array and the store's filter order.
  check("the suite covers what the filter bar offers",
    WORK_STATUS_ORDER.every((s) => STATUSES.includes(s)) && STATUSES.length === WORK_STATUS_ORDER.length,
    `${STATUSES.length} vs ${WORK_STATUS_ORDER.length}`);
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
