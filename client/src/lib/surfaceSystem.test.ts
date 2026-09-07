// The visual surface system, held to UI-4.pdf.
//
// The same arrangement as `colourSystem.test.ts` and for the same reason: the specification is
// LOCKED, so nobody disagrees with the table on purpose. What happens instead is that one of the
// three places a rung lives gets edited and the other two do not — `surfaces.ts` holds the
// specification's numbers, `tailwind.config.js` carries them as classes, `index.css` publishes them
// as custom properties for the consumers a class cannot reach. A Tailwind config cannot import a
// `.ts` module without moving the whole config to TypeScript, and a stylesheet cannot import
// anything at all, so the scale genuinely is written three times. This is what makes them agree.
//
// THE SPECIFICATION'S OWN VALUES ARE SPELLED OUT BELOW rather than derived from `surfaces.ts`. A
// table compared against itself passes just as happily with a rung deleted, and every assertion
// here would then be checking that the code agrees with the code.
//
// THE OTHER HALF IS THE ONE A NEW SCALE NEEDS AND AN ESTABLISHED ONE DOES NOT: a class Tailwind no
// longer emits is INVISIBLE. `rounded-chip` and `rounded-modal` were on the old four-rung scale and
// are on no rung of this one; a call site left on either compiles, typechecks, renders, and simply
// has square corners for ever. Nothing but a rule that reads every file can see that, which is why
// the census below is over the whole client rather than over the components this pass touched.
//
//   npm run test:surface-system

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { COMPONENT, ELEVATION_SPEC, RADIUS_SCALE, RADIUS_TOKENS, SHADOW_RULES, SHAPE } from "./surfaces.ts";
import { ELEVATION, GLOW, RADIUS } from "./tokens.ts";

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SRC = `${HERE}..`;
const CLIENT = `${SRC}/..`;
const read = (path: string): string => readFileSync(`${CLIENT}/${path}`, "utf8");

const SOURCES = readdirSync(SRC, { recursive: true })
  .map((entry) => String(entry).replace(/\\/g, "/"))
  .filter((path) => /\.tsx?$/.test(path))
  .map((path) => ({ path, text: readFileSync(`${SRC}/${path}`, "utf8") }));

/**
 * The source with its comments blanked out, line numbers intact.
 *
 * A line of prose about a radius is not a call site — this file's own comments name half the scale,
 * and `tokens.ts` spends a paragraph on the rungs it replaced. Blanking rather than deleting, so a
 * failure still reports the line somebody has to open.
 */
const withoutComments = (text: string): string =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + " ".repeat(m.length - p1.length));

const CODE = SOURCES.filter((f) => !/\.test\.tsx?$/.test(f.path)).map((f) => ({
  path: f.path,
  text: withoutComments(f.text),
}));

console.log("\n§04's nine rungs, transcribed from the PDF");
{
  // The specification's table, in its own order, with its own names and its own numbers.
  const SPEC: Record<string, number> = {
    xs: 4,
    sm: 6,
    control: 8,
    input: 10,
    card: 12,
    lg: 16,
    xl: 20,
    hero: 24,
    pill: 999,
  };

  for (const [name, px] of Object.entries(SPEC)) {
    check(`--radius-${name} is ${px}px`, RADIUS_SCALE[name as keyof typeof RADIUS_SCALE] === px,
      String(RADIUS_SCALE[name as keyof typeof RADIUS_SCALE] ?? "missing"));
  }
  check("and the scale holds nothing the specification does not name",
    Object.keys(RADIUS_SCALE).length === Object.keys(SPEC).length,
    Object.keys(RADIUS_SCALE).filter((k) => !(k in SPEC)).join(", "));

  // `tokens.ts` is the layer that says what a rung is FOR, and it must not re-value one on the way
  // through. It re-exports rather than re-declares, and this is what keeps that true.
  check("tokens.ts stands on the specification's numbers rather than its own",
    Object.entries(RADIUS_SCALE).every(([k, v]) => RADIUS[k as keyof typeof RADIUS] === v));
}

console.log("\nand the two other places every rung is written down");
{
  // Tailwind's block, which is where 300 call sites actually get their corner from.
  const config = read("tailwind.config.js");
  const block = config.match(/borderRadius: \{[\s\S]*?\n {6}\}/)?.[0] ?? "";
  for (const [name, px] of Object.entries(RADIUS_SCALE)) {
    check(`tailwind emits rounded-${name} at ${px}px`,
      new RegExp(`\\b${name}: "${px}px"`).test(block), block ? "not in the block" : "block not found");
  }
  // A rung Tailwind carries and the specification does not name is a class somebody will reach for.
  const emitted = [...block.matchAll(/^\s{8}"?([\w-]+)"?:/gm)].map((m) => m[1]!);
  check("...and nothing else", emitted.every((n) => n in RADIUS_SCALE), emitted.filter((n) => !(n in RADIUS_SCALE)).join(", "));

  // And the custom properties, for React Flow's own chrome and the surfaces drawn to a canvas.
  const css = read("src/index.css");
  const root = css.match(/:root \{[\s\S]*?\n {2}\}/)?.[0] ?? "";
  for (const [token, value] of Object.entries(RADIUS_TOKENS)) {
    check(`index.css publishes ${token} as ${value}`,
      new RegExp(`${token}:\\s*${value};`).test(root), root ? "not in :root" : ":root not found");
  }
}

console.log("\nevery corner in the client is on the scale");
{
  // THE RULE THIS SUITE EXISTS FOR. `cockpitCraft.test.ts` already asserts it over the Cockpit's
  // own components; the four rungs this scale replaced were used in 42 files, so the census has to
  // be the whole client or the rule catches the pass that wrote it and nothing after.
  //
  // `rounded-full` is allowed and is not a rung: a circle is round because it is round. `[1px]` is
  // the sparkline's 3px bar, which is below the bottom of any scale worth having.
  const NAMED = new RegExp(`rounded-(?:[trbl]{1,2}-)?(?:${Object.keys(RADIUS_SCALE).join("|")}|full|none|\\[1px\\])(?![\\w-])`);
  const offScale = CODE.flatMap((f) =>
    (f.text.match(/rounded-\[?[\w.%[\]-]+\]?/g) ?? [])
      .filter((m) => !NAMED.test(m))
      // `rounded-${...}` — a rung chosen at runtime. The variable's own arms are call sites in
      // their own right and are caught above; the interpolation itself names nothing.
      .filter((m) => m !== "rounded-")
      .map((m) => `${f.path}: ${m}`),
  );
  check("no call site is on a rung the scale does not have", offScale.length === 0, offScale.join("; "));

  // And the inline half, for the surfaces that take a number rather than a class. A literal here is
  // a corner that stays where it was when the scale moves under it.
  const literals = CODE.flatMap((f) =>
    (f.text.match(/borderRadius:\s*[\d.]+/g) ?? [])
      // GraphView's 9px diamond, whose 1.5 is the same sub-scale case as `[1px]` above.
      .filter((m) => !/borderRadius:\s*1\.5\b/.test(m))
      .map((m) => `${f.path}: ${m}`),
  );
  check("no inline radius is a hand-written number", literals.length === 0, literals.join("; "));
}

console.log("\n§05's two rules that are not a number");
{
  // "Sidebar: 0px outer radius; structural, not floating." The same sentence colour_system.pdf §02
  // already made about the sidebar's shade, and a rounded corner would undo in one property what a
  // whole cool-grey plane is saying. Asserted against the ROOT element, because every control
  // inside the sidebar is legitimately rounded and only the plane itself may not be.
  const sidebar = CODE.find((f) => f.path === "components/Sidebar.tsx")?.text ?? "";
  const root = sidebar.match(/return \(\s*<div className="([^"]*)"/)?.[1] ?? "";
  check("the sidebar plane has no outer radius",
    root !== "" && !/rounded-/.test(root) && SHAPE.sidebarOuterRadius === 0, root || "root not found");

  // §04: "Agent avatars: 20–24px container radius; artwork may have its own silhouette." A range
  // rather than a rung, which is the one place the scale is deliberately not a single answer.
  check("the avatar range is §04's two expressive rungs",
    SHAPE.avatarRadius.min === RADIUS_SCALE.xl && SHAPE.avatarRadius.max === RADIUS_SCALE.hero,
    `${SHAPE.avatarRadius.min}–${SHAPE.avatarRadius.max}`);
}

console.log("\n§06's four levels, transcribed from the PDF");
{
  // The specification's table. §06 writes its alphas against black; the values below are its
  // GEOMETRY, which is the half a tint cannot change — see `surfaces.ts` for why the colour is ink.
  const SPEC: Record<string, string | null> = {
    E0: null,
    E1: "0 1px 2px",
    E2: "0 4px 12px",
    E3: "0 12px 32px",
  };
  const ALPHA: Record<string, number> = { E1: 0.03, E2: 0.06, E3: 0.1 };
  const LEVEL: Record<string, string> = { E0: "flat", E1: "raised", E2: "floating", E3: "overlay" };

  for (const [E, geometry] of Object.entries(SPEC)) {
    const value = ELEVATION[LEVEL[E] as keyof typeof ELEVATION];
    if (geometry === null) {
      check(`${E} is flat`, value === "none", value);
      continue;
    }
    check(`${E} is ${geometry} at ${ALPHA[E]}`,
      value.startsWith(`${geometry} `) && value.endsWith(`, ${ALPHA[E]})`), value);
    // ONE LAYER, WHICH IS THE ASSERTION §07 IS ACTUALLY ABOUT. The two levels this replaced stacked
    // a pair each, ending in `0 28px 64px -16px`; "shadows are intentionally soft and rare" is a
    // rule against a second layer as much as against a dark one, and a comma is what a second layer
    // costs.
    check(`...and it is a single layer`, !value.includes("),"), value);
  }
  check("the ladder has four levels and no fifth",
    Object.keys(ELEVATION).length === 4 && Object.keys(ELEVATION_SPEC).length === 4);

  // Tailwind carries E1–E3; E0 is the absence of a class rather than a class of its own.
  const block = read("tailwind.config.js").match(/boxShadow: \{[\s\S]*?\n {6}\}/)?.[0] ?? "";
  for (const [E, name] of Object.entries(LEVEL)) {
    if (E === "E0") continue;
    check(`tailwind emits shadow-${name} at ${E}`,
      block.includes(`${name}: "${ELEVATION[name as keyof typeof ELEVATION]}"`), block ? "not in the block" : "block not found");
  }
}

console.log("\n§07: where each level is allowed to appear");
{
  // "E1 may appear on interaction; E2/E3 are reserved for genuinely floating content." Which is a
  // rule about CALL SITES rather than about values, and the only kind of elevation bug that ever
  // actually happens — every level renders, every card looks fine on its own, and what goes wrong is
  // that a card in a column reached for the dialog's shadow because depth was the nearest axis.
  //
  // A FLOATING SURFACE IS ONE THAT LEAVES THE FLOW, which in this client is exactly what `absolute`,
  // `fixed` and `inset-` say. So the test is structural: an element carrying E2 or E3 must either be
  // positioned out of the flow itself, or be the surface of something a Dialog/Popover/Overlay
  // component owns. Anything else is a card that was handed a dropdown's depth.
  // AND `backdrop-blur` COUNTS AS LEAVING THE FLOW, which is not a position but is better evidence
  // than one: a surface that blurs what is behind it demonstrably has something behind it. It is
  // what the sign-in card and React Flow's own controls are, and both are floating in every sense
  // §07 means except the one a `position` property can state.
  const FLOATS = /\b!?(?:absolute|fixed|inset-0|backdrop-blur)\b|role="dialog"/;
  /**
   * THE TWO SURFACES THAT FLOAT BY SOMETHING OTHER THAN A CLASS, named rather than pattern-matched
   * because a pattern wide enough to cover them would cover every card in the app as well.
   *
   * THE TWO SHELLS ARE THE APP ITSELF, lifted off `bg-void` by the 8px inset around them — the one
   * surface in the product that floats over the desktop rather than over the page, which is what
   * `tokens.ts` has always said E3's fourth use is. Neither can say so in a class, because what
   * makes them float is the padding on their parent.
   */
  const FLOATS_WITHOUT_SAYING_SO = new Set([
    "App.tsx",
    "components/onboarding/OnboardingSurface.tsx",
  ]);
  const misplaced: string[] = [];
  for (const { path, text } of CODE) {
    if (FLOATS_WITHOUT_SAYING_SO.has(path)) continue;
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      if (!/shadow-(?:floating|overlay)/.test(line)) return;
      // THE ELEMENT'S OWN LINE IS NOT ALWAYS WHERE ITS POSITION IS. A dialog's surface is a plain
      // box centred by the scrim that owns it, so the window is the enclosing markup rather than
      // the one attribute — twelve lines, which is the longest opening tag in this client.
      const window = lines.slice(Math.max(0, i - 12), i + 1).join("\n");
      if (FLOATS.test(window)) return;
      misplaced.push(`${path}: ${line.trim().slice(0, 90)}`);
    });
  }
  check("E2 and E3 are only on surfaces that leave the flow", misplaced.length === 0, misplaced.join("; "));

  // AND THE OTHER HALF: a card rests flat. `shadow-raised` on an element with no hover/focus prefix
  // is a card that is permanently lifted, which §11's `E0 → E1` and §12's "agent cards are E0 by
  // default" both rule out. The Inbox spent E3, E2 and E1 on its three severities before this pass.
  const lifted = CODE.flatMap(({ path, text }) =>
    text.split("\n")
      .filter((l) => /(?:^|[^:])\bshadow-raised\b/.test(l) && !/(?:hover|focus|focus-within|group-hover|active):shadow-raised/.test(l))
      .map((l) => `${path}: ${l.trim().slice(0, 90)}`),
  );
  check("nothing rests at E1 that is not answering a pointer", lifted.length === 0, lifted.join("; "));

  check("the rules say a card rests flat and lifts one level",
    SHADOW_RULES.cardAtRest === "E0" && SHADOW_RULES.cardOnInteraction === "E1");
  check("...and that only two levels are for floating content",
    SHADOW_RULES.floatingOnly.join() === "E2,E3");
}

console.log("\n§12: no dark, wide or decorative shadow anywhere");
{
  // The rule is a maximum on both axes at once, and a blur without an alpha beside it says nothing:
  // a 64px spread at two percent is atmosphere, a 12px one at forty is a bruise. §06's own widest is
  // 32px at ten percent, so that is the ceiling — anything past it on EITHER axis is a shadow this
  // system does not have a level for.
  const shadows = [...Object.values(ELEVATION), GLOW.hover, GLOW.cta, read("tailwind.config.js")]
    .join("\n")
    .matchAll(/(\d+)px\s+(-?\d+px\s+)?rgba\(29, 29, 27,\s*([\d.]+)\)/g);
  const wide = [...shadows].filter((m) => Number(m[1]) > 32 || Number(m[3]) > 0.1).map((m) => m[0]);
  check("no ink shadow is wider than E3 or darker than it", wide.length === 0, wide.join("; "));

  // And the hover state, which is where a wide shadow hides: it is a STATE rather than a level, so
  // nothing on the elevation ladder would have caught the 32px bloom this used to carry.
  check("GLOW.hover is a border plus E1, not a bloom",
    GLOW.hover === `0 0 0 1px #C9C9C4, ${ELEVATION.raised}`, GLOW.hover);
}

console.log("\n§11's component defaults, transcribed from the PDF");
{
  // The specification's own table, radius first, then the level.
  const SPEC: Record<string, [number, string]> = {
    button: [8, "E0"],
    input: [10, "E0"],
    threadRow: [0, "E0"],
    inboxCard: [12, "E0"],
    agentCard: [16, "E0"],
    dropdown: [12, "E2"],
    dialog: [16, "E3"],
  };
  for (const [name, [px, E]] of Object.entries(SPEC)) {
    const row = COMPONENT[name as keyof typeof COMPONENT];
    check(`a ${name} is ${px}px at ${E}`, row.radius === px && row.elevation === E,
      `${String(row.radius)}px at ${row.elevation}`);
  }
  // The two rows that arrow rather than sit: `E0 → E1` is a rest state and an interaction, and it
  // is the reason the Inbox's severity ladder had to give its three levels back.
  check("an inbox card and an agent card both lift to E1",
    COMPONENT.inboxCard.hover === "E1" && COMPONENT.agentCard.hover === "E1");
  check("an agent avatar is §04's expressive range",
    COMPONENT.agentAvatar.radius === SHAPE.avatarRadius);
}

console.log("\nand the components themselves stand on it");
{
  // §11 IS A TABLE OF PAIRS AND THIS IS WHERE IT MEETS THE MARKUP. Each check below reads the one
  // element the row is about, because a table nothing is held to is documentation.
  const src = (path: string): string => CODE.find((f) => f.path === path)?.text ?? "";

  // AN INPUT IS `input` AND NEVER `control`. The two rungs are 8 and 10 and the components are the
  // same height, so nothing but a rule can keep them apart — and before this pass all 54 text
  // fields in the client were on the button's rung. The census is structural: every `<input>`,
  // `<textarea>` and `<select>` in the client, not the ones somebody remembered.
  const fields: string[] = [];
  for (const { path, text } of CODE) {
    for (const m of text.matchAll(/<(?:input|textarea|select)\b/g)) {
      let i = m.index! + m[0].length, depth = 0;
      while (i < text.length) {
        const c = text[i];
        if (c === "{") depth++;
        else if (c === "}") depth--;
        else if (c === ">" && depth === 0) break;
        i++;
      }
      const tag = text.slice(m.index!, i + 1);
      if (/\brounded-(?!input\b)(?:xs|sm|control|card|lg|xl|hero)\b/.test(tag)) {
        fields.push(`${path}: ${tag.replace(/\s+/g, " ").slice(0, 70)}`);
      }
    }
  }
  check("every text field is on the input rung", fields.length === 0, fields.join("; "));

  // THE AGENT CARD, which is §11's other moved row and the product's primary object.
  const card = src("components/AgentCard.tsx");
  const surface = card.match(/className=\{`group flex cursor-pointer[^`]*`/)?.[0] ?? "";
  check("the agent card is at the major-container rung", /rounded-lg\b/.test(surface), surface.slice(0, 120));
  check("...and rests flat, lifting only for the pointer or the keyboard",
    !/(?:^|[^:])\bshadow-(?:raised|floating|overlay)\b/.test(surface) && /shadow-glow/.test(surface),
    surface.slice(0, 160));

  // THE AVATAR, whose radius is a value rather than a class because it is drawn to a canvas.
  check("the agent avatar takes its radius from §04's expressive range",
    /borderRadius: RADIUS\.(?:xl|hero)\b/.test(src("components/GlossAvatar.tsx")));

  // AND THE THREAD ROW, which is §11's one zero: the row owns no radius and no border, and the
  // divider belongs to the list. A border on the row would make it a card, which is a heavier claim
  // than the row is entitled to make.
  const row = src("components/ThreadRow.tsx").match(/className=\{`group relative cursor-pointer[^`]*`/)?.[0] ?? "";
  check("a thread row draws no corner and no box of its own",
    row !== "" && !/rounded-|(?:^|[^-])\bborder\b/.test(row), row.slice(0, 120));
  check("...and the list is what divides them", /divide-y divide-hair/.test(src("components/ThreadsView.tsx")));
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
// The same exit the other client suites use: this runs under tsx with no node types in scope.
(globalThis as { process?: { exit(code: number): void } }).process?.exit(failures === 0 ? 0 : 1);
