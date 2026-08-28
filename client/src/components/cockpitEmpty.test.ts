// §24's `test:cockpit-empty`: "the three empty states are distinguishable and each carries its
// action".
//
// DISTINGUISHABLE IS THE PROPERTY AND IT IS NOT ABOUT WORDING. §10 gives the reason: the three
// "must be distinguishable at a glance because they call for THREE DIFFERENT ACTIONS" — deploy
// something, give it something to do, or undo a filter. A reader who cannot tell which state they
// are in takes the wrong one, and the expensive version of that mistake is specific: an operator
// with forty jobs, looking at a list filtered to `failed`, being told nothing has been asked of
// their agents, and going off to deploy a second agent.
//
// SO THE SUITE RENDERS ALL THREE AND COMPARES THEM, rather than asserting each one's text. Three
// sentences that differ by a word pass a per-state assertion and fail a person at a glance; three
// that differ in what they OFFER cannot be confused.
//
// AND THE THIRD STATE'S TRIGGER IS THE SUBTLE ONE. §8 defaults the scope to `mine`, so a member of
// a busy workspace who has never touched a control is looking at a FILTERED list — which means the
// default state of the tab for that person is the third and not the second. A `filtered` test that
// only counted explicit filter presses would put the wrong sentence in front of exactly the person
// §10 is worried about.
//
//   npm run test:cockpit-empty

import { createElement } from "react";

import { EMPTY } from "../lib/cockpitCopy.ts";
import { markup, seed } from "../lib/testRender.ts";
import { useWorkStore } from "../store/workStore.ts";
import type { WorkFilters } from "../types.ts";
import { CockpitView } from "./CockpitView.tsx";
import { WorkList } from "./WorkList.tsx";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const NO_COUNTS = { queued: 0, running: 0, waiting: 0, succeeded: 0, failed: 0, cancelled: 0 };

/** Put the store in one of the states and render whichever component owns it. */
function render(state: {
  loaded: boolean;
  anyLive: boolean;
  filters: WorkFilters;
}, which: "view" | "list"): string {
  seed(useWorkStore, {
    items: [], pending: [], atTop: true, nextCursor: null,
    counts: NO_COUNTS, workspaceCounts: NO_COUNTS,
    fleet: [], open: null, openingId: null, logs: null, error: null, notice: null,
    ...state,
  });
  return markup(createElement(which === "view" ? CockpitView : WorkList));
}

const filters = (patch: Partial<WorkFilters> = {}): WorkFilters =>
  ({ scope: "all", status: null, agentId: null, ...patch });

// The three states, each rendered by whichever component owns it. The first is the shell's,
// because it replaces the whole tab; the other two are the list's, because the strip above them
// and the composer below them are both still real.
const noAgents = render({ loaded: true, anyLive: false, filters: filters() }, "view");
const noWork = render({ loaded: true, anyLive: true, filters: filters() }, "list");
const filtered = render({ loaded: true, anyLive: true, filters: filters({ status: "failed" }) }, "list");

// --- 1. three states, three sentences ---------------------------------------------------------------

console.log("\nthree different actions, so three different sentences");
{
  check("no agents says so", noAgents.includes(EMPTY.noAgents.title), EMPTY.noAgents.title);
  check("no work says so", noWork.includes(EMPTY.noWork.title), EMPTY.noWork.title);
  check("filtered to nothing says so", filtered.includes(EMPTY.filtered.title), EMPTY.filtered.title);

  // AND NO TWO OF THEM SAY THE SAME THING. Not by comparing the constants — which would be
  // comparing the code against itself — but by checking each state does NOT carry the others'.
  check("the no-agents state does not claim nothing has been asked",
    !noAgents.includes(EMPTY.noWork.title));
  check("the no-work state does not claim a filter is hiding things",
    !noWork.includes(EMPTY.filtered.title), EMPTY.filtered.title);
  check("the filtered state does not claim nothing has been asked",
    !filtered.includes(EMPTY.noWork.title), EMPTY.noWork.title);
}

// --- 2. each carries its action ---------------------------------------------------------------------

console.log("\neach one says what to do about it");
{
  // §10: the first names the Deploy panel, "with the action. This is the ONLY `full` empty state in
  // the tab — it is a genuine state of the product, not a gap that clears in ten seconds."
  check("no agents names where to go", noAgents.includes("Deploy panel"), EMPTY.noAgents.hint);

  // §10: the third "names the filter and offers to clear it", and the offer is a real control —
  // a sentence that described the way back without providing one would end in the reader hunting.
  check("the filtered state offers to clear the filter",
    filtered.includes(EMPTY.filtered.action), EMPTY.filtered.action);
  check("...and the offer is a button rather than prose",
    new RegExp(`<button[^>]*>[^<]*${EMPTY.filtered.action}`).test(filtered),
    EMPTY.filtered.action);

  // THE SECOND HAS NO CONTROL OF ITS OWN, AND THAT IS CORRECT RATHER THAN AN OMISSION. Its action
  // is the composer directly below it — §10: "`EmptyState` `line` in the list region, with the
  // composer focused." A button here would be a second way to reach a control already on screen.
  check("the no-work state does not invent a control", !noWork.includes(EMPTY.filtered.action));
}

// --- 3. the size §10 assigns each -------------------------------------------------------------------

console.log("\nfull for a state of the product, line for a gap that clears");
{
  // `EmptyState`'s `full` centres in `h-full`; `line` is a flow row at `text-caption`. The class is
  // what tells them apart in the markup, and the distinction is the one that file argues at length:
  // "a full-height centred illustration for a condition that clears itself is theatre".
  check("no agents gets the full treatment", /class="[^"]*\bh-full\b/.test(noAgents),
    noAgents.slice(noAgents.indexOf("No agents") - 200, noAgents.indexOf("No agents")).slice(-120));
  check("no work does not", !/\bh-full\b/.test(noWork.slice(0, noWork.indexOf(EMPTY.noWork.title))));
  check("...nor does the filtered state",
    !/\bh-full\b/.test(filtered.slice(0, filtered.indexOf(EMPTY.filtered.title))));
}

// --- 4. the default scope is a filter, which is the subtle one --------------------------------------

console.log("\nthe state a member of a busy workspace actually sees");
{
  // §8 DEFAULTS THE SCOPE TO `mine`, so somebody who has never touched a control is looking at a
  // filtered list — and the wrong sentence here is the expensive one: an operator told nothing has
  // been asked of their agents, over a workspace full of a colleague's jobs, goes and deploys.
  const defaults = render({ loaded: true, anyLive: true, filters: filters({ scope: "mine" }) }, "list");
  check("the default scope counts as a filter", defaults.includes(EMPTY.filtered.title),
    EMPTY.filtered.title);
  check("...and is not told nothing has been asked", !defaults.includes(EMPTY.noWork.title));

  // AND AN AGENT FILTER SET BY A FLEET CARD COUNTS TOO.
  const byAgent = render({ loaded: true, anyLive: true, filters: filters({ agentId: "a" }) }, "list");
  check("an agent filter counts as a filter", byAgent.includes(EMPTY.filtered.title));
}

// --- 5. loading is not empty ------------------------------------------------------------------------

console.log("\nwe have not been told yet is a third thing");
{
  // §10: LOADING IS A SKELETON, NOT A SPINNER — and, more importantly here, not a zero state.
  // Collapsing `loaded: false` into "there is nothing" would put "No agents are live yet" in front
  // of somebody whose fleet is still on the wire, which is the same class of mistake as the three
  // states being indistinguishable, one step earlier.
  const loading = render({ loaded: false, anyLive: false, filters: filters() }, "view");
  check("a tab that has not been told yet claims nothing", !loading.includes(EMPTY.noAgents.title),
    EMPTY.noAgents.title);
  check("...and shows a skeleton instead", /animate|bg-active/.test(loading));
  check("...which is not a spinner", !/animate-spin/.test(loading));
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
