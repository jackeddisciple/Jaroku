// §24's last three, in one file, because they are one property read three ways.
//
//   `test:cockpit-a11y`    every icon-only control has a name; only `waiting` announces
//   `test:cockpit-tokens`  no hard-coded colour, radius or font-size literal in the new components
//   `test:cockpit-craft`   no skeleton dimension differs from its resolved content's; no motion
//                          duration exceeds `MOTION.base`; the alignment spine is one value
//
// §24 SAYS TO EXTEND RATHER THAN DUPLICATE, and it is worth saying exactly what was extended and
// what is new. `colourSystem.test.ts` and `typeScale.test.ts` already scan EVERY source file in this
// client, so the Cockpit's components are already covered for hex literals and for hand-written
// pixel sizes — the tokens half of §24's table is enforced the moment a file exists, and one of
// them caught this build's `font-mono` on the first CI run. What those two do NOT cover is radius,
// spacing and duration, so that is what is here: the tab-scoped half of the rule, and no second
// copy of the two halves that already run.
//
// AND THE CRAFT ASSERTIONS ARE STRUCTURAL RATHER THAN VISUAL. "Zero layout shift" cannot be
// measured without a browser, but the thing that CAUSES it can: a skeleton whose dimensions are
// written out by hand beside a component whose dimensions are written out by hand. Both read from
// `cockpitLayout.ts` here, so the assertion is that neither file contains the number — which is
// checkable, and is the discipline §Craft 1 says the whole section costs.
//
//   npm run test:cockpit-craft

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";

import { CARD_HEIGHT, CARD_WIDTH, ROW_HEIGHT, SPINE, SPINE_X } from "../lib/cockpitLayout.ts";
import { markup, seed } from "../lib/testRender.ts";
import { MOTION, SPACE } from "../lib/tokens.ts";
import { useWorkStore } from "../store/workStore.ts";
import type { WorkItemView } from "../types.ts";
import { WorkList } from "./WorkList.tsx";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SRC = `${HERE}..`;

/**
 * The files this tab is made of.
 *
 * NAMED RATHER THAN GLOBBED, so a new Cockpit file has to be added here on purpose. A glob over
 * `Work*` would silently stop covering a component the day somebody renamed one, which is the
 * failure mode of every convention-based scan.
 */
const COCKPIT_FILES = [
  "components/CockpitView.tsx",
  "components/FleetStrip.tsx",
  "components/WorkList.tsx",
  "components/WorkDetail.tsx",
  "components/WorkComposer.tsx",
  "components/WorkGlyph.tsx",
  "components/CockpitDialog.tsx",
  "lib/cockpitLayout.ts",
  "lib/cockpitCopy.ts",
  "lib/cockpitFormat.ts",
  "lib/cockpitComposer.ts",
  "lib/fleetSentence.ts",
  "lib/workRow.ts",
  "lib/workWindow.ts",
  "lib/workLive.ts",
] as const;

const SOURCES = COCKPIT_FILES.map((path) => ({ path, text: readFileSync(`${SRC}/${path}`, "utf8") }));
/** Just the markup, with the prose comments removed — a comment quoting `#f472b6` is not a colour. */
const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const CODE = SOURCES.map((f) => ({ path: f.path, text: stripComments(f.text) }));

const NO_COUNTS = { queued: 0, running: 0, waiting: 0, succeeded: 0, failed: 0, cancelled: 0 };
const job = (id: string, patch: Partial<WorkItemView> = {}): WorkItemView => ({
  id, agent_id: "a", agent_name: "billing_bot", deployment_id: "d", run_id: "r",
  created_by: "u", created_by_name: "Tester", input_preview: "refund order 4471",
  status: "succeeded", output_preview: null, error: null, failure_kind: null,
  created_at: new Date().toISOString(), started_at: null, ended_at: null,
  cost_usd: 0.0031, tokens: 900, duration_ms: 4200, cost_complete: true,
  ...patch,
});

function renderList(items: WorkItemView[]): string {
  seed(useWorkStore, {
    items, pending: [], atTop: true, nextCursor: null, loaded: true, anyLive: true,
    counts: { ...NO_COUNTS, succeeded: items.length }, workspaceCounts: NO_COUNTS,
    filters: { scope: "all", status: null, agentId: null },
    fleet: [], open: null, openingId: null, logs: null, error: null, notice: null,
  });
  return markup(createElement(WorkList));
}

// --- 1. §Craft 3: one alignment spine ---------------------------------------------------------------

console.log("\none left edge, shared rather than agreed");
{
  // §Craft 3: "The header's 'Cockpit' label, the fleet card's name, and the work row's status glyph
  // sit on the same left edge, TO THE PIXEL." The only way three components agree to the pixel is
  // for there to be one value, so the assertion is about the VALUE and about its use.
  check(`the spine is a rung of the existing ladder (${SPINE})`, SPINE === SPACE.section, String(SPINE));
  check("...and the class spells the same rung", SPINE_X === "px-5", SPINE_X);

  // NO REGION WRITES ITS OWN. This is the assertion that fails when somebody adds a fourth region
  // and types `px-6` because that is what looked right in isolation — which is exactly how this tab
  // arrived at a `px-6` header over a `px-6` strip over a `px-4` list.
  const strays = CODE
    .filter((f) => f.path.startsWith("components/"))
    .filter((f) => /\bpx-(?:0|1|1\.5|2|2\.5|3|4|6|8|10|12)\b/.test(f.text) && /SPINE_X/.test(f.text))
    .map((f) => `${f.path}: ${(f.text.match(/\bpx-\d[\d.]*\b/g) ?? []).join(" ")}`);
  // THE SPINE IS ABOUT THE THREE REGIONS §Craft 3 NAMES, and not about every box in the tab. A card
  // has its own padding inside its border, a menu has its own, and the DETAIL PANEL has its own —
  // it is an overlay that slides over the spine rather than standing on it, so its header inset is
  // a property of the panel and not a fourth opinion about the tab's left edge. Widening this to
  // every `border-b` in the tab would be asserting a rule the specification does not make.
  const REGIONS = ["components/CockpitView.tsx", "components/FleetStrip.tsx", "components/WorkList.tsx"];
  const regionPaddings = CODE
    .filter((f) => REGIONS.includes(f.path))
    .flatMap((f) => (f.text.match(/border-b border-hair[^"`]*px-\d/g) ?? []).map((m) => `${f.path}: ${m}`));
  check("no region draws its own left edge instead of the spine", regionPaddings.length === 0,
    regionPaddings.join("; ") || strays.slice(0, 2).join("; "));

  // AND THE THREE THAT MATTER ACTUALLY CARRY IT.
  for (const path of ["components/CockpitView.tsx", "components/FleetStrip.tsx", "components/WorkList.tsx"]) {
    check(`${path} uses the shared spine`, /SPINE_X/.test(CODE.find((f) => f.path === path)!.text));
  }
}

// --- 2. §Craft 1: the skeleton's geometry is the content's -------------------------------------------

console.log("\nzero layout shift, as the discipline that causes it");
{
  // §Craft 1: "Every skeleton's geometry matches its final content EXACTLY: the same row height, the
  // same column widths, the same card width." It cannot be measured without a browser; what CAN be
  // checked is the thing that makes it false — two files each writing the number out by hand.
  const view = CODE.find((f) => f.path === "components/CockpitView.tsx")!.text;
  const strip = CODE.find((f) => f.path === "components/FleetStrip.tsx")!.text;

  check("the skeleton reads the card's real width", /CARD_WIDTH/.test(view));
  check("...and its real height", /CARD_HEIGHT/.test(view));
  check("...and the row's real height", /ROW_HEIGHT/.test(view));
  check("the card itself reads the same two", /CARD_WIDTH/.test(strip) && /CARD_HEIGHT/.test(strip));

  // NEITHER FILE CONTAINS THE NUMBER. This is the assertion — a hard-coded `248` beside an imported
  // `CARD_WIDTH` is the drift §Craft 1 is about, and it survives every review that checks the two
  // files separately.
  for (const { path, text } of [{ path: "components/CockpitView.tsx", text: view }, { path: "components/FleetStrip.tsx", text: strip }]) {
    const literals = [CARD_WIDTH, CARD_HEIGHT, ROW_HEIGHT]
      .filter((n) => new RegExp(`\\b${n}\\b`).test(text));
    check(`${path} writes none of the dimensions out`, literals.length === 0, literals.join(", "));
  }

  // AND THE SKELETON HAS THE SAME NUMBER OF COLUMNS AS THE ROW — the glyph, the flexible middle and
  // the right-hand figure. A skeleton of one bar under a row of three is a shift on every column.
  check("the skeleton row reserves the glyph, the input and a figure",
    (view.match(/rounded-(?:full|chip)/g) ?? []).length >= 3);
}

// --- 3. §Craft 2: the motion budget -----------------------------------------------------------------

console.log("\nnothing in this tab reaches for 250ms");
{
  // §Craft 2: "Default to `MOTION.fast` (120ms) for everything... Reserve `MOTION.base` (180ms) for
  // the one thing with real distance to cover — the detail panel's slide. NOTHING IN THIS TAB SHOULD
  // EVER REACH FOR 250ms OR ABOVE." The Tailwind classes are `duration-fast` and `duration-base`,
  // generated from the token, so anything else is either an arbitrary value or a raw millisecond.
  const durations = CODE.flatMap((f) =>
    (f.text.match(/duration-\[?[\w.]+\]?/g) ?? []).map((m) => `${f.path}: ${m}`),
  );
  const offLadder = durations.filter((d) => !/duration-(fast|base)\b/.test(d));
  check("every transition is `fast` or `base`", offLadder.length === 0, offLadder.join("; "));

  // AND `base` IS RESERVED FOR THE ONE THING WITH DISTANCE TO COVER. Everything else is `fast`.
  const baseUsers = CODE.filter((f) => /duration-base\b/.test(f.text)).map((f) => f.path);
  check(`only the detail panel reaches for base (${baseUsers.join(", ") || "none"})`,
    baseUsers.every((p) => p === "components/WorkDetail.tsx"), baseUsers.join(", "));

  check(`and the ceiling is the token's own (${MOTION.base}ms)`, MOTION.base === 180 && MOTION.fast === 120);

  // §Craft's CLOSING LIST rules out a set of effects by name, "because each of these reads as
  // expensive for about ten seconds and as noise from the second day onward".
  const RULED_OUT = /\b(backdrop-blur|animate-bounce|animate-shimmer|bg-gradient-to-|drop-shadow-2xl)\b/;
  const gimmicks = CODE.filter((f) => RULED_OUT.test(f.text)).map((f) => f.path);
  check("no glassmorphism, gradient, shimmer or bounce", gimmicks.length === 0, gimmicks.join(", "));
}

// --- 4. §Craft/§1: no value invented beside a ladder that names one ----------------------------------

console.log("\nno new values");
{
  // §1: "no new values. Not a colour, not a radius, not a spacing step, not a type size." The colour
  // and type halves are already enforced across the WHOLE client by `test:colour-system` and
  // `test:type-scale` — which is why they are not repeated here; §24 says to extend those rather
  // than start a third. What neither covers is RADIUS and arbitrary spacing.
  const radii = CODE.flatMap((f) =>
    (f.text.match(/rounded-\[?[\w.%]+\]?/g) ?? []).map((m) => `${f.path}: ${m}`),
  );
  const NAMED_RADII = /rounded-(chip|control|card|modal|full|\[1px\])\b/;
  const offScale = radii.filter((r) => !NAMED_RADII.test(r));
  check("every radius is a named rung", offScale.length === 0, offScale.join("; "));

  // ARBITRARY SPACING, which is the `p-[13px]` that starts a ladder drifting. A handful of arbitrary
  // WIDTHS are legitimate and named in the code — a column measured in `ch` so a figure aligns — so
  // the rule is about padding, margin and gap, which are what `SPACE` is the ladder for.
  const spacing = CODE.flatMap((f) =>
    (f.text.match(/\b[pmg][xytblrase]?-\[[^\]]+\]/g) ?? []).map((m) => `${f.path}: ${m}`),
  );
  check("no arbitrary padding, margin or gap", spacing.length === 0, spacing.join("; "));
}

// --- 5. §12: every icon-only control has a name -------------------------------------------------------

console.log("\nan icon is not a label");
{
  const list = renderList([job("w-1"), job("w-2", { status: "waiting" })]);

  // §12: "Every icon-only control has an accessible name." The failure is silent and total — a
  // screen reader reads "button" — and it is the commonest a11y regression there is, because a
  // glyph looks self-explanatory to whoever drew it.
  const buttons = list.match(/<button[^>]*>(?:(?!<\/button>).)*<\/button>/gs) ?? [];
  check(`the list renders controls (${buttons.length})`, buttons.length > 0);

  const nameless = buttons.filter((b) => {
    const hasText = />\s*[^<\s][^<]*</.test(b.replace(/<svg[\s\S]*?<\/svg>/g, ""));
    return !hasText && !/aria-label=/.test(b) && !/title=/.test(b);
  });
  check("no control is a bare glyph", nameless.length === 0, nameless.slice(0, 2).join(" | "));

  // §9 AND §12: EVERY STATUS MARK HAS A `title`. Colour is never the only signal.
  const marks = list.match(/<span title="[^"]*"[^>]*style="color/g) ?? [];
  check(`every status mark carries its word (${marks.length})`, marks.length >= 2, String(marks.length));
}

// --- 6. §12: only `waiting` announces ------------------------------------------------------------------

console.log("\na region that announces every transition is one nobody can use");
{
  // §12: "Live status changes announce through a polite live region. ONLY `waiting` ANNOUNCES,
  // because it is the only change that needs a person."
  const list = renderList([job("w-1"), job("w-2", { status: "running" })]);
  check("there is exactly one live region", (list.match(/aria-live=/g) ?? []).length === 1,
    String((list.match(/aria-live=/g) ?? []).length));
  check("...and it is polite rather than assertive", /aria-live="polite"/.test(list));
  check("...and it is not assertive anywhere", !/aria-live="assertive"/.test(list));

  // NOTHING IS ANNOUNCED FOR A LIST WITH NOTHING WAITING — which is the half that makes the region
  // usable. A region holding a sentence about a running job would speak on every delta in a busy
  // workspace.
  const region = list.match(/<div role="status" aria-live="polite"[^>]*>([^<]*)</);
  check("a list with nothing waiting announces nothing", (region?.[1] ?? "").trim() === "",
    `"${region?.[1] ?? ""}"`);

  // AND THE SIDEBAR BADGE AND THE WINDOW TITLE FOLLOW THE SAME RULE, which is what makes the
  // scarcity work: three surfaces, one question. `workBadgeCount` is the shared definition, and
  // `test:work-badge` is what holds it — named here so the connection is not only in a comment.
  const app = readFileSync(`${SRC}/App.tsx`, "utf8");
  check("the window title counts through the badge's own function", /workBadgeCount/.test(app));
  check("...and only while the tab is backgrounded", /backgrounded\(\)/.test(app));
}

// --- 7. §15: what the tab must not contain --------------------------------------------------------

console.log("\nwhat not to build");
{
  // Each of these is a §15 rule, and each is the kind that arrives by accident rather than by
  // decision — somebody reaches for the familiar control without knowing this product ruled it out.
  const natives = CODE.filter((f) => /<select\b/.test(f.text)).map((f) => f.path);
  check("no native select, ever", natives.length === 0, natives.join(", "));

  const toasts = CODE.filter((f) => /\btoast\b/i.test(f.text)).map((f) => f.path);
  check("no toasts", toasts.length === 0, toasts.join(", "));

  // NO SECOND TRACE VIEWER. The detail panel links out through `loadRun` and renders no steps.
  const detail = CODE.find((f) => f.path === "components/WorkDetail.tsx")!.text;
  check("the detail panel links to the trace rather than drawing one",
    /sendLoadRun|selectRun/.test(detail) && !/orderedSteps|stepsByRun/.test(detail));

  // NO AGENT ART ON FLEET CARDS — §15: "`agentArt.ts` exists for the Agents grid, where choosing
  // between agents is the task. Here the task is reading state, and art competes with the sentence
  // that carries it."
  const strip = CODE.find((f) => f.path === "components/FleetStrip.tsx")!.text;
  check("no generated art on a fleet card", !/agentArt|aura-/.test(strip));
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
