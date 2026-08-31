// A PERCENTAGE FLOOR ON A FIXED-CONTENT COLUMN, which App.tsx had already diagnosed in prose and
// then fixed the symptom of twice.
//
// The comment there names the cause exactly — "the pane minimums are PERCENTAGES … a percentage
// floor on a fixed-content column is the cause" — and the remedy applied at the time was to raise
// the shell's `min-w` to 900px and the sidebar's `minSize` from 14 to 16. Both moved the threshold.
// At 1024×768 the same failure returned in full: every agent row lost its name, seven of eight
// agents rendered as a status icon, a glyph and a date, run rows were cut mid-word, the account row
// showed a single `A`, and a horizontal scrollbar appeared inside a vertical scroll container.
//
// THE ARITHMETIC IS THE WHOLE BUG, WHICH IS WHY IT IS A MODULE. `16` is 307px at 1920 and 164px at
// 1024 — one number expressing two different requirements — and the second is invisible from the
// screen you are almost certainly developing on. The assertions below are the five viewport widths
// §24 requires, and they are the check that could not be made while the rule was a literal in JSX.
//
//   npm run test:pane-floor

import {
  COMPOSER_DEFAULT_MIN_PCT, COMPOSER_MAX_MIN_PCT, COMPOSER_MIN_PX,
  SIDEBAR_DEFAULT_MIN_PCT, SIDEBAR_MAX_PCT, SIDEBAR_MIN_PX, pixelFloorPercent,
} from "./paneFloor.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

/** The shell inside the viewport: 8px of inset either side (`p-2`) and a 1px border either side. */
const shellFor = (viewport: number): number => viewport - 16 - 2;

/** What the sidebar pane actually gets, in pixels, at a viewport width. */
const sidebarPx = (viewport: number): number => {
  const shell = shellFor(viewport);
  const pct = pixelFloorPercent(SIDEBAR_MIN_PX, shell, SIDEBAR_MAX_PCT, SIDEBAR_DEFAULT_MIN_PCT);
  // The library clamps the saved/default size up to the floor, so the floor is what a collapsed
  // sidebar settles at.
  return (Math.max(pct, 0) / 100) * shell;
};

console.log("\nthe five viewports §24 requires — the floor holds at every one");
{
  for (const viewport of [1920, 1440, 1280, 1024, 900]) {
    const px = sidebarPx(viewport);
    check(`${viewport}px → the sidebar cannot go below ${SIDEBAR_MIN_PX}px (${Math.round(px)}px)`,
      px >= SIDEBAR_MIN_PX - 1, `${Math.round(px)}px`);
  }
}

console.log("\n1024×768 — the resolution the audit reproduced the failure at");
{
  const shell = shellFor(1024);
  const pct = pixelFloorPercent(SIDEBAR_MIN_PX, shell, SIDEBAR_MAX_PCT, SIDEBAR_DEFAULT_MIN_PCT);
  // The old rule: 16% of a 1006px shell is 161px, and the column's content needs 181px inside a
  // list that was reporting 149px of room. That gap is where the names went.
  const old = (SIDEBAR_DEFAULT_MIN_PCT / 100) * shell;
  check("the old percentage floor was under the column's own content width", old < 181,
    `${Math.round(old)}px`);
  check("the pixel floor is not", (pct / 100) * shell >= SIDEBAR_MIN_PX - 1,
    `${Math.round((pct / 100) * shell)}px`);
  check("...and it is a wider share than 16%", pct > SIDEBAR_DEFAULT_MIN_PCT, `${pct.toFixed(1)}%`);
}

console.log("\na wide screen is untouched — this is a floor, not a resize");
{
  // At 1920 the conversion lands below `defaultSize={20}`, so the library keeps the default and
  // nothing about the layout changes for anybody whose window was already big enough.
  const pct = pixelFloorPercent(SIDEBAR_MIN_PX, shellFor(1920), SIDEBAR_MAX_PCT, SIDEBAR_DEFAULT_MIN_PCT);
  check("1920 resolves below the default size", pct < 20, `${pct.toFixed(1)}%`);
  const at1440 = pixelFloorPercent(SIDEBAR_MIN_PX, shellFor(1440), SIDEBAR_MAX_PCT, SIDEBAR_DEFAULT_MIN_PCT);
  check("1440 too", at1440 < 20, `${at1440.toFixed(1)}%`);
}

console.log("\nthe library's own constraint: minSize <= maxSize, always");
{
  for (const viewport of [1920, 1440, 1280, 1024, 900, 640, 320]) {
    const pct = pixelFloorPercent(SIDEBAR_MIN_PX, shellFor(viewport), SIDEBAR_MAX_PCT, SIDEBAR_DEFAULT_MIN_PCT);
    check(`${viewport}px stays under the ${SIDEBAR_MAX_PCT}% ceiling`, pct <= SIDEBAR_MAX_PCT,
      `${pct.toFixed(1)}%`);
  }
  // Below the shell's own `min-w-[900px]` the page scrolls horizontally by design, and the clamp is
  // what stops the floor inverting the two bounds on the way there.
  check("a viewport narrower than the floor itself clamps rather than inverting",
    pixelFloorPercent(SIDEBAR_MIN_PX, 200, SIDEBAR_MAX_PCT, SIDEBAR_DEFAULT_MIN_PCT) === SIDEBAR_MAX_PCT);
}

console.log("\nnothing to measure yet resolves to what the app shipped with");
{
  // The first render, a hidden pane, an observer that has not reported. Returning 0 there would
  // collapse the sidebar for a frame on every mount; returning 100 would pin it open.
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    check(`a container width of ${String(bad)} falls back to ${SIDEBAR_DEFAULT_MIN_PCT}%`,
      pixelFloorPercent(SIDEBAR_MIN_PX, bad, SIDEBAR_MAX_PCT, SIDEBAR_DEFAULT_MIN_PCT) === SIDEBAR_DEFAULT_MIN_PCT);
  }
}

console.log("\nthe floor is wider than the content that could not fit");
{
  // The measurement the audit took: 181px of content inside a 149px list, in a pane of about 200px.
  // A floor at or below 232px would reproduce the failure exactly.
  check("the pixel floor exceeds the pane the failure happened in", SIDEBAR_MIN_PX > 200);
  check("...and exceeds the column's measured content requirement", SIDEBAR_MIN_PX >= 232);
}

/**
 * What the composer's own group gets, in pixels, at a viewport width.
 *
 * The group is the shell minus the sidebar at its floor and minus the 5px divider between them —
 * which is the worst case for the composer and therefore the one worth asserting: every pixel the
 * sidebar is allowed to take is a pixel this column is not.
 */
const panesFor = (viewport: number): number => {
  const shell = shellFor(viewport);
  const sidebar = (pixelFloorPercent(SIDEBAR_MIN_PX, shell, SIDEBAR_MAX_PCT, SIDEBAR_DEFAULT_MIN_PCT) / 100) * shell;
  return shell - sidebar - 5;
};

const composerPx = (viewport: number): number => {
  const group = panesFor(viewport);
  const pct = pixelFloorPercent(COMPOSER_MIN_PX, group, COMPOSER_MAX_MIN_PCT, COMPOSER_DEFAULT_MIN_PCT);
  return (pct / 100) * group;
};

console.log("\nand the composer column, whose control bar is the same kind of fixed-width content");
{
  // THE ROW THE FLOOR EXISTS FOR: ⊕, expand, ⋯, the model chip, Chat/Test, the mic and send, at a
  // 32px hit target and an 8px gap each. `lib/composerBar.ts` promises that row never wraps and
  // that the mic and send never collapse; at 30% of this group both promises were broken at 1440,
  // with the two of them outside the composer's own box.
  for (const viewport of [1920, 1440, 1280]) {
    check(`${viewport}px → the composer cannot go below ${COMPOSER_MIN_PX}px (${Math.round(composerPx(viewport))}px)`,
      composerPx(viewport) >= COMPOSER_MIN_PX - 1, `${Math.round(composerPx(viewport))}px`);
  }
  // The old rule, at the window this was found on.
  const group = panesFor(1440);
  const old = (COMPOSER_DEFAULT_MIN_PCT / 100) * group;
  check("the old percentage floor was under the bar's own width", old < 436, `${Math.round(old)}px`);
  check("...and the pixel floor is not", COMPOSER_MIN_PX >= 436);
}

console.log("\nthe two floors are handed to one group and may never sum past it");
{
  // The right pane asks for 32% of the same group. A pair of minimums that sums past 100 has no
  // valid layout, and `react-resizable-panels` resolves that by ignoring one of them — silently.
  const RIGHT_MIN_PCT = 32;
  for (const viewport of [1920, 1440, 1280, 1024, 900, 640, 320]) {
    const pct = pixelFloorPercent(COMPOSER_MIN_PX, panesFor(viewport), COMPOSER_MAX_MIN_PCT, COMPOSER_DEFAULT_MIN_PCT);
    check(`${viewport}px leaves the right pane its own ${RIGHT_MIN_PCT}%`, pct + RIGHT_MIN_PCT <= 100,
      `${pct.toFixed(1)}%`);
  }
  check("a group narrower than the floor itself clamps rather than inverting",
    pixelFloorPercent(COMPOSER_MIN_PX, 200, COMPOSER_MAX_MIN_PCT, COMPOSER_DEFAULT_MIN_PCT) === COMPOSER_MAX_MIN_PCT);
}

console.log("\na wide screen is untouched here too");
{
  // At 1920 and 1440 the conversion lands below `defaultSize={45}`, so nothing about the shipped
  // layout moves for anybody whose window was already big enough.
  for (const viewport of [1920, 1440]) {
    const pct = pixelFloorPercent(COMPOSER_MIN_PX, panesFor(viewport), COMPOSER_MAX_MIN_PCT, COMPOSER_DEFAULT_MIN_PCT);
    check(`${viewport} resolves below the default size`, pct < 45, `${pct.toFixed(1)}%`);
  }
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
