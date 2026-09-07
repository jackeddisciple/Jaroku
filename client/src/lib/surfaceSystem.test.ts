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

import { RADIUS_SCALE, RADIUS_TOKENS, SHAPE } from "./surfaces.ts";
import { RADIUS } from "./tokens.ts";

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

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
// The same exit the other client suites use: this runs under tsx with no node types in scope.
(globalThis as { process?: { exit(code: number): void } }).process?.exit(failures === 0 ? 0 : 1);
