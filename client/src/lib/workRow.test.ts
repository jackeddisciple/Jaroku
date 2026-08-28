// §24's `test:work-row`: "column shedding order; the agent column disappears when filtered to one
// agent".
//
// AN ORDER IS THE THING A SCREENSHOT CANNOT SHOW. Any single width renders a row that looks
// correct — six columns at a comfortable width looks right, three at a narrow one looks right —
// and what §13 actually specifies is the SEQUENCE between them: actor, then agent name, then cost,
// with time and status never leaving. A implementation that shed cost first passes every
// screenshot and fails the one question the reader is asking at a narrow width, which is what the
// figures were.
//
// SO THE SUITE WALKS THE WIDTH DOWNWARDS AND ASSERTS THE SEQUENCE, rather than asserting three
// widths independently. That is also what catches the subtler failure: a column that comes back at
// a narrower width because two thresholds were written in the wrong order.
//
// AND THE DAY GROUPING, whose two rules are both about absence: a day with no items renders
// nothing, and a single row still gets its heading. Both look identical on a busy workspace and
// differ only on the two shapes §22 names.
//
//   npm run test:work-row

import { BREAKPOINT, dayLabel, groupByDay, rowColumns } from "./workRow.ts";
import type { WorkFilters, WorkItemView } from "../types.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const filters = (patch: Partial<WorkFilters> = {}): WorkFilters => ({
  scope: "all", status: null, agentId: null, ...patch,
});

let seq = 0;
const item = (createdAt: string, patch: Partial<WorkItemView> = {}): WorkItemView => ({
  id: `w-${++seq}`, agent_id: "a", agent_name: "billing_bot", deployment_id: "d", run_id: "r",
  created_by: "u", created_by_name: "Tester", input_preview: "refund order 4471",
  status: "succeeded", output_preview: null, error: null, failure_kind: null,
  created_at: createdAt, started_at: createdAt, ended_at: createdAt,
  cost_usd: 0.0031, tokens: 900, duration_ms: 4200, cost_complete: true,
  ...patch,
});

// --- 1. the shedding order -------------------------------------------------------------------------

console.log("\nactor, then agent name, then cost");
{
  const wide = rowColumns(1400, filters());
  check("everything is there at a comfortable width",
    wide.actor && wide.agent && wide.cost, JSON.stringify(wide));

  // WALKED DOWNWARDS, which is the only way an ORDER is asserted rather than three widths. A
  // column that has gone must stay gone as the pane narrows further — the failure that puts a
  // column back at a narrower width is two thresholds written the wrong way round.
  const widths = [1400, BREAKPOINT.lg, BREAKPOINT.md, BREAKPOINT.sm, 480, 320];
  const seen = widths.map((w) => rowColumns(w, filters()));
  for (const key of ["actor", "agent", "cost"] as const) {
    const present = seen.map((c) => c[key]);
    // Once false, never true again.
    const returns = present.some((v, i) => v && present.slice(0, i).some((p) => !p));
    check(`${key} never comes back once it has gone`, !returns, present.join(","));
  }

  // THE ORDER ITSELF. At the width where the first column has gone, the other two are still there;
  // at the width where the second has gone, the third is; and so on.
  const atMd = rowColumns(BREAKPOINT.md - 1, filters());
  check("actor goes first", !atMd.actor && atMd.agent && atMd.cost, JSON.stringify(atMd));

  const atSm = rowColumns(BREAKPOINT.sm - 1, filters());
  check("agent name and cost go together at the narrowest step",
    !atSm.actor && !atSm.agent && !atSm.cost, JSON.stringify(atSm));

  // TIME AND STATUS NEVER LEAVE — §13. They are not flags at all, which is the strongest form of
  // "never": there is nothing to set false. Asserted as a property of the shape rather than of a
  // value, so a future `time: boolean` fails here rather than shipping.
  check("there is no flag that could remove time or status",
    !("time" in atSm) && !("status" in atSm) && !("input" in atSm), Object.keys(atSm).join(", "));
  check("...and exactly three columns are sheddable", Object.keys(atSm).length === 3);
}

// --- 2. the two scope rules, which are the same rule twice -----------------------------------------

console.log("\na column that repeats one value forty times");
{
  // §6, AND §24 NAMES THIS ONE: "the agent column disappears when filtered to one agent".
  const filtered = rowColumns(1400, filters({ agentId: "a" }));
  check("the agent column goes when the list is filtered to one agent",
    !filtered.agent, JSON.stringify(filtered));
  check("...at any width, not only a narrow one", !rowColumns(4000, filters({ agentId: "a" })).agent);
  check("...and the other columns stay", filtered.actor && filtered.cost, JSON.stringify(filtered));

  // §6: "Actor, shown only in the `all` view. In `mine` it is always the reader."
  const mine = rowColumns(1400, filters({ scope: "mine" }));
  check("the actor column goes in the mine scope", !mine.actor, JSON.stringify(mine));
  check("...and comes back in everyone's", rowColumns(1400, filters({ scope: "all" })).actor);
  check("...while the agent column is unaffected by scope", mine.agent);
}

// --- 3. an unmeasured container is wide, not narrow ------------------------------------------------

console.log("\nthe first frame");
{
  // THE OPPOSITE OF WHAT A NAIVE COMPARISON GIVES. A container reports zero until it is measured,
  // and `0 < 640` is true — so a row would arrive with three columns and grow to six a frame
  // later, which is exactly the layout shift §Craft 1 is about.
  const unmeasured = rowColumns(0, filters());
  check("an unmeasured container renders every column",
    unmeasured.actor && unmeasured.agent && unmeasured.cost, JSON.stringify(unmeasured));
  check("...and so does a negative one", rowColumns(-1, filters()).cost);
}

// --- 4. no breakpoint that is not already in the app's set -----------------------------------------

console.log("\nTailwind's own steps and no others");
{
  check("the thresholds are sm, md and lg",
    BREAKPOINT.sm === 640 && BREAKPOINT.md === 768 && BREAKPOINT.lg === 1024,
    JSON.stringify(BREAKPOINT));
  check("...and there is no fourth", Object.keys(BREAKPOINT).length === 3);
}

// --- 5. the day grouping ---------------------------------------------------------------------------

console.log("\nwhere the days break");
{
  const now = new Date("2026-08-28T14:00:00Z");
  const at = (iso: string): string => new Date(iso).toISOString();

  // ORDER IS PRESERVED AND NOT RE-SORTED. §18: "Sort is by creation time and creation time does not
  // change." A grouping function that sorted would be a second opinion about the order, and the one
  // place the two could disagree is mid-delta under a reader's cursor.
  const rows = [
    item(at("2026-08-28T13:00:00")), item(at("2026-08-28T09:00:00")),
    item(at("2026-08-27T22:00:00")),
    item(at("2026-08-25T11:00:00")),
  ];
  const days = groupByDay(rows, now);
  check(`three distinct days become three groups (${days.length})`, days.length === 3, String(days.length));
  check("...in the order they arrived", days[0]!.items.length === 2 && days[1]!.items.length === 1);
  check("...with the rows inside each group untouched",
    days[0]!.items[0]!.id === rows[0]!.id && days[0]!.items[1]!.id === rows[1]!.id);

  // A DAY WITH NO ITEMS RENDERS NOTHING, which falls out of deriving groups FROM items. The 26th
  // is between two days that have rows and produces no group at all.
  check("a day with nothing in it produces no group",
    !days.some((d) => d.key === "2026-08-26"), days.map((d) => d.key).join(", "));

  // §22: "One job. The day grouping still renders its heading. A single row with no heading looks
  // like a fragment."
  const one = groupByDay([item(at("2026-08-28T13:00:00"))], now);
  check("a single row still gets its heading", one.length === 1 && one[0]!.label.length > 0,
    JSON.stringify(one.map((d) => d.label)));

  check("an empty list produces no groups", groupByDay([], now).length === 0);

  // A MALFORMED INSTANT STILL GETS A ROW. Dropping it would be the list quietly deciding a job did
  // not exist, which is the one thing this tab exists to never do.
  const withBad = groupByDay([item(at("2026-08-28T13:00:00")), item("not a date")], now);
  check("a row with an unreadable timestamp is still in the list",
    withBad.reduce((n, d) => n + d.items.length, 0) === 2,
    String(withBad.reduce((n, d) => n + d.items.length, 0)));
}

// --- 6. what a heading says ------------------------------------------------------------------------

console.log("\ntwo named days and then dates");
{
  const now = new Date("2026-08-28T14:00:00");
  const on = (iso: string): string => new Date(iso).toISOString();

  check("today is named", dayLabel(on("2026-08-28T09:00:00"), now) === "Today",
    dayLabel(on("2026-08-28T09:00:00"), now));
  check("yesterday is named", dayLabel(on("2026-08-27T22:00:00"), now) === "Yesterday",
    dayLabel(on("2026-08-27T22:00:00"), now));

  // A THIRD NAMED DAY IS AMBIGUOUS WITHIN A WEEK, which is the ceiling argument `relTime` already
  // makes for itself one unit up.
  const older = dayLabel(on("2026-08-25T11:00:00"), now);
  check("the day before that is dated rather than named",
    older !== "Today" && older !== "Yesterday" && /\d/.test(older), older);

  // THE YEAR APPEARS ONLY WHEN IT IS NOT THIS ONE — `relTime`'s own convention, borrowed so a
  // heading and the rows under it date things the same way.
  check("this year carries no year", !/2026/.test(dayLabel(on("2026-03-02T11:00:00"), now)),
    dayLabel(on("2026-03-02T11:00:00"), now));
  check("...and a previous year does", /2025/.test(dayLabel(on("2025-12-02T11:00:00"), now)),
    dayLabel(on("2025-12-02T11:00:00"), now));

  // NOT `relTime`, AND NOT BY ACCIDENT. A heading names a calendar day; "4h ago" is not a name a
  // day can have, and two rows eleven hours apart under one heading would be given two labels.
  check("a heading is never an elapsed interval",
    !/ago/.test(dayLabel(on("2026-08-28T09:00:00"), now) + older));

  check("an unreadable instant has no heading", dayLabel("not a date", now) === "");
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
