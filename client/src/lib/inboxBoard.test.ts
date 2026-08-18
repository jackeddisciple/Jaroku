// The board's arrangement rules, as claims.
//
// EVERY ONE OF THESE LOOKS RIGHT IN A SCREENSHOT AND IS WRONG IN THE CASE NOBODY HAD THAT DAY, which
// is why they are a module with a suite rather than expressions inside a component:
//
//   The age bar is logarithmic. A linear one over a week makes the first hour invisible, which is
//   exactly the period a triage surface is about.
//
//   The tray never renders a negative duration. Snoozes are evaluated at read time, so "fired but
//   the snapshot has not arrived" is a real few seconds — and "-3h" on screen is the kind of thing
//   that makes somebody distrust everything else on it.
//
//   A shift-click range works upwards. A range that only worked downwards silently selects nothing
//   half the time, and it is the half nobody tries first.
//
//   The agent filter and the severity chip COMPOSE. Collapsing them into one selection makes the
//   second click undo the first.
//
//   npm run test:inbox-board

import {
  AGE_BAR_WINDOW_MS,
  COLUMN_EMPTY,
  INBOX_COLUMNS,
  INBOX_FILTERS,
  ageFraction,
  columnItems,
  filterInbox,
  isTeamItem,
  rangeBetween,
  shortDuration,
  sortForBoard,
  trayLine,
} from "./inboxBoard.ts";
import type { InboxItemView, InboxSeverity } from "../types.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const NOW = Date.parse("2026-08-19T12:00:00.000Z");
const HOUR = 3_600_000;
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

function item(over: Partial<InboxItemView> = {}): InboxItemView {
  return {
    id: over.id ?? "i1",
    type: "credential_missing",
    severity: "blocking",
    icon: "key",
    subject_type: "agent",
    subject_id: "agent-a",
    subject: "api_gateway needs STRIPE_KEY",
    payload: {},
    count: 1,
    first_seen_at: ago(HOUR),
    last_seen_at: ago(HOUR),
    actions: ["set_secret", "open_agent", "dismiss"],
    snoozed_until: null,
    ...over,
  };
}

// --- 1. the vocabulary ------------------------------------------------------------------------

console.log("\nsix filters and three columns");
{
  check("the rail's six chips are positional, so 1–6 is a stable address", INBOX_FILTERS.length === 6);
  check("...and All comes first, because that is where reopening the tab starts", INBOX_FILTERS[0] === "all");
  check("three columns, left to right", INBOX_COLUMNS.join(",") === "blocking,attention,proposal");
  check(
    "each empty column says its own thing, because three empty columns mean three different things",
    new Set(INBOX_COLUMNS.map((c) => COLUMN_EMPTY[c as InboxSeverity])).size === 3,
  );
  check(
    "...and Blocking's reads as an achievement rather than as an absence",
    COLUMN_EMPTY.blocking === "Nothing is blocked",
  );
}

// --- 2. the filters compose --------------------------------------------------------------------

console.log("\nthe severity chip and the agent breakdown are two selections, not one");
{
  const items = [
    item({ id: "b-a", severity: "blocking", subject_id: "agent-a" }),
    item({ id: "b-b", severity: "blocking", subject_id: "agent-b" }),
    item({ id: "a-a", severity: "attention", subject_id: "agent-a" }),
    item({ id: "p-a", severity: "proposal", subject_id: "agent-a" }),
    item({ id: "t-a", severity: "attention", type: "invite_pending", subject_id: null }),
  ];

  check("All is everything", filterInbox(items, [], "all", null).length === 5);
  check("Blocking is the two blocking", filterInbox(items, [], "blocking", null).length === 2);
  check("Proposals maps onto the singular severity", filterInbox(items, [], "proposals", null).length === 1);
  check("Team is the team-only types", filterInbox(items, [], "team", null).map((i) => i.id).join() === "t-a");
  check("...which is a property of the TYPE rather than of the column it sits in", isTeamItem(items[4]!));

  check("an agent alone narrows every column", filterInbox(items, [], "all", "agent-a").length === 3);
  check(
    "...and composes with the chip rather than replacing it",
    filterInbox(items, [], "blocking", "agent-a").map((i) => i.id).join() === "b-a",
  );

  // The snoozed chip selects a different LIST. A snoozed card is not on the board at all, so it can
  // never be reachable by filtering the board.
  const snoozed = [item({ id: "s1", snoozed_until: new Date(NOW + HOUR).toISOString() })];
  check("Snoozed shows the tray's contents", filterInbox(items, snoozed, "snoozed", null).map((i) => i.id).join() === "s1");
  check("...and nothing snoozed is reachable from any other chip", filterInbox(items, snoozed, "all", null).every((i) => i.id !== "s1"));
}

// --- 3. order within a column -------------------------------------------------------------------

console.log("\noldest first, because that is the reading of age that makes a board shrink");
{
  const items = [
    item({ id: "new", first_seen_at: ago(HOUR) }),
    item({ id: "old", first_seen_at: ago(72 * HOUR) }),
    item({ id: "mid", first_seen_at: ago(12 * HOUR) }),
  ];
  check("the longest-waiting card is first", sortForBoard(items).map((i) => i.id).join() === "old,mid,new");
  check(
    "...rather than buried under every new arrival",
    sortForBoard(items)[0]?.id !== "new",
  );
  check("sorting does not mutate the list it was given", items[0]?.id === "new");

  const mixed = [item({ id: "b", severity: "blocking" }), item({ id: "a", severity: "attention" })];
  check("a column holds only its own severity", columnItems(mixed, "blocking").map((i) => i.id).join() === "b");
}

// --- 4. the age bar ------------------------------------------------------------------------------

console.log("\nthe age bar moves in the first hour, which is the period a triage surface is about");
{
  check("a brand-new item is empty", ageFraction(new Date(NOW).toISOString(), NOW) === 0);
  const anHour = ageFraction(ago(HOUR), NOW);
  const aDay = ageFraction(ago(24 * HOUR), NOW);
  check("an hour is visible", anHour > 0.35, `${anHour.toFixed(3)}`);
  check("...and a day is most of the way", aDay > 0.7 && aDay < 1, `${aDay.toFixed(3)}`);
  check(
    "...which a LINEAR bar would not do — an hour would be under two percent of a week",
    anHour > HOUR / AGE_BAR_WINDOW_MS + 0.3,
  );
  check("a week is full", ageFraction(ago(AGE_BAR_WINDOW_MS), NOW) === 1);
  check("...and so is a fortnight, rather than overflowing", ageFraction(ago(14 * 24 * HOUR), NOW) === 1);
  check(
    "a clock skew that puts the start in the future draws nothing rather than a bar filling backwards",
    ageFraction(new Date(NOW + HOUR).toISOString(), NOW) === 0,
  );
  check("a timestamp nothing can parse draws nothing", ageFraction("not a date", NOW) === 0);
}

// --- 5. the tray line -----------------------------------------------------------------------------

console.log("\nthe tray says how many and when the next one is back");
{
  check("nothing snoozed renders no strip at all rather than '0 snoozed'", trayLine([], NOW) === null);

  const four = [
    item({ id: "s1", snoozed_until: new Date(NOW + 3 * HOUR).toISOString() }),
    item({ id: "s2", snoozed_until: new Date(NOW + 26 * HOUR).toISOString() }),
    item({ id: "s3", snoozed_until: new Date(NOW + 8 * HOUR).toISOString() }),
    item({ id: "s4", snoozed_until: new Date(NOW + 200 * HOUR).toISOString() }),
  ];
  check("four snoozed, next in three hours", trayLine(four, NOW) === "4 snoozed · next returns in 3h", trayLine(four, NOW) ?? "");

  const fired = [item({ id: "s1", snoozed_until: new Date(NOW - 3 * HOUR).toISOString() })];
  check(
    "a timer that has already fired reads as 'any moment', never as a negative duration",
    trayLine(fired, NOW) === "1 snoozed · next returns any moment",
    trayLine(fired, NOW) ?? "",
  );

  check("under an hour is minutes", shortDuration(45 * 60_000) === "45m");
  check("...and never rounds down to zero", shortDuration(10_000) === "1m");
  check("a day and a half is hours, because that is still a working answer", shortDuration(36 * HOUR) === "36h");
  check("past two days it is days", shortDuration(72 * HOUR) === "3d");
}

// --- 6. shift-click -------------------------------------------------------------------------------

console.log("\na range works in both directions, across column boundaries");
{
  const ordered = ["a", "b", "c", "d", "e"].map((id) => item({ id }));
  check("downwards", rangeBetween(ordered, "b", "d").join() === "b,c,d");
  check("...and upwards selects the same range", rangeBetween(ordered, "d", "b").join() === "b,c,d");
  check("a range of one is one", rangeBetween(ordered, "c", "c").join() === "c");
  check(
    "an anchor that has since resolved out from under the click selects only what was clicked",
    rangeBetween(ordered, "gone", "d").join() === "d",
  );
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
// The same exit the other client suites use: this runs under tsx with no node types in scope.
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
