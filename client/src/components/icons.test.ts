// The icon registry, and the one failure it exists to catch.
//
// §2.1's rule is "every icon is referenced by this registry, never imported ad hoc in a component
// — one place to swap a glyph, one place to fix a name." The reason that rule is worth a suite is
// in §2: Hugeicons numbers some glyph families and the numbers move between releases. A renamed
// export does not throw on import — it arrives as `undefined`, `HugeiconsIcon` renders an empty
// `<svg>`, and the control bar loses a button silently. Nothing about that shows up in a
// typecheck, because the package's types allow it.
//
// So this suite asserts the shape of every entry rather than that the file parses. An upgrade that
// renames `AiBrain02Icon` fails here, by name, instead of shipping a composer with a blank square
// where reasoning effort used to be.
//
//   npm run test:icons

import { GLYPH, HIT_TARGET, Icon, type IconToken } from "./icons.ts";
import { ICON } from "../lib/tokens.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const TOKENS = Object.keys(Icon) as IconToken[];

console.log("\nevery token in §2.1's table resolves to a real glyph");
{
  // The twenty the spec names, spelled here rather than derived from `Icon` — a table that checked
  // itself would pass just as happily with a token deleted.
  const REQUIRED: IconToken[] = [
    "Add", "Fullscreen", "Effort", "Shield", "Connect", "Mic", "Send",
    "AttachFile", "AttachRun", "AttachDataset", "AttachTool", "Github",
    "Copy", "Note", "Pin", "Regenerate", "ThumbUp", "ThumbDown",
    "Build", "Duration",
  ];
  check("twenty tokens, matching the spec's table", REQUIRED.length === 20);
  for (const token of REQUIRED) {
    check(`Icon.${token} is registered`, token in Icon);
  }
  check("and the registry holds nothing else", TOKENS.length === REQUIRED.length, TOKENS.join(", "));
}

console.log("\n...and a resolved glyph is path data, not undefined");
{
  // THE ACTUAL FAILURE MODE. `import { Renamed01Icon }` from an ESM package yields `undefined`
  // rather than an error, so "the import worked" proves nothing. An `IconSvgElement` is an array
  // of `[tag, attrs]` tuples and an empty one draws nothing, so both are checked.
  for (const token of TOKENS) {
    const glyph = Icon[token] as unknown;
    const ok = Array.isArray(glyph) && glyph.length > 0
      && glyph.every((part) => Array.isArray(part) && typeof part[0] === "string" && !!part[1]);
    check(`Icon.${token} carries drawable path data`, ok, glyph === undefined ? "undefined — renamed upstream?" : "");
  }
}

console.log("\nno two jobs share a glyph");
{
  // Not a purity rule — a genuine legibility one. The control bar puts seven of these in a row and
  // the action row five more, and two controls wearing the same mark is a bar somebody has to read
  // the tooltips of every time.
  const seen = new Map<string, IconToken>();
  for (const token of TOKENS) {
    const key = JSON.stringify(Icon[token]);
    const prior = seen.get(key);
    check(`Icon.${token} is its own shape`, prior === undefined, prior ? `same glyph as Icon.${prior}` : "");
    if (prior === undefined) seen.set(key, token);
  }
}

console.log("\nthe size ladder is Hugeicons', not the Lucide one beside it");
{
  // §2.3's four contexts, and the reason they are their own table: these glyphs are drawn at
  // stroke 1.5 on Hugeicons' grid, while `ICON` describes Lucide at 1.75. Collapsing the two would
  // render one family at a size chosen for the other everywhere in the app.
  check("a toolbar control is 20", GLYPH.toolbar === 20);
  check("an action row glyph is 16", GLYPH.action === 16);
  check("a metadata glyph is 14", GLYPH.meta === 14);
  check("a menu row is 18", GLYPH.menu === 18);
  check("an empty state is 32", GLYPH.empty === 32);
  check("stroke is 1.5 throughout", GLYPH.strokeWidth === 1.5);
  check("...which is NOT the Lucide ladder's weight", GLYPH.strokeWidth !== ICON.strokeWidth);
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
