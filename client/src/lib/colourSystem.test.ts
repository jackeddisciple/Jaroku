// The palette, held to colour_system.pdf.
//
// The specification is LOCKED, so drift is the only interesting failure — nobody disagrees with it
// on purpose. What happens instead is that one of the four places these values live gets edited and
// the other three do not: `palette.ts` holds the specification's tokens, `tokens.ts` says what they
// mean, `tailwind.config.js` carries them as classes, and `index.css` publishes them as custom
// properties for the three consumers a class cannot reach. A Tailwind config cannot import a `.ts`
// module without moving the whole config to TypeScript, and a stylesheet cannot import anything at
// all, so the palette genuinely is written three times. This is what makes them agree.
//
// THE SPECIFICATION'S OWN VALUES ARE SPELLED OUT BELOW rather than derived from `palette.ts`. A
// table compared against itself passes just as happily with a token deleted, and every assertion
// here would then be checking that the code agrees with the code.
//
// THE OTHER HALF IS THE INVERSION, and it is the half worth having. This client was built on a
// near-black system: nine hex literals in GraphView, four in the Inbox, a `#52525b` in the glyphs,
// a shiki theme that writes its own background into the markup. Every one of those is invisible to
// a palette change — they do not fail, they simply stay dark while everything around them goes
// light. So the rules below are mostly about ABSENCE: no source file carries a colour of its own
// unless it is a third-party brand mark, no dark-era value survives anywhere, and the one component
// that could quietly keep its own theme is checked by name.
//
//   npm run test:colour-system

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  BORDER,
  BRAND,
  CANVAS,
  DEEP_HARBOR,
  NEUTRAL_SHARE_FLOOR,
  PALE_MIST,
  SEMANTIC,
  SIDEBAR,
  SPEC_TOKENS,
  TEXT as INK,
  alpha,
  channels,
} from "./palette.ts";
import { ACCENT, ELEVATION, GLOW, INTERACTION, SHARE_RAMP, STATUS, STEP_TYPE, SURFACE, TEXT } from "./tokens.ts";

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
 * A line of prose about a colour is not a call site — this file's own comments name fifty. A
 * leading-`//`-or-`*` test was the first version and it is not enough: a JSX comment is a `{/* … *​/}`
 * block whose middle lines start with an ordinary word, which is exactly where the paragraph
 * explaining a colour change tends to name the colour it replaced. Blanking rather than deleting,
 * so a failure still reports the line somebody has to open.
 */
const withoutComments = (text: string): string =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + " ".repeat(m.length - p1.length));

const eq = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

console.log("\nevery token in the specification's tables, transcribed from the PDF");
{
  // §01 through §08, value by value, in the specification's own order.
  const SPEC: Record<string, string> = {
    "--color-bg-canvas": "#F7F7F5",
    "--color-bg-surface": "#FBFBFA",
    "--color-bg-elevated": "#FFFFFF",
    "--color-bg-subtle": "#F1F1EF",
    "--color-bg-hover": "#ECECEA",
    "--color-bg-active": "#E5E5E1",
    "--color-sidebar": "#E9EEEF",
    "--color-sidebar-hover": "#DEE6E8",
    "--color-sidebar-active": "#D3DDE0",
    "--color-sidebar-border": "#D2DCDD",
    "--color-pale-mist-50": "#F3F6F6",
    "--color-pale-mist-100": "#E9EEEF",
    "--color-pale-mist-200": "#DEE6E8",
    "--color-pale-mist-300": "#D3DDE0",
    "--color-pale-mist-400": "#C0C8CA",
    "--color-deep-harbor": "#2B4851",
    "--color-deep-harbor-hover": "#24404A",
    "--color-deep-harbor-soft": "#E8EFF0",
    "--color-text-primary": "#1D1D1B",
    "--color-text-secondary": "#62625F",
    "--color-text-muted": "#90908C",
    "--color-text-disabled": "#B5B5B0",
    "--color-border-subtle": "#E6E6E2",
    "--color-border-default": "#DCDCD8",
    "--color-border-strong": "#C9C9C4",
    "--color-success": "#3B8F5A",
    "--color-warning": "#B77A1B",
    "--color-danger": "#C94A43",
    "--color-info": "#4B78B8",
    "--color-brand-strong": "#1D1D1B",
    "--color-brand-secondary": "#2B4851",
  };

  for (const [token, value] of Object.entries(SPEC)) {
    check(`${token} is ${value}`, eq(SPEC_TOKENS[token] ?? "", value), SPEC_TOKENS[token] ?? "missing");
  }
  check("and the palette holds nothing the specification does not name",
    Object.keys(SPEC_TOKENS).length === Object.keys(SPEC).length,
    Object.keys(SPEC_TOKENS).filter((k) => !(k in SPEC)).join(", "));

  // §08 writes NONE in the `--color-brand` row. An absence is easy to lose to a helpful edit.
  check("§08's brand colour is absent rather than empty", BRAND.base === null && !("--color-brand" in SPEC_TOKENS));
  // §03's family and §02's plane share three values, which is what makes the sidebar Pale Mist
  // rather than merely near it. If the two ever disagree the sidebar has left the family.
  check("the sidebar IS the Pale Mist family", eq(SIDEBAR.base, PALE_MIST[100]) && eq(SIDEBAR.hover, PALE_MIST[200]) && eq(SIDEBAR.active, PALE_MIST[300]));
  // §08 again: charcoal for a primary action is the same charcoal as a heading, or a filled
  // button is a slightly different black from the text above it.
  check("§08's charcoal is §05's ink", eq(BRAND.strong, INK.primary));
  check("...and §08's secondary is §04's Harbor", eq(BRAND.secondary, DEEP_HARBOR.base));
}

console.log("\n...and the stylesheet publishes exactly that set");
{
  const css = read("src/index.css");
  const root = css.match(/:root \{[\s\S]*?\n  \}/)?.[0] ?? "";
  const declared = new Map<string, string>();
  for (const m of root.matchAll(/(--color-[a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8});/g)) declared.set(m[1]!, m[2]!);

  for (const [token, value] of Object.entries(SPEC_TOKENS)) {
    check(`${token} is published`, eq(declared.get(token) ?? "", value), declared.get(token) ?? "missing");
  }
  check("and publishes nothing else", declared.size === Object.keys(SPEC_TOKENS).length,
    [...declared.keys()].filter((k) => !(k in SPEC_TOKENS)).join(", "));
  // The theme the browser is told to expect. A `dark` here with a light palette below it makes the
  // browser paint form controls, scrollbars and autofill for the wrong system.
  check("the page declares itself light", /color-scheme:\s*light/.test(root), root.match(/color-scheme:[^;]*/)?.[0] ?? "no color-scheme");
}

console.log("\n...and the Tailwind config, which is the third copy");
{
  const config = read("client/tailwind.config.js".replace("client/", ""));
  // Each utility name this app uses, and the specification token it must BE. Two thousand call
  // sites say `bg-panel` rather than `bg-bg-surface`; what has to be true is that they are equal.
  const MAPPING: Record<string, string> = {
    void: "--color-bg-subtle",
    bg: "--color-bg-canvas",
    panel: "--color-bg-surface",
    elevated: "--color-bg-elevated",
    active: "--color-bg-hover",
    chrome: "--color-bg-active",
    sidebar: "--color-sidebar",
    "sidebar-hover": "--color-sidebar-hover",
    "sidebar-active": "--color-sidebar-active",
    "sidebar-border": "--color-sidebar-border",
    ink: "--color-text-primary",
    muted: "--color-text-secondary",
    faint: "--color-text-muted",
    disabled: "--color-text-disabled",
    hair: "--color-border-subtle",
    edge: "--color-border-default",
    grip: "--color-border-strong",
    accent: "--color-deep-harbor",
    "accent-hover": "--color-deep-harbor-hover",
    "accent-soft": "--color-deep-harbor-soft",
    ok: "--color-success",
    err: "--color-danger",
    run: "--color-warning",
    warn: "--color-info",
  };

  for (const [name, token] of Object.entries(MAPPING)) {
    const key = name.includes("-") ? `"${name}"` : name;
    const declared = config.match(new RegExp(`^\\s+${key}: "(#[0-9a-fA-F]{6})"`, "m"))?.[1];
    check(`${name} is ${token}`, eq(declared ?? "", SPEC_TOKENS[token]!), declared ?? "missing");
  }
  // §03's five steps, which the sidebar's four are drawn from and which §09 hands the rest of the
  // cool atmosphere to.
  for (const step of [50, 100, 200, 300, 400] as const) {
    const declared = config.match(new RegExp(`^\\s+${step}: "(#[0-9a-fA-F]{6})",`, "m"))?.[1];
    check(`mist-${step} is Pale Mist ${step}`, eq(declared ?? "", PALE_MIST[step]), declared ?? "missing");
  }
}

console.log("\ntokens.ts says what the palette MEANS, and says it in the palette's own values");
{
  check("SURFACE.bg is the canvas", eq(SURFACE.bg, CANVAS.canvas));
  check("SURFACE.panel is a card", eq(SURFACE.panel, CANVAS.surface));
  check("SURFACE.elevated is what floats", eq(SURFACE.elevated, CANVAS.elevated));
  check("SURFACE.void is under the shell", eq(SURFACE.void, CANVAS.subtle));
  check("SURFACE.hair is the quietest border", eq(SURFACE.hair, BORDER.subtle));
  check("SURFACE.edge is the default border", eq(SURFACE.edge, BORDER.default));
  check("SURFACE.grip is the strongest", eq(SURFACE.grip, BORDER.strong));
  check("TEXT.ink is §05's primary", eq(TEXT.ink, INK.primary));
  check("TEXT.disabled is §05's fourth step", eq(TEXT.disabled, INK.disabled));
  check("the interaction accent is Deep Harbor", eq(INTERACTION.accent, DEEP_HARBOR.base));

  // §01's ladder must ASCEND in lightness from what the shell sits on to what floats above it. A
  // rung out of order still renders — it just makes a popover recede and a page come forward.
  const lightness = (hex: string): number => {
    const [r, g, b] = channels(hex).split(", ").map(Number) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ladder = [SURFACE.void, SURFACE.bg, SURFACE.panel, SURFACE.elevated];
  check("the surface ladder ascends", ladder.every((c, i) => i === 0 || lightness(c) > lightness(ladder[i - 1]!)),
    ladder.map((c) => `${c} ${lightness(c).toFixed(0)}`).join(" → "));
  // And the borders must DESCEND, or "strong" is quieter than "subtle".
  const borders = [BORDER.subtle, BORDER.default, BORDER.strong];
  check("the border ladder descends", borders.every((c, i) => i === 0 || lightness(c) < lightness(borders[i - 1]!)));
}

console.log("\n§07's four are spent on meaning and nothing else claims them");
{
  check("ok is §07's success", eq(STATUS.ok, SEMANTIC.success));
  check("error is §07's danger", eq(STATUS.error, SEMANTIC.danger));
  // Amber means IN FLIGHT in this product — forty-eight call sites, a node glow and a stream
  // pulse — which is why `pending` holds §07's amber and `warn` holds its blue. See STATUS.warn.
  check("pending is §07's amber", eq(STATUS.pending, SEMANTIC.warning));
  check("caution is §07's blue, not a second amber", eq(STATUS.warn, SEMANTIC.info));

  // The four category accents say WHAT KIND, the four semantics say HOW IT IS DOING, and the whole
  // system stops working the moment a badge can be mistaken for a state. Distance in RGB is a
  // crude proxy for that and a sufficient one: what it catches is two colours that are nearly the
  // same, which is the only failure mode here.
  const dist = (a: string, b: string): number => {
    const [ar, ag, ab] = channels(a).split(", ").map(Number) as [number, number, number];
    const [br, bg2, bb] = channels(b).split(", ").map(Number) as [number, number, number];
    return Math.sqrt((ar - br) ** 2 + (ag - bg2) ** 2 + (ab - bb) ** 2);
  };
  const named = [
    ...Object.entries(ACCENT).map(([k, v]) => [`ACCENT.${k}`, v] as const),
    ["STATUS.ok", STATUS.ok] as const,
    ["STATUS.pending", STATUS.pending] as const,
    ["STATUS.error", STATUS.error] as const,
    ["STATUS.warn", STATUS.warn] as const,
    ["INTERACTION.accent", INTERACTION.accent] as const,
  ];
  let closest = { pair: "", d: Infinity };
  for (let i = 0; i < named.length; i++) {
    for (let j = i + 1; j < named.length; j++) {
      const d = dist(named[i]![1], named[j]![1]);
      if (d < closest.d) closest = { pair: `${named[i]![0]} / ${named[j]![0]}`, d };
    }
  }
  // 55 is where a difference stops being one somebody can rely on at badge size. It is not a
  // theoretical floor: the first draft of this palette put `ACCENT.state` at an indigo 42 from
  // §07's info blue, which is a "what kind of thing is this" mark that reads as a status.
  check("no two meaning-bearing colours are near-identical", closest.d > 55, `${closest.pair} are ${closest.d.toFixed(0)} apart`);
}

console.log("\n§09's neutral-first rule, counted where colour is actually spent");
{
  // §09: "roughly 75–85% of the interface remains neutral ... Deep Harbor remains rare and
  // intentional", "Not every button or heading."
  //
  // COUNTED IN CALL SITES, NOT IN TOKENS. The first version of this check compared the palette's
  // own token counts and reported 45% — which says nothing at all, because the palette has one
  // canvas token that covers a whole screen and five Pale Mist steps that mostly do not appear.
  // Where colour is spent is the call sites, and a class census is a fair proxy for area in an app
  // whose surfaces are all painted by classes.
  const count = (re: RegExp): number =>
    SOURCES.reduce((n, f) => n + (f.text.match(re) ?? []).length, 0);
  const P = "(bg|text|border|ring|fill|stroke|divide|placeholder|shadow|from|to|via|decoration)";
  const neutral = count(new RegExp(`\\b${P}-(void|bg|panel|elevated|active|chrome|hair|edge|grip|ink|muted|faint|disabled|sidebar|sidebar-hover|sidebar-active|sidebar-border|mist-[0-9]+)\\b`, "g"));
  const accent = count(new RegExp(`\\b${P}-accent(-hover|-soft)?\\b`, "g"));
  const semantic = count(new RegExp(`\\b${P}-(ok|err|run|warn)\\b`, "g"));
  const category = count(new RegExp(`\\b${P}-(reviewed|bespoke|stateful)\\b`, "g"));
  const total = neutral + accent + semantic + category;

  const share = neutral / total;
  check(`at least ${Math.round(NEUTRAL_SHARE_FLOOR * 100)}% of coloured call sites are neutral`,
    share >= NEUTRAL_SHARE_FLOOR, `${Math.round(share * 100)}% of ${total}`);
  // And the accent's own restraint, which §09 states twice and which is the rule that actually
  // decays: an accent spreads one sanctioned-looking call site at a time.
  check("Deep Harbor stays rare", accent / total <= 0.05, `${accent} of ${total}`);
}

console.log("\nno dark-era value survives anywhere in the client");
{
  // THE ASSERTION THIS SUITE EXISTS FOR. A hex literal does not fail when the palette moves under
  // it — it stays exactly as dark as it was while everything around it goes light, which is a bug
  // that only a person looking at the screen can see. Each of these was in the client before this
  // pass, in a file that had no idea it was part of a palette.
  const DEAD = [
    "#08080a", "#0d0d0f", "#0e0e12", "#18181b", "#1e1e22", "#202024", "#232329", "#242429",
    "#26262b", "#2a2a30", "#34343c", "#3a3a3f", "#3a3a44", "#3f3f46", "#4c4c56", "#52525b",
    "#565661", "#5a5a66", "#6c6c78", "#6f6f7a", "#71717a", "#8b8b96", "#9a9aa4", "#9ca3af",
    "#a1a1aa", "#e4e4e7", "#6b8afd", "#8aa0ff", "#22c55e", "#ef4444", "#f59e0b", "#fb923c",
    "#fbbf24", "#5eead4", "#c084fc", "#a5b4fc", "#f472b6", "#182130", "#16221a", "#241f18",
    "#221826", "#7fa9db", "#79c48f", "#c99a52", "#a98cc4", "#a6b0ff", "#c3c7d1", "#7fa9d6",
  ];
  // AND THE SAME VALUES AS CHANNELS, which is the half a hex scan misses entirely. A gradient, a
  // scrim and an SVG filter all take `rgba(...)`, and five of the six that survived the first pass
  // of this migration were written that way — including two dot fields drawn in off-white, which on
  // an off-white page are not a faint texture but nothing at all.
  const asChannels = (hex: string): string => {
    const n = Number.parseInt(hex.slice(1), 16);
    return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
  };

  const found: string[] = [];
  for (const file of SOURCES) {
    if (file.path === "lib/colourSystem.test.ts") continue;
    withoutComments(file.text).split("\n").forEach((line, i) => {
      const lower = line.toLowerCase();
      // Channel lists are compared with the spaces taken out, because `rgba(13, 13, 15, .6)` and
      // `rgba(13,13,15,.6)` are the same colour and both spellings were in the client.
      const squeezed = lower.replace(/\s+/g, "");
      for (const dead of DEAD) {
        if (lower.includes(dead)) found.push(`${file.path}:${i + 1} ${dead}`);
        else if (squeezed.includes(`(${asChannels(dead)},`)) found.push(`${file.path}:${i + 1} rgba(${asChannels(dead)}…)`);
      }
    });
  }
  check("every one of them is gone", found.length === 0, found.slice(0, 10).join("; "));
}

console.log("\n...and no file outside the brand marks writes a colour of its own");
{
  // Third-party logos are the one legitimate reason for a hex in a component: Slack's aubergine is
  // Slack's, and a palette has no opinion about it. Everything else has to come from a token, or
  // the next palette change leaves it behind exactly as this one nearly did.
  const BRAND_FILES = new Set([
    "components/graphIcons.tsx", // Slack, Gmail, Drive, Stripe, Anthropic, Postgres
    "components/auth/SignInScreen.tsx", // Google's four-colour G
    "lib/icons.tsx", // BRAND_COLOR — the provider marks' real colours
  ]);
  // Two files hold values that are deliberately off-palette, and both say so at length.
  const OFF_PALETTE = new Set([
    "lib/memberList.ts", // §6.2's avatar mnemonics — a mnemonic, not a status
    "components/VoiceWaveform.tsx", // two tokens as channels, because they are interpolated
    "lib/palette.ts",
    "lib/tokens.ts",
    "lib/colourSystem.test.ts",
  ]);
  const strays: string[] = [];
  for (const file of SOURCES) {
    if (BRAND_FILES.has(file.path) || OFF_PALETTE.has(file.path) || file.path.endsWith(".test.ts")) continue;
    withoutComments(file.text).split("\n").forEach((line, i) => {
      const m = line.match(/#[0-9a-fA-F]{6}\b/);
      if (m) strays.push(`${file.path}:${i + 1} ${m[0]}`);
    });
  }
  check("no component carries its own palette", strays.length === 0, strays.slice(0, 10).join("; "));
}

console.log("\nthe two surfaces that write their own colours past every rule above");
{
  // SHIKI WRITES A BACKGROUND INTO THE HTML IT RETURNS, so a dark syntax theme survives a palette
  // change untouched: no token, class or variable in this system reaches inside that markup. It is
  // the one thing in the client that could have shipped a near-black pane in a light application,
  // and nothing but this line would have said so.
  const viewer = SOURCES.find((f) => f.path === "components/CodeViewer.tsx")?.text ?? "";
  const theme = viewer.match(/const THEME = "([^"]+)"/)?.[1] ?? "";
  check("the syntax theme is a light one", /light/.test(theme) && !/dark/.test(theme), theme || "not found");

  // And the graph canvas, which is drawn by React Flow rather than by a class — the reason the
  // custom properties are published at all. A literal here is a canvas that stays dark.
  const css = read("src/index.css");
  const canvas = css.match(/\.graph-canvas \{[\s\S]*?\}/)?.[0] ?? "";
  check("the graph canvas reads a token", /var\(--color-/.test(canvas), canvas.replace(/\s+/g, " ").trim());
}

console.log("\ndepth is struck from ink, at a light system's alphas");
{
  // `rgba(0,0,0,0.4)` under a card is invisible on near-black and a bruise on off-white, and a
  // pure-black shadow under #FBFBFA goes grey-blue rather than neutral-warm. Both halves matter,
  // and neither is visible in a diff that only changed a number.
  for (const [name, value] of Object.entries(ELEVATION)) {
    if (value === "none") continue;
    const alphas = [...value.matchAll(/rgba\([^)]*?,\s*([\d.]+)\)/g)].map((m) => Number(m[1]));
    check(`ELEVATION.${name} is struck from ink`, value.includes(channels(INK.primary)), value);
    check(`ELEVATION.${name} is subtle enough for a light page`, alphas.every((a) => a <= 0.2), alphas.join(", "));
  }
  // GLOW answers "is this the one I am on". It lifted by LIGHT on near-black because a card there
  // could only get brighter; here it can only get darker, and a glow that still brightened would
  // be invisible on a white surface.
  check("GLOW.hover deepens rather than brightens", GLOW.hover.includes(BORDER.strong), GLOW.hover);
  check("GLOW.cta is ink at an alpha", GLOW.cta.includes(channels(INK.primary)), GLOW.cta);
  check("the focus ring is the accent, not a grey", INTERACTION.soft === alpha(DEEP_HARBOR.base, 0.16));
}

console.log("\nthe derived sets that have no specification row of their own");
{
  // Four step-type pairs and a five-step share ramp. Neither is in the PDF, and both were built for
  // a dark page — a pale wash with dark text is the inversion of a dark tint with light text, and
  // a ramp that descended into the page has to climb out of it instead.
  const lightness = (hex: string): number => {
    const [r, g, b] = channels(hex).split(", ").map(Number) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  for (const [kind, pair] of Object.entries(STEP_TYPE)) {
    check(`${kind}'s fill is a wash and its text is legible on it`, lightness(pair.bg) > 200 && lightness(pair.fg) < 130,
      `bg ${lightness(pair.bg).toFixed(0)}, fg ${lightness(pair.fg).toFixed(0)}`);
  }
  check("the share ramp climbs from ink towards the page",
    SHARE_RAMP.every((c, i) => i === 0 || lightness(c) > lightness(SHARE_RAMP[i - 1]!)),
    SHARE_RAMP.join(" → "));
  check("...and its darkest step is no darker than §05's supporting ink",
    lightness(SHARE_RAMP[0]!) >= lightness(INK.secondary));
}

console.log(failures === 0 ? "\nALL CORRECT" : `\n${failures} FAILURES`);
// The same exit the other client suites use: this runs under tsx with no node types in scope.
(globalThis as { process?: { exit(code: number): void } }).process?.exit(failures === 0 ? 0 : 1);
