// §8's `test:sidebar-identity`: the name never truncates, the category does, and `Uncategorized`
// renders as name-only.
//
// ALL THREE ARE RULES ABOUT WHAT IS MISSING FROM A ROW, which is why none of them can be checked by
// looking at a screenshot of a comfortable sidebar. They only appear at a width somebody has dragged
// narrow, on an agent whose name is long, in a workspace where categories were set — and the way
// each goes wrong is silent:
//
//   THE NAME TRUNCATING is the default behaviour of a flex row, because the name is the longest
//   item and shrinks first. It renders `invoice_par…` beside `invoice_parser_v2` — two agents that
//   read as one, in the list whose whole job is telling them apart.
//
//   THE CATEGORY NOT TRUNCATING pushes the row wider than the sidebar and the overflow is clipped
//   with no mark at all, which reads as a category that happens to end mid-word.
//
//   `Uncategorized` SHOWING is a column of identical noise down every list that predates the
//   feature — which is every list, on the day it ships.
//
// STRUCTURAL, NOT A CLICK TEST. What is asserted is which element carries the truncation, which is
// a fact about the markup — and `Truncate` measures at runtime, so a suite that tried to observe an
// actual ellipsis would be asserting against a layout engine it does not have.
//
//   npm run test:sidebar-identity

import { readFileSync } from "node:fs";
import { createElement } from "react";

import { AgentIdentityLine, identityTitle } from "../components/AgentIdentityLine.tsx";
import { UNCATEGORIZED } from "./agentCategories.ts";
import { markup } from "./testRender.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const line = (name: string, category: string | null, emoji: string | null = "🐢"): string =>
  markup(createElement(AgentIdentityLine, { emoji, name, category }));

const LONG = "invoice_reconciliation_and_vendor_chasing_agent";

// --- 1. the name --------------------------------------------------------------------------------

console.log("\nthe name never truncates");
{
  const html = line(LONG, "Billing");
  check("the whole name is in the markup", html.includes(LONG), html.slice(0, 200));

  // `shrink-0` IS THE RULE, and its absence is the bug. Without it the flex row shrinks the name
  // first, because it is the longest item — which is exactly backwards.
  const nameSpan = /<span class="([^"]*)"[^>]*>invoice_reconciliation/.exec(html);
  check("the name is a plain span, not a Truncate", nameSpan !== null, html.slice(0, 240));
  check("...that refuses to shrink", (nameSpan?.[1] ?? "").includes("shrink-0"), nameSpan?.[1] ?? "");
  check("...and does not wrap", (nameSpan?.[1] ?? "").includes("whitespace-nowrap"), nameSpan?.[1] ?? "");
  check("...and carries no ellipsis treatment",
    !(nameSpan?.[1] ?? "").includes("text-ellipsis") && !(nameSpan?.[1] ?? "").includes("overflow-hidden"),
    nameSpan?.[1] ?? "");
}

// --- 2. the category ----------------------------------------------------------------------------

console.log("\nthe category is what gives");
{
  const html = line("Stacey", "Personal Assistant");
  check("the category is on the line", html.includes("Personal Assistant"), html.slice(0, 240));
  check("...with §7's em dash", html.includes("— Personal Assistant"), html.slice(0, 240));

  // THROUGH THE EXISTING `Truncate`, which is §7's other instruction: "no new truncation logic, and
  // no character-count rule, because the correct cut depends on rendered width, not on letters."
  // `Truncate`'s prose variant is `overflow-hidden` + `text-ellipsis` + `min-w-0`, and `min-w-0` is
  // the one that actually lets a flex child shrink at all.
  const cat = /<span class="([^"]*)"[^>]*>— Personal Assistant/.exec(html)
    ?? /class="([^"]*)"[^>]*title="Personal Assistant"/.exec(html);
  const cls = cat?.[1] ?? html;
  check("the category truncates", cls.includes("text-ellipsis"), cls.slice(0, 160));
  check("...and can shrink", cls.includes("min-w-0"), cls.slice(0, 160));
  // `flex-1 basis-0` IS WHAT LETS THE SLOT REACH ZERO. Sized to its content instead, the box is
  // clipped by the row rather than shrunk.
  check("...all the way to nothing",
    cls.includes("flex-1") && cls.includes("basis-0"), cls.slice(0, 160));

  // AND BELOW A FLOOR IT IS NOT DRAWN AT ALL, which was found by looking at a real sidebar rather
  // than by reading §7. At fourteen pixels `text-overflow: ellipsis` renders the em dash alone —
  // the dash is narrower than the ellipsis that would have replaced it — so a long-named agent
  // came out as `Doc Indexer —`: the dangling separator §7 warns about, arriving through the
  // layout instead of through the markup. Asserted on the source, because the floor is a
  // measurement at runtime and this suite has no layout engine.
  const source = readSource("src/components/AgentIdentityLine.tsx");
  check("there is a measured floor below which the category is dropped",
    /CATEGORY_FLOOR/.test(source) && /clientWidth\s*>=\s*CATEGORY_FLOOR/.test(source), "no floor found");
  // IT DECIDES VISIBILITY, NEVER WHERE THE TEXT IS CUT. §7 forbids a second truncation rule and is
  // right to; the cut is still `Truncate`'s, still measured, and still the only one in the row.
  check("...and it is not a second way of cutting text",
    !/slice\(|substring\(|length\s*>\s*\d+/.test(source), "the line does its own cutting");
  check("the full category is on hover", html.includes('title="Personal Assistant"'), html.slice(0, 300));

  // A LONG CUSTOM ONE IS THE SAME PATH. I6 means a category can be any string, so the rule cannot
  // be "presets fit and custom ones do not" — it is one measured cut for both.
  const custom = line("Stacey", "Vendor chasing and reconciliation across three systems");
  check("a forty-character custom category takes the same treatment",
    custom.includes("text-ellipsis") && custom.includes("Vendor chasing"), custom.slice(0, 200));
}

// --- 3. Uncategorized ---------------------------------------------------------------------------

console.log("\nUncategorized renders as the name alone");
{
  const html = line("Stacey", UNCATEGORIZED);
  check("the placeholder is not shown", !html.includes(UNCATEGORIZED), html);
  // AND THE EM DASH GOES WITH IT. A separator with nothing after it is a worse artefact than the
  // placeholder it was separating.
  check("...and neither is a dangling em dash", !html.includes("—"), html);
  check("the name is still there", html.includes("Stacey"));

  for (const [label, value] of [["null", null], ["empty", ""]] as const) {
    const h = line("Stacey", value);
    check(`a ${label} category renders the name alone`, !h.includes("—"), h);
  }
}

// --- 4. the hover case --------------------------------------------------------------------------

console.log("\nthe row's title carries what the cut gave up");
{
  check("name and category, in §7's shape",
    identityTitle("Stacey", "Billing") === "Stacey — Billing", identityTitle("Stacey", "Billing"));
  check("the neutral value is left out",
    identityTitle("Stacey", UNCATEGORIZED) === "Stacey", identityTitle("Stacey", UNCATEGORIZED));
  check("...as is a missing one", identityTitle("Stacey", null) === "Stacey");

  // AND THE ROW ACTUALLY USES IT. The component cannot assert this about its caller, and the caller
  // is where §7's sentence lands — a title that stayed as the old connector string would leave the
  // truncated category unreachable.
  const sidebar = readSource("src/components/Sidebar.tsx");
  check("the sidebar row puts it in its title", sidebar.includes("identityTitle(agent.name, agent.category)"),
    "identityTitle not found in Sidebar.tsx");
}

// --- 5. no 3D down here -------------------------------------------------------------------------

console.log("\nI4: the sidebar is the emoji's, not the character's");
{
  // "A glossy 3D character at 16px is a smudge, and running the renderer to produce a smudge is the
  // worst of both." The sidebar is the surface that argument is about, and the temptation to put the
  // avatar here is exactly what it is guarding against.
  const sidebar = readSource("src/components/Sidebar.tsx");
  check("the sidebar mounts no avatar", !sidebar.includes("GlossAvatar"), "GlossAvatar in Sidebar.tsx");
  const identity = readSource("src/components/AgentIdentityLine.tsx");
  check("nor does the identity line", !identity.includes("GlossAvatar"));
  check("it draws the emoji instead", identity.includes("AgentEmoji"));
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);

/** One file, as text. The suites here read source when the claim is about a call site. */
function readSource(path: string): string {
  return readFileSync(path, "utf8");
}
