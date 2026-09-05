// I1: one stroke weight, and it comes from the token.
//
// THE PROPERTY IS AN ABSENCE, which is the hardest kind to see by looking. A mark carrying its own
// `stroke-width` renders correctly, screenshots correctly, and is wrong only in the sense that it
// will not MOVE when `ICON.strokeWidth` moves — so the failure surfaces the day somebody changes
// the token and one glyph in a rail of ten stays where it was. The package ships 1.5 on most marks
// and 2 on `GameController03Icon`, which is the sidebar rail's Cockpit destination, so this was a
// real mixed-weight rail before the generator stripped it.
//
// The other half is that the token is genuinely reachable: every generated mark draws through
// `panelIcons.tsx`'s one factory, and that factory defaults its stroke to `ICON.strokeWidth`.
//
//   npm run test:icon-stroke

import { readdirSync } from "node:fs";

import { check, done, read } from "./harness.ts";
import { ICON } from "../tokens.ts";

const DIR = "src/lib/icons/generated";
const files = readdirSync(DIR).filter((f) => f.endsWith(".tsx")).sort();
const sources = new Map<string, string>(files.map((f) => [f, read(`${DIR}/${f}`)]));

console.log("\nall 117 marks are present");
check("117 generated components", files.length === 117, `${files.length}`);

console.log("\nno mark carries its own weight");
{
  // BOTH SPELLINGS. The package's payload uses `strokeWidth`; a hand-edit would plausibly reach for
  // the SVG attribute `stroke-width`. Neither may appear in a generated file.
  let carrying = 0;
  for (const [file, text] of sources) {
    if (/strokeWidth=|stroke-width=/.test(text)) {
      carrying++;
      console.log(`  FAIL ${file} carries a stroke width`);
    }
  }
  check("no generated file writes a stroke width", carrying === 0, `${carrying} file(s)`);
}

console.log("\n...because every one of them draws through the one factory");
{
  let wrong = 0;
  for (const [file, text] of sources) {
    const drawsThroughFactory =
      text.includes('import { svg, type IconProps } from "../../../components/panelIcons.tsx";')
      && /return svg\(\s*p,/.test(text);
    if (!drawsThroughFactory) { wrong++; console.log(`  FAIL ${file} does not draw through svg()`); }
  }
  check("every mark delegates to panelIcons' svg()", wrong === 0, `${wrong} file(s)`);
  // AND NO SECOND SVG ELEMENT. A generated file that opened its own would have to set its own
  // attributes, which is the whole failure this invariant is about. The check reads the component
  // BODY — every file's header comment names the element in prose, and prose is not markup.
  const body = (text: string): string => text.slice(text.indexOf("export function"));
  check("no generated file opens its own svg element",
    [...sources.values()].every((t) => !body(t).includes("<svg")));
}

console.log("\n...and that factory sources the token");
{
  const factory = read("src/components/panelIcons.tsx");
  check("svg() defaults strokeWidth to ICON.strokeWidth",
    /strokeWidth = ICON\.strokeWidth/.test(factory));
  check("...and puts it on the <svg> element", /strokeWidth=\{strokeWidth\}/.test(factory));
  check("the token is a single number, so there is exactly one weight",
    typeof ICON.strokeWidth === "number");
}

console.log("\nthe stroke colour is inherited too, except where a mark is genuinely filled");
{
  // The four fill-only elements in the set — a solid dot on `ClipboardListIcon`, two on
  // `CloudSyncIcon`, one on `SquareArrowOutUpRightIcon` — carry `stroke="none"` on purpose. Without
  // it they would inherit the factory's `currentColor` and render as a filled shape wearing an
  // outline. Every OTHER element must carry no stroke at all, so the factory's decides.
  let stray = 0;
  for (const [file, text] of sources) {
    for (const m of text.matchAll(/stroke="([^"]+)"/g)) {
      if (m[1] !== "none") { stray++; console.log(`  FAIL ${file} pins stroke="${m[1]}"`); }
    }
    for (const m of text.matchAll(/fill="([^"]+)"/g)) {
      if (m[1] !== "currentColor") { stray++; console.log(`  FAIL ${file} pins fill="${m[1]}"`); }
    }
  }
  check("no mark pins a stroke colour, and a fill is always currentColor", stray === 0, `${stray}`);
  check("the filled elements do carry stroke=\"none\"",
    ["ClipboardListIcon", "CloudSyncIcon", "SquareArrowOutUpRightIcon"]
      .every((n) => sources.get(`${n}.tsx`)?.includes('stroke="none"')));
}

done();
