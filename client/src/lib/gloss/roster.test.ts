// §8's `test:gloss-roster`: every entry has all five axes and a unique id, the array is explicitly
// sorted, every entry is humanoid, and no entry uses an excluded palette.
//
// THE SORT IS THE MAPPING, WHICH IS WHY IT IS RE-DERIVED HERE RATHER THAN TRUSTED. Migration 068's
// backfill hashes an agent's uuid into this array by INDEX, so a reordering moves every backfilled
// agent to a different face with nothing in the diff to say so. `EMOJI_PALETTE` is asserted the same
// way one package over, and for the same reason: an order somebody typed is an order somebody can
// retype.
//
// AND THE AMBER RULE IS APPLIED TWICE, AT TWO GRAINS. The palette list is a coarse filter over five
// colours; what actually reaches the card is ONE of them, chosen by `colorIx`, which is dealt from
// the seed. Four of the surviving palettes carry one amber-range colour each, so a passing palette
// and an unlucky seed is a permanently-orange agent in a grid where amber means running. This suite
// builds each entry's parameters through the vendored `ensureGParams` — the same function the
// renderer calls — and asks the question of the colour the character is actually poured in.
//
// IT RUNS AGAINST AN EMPTY ROSTER AND MOST OF IT IS VACUOUS. That is the point of landing the
// contract before the content: the assertions exist before the twenty-four literals do, so the
// curation commit cannot quietly invent a different shape.
//
//   npm run test:gloss-roster

import { readFileSync, readdirSync } from "node:fs";

import { ensureGParams } from "./grig.js";
import { PALETTES } from "./gpalette.js";
import { MATERIAL_IDS } from "./gmedia.js";
import { GSPECIES_IDS } from "./gspecies.js";
import {
  EXCLUDED_PALETTES, GLOSS_BODIES, GLOSS_PALETTES, GLOSS_SPECIES, GLOSS_STANCES,
  isAmberish, toGlossRecipe,
} from "./recipe.ts";
import { GLOSS_ROSTER, ROSTER_BY_ID, avatarIdFor } from "./roster.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

// --- 1. the vocabularies agree with the runtime they name -------------------------------------

console.log("\nthe axes name things the vendored runtime has");
{
  // THE DRIFT CHECK, and it is here because `recipe.ts` retypes upstream's vocabularies as unions.
  // A union is what makes a roster entry checkable at all, and it is also a SECOND COPY of a list
  // that lives in somebody else's file — so the copy is held to the original, exactly as
  // `test:agent-emoji` holds the client's emoji palette to the server's.
  check("the species exists upstream", GSPECIES_IDS.includes(GLOSS_SPECIES), GLOSS_SPECIES);

  const paletteIds = new Set(PALETTES.map((p) => p.id));
  const unknownPalettes = [...GLOSS_PALETTES, ...EXCLUDED_PALETTES].filter((id) => !paletteIds.has(id));
  check("every palette named — allowed or excluded — exists upstream", unknownPalettes.length === 0,
    unknownPalettes.join(", "));

  // AND THE TWO HALVES COVER THE WHOLE LIST. A palette added upstream that is in neither set would
  // be silently unavailable rather than deliberately excluded, which is the difference between a
  // decision and an oversight.
  const accounted = new Set([...GLOSS_PALETTES, ...EXCLUDED_PALETTES]);
  const unaccounted = [...paletteIds].filter((id) => !accounted.has(id));
  check("every upstream palette is either allowed or excluded", unaccounted.length === 0,
    unaccounted.join(", "));

  check("the allowed palettes are sorted",
    JSON.stringify([...GLOSS_PALETTES].sort()) === JSON.stringify([...GLOSS_PALETTES]));

  // THE EXCLUSIONS ARE MEASURED, NOT ASSERTED. Each of the three is out because two or more of its
  // five colours sit in the band around this product's amber, and re-deriving that here is what
  // stops the list becoming folklore: if somebody re-values a palette upstream, this says so.
  for (const id of EXCLUDED_PALETTES) {
    const hot = PALETTES.find((p) => p.id === id)!.colors.filter(isAmberish).length;
    check(`${id} is excluded because ${hot} of its five colours read amber`, hot >= 2, `${hot}`);
  }
  // ...and the converse, which is the half that would actually have caught a mistake: `skin` is the
  // humanoid's own palette, sits at hue 25, and a hue-only rule would have thrown it out.
  const skinHot = PALETTES.find((p) => p.id === "skin")!.colors.filter(isAmberish).length;
  check("skin is not caught by the amber rule", skinHot === 0, `${skinHot}`);
}

// --- 2. the roster's shape ---------------------------------------------------------------------

console.log("\nevery entry is a complete, humanoid recipe");
{
  const materials = new Set(MATERIAL_IDS);
  const allowed = new Set(GLOSS_PALETTES);
  const bad: string[] = [];
  for (const r of GLOSS_ROSTER) {
    if (typeof r.id !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(r.id)) bad.push(`${r.id}: id`);
    if (typeof r.label !== "string" || r.label.length === 0) bad.push(`${r.id}: label`);
    if (!Number.isInteger(r.seed)) bad.push(`${r.id}: seed`);
    if (r.species !== GLOSS_SPECIES) bad.push(`${r.id}: species ${r.species}`);
    if (!(GLOSS_BODIES as readonly string[]).includes(r.body)) bad.push(`${r.id}: body ${r.body}`);
    if (!(GLOSS_STANCES as readonly string[]).includes(r.stance)) bad.push(`${r.id}: stance ${r.stance}`);
    if (!allowed.has(r.palette)) bad.push(`${r.id}: palette ${r.palette}`);
    if (!materials.has(r.material)) bad.push(`${r.id}: material ${r.material}`);
  }
  check("every entry has all five axes, a seed, an id and a label", bad.length === 0, bad.join("; "));

  const ids = GLOSS_ROSTER.map((r) => r.id);
  check("ids are unique", new Set(ids).size === ids.length);
  check("the array is sorted by id",
    JSON.stringify([...ids].sort()) === JSON.stringify(ids), ids.join(", "));
  check("the by-id map covers the array", ROSTER_BY_ID.size === GLOSS_ROSTER.length);
}

// --- 3. no agent comes out permanently orange --------------------------------------------------

console.log("\nnothing in the roster reads as running");
{
  // THE COLOUR THE CHARACTER IS ACTUALLY POURED IN, resolved through the runtime's own
  // `ensureGParams` rather than reimplemented. `colorIx` is dealt from the seed, so this is the one
  // question a static list of palettes cannot answer, and it is the question §3.3 is really asking.
  const orange: string[] = [];
  for (const r of GLOSS_ROSTER) {
    const filled = ensureGParams(toGlossRecipe(r));
    const palette = PALETTES.find((p) => p.id === filled.palette)!;
    const body = palette.colors[filled.colorIx! % palette.colors.length]!;
    if (isAmberish(body)) orange.push(`${r.id} → ${body}`);
  }
  check("no entry's resolved body colour reads amber", orange.length === 0, orange.join(", "));
}

// --- 4. nothing generates a recipe at runtime --------------------------------------------------

console.log("\nI2: the roster is data, never a render");
{
  // `newGRecipe` ROLLS A SEED FROM `Math.random()`. A call site in shipped code is an avatar that
  // is different every time the page loads, which is the exact opposite of an identity — and it is
  // the sort of line that gets added in good faith as a fallback for a missing roster entry.
  //
  // The scan is over `src`, MINUS this file and the vendored `.js` — the runtime defines the
  // function and the declaration types it, and neither is a call site. A suite that excluded itself
  // by name would go stale; matching on the call shape `newGRecipe(` and skipping the two places it
  // is legitimately spelled is what keeps this honest.
  const source = readFileSync("src/lib/gloss/roster.ts", "utf8");
  check("roster.ts does not call newGRecipe", !source.includes("newGRecipe("));

  const files = readdirRecursive("src").filter(
    (f) => /\.(ts|tsx)$/.test(f) && !f.endsWith("roster.test.ts") && !f.endsWith(".d.ts"),
  );
  const callers = files.filter((f) => /\bnewGRecipe\s*\(/.test(readFileSync(f, "utf8")));
  check("nothing under client/src calls newGRecipe", callers.length === 0, callers.join(", "));
}

// --- 5. the default assignment ------------------------------------------------------------------

console.log("\nthe hash lands somewhere, and lands there every time");
{
  const uuid = "9f2b1c44-6d21-4f8a-b3e7-0a51d9c78e10";
  const first = avatarIdFor(uuid);
  check("it is deterministic", first === avatarIdFor(uuid), `${first} vs ${avatarIdFor(uuid)}`);
  // AN EMPTY ROSTER ANSWERS NULL RATHER THAN THROWING, which is what makes this commit a working
  // state of the product: the contract ships before the content and nothing that calls it breaks.
  if (GLOSS_ROSTER.length === 0) check("an empty roster answers null", first === null, `${first}`);
  else check("it lands on a real entry", ROSTER_BY_ID.has(first!), `${first}`);
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);

/** Every file under a directory, as a path this process can open. `node:fs` is the whole shim. */
function readdirRecursive(dir: string): string[] {
  return readdirSync(dir, { recursive: true }).map((name) => `${dir}/${name}`);
}
