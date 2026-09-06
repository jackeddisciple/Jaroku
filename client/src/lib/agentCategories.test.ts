// §8's `test:agent-category`: twenty-five presets, sorted, unique; custom text round-trips; the
// column is TEXT and not an enum.
//
// THE LAST OF THOSE IS THE ONE WORTH HAVING, and it is asserted against the MIGRATION rather than
// against this file. I6 is a rule about the database — "the column is TEXT, never an enum — the list
// will change, and a migration to add 'Compliance' to a preset list would be absurd" — and the way
// it gets broken is not by editing this list. It is by somebody adding a `CHECK (category IN (...))`
// in six months because the data looked untidy, at which point every agent carrying a category
// somebody typed becomes unsaveable.
//
// THE OTHER HALF IS THE COUNT AND THE SORT, and neither indexes anything: unlike the emoji palette
// and the avatar roster, nothing hashes into this list, so reordering it is harmless. It is asserted
// because a hand-maintained list of twenty-five drifts into the order things were thought of in, and
// twenty-five items in no order is a list you read all of to find one.
//
//   npm run test:agent-category

import { readFileSync } from "node:fs";
import { createElement } from "react";

import { NewAgentDialog } from "../components/NewAgentDialog.tsx";
import { GLOSS_ROSTER } from "./gloss/roster.ts";
import { markup } from "./testRender.ts";

import {
  AGENT_CATEGORIES, CATEGORY_GROUPS, UNCATEGORIZED, isPresetCategory, normalizeCategory,
  showsCategory,
} from "./agentCategories.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

console.log("\nforty presets, grouped and sorted");
{
  check("there are forty", AGENT_CATEGORIES.length === 40, `${AGENT_CATEGORIES.length}`);
  check("they are unique", new Set(AGENT_CATEGORIES).size === AGENT_CATEGORIES.length);
  check("there are six groups", CATEGORY_GROUPS.length === 6, `${CATEGORY_GROUPS.length}`);
  check("the groups are §6's five plus Operations",
    CATEGORY_GROUPS.map((g) => g.label).join(",") === "Business,Operations,Data,Engineering,Content,General",
    CATEGORY_GROUPS.map((g) => g.label).join(","));

  // SORTED WITHIN GROUPS, not across them: the groups are ordered by expected use — Business first
  // because it is the largest and the commonest, General last because it is the fallback — and a
  // picker whose first heading is "Content" makes somebody read all five to find the one they meant.
  for (const group of CATEGORY_GROUPS) {
    check(`${group.label} is sorted`,
      JSON.stringify([...group.categories].sort()) === JSON.stringify([...group.categories]),
      group.categories.join(", "));
    check(`${group.label} is not empty`, group.categories.length > 0);
  }

  // NO GROUP IS A GRAB BAG. Nothing enforces where a category lands, so the only guard against the
  // list decaying into twenty in "Other" is that every group is small enough to scan.
  const biggest = Math.max(...CATEGORY_GROUPS.map((g) => g.categories.length));
  check("no group is longer than a glance", biggest <= 8, `${biggest}`);

  // §6'S OWN TWENTY-FIVE ARE ALL STILL HERE, BY NAME. The list grew to forty; it did not change.
  // A preset quietly renamed or dropped is a category every agent already carrying it stops
  // matching — and unlike a schema change, nothing would say so.
  const brief = [
    "Analytics", "Billing", "Code Review", "Coding", "Data Entry", "Debugging", "Design", "DevOps",
    "Documentation", "Email Triage", "Marketing", "Monitoring", "Outreach", "Personal Assistant",
    "Reporting", "Research", "Sales", "Scheduling", "Scraping", "Social Media", "Summarization",
    "Support", "Testing", "Translation", "Writing",
  ];
  const lost = brief.filter((c) => !AGENT_CATEGORIES.includes(c));
  check("every one of §6's twenty-five survives", lost.length === 0, lost.join(", "));

  // THE NEUTRAL VALUE IS NOT ONE OF THEM. It is what an agent has when nobody has answered, and
  // offering it in the picker would make "I have not decided" a thing somebody chooses on purpose.
  check("Uncategorized is not a preset", !AGENT_CATEGORIES.includes(UNCATEGORIZED));
}

console.log("\ncustom text is the same column");
{
  // I6, AT THE LEVEL A USER MEETS IT: a preset and something typed are indistinguishable once
  // stored. The only difference between them is how much typing it took.
  check("a preset is recognised", isPresetCategory("Billing"));
  check("...with surrounding space", isPresetCategory("  Billing  "));
  check("something typed is not a preset", !isPresetCategory("Vendor chasing"));
  check("a typed category round-trips", normalizeCategory("  Vendor chasing  ") === "Vendor chasing",
    normalizeCategory("  Vendor chasing  "));
  // NOT NULL MEANS EMPTY IS NOT AN OPTION. "" would render as a name, an em dash, and nothing —
  // which reads as a bug rather than as an absence.
  check("empty becomes the neutral value", normalizeCategory("   ") === UNCATEGORIZED);
  check("the neutral value stays itself", normalizeCategory(UNCATEGORIZED) === UNCATEGORIZED);

  // §7'S SIDEBAR RULE, decided here so the row does not have to know about it.
  check("Uncategorized is not shown", !showsCategory(UNCATEGORIZED));
  check("null is not shown", !showsCategory(null));
  check("empty is not shown", !showsCategory(""));
  check("a real category is shown", showsCategory("Billing"));
}

console.log("\nthe column is TEXT, and stays TEXT");
{
  // THE ASSERTION THIS SUITE EXISTS FOR, and it reads the MIGRATION rather than this file. I6 is a
  // rule about the database, and it does not get broken by editing a list — it gets broken by
  // somebody adding a CHECK constraint in six months because the data looked untidy, at which point
  // every agent carrying a category somebody typed becomes unsaveable.
  for (const dialect of ["sqlite", "postgres"]) {
    // COMMENTS STRIPPED BEFORE MATCHING, the same way `db/expandContract.ts` reads a migration: the
    // file ARGUES for TEXT over an enum at some length, and a scan that could not tell the argument
    // from the statement would fail on a migration that does exactly what it says.
    const sql = readFileSync(`../server/migrations/${dialect}/068_agent_identity.sql`, "utf8")
      .replace(/--[^\n]*/g, " ");
    const line = sql.split("\n").find((l) => /ADD COLUMN category/.test(l)) ?? "";
    check(`${dialect}: the column is TEXT`, /\bTEXT\b/.test(line), line);
    check(`${dialect}: no CHECK constraint on it`, !/CHECK\s*\(/i.test(line), line);
    check(`${dialect}: no enum type anywhere in the migration`, !/CREATE TYPE|\bENUM\b/i.test(sql));
  }

  // AND THERE IS NO SECOND COPY OF THE LIST. The server neither validates nor knows these words —
  // it stores a string — so a preset added here is a preset available immediately, with no deploy
  // ordering to think about and no drift test to keep two lists honest.
  const serverSources = ["../server/src/db/repositories/agents.ts", "../server/src/agents/avatarRoster.ts"];
  const leaked = serverSources.filter((f) => readFileSync(f, "utf8").includes("Email Triage"));
  check("the server holds no copy of the presets", leaked.length === 0, leaked.join(", "));
}

console.log("\n§6's dialog offers all of them, in this order");
{
  // A STRUCTURAL TEST, NOT A CLICK TEST. `renderToStaticMarkup` gives the markup the browser would
  // start from, which is enough for the two questions worth asking of a picker: are all
  // twenty-five actually offered, and are the three inputs in §6's order. Both go wrong silently —
  // a group left out of a `map` is a category nobody can pick and nothing says so.
  const html = markup(
    createElement(NewAgentDialog, { open: true, onClose: () => undefined }),
  );
  const missing = AGENT_CATEGORIES.filter((c) => !html.includes(`>${c}<`));
  check("every preset is on screen", missing.length === 0, missing.join(", "));
  check("...and so is the custom fallback", html.includes("Name your own"));

  // §6's ORDER, for the two inputs this dialog still asks. Name, then category — and the order is
  // the part a chip row cannot carry, which is the whole reason this is a dialog.
  const at = (needle: string): number => html.indexOf(needle);
  check("name comes before category", at(">Name<") >= 0 && at(">Name<") < at(">Category<"),
    `${at(">Name<")} / ${at(">Category<")}`);

  // AND THERE IS NO AVATAR STEP HERE. Choosing a face is asked once, on the onboarding screen, by
  // the carousel — a picker here would be a third surface competing for the same decision on a form
  // whose job is to get a brief written. An agent made from this dialog takes the avatar its uuid
  // hashes to, which is the answer the server has always given when nobody chose.
  check("the dialog offers no avatar picker",
    !html.includes(">Avatar<") && !GLOSS_ROSTER.some((r) => html.includes(`aria-label="${r.label}"`)));

  // AND IT IS A DIALOG, not a div drawn on top of the application — `useDialog`'s whole argument.
  check("it announces itself as a dialog",
    html.includes('role="dialog"') && html.includes('aria-modal="true"'));
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
