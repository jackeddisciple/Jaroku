// §8.4: bare emoji, no container, at all seven sites — and never in the tag row.
//
// THE NO-CONTAINER RULE IS THE ONE THIS SUITE EXISTS FOR, because a box is the most natural thing in
// the world to add. A circle, a rounded square, a tinted cell, a gradient backdrop — every one of
// them looks tidier in isolation and every one of them would be the first filled container in a
// product that draws structure in hairlines. At 16px the container is larger and louder than the
// thing inside it, which is the specific way "tidier" becomes worse.
//
// AND IT IS NEVER A TAG. This app has a real tag row with a precedence ladder — Attention > Runtime
// > Deploy > Health > Lifecycle — that trims to three plus a `+n` chip. An identity mark in that
// row would be trimmed away exactly when the card is busiest, which is when you most need to know
// which agent you are looking at. So the emoji sits with the name, and `test:agent-tags` and this
// suite between them make that a property rather than a habit.
//
// EVERY SITE IS `aria-hidden`. The agent's name is beside it — a screen reader announcing "tractor"
// before every agent name is noise, not information. The picker is the one place the character IS
// the content, and it is the one place with a name.
//
//   npm run test:emoji-render

import { createElement } from "react";

import { markup } from "../lib/testRender.ts";
import { check, done, read, sourceFiles } from "../lib/icons/harness.ts";
import { EMOJI_PALETTE } from "../lib/emojiPalette.ts";
import { AgentEmoji, EMOJI_SIZE } from "./AgentEmoji.tsx";
import { EmojiPicker } from "./EmojiPicker.tsx";

const drawn = markup(createElement(AgentEmoji, { emoji: "🐢", size: EMOJI_SIZE.sidebar }));

// --- 1. bare ------------------------------------------------------------------------------------

console.log("\nno circle, no box, no tint, no backdrop, no border");
{
  check("it draws the mark", drawn.includes("🐢"), drawn);
  // ONE ELEMENT, AND IT IS A SPAN. A nested wrapper is where a background arrives.
  check("it is one span", /^<span [^>]*>🐢<\/span>$/.test(drawn), drawn);
  check("no background", !/background|bg-/.test(drawn), drawn);
  check("no border", !/border|rounded/.test(drawn), drawn);
  // NO WIDTH AND NO HEIGHT — a box. `line-height` is not one: it pins the LINE the glyph sits on,
  // which is what stops a tall emoji growing its row, and it gives the mark no dimensions of its own.
  check("no fixed box", !/(^|[^-])\b(width|height)\s*:/.test(drawn), drawn);
  check("no class at all", !/class=/.test(drawn), drawn);
  // SIZED BY FONT-SIZE, which is what lets it sit on the text baseline with the name and take
  // normal inline spacing rather than a fixed-width gutter.
  check("sized with font-size", /font-size:16px/.test(drawn), drawn);
  // AND `line-height: 1`, for §13's walk: an unusually tall glyph must not push its row taller than
  // its neighbours, and a default line box is exactly how that happens.
  check("its line box is pinned", /line-height:1/.test(drawn), drawn);
  check("it is decorative", drawn.includes('aria-hidden="true"'), drawn);

  // NULL RENDERS NOTHING — not a placeholder, which would be a mark identical on every agent and
  // therefore the failure this whole feature exists to fix.
  check("no mark renders nothing", markup(createElement(AgentEmoji, { emoji: null })) === "");
  check("...and so does an empty one", markup(createElement(AgentEmoji, { emoji: "" })) === "");
}

// --- 2. the seven sites --------------------------------------------------------------------------

console.log("\nthe seven sites §8.4 names");
{
  // WRITTEN OUT, WITH THE REGISTER EACH ONE USES. A site that quietly went back to no mark leaves no
  // trace but a screenshot, and a site that wrote its own pixel count is off the ladder.
  const SITES: [string, string][] = [
    // THE SIDEBAR'S MARK MOVED INTO `AgentIdentityLine`, which is now the whole of §7's row: the
    // emoji, the name that never truncates, and the category that does. The mark did not change
    // register — it is still `EMOJI_SIZE.sidebar`, still bare, still 16px — it is drawn one
    // component down, beside the two rules it shares a line with.
    ["components/AgentIdentityLine.tsx", "AgentEmoji"],     // 16 — the reason this exists
    // THE TWO 3D SURFACES REACH THE MARK THROUGH `GlossAvatar`, which is where §5.2's split lands:
    // small sizes wear the emoji directly, and the card and the detail header wear the character
    // with the emoji inside it — as the placeholder while it builds, and for ever on a machine with
    // no WebGL. "Not two systems, one identity at two fidelities." A surface drawing BOTH would be
    // exactly the "blue one here, tractor there" D6 warned about, on one card, at once — which is
    // what the detail header did until the gradient band was retired.
    ["components/AgentCard.tsx", "GlossAvatar"],            // the grid card, at avatar size
    ["components/AgentOverview.tsx", "GlossAvatar"],        // the detail header, at avatar size
    ["components/GlossAvatar.tsx", "AgentEmoji"],           // and the one component that draws it
    ["components/ThreadRow.tsx", "AgentEmoji"],             // 14 — the row default
    ["components/FleetStrip.tsx", "AgentEmoji"],            // 14
    ["components/WorkList.tsx", "AgentEmoji"],              // 14
    ["components/CommandPalette.tsx", "AgentEmoji"],        // 14
  ];
  // THE MARK REACHES A SURFACE ONE OF TWO WAYS, and both count. Six sites mount `<AgentEmoji`
  // directly at a named register; the two that draw 3D mount `<GlossAvatar`, which holds the emoji
  // inside it as the placeholder and as the no-WebGL fallback. Requiring `<AgentEmoji` in all eight
  // would have failed the card and the detail for doing exactly what §5.2 asks of them.
  for (const [path, needle] of SITES) {
    const text = read(`src/${path}`);
    check(`${path} draws the mark`, text.includes(`<${needle}`), needle);
  }
  // AND THE FOUR REGISTERS ARE STILL NAMED, which is the half the needle above stopped covering
  // when two sites moved behind `GlossAvatar`. A size written against the card it looked right on
  // is a size nothing can move.
  check("the sidebar's register is named",
    read("src/components/AgentIdentityLine.tsx").includes("EMOJI_SIZE.sidebar"));
  check("the avatar box sizes its placeholder off its own box, not a literal",
    read("src/components/GlossAvatar.tsx").includes("Math.round(size *"));
  check("the picker is the eighth site", read("src/components/AgentOverview.tsx").includes("<EmojiPicker"));

  // NO CALL SITE WRITES A PIXEL COUNT. The four registers are named for the same reason the icon
  // ladder's are: a size written against the card it looked right on is a size nothing can move.
  const raw: string[] = [];
  for (const [path] of SITES) {
    read(`src/${path}`).split("\n").forEach((line, i) => {
      if (/<AgentEmoji/.test(line) && /size=\{\d/.test(line)) raw.push(`${path}:${i + 1}`);
    });
  }
  check("nothing writes its own size", raw.length === 0, raw.join(", "));
}

// --- 3. never in the tag row ----------------------------------------------------------------------

console.log("\nit is identity, so it never enters the tag row");
{
  // TWO DIRECTIONS. The tag row must not draw it, and the tag builder must not know about it — a
  // mark that reached `agentTags.ts` would be subject to a precedence ladder that trims to three,
  // which would hide it exactly when the card is busiest.
  check("the tag row draws no mark", !read("src/components/AgentTagRow.tsx").includes("AgentEmoji"));
  check("the tag builder has never heard of it", !read("src/lib/agentTags.ts").includes("emoji"));

  // AND ON THE CARD THE IDENTITY SITS ABOVE THE TAG ROW rather than in it. Read positionally,
  // because "not in the tag row" is a claim about ORDER that no import check can see. What is read
  // for is `<GlossAvatar` now: the card's identity is the character, and the emoji is inside it as
  // the placeholder — the same claim about the same pixels, one component down.
  const card = read("src/components/AgentCard.tsx");
  check("on the card the identity comes before the tag row",
    card.indexOf("<GlossAvatar") < card.indexOf("<AgentTagRow"), `${card.indexOf("<GlossAvatar")}`);
}

// --- 4. the picker ---------------------------------------------------------------------------------

console.log("\nthe picker offers the whole palette and warns rather than blocks");
{
  const picker = markup(
    createElement(EmojiPicker, {
      current: EMOJI_PALETTE[0]!,
      takenBy: new Map([[EMOJI_PALETTE[1]!, "billing bot"]]),
      onChoose: () => {},
    }),
  );
  check("every mark is offered", EMOJI_PALETTE.every((e) => picker.includes(e)),
    EMOJI_PALETTE.filter((e) => !picker.includes(e)).join(""));
  check("it is a radiogroup", picker.includes('role="radiogroup"'));
  check("exactly one is chosen", (picker.match(/aria-checked="true"/g) ?? []).length === 1);
  check("the choice is held down", picker.includes("bg-active"));

  // §8.5: ALLOWED BUT WARNED. A taken mark is still pressable — it is their workspace, and a hard
  // block on a cosmetic choice feels worse than a duplicate — and the warning names the agent it
  // collides with, because "already taken" without saying by what is a warning nobody can act on.
  // SCOPED TO THE CELLS. The shuffle beside them is an `IconButton`, whose class list carries
  // `disabled:opacity-40` for every one in the product — a whole-markup scan would read that as a
  // disabled cell for ever.
  const cells = [...picker.matchAll(/<button\b[^>]*role="radio"[^>]*>/g)].map((m) => m[0]!);
  check("a taken mark is not disabled",
    cells.length === EMOJI_PALETTE.length && cells.every((c) => !/\bdisabled\b/.test(c)),
    `${cells.length} cells`);
  check("...and it says who has it", picker.includes("billing bot"), picker.slice(0, 400));

  // THE CELLS ARE 32×32, because a picker is a control and a 32px glyph with nothing to press is a
  // picker nobody can use. The MARK inside is still bare — the button is the container, not the box
  // §8.4 forbids.
  check("the cells are real hit targets", /min-width:32px/.test(picker) && /min-height:32px/.test(picker));
  check("the marks inside are still bare",
    (picker.match(/font-size:\d+px;line-height:1/g) ?? []).length >= EMOJI_PALETTE.length, picker.slice(0, 200));

  // AND THE SHUFFLE RE-RUNS THE ASSIGNMENT rather than picking at random — the same function the
  // server uses at creation, so the picker cannot propose a mark the server would not have chosen.
  const source = read("src/components/EmojiPicker.tsx");
  // THE SHUFFLE IS NOT THE CREATION ASSIGNMENT, and that is the fix for a control that did nothing.
  // `assignEmoji` hashes the uuid, so on an agent still wearing its hashed mark it answers with the
  // mark already on screen — which is every agent until somebody changes one.
  check("the shuffle walks from the current mark", source.includes("shuffleEmoji(current"));
  check("...and not from the creation assignment", !source.includes("assignEmoji("));
  check("...and nothing here reaches for Math.random", !source.includes("Math.random"));
}

// --- 5. one component, everywhere -------------------------------------------------------------------

console.log("\nnothing renders an agent's mark by hand");
{
  // A BARE `{agent.emoji}` IN JSX is what this rule fails as: it renders correctly, it is one
  // character shorter, and it carries no `aria-hidden` and no line-height pin.
  const rogue: string[] = [];
  for (const file of sourceFiles()) {
    if (file.endsWith(".test.ts") || file.includes("AgentEmoji") || file.includes("EmojiPicker")) continue;
    read(file).split("\n").forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      // A JSX TEXT CHILD, not a prop. `emoji={agent.emoji}` is the correct way to hand the mark to
      // the one component; `>{agent.emoji}<` is the shortcut this rule exists to catch.
      if (/(?<![=\w])\{\s*\w+\.emoji\s*\}/.test(line)) rogue.push(`${file}:${i + 1}`);
    });
  }
  check("every mark goes through the one component", rogue.length === 0, rogue.join(", "));
}

done();
