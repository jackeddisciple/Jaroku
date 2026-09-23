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
// and the agent faces, nothing hashes into this list, so reordering it is harmless. It is asserted
// because a hand-maintained list of twenty-five drifts into the order things were thought of in, and
// twenty-five items in no order is a list you read all of to find one.
//
//   npm run test:agent-category

import { readFileSync } from "node:fs";
import { createElement } from "react";

import { categoryRows } from "../components/CategoryPicker.tsx";
import { NewAgentDialog } from "../components/NewAgentDialog.tsx";
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
  const serverSources = ["../server/src/db/repositories/agents.ts", "../server/src/agents/category.ts"];
  const leaked = serverSources.filter((f) => readFileSync(f, "utf8").includes("Email Triage"));
  check("the server holds no copy of the presets", leaked.length === 0, leaked.join(", "));
}

console.log("\n§6's picker offers all of them, and the dialog does not lay them out");
{
  // ASKED OF THE ROW BUILDER, NOT OF THE MARKUP. The old check scraped the rendered dialog for
  // each preset, which only worked while all forty were chips on the form; they are behind a
  // popover now and there is nothing to scrape until somebody clicks. `categoryRows` IS the
  // picker's logic, so asking it is asking the thing that would actually drop a group — the
  // silent failure this file exists for.
  const all = categoryRows("");
  const offered = all.map((r) => r.value);
  const missing = AGENT_CATEGORIES.filter((c) => !offered.includes(c));
  check("every preset is reachable", missing.length === 0, missing.join(", "));
  check("...in the order the groups declare them",
    offered.join(",") === AGENT_CATEGORIES.join(","));
  check("...and nothing else is", all.every((r) => r.kind === "preset"));

  // EVERY GROUP HAS A HEADING, and it is derived rather than hand-written, so a filtered list
  // cannot strand one over nothing.
  const heads = new Set(all.map((r) => (r.kind === "preset" ? r.group : "")));
  check("each row knows its group",
    CATEGORY_GROUPS.every((g) => heads.has(g.label)) && heads.size === CATEGORY_GROUPS.length,
    [...heads].join(","));

  // THE FILTER NARROWS AND DOES NOT PROPOSE. Typing part of a preset's name should find it, not
  // offer to invent a category spelled the same way with different capitals.
  const bill = categoryRows("bill");
  check("a partial match finds the preset", bill.some((r) => r.value === "Billing"));
  check("...and offers nothing custom", bill.every((r) => r.kind === "preset"));
  check("the match is case-blind", categoryRows("BILL").length === bill.length);

  // AND THE SEARCH FIELD IS THE CUSTOM ENTRY, which is what replaced "Name your own" and the
  // input it revealed. The offer is the ONLY row when nothing matches, and it is never made on
  // whitespace: `normalizeCategory("")` is `Uncategorized`, and offering to name a category
  // "Uncategorized" is offering the absence of one as a choice.
  const own = categoryRows("queue watching");
  check("an unmatched query offers itself", own.length === 1 && own[0]?.kind === "custom");
  check("...spelled as it was typed", own[0]?.value === "queue watching");
  check("...trimmed", categoryRows("  vendor chasing  ")[0]?.value === "vendor chasing");
  check("whitespace is no filter at all", categoryRows("   ").length === AGENT_CATEGORIES.length);
  check("...and offers nothing custom", categoryRows("   ").every((r) => r.kind === "preset"));

  // A STRUCTURAL TEST OF THE DIALOG, for the two things about it that go wrong silently: the order
  // of its questions, and whether the taxonomy has crept back onto the form.
  const html = markup(
    createElement(NewAgentDialog, { open: true, onClose: () => undefined }),
  );

  // THE ORDER, AND IT IS THE OTHER WAY ROUND FROM §6's FIRST DRAFT. The sentence that says what
  // the agent is FOR is the field this dialog is for; the category is a word, on one line, under
  // it. It asked them category-first with all forty presets laid out, which put the brief below
  // six hundred pixels of vocabulary in a dialog that had to scroll.
  //
  // THE NAME FIELD IS GONE AND ITS ABSENCE IS ASSERTED. It used to be first; the name is paired
  // with the face and given at creation, so a field for it was a question whose answer the product
  // already held. A form that asks for something it will then ignore is the failure this checks for.
  const at = (needle: string): number => html.indexOf(needle);
  check("the dialog asks for no name", at(">Name<") === -1, String(at(">Name<")));
  check("what it should help with comes before the category",
    at(">What should it help you with?<") >= 0
      && at(">What should it help you with?<") < at(">Category<"),
    `${at(">What should it help you with?<")} / ${at(">Category<")}`);

  // AND THE FORTY ARE NOT ON THE FORM. The brief's rule, and the reason for the popover: a
  // category selector is one line until somebody wants the list. This catches a revert to chips
  // as surely as the old check caught a dropped group.
  const onForm = AGENT_CATEGORIES.filter((c) => html.includes(`>${c}<`));
  check("the taxonomy is not laid out in the dialog", onForm.length === 0, onForm.join(", "));
  check("...it is behind one trigger",
    html.includes("Choose a category\u2026") && html.includes('aria-haspopup="listbox"'));

  // AND THERE IS NO STEP HERE FOR WHAT AN AGENT LOOKS LIKE, which is now true of every surface in
  // the product rather than just this one. An agent is given one of the eleven faces, and the name
  // paired with it, by its position in its workspace's creation order — so a picker here would be a
  // control for a decision nothing can make, on a form whose job is to get a brief written.
  check("the dialog offers no picture picker",
    !/>(?:Avatar|Face|Picture)</.test(html));

  // AND IT IS A DIALOG, not a div drawn on top of the application — `useDialog`'s whole argument.
  check("it announces itself as a dialog",
    html.includes('role="dialog"') && html.includes('aria-modal="true"'));

  // WITH A WAY OUT THAT IS NOT THE BACKDROP. The redesign added it; a modal whose only dismissal
  // is a click on the dark area behind it is a modal some people cannot leave.
  check("it has a close button", html.includes('aria-label="Close (Esc)"'));
}

console.log("\nthe agent detail changes a category with the same picker that set it");
{
  // TWO CONTROLS FOR ONE DECISION was the bug: the dialog had this picker, and the detail a flat
  // wall of forty chips and a bare field with no way back to no category at all.
  const overview = readFileSync("src/components/AgentOverview.tsx", "utf8");
  check("the detail renders CategoryPicker", /<CategoryPicker\b/.test(overview));
  check("...and lays out no preset chips of its own", !/AGENT_CATEGORIES\.map/.test(overview));
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
