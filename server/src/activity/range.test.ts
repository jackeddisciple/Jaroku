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
  bucketIndex,
  bucketStarts,
  comparable,
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
  check("the first is the window's own start", starts[0] === w.from);
  check(
    "the last is one bucket short of the end",
    Date.parse(starts[starts.length - 1]!) === Date.parse(w.to) - w.bucketMs,
  );

  check("the first instant lands in bucket 0", bucketIndex(w, w.from) === 0);
  check(
    "an instant just inside the end lands in the last bucket",
    bucketIndex(w, new Date(Date.parse(w.to) - 1).toISOString()) === w.buckets - 1,
  );
  // THE CASE THIS FUNCTION EXISTS FOR. A run that began before the range and ended inside it is a
  // real row a query bounded on `ended_at` returns, and folding it into bucket zero would pile
  // every long-running thing onto the chart's left edge.
  check(
    "a moment before the window is not bucket 0",
    bucketIndex(w, new Date(Date.parse(w.from) - 1).toISOString()) === -1,
  );
  check("the exclusive end is outside", bucketIndex(w, w.to) === -1);
  check("so is a date nobody can parse", bucketIndex(w, "not a date") === -1);
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

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
