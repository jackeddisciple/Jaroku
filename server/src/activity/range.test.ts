// The one window, as claims.
//
// EVERY RULE HERE IS ONE A SCREENSHOT CANNOT DISPROVE, which is the whole reason the window is a
// pure module and not a `WHERE` clause per aggregate:
//
//   The previous window is EXACTLY as long as the current one and ends where it begins. A "previous
//   calendar month" would make a 31-day month read 3% busier than a 30-day one, and the delta badge
//   would report a fact about the calendar as a fact about the workspace.
//
//   A custom range somebody inverted, left blank or typed prose into falls back to 7d rather than
//   throwing. This value arrives over a socket, and an exception here is a blank dashboard.
//
//   A very long custom range is CLAMPED FROM THE END the caller chose. Clamping from the start would
//   move the window somebody was looking at while appearing to honour it.
//
//   The bucket count stays in band for every span from a minute to a year. A month drawn as four
//   columns is not a time series, and a week drawn as ten thousand is not a chart.
//
//   `comparable` tests the WORKSPACE'S AGE, not whether the previous window was busy. A quiet week
//   is a real comparison; a week before the workspace existed is not.
//
//   npm run test:activity-range

import {
  ACTIVITY_RANGES,
  BUCKET_TARGET,
  MAX_CUSTOM_SPAN_MS,
  bucketFor,
  columnFor,
  bucketStarts,
  comparable,
  grainFor,
  grainInstant,
  isActivityRange,
  resolveWindow,
} from "./range.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

const NOW = new Date("2026-08-19T12:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const span = (from: string, to: string): number => Date.parse(to) - Date.parse(from);

console.log("\nthe vocabulary");
{
  check("four ranges and no more", ACTIVITY_RANGES.length === 4);
  check("a range off the wire is checked", isActivityRange("7d") && !isActivityRange("7 days"));
}

console.log("\nthe named ranges are the durations they are named after");
{
  for (const [range, ms] of [["24h", DAY], ["7d", 7 * DAY], ["30d", 30 * DAY]] as const) {
    const w = resolveWindow(range, NOW, null);
    check(`${range} spans ${ms / DAY} day(s)`, span(w.from, w.to) === ms);
    check(`${range} ends now`, w.to === NOW.toISOString());
  }
}

console.log("\nthe previous window is equivalent, not merely earlier");
{
  for (const range of ["24h", "7d", "30d"] as const) {
    const w = resolveWindow(range, NOW, null);
    check(
      `${range}: the previous window ends where this one begins`,
      w.previousTo === w.from,
      `${w.previousTo} vs ${w.from}`,
    );
    check(
      `${range}: and is exactly as long`,
      span(w.previousFrom, w.previousTo) === span(w.from, w.to),
    );
  }
}

console.log("\nonly 24h is live");
{
  check("24h is computed live", resolveWindow("24h", NOW, null).live);
  check("7d is not", !resolveWindow("7d", NOW, null).live);
  check("30d is not", !resolveWindow("30d", NOW, null).live);
  check(
    "and neither is a custom range that happens to be a day long",
    !resolveWindow("custom", NOW, {
      from: new Date(NOW.getTime() - DAY).toISOString(),
      to: NOW.toISOString(),
    }).live,
  );
}

console.log("\na custom range that cannot be read falls back rather than throwing");
{
  const sevenDays = 7 * DAY;
  const bad = [
    ["nothing at all", null],
    ["prose", { from: "yesterday", to: "today" }],
    ["inverted", { from: NOW.toISOString(), to: new Date(NOW.getTime() - DAY).toISOString() }],
    ["zero-width", { from: NOW.toISOString(), to: NOW.toISOString() }],
    ["half-given", { from: NOW.toISOString(), to: "" }],
  ] as const;
  for (const [name, custom] of bad) {
    const w = resolveWindow("custom", NOW, custom as never);
    check(`${name} falls back to 7d`, w.range === "7d" && span(w.from, w.to) === sevenDays);
  }
}

console.log("\na custom range is honoured, and clamped from the end");
{
  const from = "2026-08-01T00:00:00.000Z";
  const to = "2026-08-15T00:00:00.000Z";
  const w = resolveWindow("custom", NOW, { from, to });
  check("its own ends are kept", w.from === from && w.to === to);
  check("it says it is custom", w.range === "custom");

  const huge = resolveWindow("custom", NOW, { from: "2019-01-01T00:00:00.000Z", to });
  check("a decade is clamped to the cap", span(huge.from, huge.to) === MAX_CUSTOM_SPAN_MS);
  check("...and clamped from the START, keeping the end somebody chose", huge.to === to);
}

console.log("\nthe bucket count stays in band");
{
  const spans: [string, number][] = [
    ["a minute", MINUTE],
    ["an hour", HOUR],
    ["a day", DAY],
    ["a week", 7 * DAY],
    ["a month", 30 * DAY],
    ["a quarter", 90 * DAY],
    ["a year", 365 * DAY],
  ];
  for (const [name, ms] of spans) {
    const { bucketMs, buckets } = bucketFor(ms);
    check(
      `${name}: ${buckets} bucket(s) of ${Math.round(bucketMs / MINUTE)}m`,
      buckets <= BUCKET_TARGET.max && buckets >= 1 && bucketMs > 0,
      `${buckets} buckets`,
    );
  }
  // The three named ranges are the ones that must land on a boundary a person can name. A legal
  // column count is not enough: 24h in fifteen-minute columns is ninety-six of them and a boundary
  // nobody reading the chart could say out loud.
  check("24h buckets on the hour", bucketFor(DAY).bucketMs === HOUR);
  check("7d buckets on six hours", bucketFor(7 * DAY).bucketMs === 6 * HOUR);
  check("30d buckets on the day", bucketFor(30 * DAY).bucketMs === DAY);
  // And the short end, where fewer columns is the honest answer rather than a manufactured
  // thirty-seven-second bucket.
  check("an hour buckets on five minutes", bucketFor(HOUR).bucketMs === 5 * MINUTE);
}

console.log("\nthe series names its own x-axis and places a moment in it");
{
  const w = resolveWindow("24h", NOW, null);
  const starts = bucketStarts(w);
  check("one start per bucket", starts.length === w.buckets);
  // NOW sits on the hour, so the grid and the window happen to coincide here. The section further
  // down exercises the case where they do not, which is every other minute of the day.
  check("the first column starts on the grid", starts[0] === w.bucketFrom);
  check(
    "the last is one bucket short of the end",
    Date.parse(starts[starts.length - 1]!) === Date.parse(w.to) - w.bucketMs,
  );

  check("the first instant lands in bucket 0", columnFor(w, w.from) === 0);
  check(
    "an instant just inside the end lands in the last bucket",
    columnFor(w, new Date(Date.parse(w.to) - 1).toISOString()) === w.buckets - 1,
  );
  // Before the grid is nowhere rather than column zero — folding it in would pile whatever produced
  // it onto the chart's left edge and draw it as data. NOW sits on the hour here, so the grid and
  // the window begin together and this moment is outside both.
  check(
    "a moment before the grid is not column 0",
    columnFor(w, new Date(Date.parse(w.bucketFrom) - 1).toISOString()) === -1,
  );
  check("the exclusive end is outside", columnFor(w, w.to) === -1);
  check("so is a date nobody can parse", columnFor(w, "not a date") === -1);
}

console.log("\ncomparability is a question about the workspace, not about the data");
{
  const w = resolveWindow("30d", NOW, null);
  const older = new Date(Date.parse(w.previousFrom) - DAY).toISOString();
  const younger = new Date(Date.parse(w.previousFrom) + DAY).toISOString();

  check("a workspace older than the previous window is comparable", comparable(w, older));
  check("one created inside it is not", !comparable(w, younger));
  check(
    "one created exactly at its start is",
    comparable(w, w.previousFrom),
    "the boundary is inclusive, so the previous window is fully covered",
  );
  // The direction to be wrong in: one failed lookup must not blank every delta on the page.
  check("an unknown creation time reads as comparable", comparable(w, null));
  check("...and so does an unparseable one", comparable(w, "sometime last year"));
}

console.log("\nthe column grid is aligned to the epoch even when the window is not");
{
  // A window that ends at 14:37 — which is what "the last 24 hours" means at 14:37, and what the
  // three assertions above never exercised because NOW happens to sit on the hour.
  const odd = new Date("2026-08-19T14:37:11.500Z");
  const w = resolveWindow("24h", odd, null);

  check("the window itself is exact", w.to === odd.toISOString());
  check("...and reaches back exactly a day", span(w.from, w.to) === DAY);
  // The grid is what gets rounded, not the window.
  check("the grid starts on a bucket boundary", Date.parse(w.bucketFrom) % w.bucketMs === 0);
  check("...at or before the window's own start", Date.parse(w.bucketFrom) <= Date.parse(w.from));
  check(
    "...and within one bucket of it, so no whole empty column is prepended",
    Date.parse(w.from) - Date.parse(w.bucketFrom) < w.bucketMs,
  );
  const starts = bucketStarts(w);
  check("every column starts on a boundary", starts.every((s) => Date.parse(s) % w.bucketMs === 0));
  check("and the grid covers the whole window", Date.parse(starts[starts.length - 1]!) + w.bucketMs >= Date.parse(w.to));

  // THE DIVISION THIS FUNCTION EXISTS FOR: the GRID places, the QUERY decides membership. The grain
  // cell holding the window's first rows begins at 14:00 while the window begins at 14:37, so a
  // placement that re-checked the window would refuse that cell and take its rows off the chart
  // while the total above the chart still counted them. It is placed instead.
  const cellStart = w.bucketFrom;
  check("the first grain cell's own start is before the window's", Date.parse(cellStart) < Date.parse(w.from));
  check("...and it is still placed in the first column", columnFor(w, cellStart) === 0);
  check("a moment just inside the window is in the first column too", columnFor(w, w.from) === 0);
  // Outside the GRID has no column, and is not clamped onto an edge.
  check("a moment before the grid has no column", columnFor(w, new Date(Date.parse(cellStart) - 1).toISOString()) === -1);
  check("and the exclusive end has none either", columnFor(w, w.to) === -1);
}

console.log("\nthe grain always fits inside a column, on every range");
{
  const GRAIN_MS: Record<string, number> = { minute: MINUTE, hour: HOUR, day: DAY };
  const spans: [string, number][] = [
    ["an hour", HOUR], ["a day", DAY], ["a week", 7 * DAY], ["a month", 30 * DAY], ["a year", 365 * DAY],
  ];
  for (const [name, ms] of spans) {
    const { bucketMs } = bucketFor(ms);
    const g = grainFor(bucketMs);
    // BOTH HALVES ARE NEEDED. A grain no coarser than the column keeps a cell from spanning two;
    // a column that is a whole multiple of the grain keeps the epoch-aligned cells from straddling
    // a boundary. Together they are what makes the fold exact rather than approximate.
    check(
      `${name}: ${g} cells fit inside ${bucketMs / MINUTE}m columns`,
      GRAIN_MS[g]! <= bucketMs && bucketMs % GRAIN_MS[g]! === 0,
    );
  }
  check("a grain key round-trips into the instant it names", grainInstant("hour", "2026-08-19T14") === "2026-08-19T14:00:00.000Z");
  check("...for a day too", grainInstant("day", "2026-08-19") === "2026-08-19T00:00:00.000Z");
  check("...and a minute", grainInstant("minute", "2026-08-19T14:37") === "2026-08-19T14:37:00.000Z");
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
