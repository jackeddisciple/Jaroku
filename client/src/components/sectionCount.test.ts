// I5 and I6: a count is a total, and empty is not zero.
//
// BOTH RULES FAIL SILENTLY AND BOTH FAIL WHILE LOOKING CORRECT, which is why they are a suite
// rather than a convention.
//
//   I5. `rows.length` over a virtualised list is the RENDER WINDOW. The Activity feed holds ten
//   thousand events and renders forty of them; a header reading "Activity 40" is a lie that looks
//   like a feature, and it changes as you scroll, which is the only symptom anybody would ever see.
//
//   I6. A count that is not yet known, rendered as `0`, is this product's strongest copy turned
//   into its most confident wrong answer: `Blocking 0` is the state the whole Inbox exists to reach,
//   so rendering it at somebody whose board simply has not arrived is worse than rendering nothing.
//
// SO THE CALL SITES ARE A TABLE IN THIS FILE, written out rather than globbed. A scan that found
// every `<SectionHeader` and checked it "looked reasonable" would pass just as happily with a
// paginated list wired to `.length`, because a `.length` is what a correct call site looks like too.
// What can actually be checked is WHICH surfaces have a count and which deliberately do not, and the
// three that do not are the three that are genuinely paginated.
//
// AND THE SIDEBAR'S INBOX BADGE IS NOT A SECTION COUNT. §4.3 says so and asks for a check, because
// the tempting change is to "fix" it to count everything: it counts blocking plus proposals only,
// attention is deliberately excluded, and a badge that never reaches zero is one people train
// themselves to ignore. `test:inbox-snapshot` holds the server's half; this holds the client's.
//
//   npm run test:section-count

import { createElement } from "react";

import { markup } from "../lib/testRender.ts";
import { check, done, read, sourceFiles } from "../lib/icons/harness.ts";
import { SectionHeader, UNKNOWN_COUNT } from "./SectionHeader.tsx";

const draw = (count: number | null): string => markup(createElement(SectionHeader, { name: "Blocking", count }));

// --- 1. empty is not zero ----------------------------------------------------------------------

console.log("\nzero and unknown are different sentences");
{
  const zero = draw(0);
  const unknown = draw(null);
  const twelve = draw(12);

  check("a genuine zero renders 0", />0</.test(zero), zero);
  check("an unknown count renders the dash", unknown.includes(UNKNOWN_COUNT), unknown);
  check("...and they are not the same markup", zero !== unknown);
  // THE DASH IS `format.ts`'s, not a second spelling of unknown. Every other unknown figure in this
  // product — a cost, a token count, a duration, a ratio — renders this exact character.
  check("the dash is the one the rest of the app uses", UNKNOWN_COUNT === "—", UNKNOWN_COUNT);
  check("an ordinary count renders itself", twelve.includes("12"), twelve);
  // AND THE NAME SURVIVES ALL THREE. A header that lost its word when the count went unknown would
  // be a section nobody could name while it was loading.
  for (const [label, m] of [["zero", zero], ["unknown", unknown], ["twelve", twelve]] as const) {
    check(`the name is there when the count is ${label}`, m.includes("Blocking"), m);
  }
}

// --- 2. a count is not a badge -----------------------------------------------------------------

console.log("\nno parentheses, no brackets, no pill");
{
  const m = draw(12);
  check("no parentheses around the count", !/\(\s*12\s*\)/.test(m), m);
  check("no brackets either", !/\[\s*12\s*\]/.test(m), m);
  // A PILL IS AN ALERT AND A SECTION THAT IS MERELY FULL IS NOT ONE. `rounded-full` plus a
  // background is what a badge is made of, and neither may appear here.
  check("no rounded fill behind it", !/rounded-full/.test(m) && !/bg-(err|run|ok|accent)/.test(m), m);
  // TABULAR, so a column of headers keeps its counts on one axis instead of shifting by a pixel per
  // digit as numbers change under a live list.
  check("the count is tabular", m.includes("tabular-nums"), m);
  // AND THE COUNT IS NOT LOUDER THAN THE NAME. §4.1: same size, secondary colour, immediately after.
  check("the count is the same size as the name", (m.match(/text-tiny/g) ?? []).length >= 2, m);
}

// --- 3. which surfaces have a count, and which deliberately do not ------------------------------

console.log("\nevery count is a total");
{
  // THE TABLE, WRITTEN OUT. §4.2's sites, each with the reason its number is a total: either the
  // payload carries every row, or the list is filtered in the browser out of one that does — in
  // which case the visible length is the honest answer and the server's figure is the wrong one,
  // because it would disagree with the rows under it the moment somebody filters (§4.3).
  const COUNTED: [string, string][] = [
    ["components/InboxView.tsx", "items.length"],
    ["components/ThreadsView.tsx", "section.threads.length"],
    ["components/FleetStrip.tsx", "fleet.length"],
    ["components/McpPanel.tsx", "servers.length"],
    ["components/ConnectionsPanel.tsx", "connections.length"],
    ["components/SecretsList.tsx", "secrets.length"],
    ["components/AccessPeople.tsx", "rows.length"],
    ["components/AccessInvites.tsx", "invites.length"],
    ["components/DatasetBuilder.tsx", "datasets.length"],
    ["components/GitHubPanel.tsx", "view.unpushed.length"],
  ];
  // THE SIDEBAR'S RUNS COUNT IS NO LONGER A SECTION HEADER — it moved onto each agent's row as a
  // capsule when runs stopped being a flat list and became a tree under the agent that produced
  // them. The REQUIREMENT did not move: that list is still a window (`listRuns` takes a cap, and
  // the column still has a "load older" control), so a bare figure would be a claim about a total
  // nobody has. A capsule has no `count` prop to pass null to, so the figure stays and the sentence
  // on hover carries the qualification — checked here rather than dropped, because dropping it is
  // how the wrong count comes back.
  {
    const text = read("src/components/Sidebar.tsx");
    check("the sidebar's runs capsule says when its figure is only what is loaded",
      /historyComplete/.test(text) && /older runs have not been fetched/.test(text),
      "the capsule claims a total it cannot know");
  }

  for (const [path, source] of COUNTED) {
    const text = read(`src/${path}`);
    check(`${path} counts ${source}`,
      text.includes("<SectionHeader") && text.includes(`count={${source}}`), source);
  }

  // AND THE THREE THAT ARE GENUINELY PAGINATED TAKE NO COUNT AT ALL. §13: "A missing count is fine.
  // A wrong count is not." Each of these renders a page or a window, and no payload behind it
  // carries a total — so a header here would be the exact failure I5 describes.
  //
  //   The Activity feed is virtualised at ten thousand rows and grouped by day; the feed payload
  //   carries a keyset cursor and no per-day total.
  //
  //   The Cockpit work list is cursor-paginated and grouped by day; `WorkCounts` is per STATUS for
  //   the current filters, which is not a per-day figure.
  //
  //   The workspace audit list is `listAudit(limit)` and the payload carries no total.
  const PAGINATED = ["components/ActivityFeed.tsx", "components/WorkList.tsx", "components/AccessHistory.tsx"];
  for (const path of PAGINATED) {
    check(`${path} takes no count`, !read(`src/${path}`).includes("<SectionHeader"));
  }

  // NOTHING PASSES A COUNT THIS FILE HAS NOT ACCOUNTED FOR. A call site added without a row above is
  // a count nobody has argued is a total, which is how the rule decays — one sanctioned-looking call
  // site at a time.
  const known = new Set([...COUNTED.map(([p]) => p), "components/SectionHeader.tsx", "components/sectionCount.test.ts"]);
  const stray = sourceFiles()
    .map((f) => f.replace(/^src\//, ""))
    .filter((f) => !known.has(f) && read(`src/${f}`).includes("<SectionHeader"));
  check("no unaccounted call site", stray.length === 0, stray.join(", "));
}

// --- 4. the sidebar badge is not a section count -----------------------------------------------

console.log("\n...and the badge that is not one is untouched");
{
  // §4.3 ASKS FOR THIS BY NAME. The Inbox badge counts blocking plus proposals; attention is
  // deliberately out, because a badge that counts everything never reaches zero and a badge that is
  // never zero is one people train themselves to ignore.
  const store = read("src/store/inboxStore.ts");
  const sums = [...store.matchAll(/counts\.badge = ([^;]+);/g)].map((m) => m[1]!.trim());
  check("the badge is still blocking plus proposals",
    sums.length > 0 && sums.every((s) => s === "counts.blocking + counts.proposals"),
    sums.join(" | "));
  check("...and attention is still out of it",
    !sums.some((s) => s.includes("attention")), sums.join(" | "));
  // AND THE BADGE IS NOT DRAWN BY THIS PATTERN. The sidebar DOES carry section headers — Pinned,
  // All agents, Runs — and the Inbox badge is none of them: it is a number on a destination row,
  // and a badge redrawn as a section count is a badge that has stopped being a badge.
  const sidebar = read("src/components/Sidebar.tsx");
  const badgeLines = sidebar.split("\n").filter((l) => /badge/.test(l) && /SectionHeader|RailSection/.test(l));
  check("no badge is rendered as a section count", badgeLines.length === 0, badgeLines.join(" | "));
}

done();
