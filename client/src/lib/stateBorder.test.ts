// I7 and I8: the border changes colour and never width, and it never travels alone.
//
// THE LADDER IS AN ORDERING, AND AN ORDERING IS THE ONE THING A PALETTE CHECK CANNOT SEE. Five
// colours all present and all correct is compatible with `selected` outranking `archived`, which is
// the arrangement where an archived agent that was failing when it was archived comes back shouting.
// So the rungs are named and the suite asserts the ORDER, case by case, with every pair of facts
// that can be true at once actually set to true.
//
// I7 IS ASSERTED AS AN ABSENCE OF WIDTH. This module returns a colour and nothing else, which makes
// the invariant true by construction — so what is worth checking is that no CALL SITE reintroduces
// it: a `border-2` conditioned on a state is a card whose contents reflow by a pixel every time a
// run starts, forty times a minute on a busy workspace, and the symptom is a twitch nobody can
// photograph.
//
// I8 IS ASSERTED AS A COMPANION. A card whose only "this failed" signal is a rose edge is
// unreadable to about one man in twelve and invisible in a greyscale screenshot, so every surface
// that takes a border from here is checked for a glyph or a tag beside it.
//
//   npm run test:state-border

import { check, done, read } from "./icons/harness.ts";
import { rowEdge, stateBorder, stateRung, type CardState } from "./stateBorder.ts";
import { STATUS, SURFACE } from "./tokens.ts";

// --- 1. the ladder, as an ordering --------------------------------------------------------------

console.log("\nthe ladder resolves in one order, everywhere");
{
  const rung = (s: CardState): string => stateRung(s);

  check("nothing set is the default", rung({}) === "default", rung({}));
  check("running alone is running", rung({ running: true }) === "running");
  check("failed alone is failed", rung({ failed: true }) === "failed");
  check("selected alone is selected", rung({ selected: true }) === "selected");
  check("archived alone is archived", rung({ archived: true }) === "archived");

  // RUNG 4 UNDER RUNG 3. A run that failed is not still running, but a card can carry both flags for
  // a frame while a broadcast lands, and the answer must not depend on which arrives first.
  check("failed outranks running", rung({ failed: true, running: true }) === "failed");
  // RUNG 3 UNDER RUNG 2 — §9: the user's own focus outranks the card's state, because they are
  // looking at it right now.
  check("selected outranks failed", rung({ selected: true, failed: true }) === "selected");
  check("selected outranks running", rung({ selected: true, running: true }) === "selected");
  // RUNG 2 UNDER RUNG 1, and this is §13's own walk: "an archived agent that was failing when it was
  // archived. Ladder says quiet."
  check("archiving outranks selection", rung({ archived: true, selected: true }) === "archived");
  check("archiving outranks failure", rung({ archived: true, failed: true }) === "archived");
  check("...and everything at once is still quiet",
    rung({ archived: true, selected: true, failed: true, running: true }) === "archived");
}

// --- 2. the colours, and how few of them there are ----------------------------------------------

console.log("\ntwo colours and three neutrals");
{
  check("running is the one amber", stateBorder({ running: true }) === STATUS.pending);
  check("failed is the rose", stateBorder({ failed: true }) === STATUS.error);
  // EXACTLY ONE AMBER, which is I1 read from this module's end: a second state border in amber
  // would be a second meaning for the colour, one card away from the first.
  const AMBER = [{}, { archived: true }, { selected: true }, { failed: true }, { running: true }]
    .filter((s) => stateBorder(s) === STATUS.pending);
  check("exactly one rung is amber", AMBER.length === 1, JSON.stringify(AMBER));
  const ROSE = [{}, { archived: true }, { selected: true }, { failed: true }, { running: true }]
    .filter((s) => stateBorder(s) === STATUS.error);
  check("exactly one rung is rose", ROSE.length === 1, JSON.stringify(ROSE));

  // AND `archived` IS QUIETER THAN THE DEFAULT, not equal to it. "The same as every other card" is
  // unremarkable, which is a different claim from quiet.
  check("archived recedes below the default",
    stateBorder({ archived: true }) === SURFACE.hair && String(SURFACE.hair) !== String(SURFACE.edge),
    `${stateBorder({ archived: true })} vs ${SURFACE.edge}`);
  check("selected is the strongest neutral", stateBorder({ selected: true }) === SURFACE.grip);
  check("the default is the card border", stateBorder({}) === SURFACE.edge);
  // NO GREEN ANYWHERE. A card that finished cleanly is not an achievement to be outlined.
  check("nothing is the ok green",
    ![{}, { archived: true }, { selected: true }, { failed: true }, { running: true }]
      .some((s) => stateBorder(s) === STATUS.ok));
}

// --- 3. a row is not a card ---------------------------------------------------------------------

console.log("\na row draws an edge, and only when it has something to say");
{
  // NOTHING FOR ORDINARY, which is the rule this app draws structure by: a transparent 2px edge on
  // every row is a 2px indent on every row, and nothing is spent on saying "ordinary".
  check("an ordinary row draws nothing", rowEdge({}) === null);
  // AND NOTHING FOR ARCHIVED EITHER. Quiet on a card means the faintest hairline it already has;
  // quiet on a row means no mark at all, because there is no border there to quieten.
  check("an archived row draws nothing", rowEdge({ archived: true }) === null);
  check("a running row is amber", rowEdge({ running: true }) === STATUS.pending);
  check("a failed row is rose", rowEdge({ failed: true }) === STATUS.error);
  check("a selected row is the strong neutral", rowEdge({ selected: true }) === SURFACE.grip);
  // THE SAME LADDER. A row and a card resolving two orders would be the exact drift this module
  // exists to end.
  check("a row obeys the same order", rowEdge({ archived: true, running: true }) === null);
  check("...at every rung", rowEdge({ selected: true, failed: true }) === SURFACE.grip);
}

// --- 4. I7, at the call sites --------------------------------------------------------------------

console.log("\nno call site changes a width");
{
  const SITES = [
    "components/AgentCard.tsx",
    "components/ThreadRow.tsx",
    "components/DeployPanel.tsx",
  ];
  for (const path of SITES) {
    const text = read(`src/${path}`);
    check(`${path} takes its colour from the ladder`,
      /from "[^"]*stateBorder/.test(text), path);
    // A CONDITIONAL WIDTH IS THE TWITCH. `border-2` inside a template literal beside a state is the
    // shape it arrives in; the width classes this app uses are `border` and `border-0` and nothing
    // between them.
    const widths = text.split("\n").filter((l) => /\bborder-[2348]\b/.test(l) && !/^\s*(\/\/|\*)/.test(l));
    check(`...and never a second width`, widths.length === 0, widths.join(" | ").slice(0, 200));
  }
  // AND NEITHER DOES THE MODULE. It returns a colour; there is nothing here that could set a width
  // even if somebody wanted one.
  const source = read("src/lib/stateBorder.ts");
  check("the module offers no width at all",
    !/width|border-[0-9]/.test(source.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n")));
  // NOR A FILL. §6.1: a tinted card background would be the first fill in a product that draws
  // structure in hairlines, and it would flatten the card / section / well nesting the whole layout
  // is built on.
  check("...and no background either",
    !/background|bg-/.test(source.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n")));
}

// --- 5. I8, at the call sites ---------------------------------------------------------------------

console.log("\nno border travels alone");
{
  // EVERY SURFACE THAT TAKES A BORDER ALSO SAYS IT IN A SHAPE OR A WORD. The agent card carries the
  // phase glyph in its title row and the tag row under it; the thread row carries the glyph two
  // pixels to the right of the edge; the deploy rail's rows are `ActionRow`s, whose whole content is
  // a verb.
  const COMPANION: [string, string][] = [
    ["components/AgentCard.tsx", "StatusGlyph"],
    ["components/ThreadRow.tsx", "ThreadGlyph"],
    ["components/DeployPanel.tsx", "ActionRow"],
  ];
  for (const [path, companion] of COMPANION) {
    check(`${path} says it in a shape or a word too`, read(`src/${path}`).includes(companion), companion);
  }

  // AND THE INBOX IS UNTOUCHED — §6.2 says its rose left edge on blocking is already shipped, that no
  // full border is to be added and that no amber is to be added at all. The card has severity in its
  // SIZE and the rose edge; a second treatment would be a third signal for one fact.
  const inbox = read("src/components/InboxCard.tsx");
  check("the Inbox card takes no state border", !/from "[^"]*stateBorder/.test(inbox));
  check("...and gains no amber", !/bg-run|border-run/.test(inbox), inbox.match(/bg-run|border-run/g)?.join(", "));
}

done();
