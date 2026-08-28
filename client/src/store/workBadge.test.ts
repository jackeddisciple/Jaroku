// The badge counts `waiting` and nothing else, and this is the test that fails if somebody fixes it.
//
// §9 ASKS FOR THIS SUITE BY NAME: "The Inbox has a test that fails if somebody 'fixes' its badge to
// count more; write the equivalent here." The reason is behavioural rather than aesthetic, and it is
// worth restating because it reads as a restriction: a badge that counts everything never reaches
// zero, and a badge that is never zero is one people train themselves to ignore. `waiting` is the
// only state where a HUMAN is the blocker, and that is the only thing a badge should ever mean.
//
// THE THREE IT MUST NOT COUNT ARE EACH A DIFFERENT ARGUMENT, so each has its own case:
//
//   `running` is the product WORKING. A badge lit whenever an agent was doing something would be
//   lit permanently in exactly the workspaces this feature is for.
//   `failed` is OVER. It is worth seeing and nobody is blocked on it; the Inbox raises the failures
//   that need a decision, which is what that board is for.
//   `queued` is a MOMENT. It lasts as long as one HTTP request, so a badge counting it would
//   flicker rather than inform.
//
// AND THE SECOND HALF IS THE ONE A UNIT TEST USUALLY MISSES: it reads the SIDEBAR'S SOURCE and
// fails if the badge is drawn from anything but this function. A correct `workBadgeCount` beside a
// component that renders `counts.running + counts.waiting` is two definitions, and the one that
// drifts is the one nobody is testing.
//
//   npm run test:work-badge

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { WorkCounts } from "../types.ts";
import { workBadgeCount } from "./workStore.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const counts = (patch: Partial<WorkCounts>): WorkCounts => ({
  queued: 0, running: 0, waiting: 0, succeeded: 0, failed: 0, cancelled: 0, ...patch,
});

console.log("\nwhat the badge counts");
{
  check("nothing waiting is zero", workBadgeCount(counts({})) === 0);
  check("one job waiting is one", workBadgeCount(counts({ waiting: 1 })) === 1);
  check("three are three", workBadgeCount(counts({ waiting: 3 })) === 3);
}

console.log("\nwhat it must not count");
{
  // RUNNING IS THE PRODUCT WORKING. Forty jobs in flight is a busy workspace, not forty things
  // waiting on a person — and a badge that lit for it would be lit permanently in exactly the
  // workspaces the Cockpit exists for.
  check("forty running jobs light nothing", workBadgeCount(counts({ running: 40 })) === 0);
  // FAILED IS OVER. Nobody is blocked on it, and the Inbox is what raises the failures that need a
  // decision. A badge here would be a second, quieter copy of that board.
  check("failures light nothing", workBadgeCount(counts({ failed: 12 })) === 0);
  check("...nor do cancellations", workBadgeCount(counts({ cancelled: 5 })) === 0);
  check("...nor successes", workBadgeCount(counts({ succeeded: 900 })) === 0);
  // QUEUED IS A MOMENT — it lasts as long as one HTTP request — so a badge counting it would
  // flicker rather than inform.
  check("queued lights nothing", workBadgeCount(counts({ queued: 4 })) === 0);
  // THE WHOLE BOARD AT ONCE, which is the shape a "fix" actually takes: somebody adds `+
  // counts.failed` because a failure felt important, and the badge stops reaching zero.
  check(
    "a busy, broken, finished workspace with nothing waiting still shows nothing",
    workBadgeCount(counts({ queued: 4, running: 40, failed: 12, cancelled: 5, succeeded: 900 })) === 0,
  );
  check(
    "...and the same board with two waiting shows exactly two",
    workBadgeCount(counts({ queued: 4, running: 40, failed: 12, cancelled: 5, succeeded: 900, waiting: 2 })) === 2,
  );
}

console.log("\nthe sidebar draws it from here and nowhere else");
{
  // THROUGH `new URL` RATHER THAN `node:path`, which the client deliberately does not shim: this
  // package has no `@types/node` on purpose — a browser bundle that could typecheck `process` is a
  // mistake that compiles — and `node-shims.d.ts` says adding to it should feel like a decision.
  // Resolving a sibling file needs no path module.
  const sidebar = readFileSync(fileURLToPath(new URL("../components/Sidebar.tsx", import.meta.url)), "utf8");

  check("the sidebar imports the badge function", /workBadgeCount/.test(sidebar));
  // A CORRECT FUNCTION BESIDE A COMPONENT THAT ADDS UP FIELDS IS TWO DEFINITIONS, and the one that
  // drifts is the one nobody is testing.
  //
  // NARROWED TO READS OFF THE WORK STORE, because `counts.running` also names the agent list's own
  // tallies further down this file and those have nothing to do with this badge. What a drifted
  // badge would have to look like is a selector reaching into the work store's counts.
  const drifted = sidebar.match(/useWorkStore\(\(s\) => s\.(workspaceC|c)ounts\.\w+\)/g) ?? [];
  check(
    `no status count is read off the work store directly (${drifted.join(", ") || "none is"})`,
    drifted.length === 0,
  );
  // AND THE POSITIVE HALF OF THE SAME RULE: a sidebar that imported `workBadgeCount` and then
  // rendered something else would satisfy both checks above and still be wrong.
  //
  // OFF `workspaceCounts`, NOT `counts`. The latter follows the Cockpit's scope, so a badge drawn
  // from it would drop to nothing the moment somebody switched that tab to "Mine" — reporting a
  // filter instead of the workspace, on the one piece of chrome whose job is being right while
  // nobody is looking at the tab.
  check("...and the badge is drawn through it", /workBadgeCount\(s\.workspaceCounts\)/.test(sidebar));
  check("...off the workspace's counts rather than the page's", !/workBadgeCount\(s\.counts\)/.test(sidebar));
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
// The client has no `@types/node` on purpose — see `node-shims.d.ts` — so `process` is reached the
// way `reset.test.ts` reaches it rather than by widening the shim for one line.
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
