// The composer's size ladder, and the rule that there is now only one stroke weight.
//
// WHAT THIS SUITE USED TO ASSERT, AND WHY IT DOES NOT ANY MORE. It guarded a registry of twenty
// HugeIcons payloads in `icons.ts` and, alongside it, a SECOND stroke ladder: `GLYPH.strokeWidth`
// was 1.5, and one of its checks existed specifically to fail if anybody merged it with
// `ICON.strokeWidth`. That check was not wrong about optics — a HugeIcons mark at 1.75 does read
// heavier than the Lucide geometry around it — but it was defending the wrong thing. The composer's
// seven controls drew at 1.5 inside a panel that drew at 1.75, so the bar was a different weight
// from everything touching it, and no screenshot of the bar alone could show that.
//
// So the merge happened deliberately (icons_integration I1, decision D1) and this suite now guards
// the merge. If somebody reintroduces a second weight, the first two checks below fail.
//
// The twenty tokens moved to `lib/icons/registry.ts` and are covered by `test:icon-registry` and
// `test:icon-manifest`, which do the job this file's first half used to: catching an upstream
// rename before it ships as a blank square.
//
//   npm run test:icons

import { GLYPH, HIT_TARGET } from "./icons.ts";
import { ICON } from "../lib/tokens.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

console.log("\nthere is one stroke weight in this app, and it is not here");
{
  // THE LADDER CARRIES SIZES AND NOTHING ELSE. A `strokeWidth` on this object is the second weight
  // coming back, which is the failure the whole icon pass exists to close.
  check("GLYPH declares no stroke width of its own",
    !("strokeWidth" in (GLYPH as Record<string, unknown>)));
  check("...and the one weight comes from ICON.strokeWidth", typeof ICON.strokeWidth === "number");
}

console.log("\nthe size ladder is unchanged — sizes are not weights");
{
  // §2.3's five contexts. These survived the merge intact, because the reasoning behind them was
  // never about stroke: a toolbar control is 20 and an action-row glyph is 16 because of what those
  // rows are for.
  check("a toolbar control is 20", GLYPH.toolbar === 20);
  check("an action row glyph is 16", GLYPH.action === 16);
  check("a metadata glyph is 14", GLYPH.meta === 14);
  check("a menu row is 18", GLYPH.menu === 18);
  check("an empty state is 32", GLYPH.empty === 32);
  // The ladder ascends. A context that reads as more subordinate than another must not be drawn
  // larger than it.
  check("meta < action < menu < toolbar < empty",
    GLYPH.meta < GLYPH.action && GLYPH.action < GLYPH.menu
    && GLYPH.menu < GLYPH.toolbar && GLYPH.toolbar < GLYPH.empty);
}

console.log("\nthe hit target does not follow the glyph down");
{
  // §2.3: "Hit target is always >= 32x32 regardless of glyph size." The metadata row's glyphs are
  // 14px and its controls are still 32px boxes — which is the whole reason this is a separate
  // number rather than a padding somebody remembers to add.
  check("32px minimum", HIT_TARGET >= 32);
  check("...larger than the largest control glyph", HIT_TARGET > GLYPH.toolbar);
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
