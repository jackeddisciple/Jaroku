// FORTY THREE-PIXEL BUTTONS BETWEEN A KEYBOARD AND THE FAR SIDE OF THE AGENTS GRID.
//
// Each bar of an agent card's sparkline was a real `<button>` with its own `aria-label` and `title`,
// measured at 3×12px — under a tenth of this client's own `HIT_TARGET = 32`, which it applies
// correctly to every composer control. Eight cards render on the grid and one of them carried five
// bars, so the strip was both effectively unclickable with a mouse and a long walk with a keyboard.
//
// TWO FIXES, AND THE SECOND IS THE ONE THAT MATTERS MORE. The painted mark is no longer the hit
// area — the technique `PaneDivider` already uses two files over, "the line is one pixel, the
// element around it is five" — so the gap moved inside the button and the target grew from 3px to
// the full 5px pitch with every bar still exactly where it was. And the strip is one tab stop now
// rather than one per bar, walked with the arrow keys.
//
// TWENTY BARS AT A FULL 32px WOULD BE A 640px STRIP INSIDE A CARD, which is why the width fix is
// proportional rather than absolute and why this suite asserts the ratio and the pitch rather than
// asserting 32. A bar is a shortcut to a run; the card behind it is the primary target.
//
//   npm run test:sparkline-hits

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SPARKLINE = readFileSync(`${HERE}AgentSparkline.tsx`, "utf8");
const ICONS = readFileSync(`${HERE}icons.ts`, "utf8");

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

console.log("\nthe hit area and the painted mark are different elements");
{
  check("the button is 5px, the pitch of the strip", /w-\[5px\]/.test(SPARKLINE));
  check("the mark inside it is still the 3px bar", /w-\[3px\]/.test(SPARKLINE));
  // The half that makes the separation real: a mark that still took clicks would leave the button's
  // extra two pixels as decoration.
  check("the mark takes no pointer events", SPARKLINE.includes("pointer-events-none"));
  check("...and is hidden from assistive tech, since the button carries the label",
    /aria-hidden/.test(SPARKLINE));
  check("the button keeps the accessible name", /aria-label=\{`Run \$\{LABEL/.test(SPARKLINE));
}

console.log("\nthe strip did not get wider — the gap moved inside the button");
{
  // `gap-[2px]` plus a 3px bar was a 5px pitch. The button IS the pitch now, so the bars land where
  // they always did and nothing on the card reflows.
  check("the flex gap is gone", !/gap-\[2px\]/.test(SPARKLINE), "the strip still spaces with a gap");
  check("...because the button spans the pitch", /w-\[5px\]/.test(SPARKLINE));
}

console.log("\none tab stop for the strip, not one per run");
{
  check("a roving tabindex", /tabIndex=\{i === entry \? 0 : -1\}/.test(SPARKLINE),
    "every bar is still its own tab stop");
  check("the arrow keys walk it", /ArrowRight/.test(SPARKLINE) && /ArrowLeft/.test(SPARKLINE));
  // The strip is oldest-first because that is how a sparkline reads; the run somebody wants is
  // almost always the newest, so that is where the one stop lands.
  check("and it enters on the most recent run", /const entry = bars\.length - 1/.test(SPARKLINE));
  check("the group still names itself", /role="group"/.test(SPARKLINE));
}

console.log("\nthe client's own minimum is still where it was");
{
  // Quoted rather than assumed: this suite argues from `HIT_TARGET`, so it fails loudly if the
  // constant it argues from moves.
  check("HIT_TARGET is 32", /HIT_TARGET = 32/.test(ICONS));
  // And the record of why a bar does not reach it. 20 bars × 32px is a 640px strip in a card that
  // is not 640px wide.
  check("...and the strip explains why it is proportional", SPARKLINE.includes("640px"));
}

console.log("\nthe bar still opens the run rather than the card behind it");
{
  // The one behaviour the widening must not break: two destinations a pixel apart.
  check("the click is stopped from the card", SPARKLINE.includes("e.stopPropagation()"));
  check("...and opens the run", SPARKLINE.includes("openRun(bar)"));
  // The arrow keys must not reach the grid's own j/k cursor either.
  check("the arrow keys are stopped too",
    /moveFocus\(i,/.test(SPARKLINE) && SPARKLINE.split("e.stopPropagation()").length >= 3);
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
