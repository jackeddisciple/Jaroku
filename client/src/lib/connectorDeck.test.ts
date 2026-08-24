// The connector deck's layout, which is §12.9: "1/2/3 render as tiles; 5 renders 3 tiles + +2; a
// disabled connector renders grayscale and stays in the deck."
//
// Every clause of that has a wrong answer that looks fine on the one workspace somebody tested
// with. Three connectors is the common case and the case where nothing is exercised: the counter
// never appears, the stacking order is unnoticeable at that width, and a deck that shrank when you
// disabled something is indistinguishable from one that did not.
//
//   npm run test:connector-deck

import {
  DECK, MAX_TILES, deckLayout, monogramColor, monogramLetter, tileOffset, tileZ,
  type DeckConnector,
} from "./connectorDeck.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const c = (id: string, enabled = true, warning: string | null = null): DeckConnector =>
  ({ id, label: id, logoUrl: `https://example.test/${id}.png`, enabled, warning });

const many = (n: number): DeckConnector[] =>
  Array.from({ length: n }, (_, i) => c(`connector-${i + 1}`));

console.log("\n§12.9 — one, two and three render as tiles");
{
  for (const n of [1, 2, 3]) {
    const l = deckLayout(many(n));
    check(`${n} connector${n === 1 ? "" : "s"} → ${n} tile${n === 1 ? "" : "s"}`, l.tiles.length === n, String(l.tiles.length));
    check(`...and no counter`, l.overflow === 0, String(l.overflow));
  }
}

console.log("\n...and five renders three tiles plus +2");
{
  const l = deckLayout(many(5));
  check("three tiles", l.tiles.length === MAX_TILES, String(l.tiles.length));
  check("...and +2", l.overflow === 2, String(l.overflow));
  // The tiles are the FIRST three, not an arbitrary three. A deck whose visible members changed
  // between renders would be unreadable even though the count was right.
  check("the first three, in order", l.tiles.map((t) => t.id).join(",") === "connector-1,connector-2,connector-3");

  // The boundary. Four is where the counter first appears, and an off-by-one here shows four tiles
  // — the exact case §3.2 says is unreadable at 20px.
  check("four is three tiles and +1", deckLayout(many(4)).tiles.length === 3 && deckLayout(many(4)).overflow === 1);
  check("...and twenty is still three tiles", deckLayout(many(20)).tiles.length === 3);
  check("...with the rest counted", deckLayout(many(20)).overflow === 17);
}

console.log("\n...and a disabled connector STAYS in the deck");
{
  // The clause most likely to be simplified away, and the spec pre-empts it: "its absence would be
  // more confusing than its dimming." A deck that shrank would read as the connector having been
  // removed from the WORKSPACE, which is precisely what the toggle does not do.
  const withOff = [c("slack"), c("postgres", false), c("notion")];
  const l = deckLayout(withOff);
  check("three connectors, one off → still three tiles", l.tiles.length === 3, String(l.tiles.length));
  check("...and the disabled one is still there", l.tiles.some((t) => t.id === "postgres"));
  check("...still marked disabled, so it can be drawn grayscale", l.tiles.find((t) => t.id === "postgres")?.enabled === false);
  check("...and it did not move", l.tiles.map((t) => t.id).join(",") === "slack,postgres,notion");

  // Everything off is still a full deck. A conversation that has switched all its connectors off
  // has three dimmed tiles, not an empty state — the empty state means "this workspace has none".
  const allOff = deckLayout([c("a", false), c("b", false)]);
  check("all off is still a deck, not an empty state", allOff.present && allOff.tiles.length === 2);

  // ...and the counter counts disabled ones too, because the deck is a picture of what the
  // conversation HAS and the dimming is what says which it will use.
  const mixed = deckLayout([c("a"), c("b"), c("c"), c("d", false), c("e", false)]);
  check("the counter includes disabled connectors", mixed.overflow === 2, String(mixed.overflow));
}

console.log("\nno connectors is an empty state, not an empty deck");
{
  const l = deckLayout([]);
  check("nothing is present", !l.present);
  check("...no tiles", l.tiles.length === 0);
  check("...and no counter", l.overflow === 0);
}

console.log("\nthe stack reads left to right");
{
  // §3.2: "Stack order: leftmost on top (z-index descending), so the deck reads left-to-right."
  // The naive ascending order puts the LAST tile on top, which makes the first connector the one
  // most hidden by its neighbours.
  const z = [0, 1, 2].map((i) => tileZ(i, 3));
  check("leftmost is on top", z[0]! > z[1]! && z[1]! > z[2]!, z.join(" > "));

  // The first tile never shifts; every one after it overlaps.
  check("the first tile sits at zero", tileOffset(0, false) === 0);
  check("the rest overlap by 8px", tileOffset(1, false) === DECK.overlap && DECK.overlap === -8);
  // Hover fans them out — a smaller overlap, not a larger one. Getting the sign wrong here makes
  // hovering bunch the deck tighter.
  check("hover fans them apart rather than together",
    tileOffset(1, true) > tileOffset(1, false), `${tileOffset(1, true)} vs ${tileOffset(1, false)}`);
  check("...to 4px", tileOffset(1, true) === DECK.overlapHovered && DECK.overlapHovered === -4);
  check("...and the first still does not move", tileOffset(0, true) === 0);
}

console.log("\nthe metrics are §3.2's");
{
  check("a 20px tile", DECK.tile === 20);
  check("6px radius", DECK.radius === 6);
  check("a 2px ring, so the overlap reads as separation rather than mud", DECK.ring === 2);
}

console.log("\na monogram is the same colour for the same connector, forever");
{
  // DETERMINISTIC IS THE WHOLE REQUIREMENT. A random colour flickers between renders; a colour
  // derived from the INDEX changes when another connector is added. Only the slug is stable
  // across both, and it is what a person associates with the tile.
  check("the same slug is the same colour", monogramColor("my-mcp") === monogramColor("my-mcp"));
  check("...across separate calls", monogramColor("acme-tools") === monogramColor("acme-tools"));
  check("a different slug is a different colour", monogramColor("my-mcp") !== monogramColor("your-mcp"));
  check("it is a usable CSS colour", /^hsl\(\d+ \d+% \d+%\)$/.test(monogramColor("x")), monogramColor("x"));

  // The hue varies. A hash that collapsed to one hue would satisfy "deterministic" and produce a
  // deck of identical tiles, which is the failure the colour exists to prevent.
  const hues = new Set(["a", "b", "c", "d", "e", "f", "g", "h"].map((s) => monogramColor(s)));
  check("eight slugs give several distinct colours", hues.size >= 6, `${hues.size} of 8`);

  check("the letter is the first, uppercased", monogramLetter("notion") === "N");
  check("...trimmed", monogramLetter("  slack") === "S");
  check("...and never empty", monogramLetter("") === "?" && monogramLetter("   ") === "?");
}

console.log("\na credential warning reaches the deck");
{
  // §3.2: "Health: surface expiring/broken credentials here with a warning row. This is the
  // surface where a user is thinking about connectors, so it's the right place to learn a token
  // is dying." The deck's dot is what makes them open the dropdown to find the row.
  check("no warnings, no dot", !deckLayout([c("a"), c("b")]).hasWarning);
  check("one warning sets the dot", deckLayout([c("a"), c("b", true, "expires in 3 days")]).hasWarning);
  // Including one on a connector past the third tile — a dying token must not be invisible because
  // its logo did not fit.
  const deep = deckLayout([c("a"), c("b"), c("c"), c("d", true, "broken")]);
  check("...even on a connector the deck could not draw", deep.hasWarning && deep.tiles.every((t) => t.id !== "d"));
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
